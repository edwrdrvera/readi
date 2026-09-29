// M3 part of the packaged check: live import, crash recovery, and watched
// folders, against a fresh data dir. Node makes every outside-the-app change
// when the self-test logs `fs:<step>`, and inspects the database and library
// directory while the app is not running.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, realpathSync, renameSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const sha256 = buf => createHash('sha256').update(buf).digest('hex')
const sha256File = path => new Promise((resolve, reject) => {
  const h = createHash('sha256')
  createReadStream(path).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
})
const HUGE_BYTES = 2 * 1024 ** 3

/** Distinct-hash copies of text.pdf: a trailing PDF comment keeps them valid. */
function inputs(root, tmp, fixtures) {
  const text = readFileSync(join(root, 'fixtures/text.pdf'))
  const variant = n => Buffer.concat([text, Buffer.from(`\n%variant-${n}\n`)])
  const dirs = Object.fromEntries(['watchA', 'watchB', 'watchC', 'outside', 'copies'].map(d => [d, join(tmp, d)]))
  for (const d of Object.values(dirs)) mkdirSync(d)
  const A = dirs.watchA
  const files = {
    huge: join(tmp, 'huge.pdf'),
    huge2: join(tmp, 'huge2.pdf'),
    resumable: join(tmp, 'resumable.pdf'),
    drop: join(tmp, 'dropped.pdf'),
    openWith: join(tmp, 'opened-with.pdf'),
    dup: join(A, 'dup.pdf'),
    dupB: join(dirs.watchB, 'dup.pdf'),
    added: join(A, 'added.pdf'),
    rename: join(A, 'rename.pdf'),
    renamed: join(A, 'sub/rename.pdf'),
    moveout: join(A, 'moveout.pdf'),
    movedOut: join(dirs.outside, 'moveout.pdf'),
    delete: join(A, 'delete.pdf'),
    change: join(A, 'change.pdf'),
    perm: join(A, 'perm.pdf'),
    explicit: join(A, 'explicit.pdf'),
    exclude: join(A, 'exclude.pdf'),
    c1: join(dirs.watchC, 'c1.pdf'),
    offAdded: join(dirs.watchB, 'offline-added.pdf'),
    offRename: join(A, 'off-rename.pdf'),
    offRenamed: join(A, 'off-renamed.pdf'),
    offMoveout: join(A, 'off-moveout.pdf'),
    offMovedOut: join(dirs.outside, 'off-moveout.pdf'),
    offDelete: join(A, 'off-delete.pdf'),
    offChange: join(A, 'off-change.pdf'),
    offPerm: join(A, 'off-perm.pdf'),
  }
  // Variant number per content key; `changed` and `offChanged` replace bytes in place.
  const numbers = {
    resumable: 1, drop: 2, openWith: 3, dup: 10, added: 11, rename: 12, moveout: 13, delete: 14, change: 15, changed: 16,
    perm: 17, explicit: 18, exclude: 19, c1: 20, offAdded: 21, offRename: 22, offMoveout: 23, offDelete: 24,
    offChange: 25, offChanged: 26, offPerm: 27,
  }
  const bytes = Object.fromEntries(Object.entries(numbers).map(([k, n]) => [k, variant(n)]))
  const sha = Object.fromEntries(Object.entries(bytes).map(([k, b]) => [k, sha256(b)]))
  const initial = ['resumable', 'drop', 'openWith', 'dup', 'rename', 'moveout', 'delete', 'change', 'perm', 'explicit', 'exclude', 'c1',
    'offRename', 'offMoveout', 'offDelete', 'offChange', 'offPerm']
  for (const k of initial) writeFileSync(files[k], bytes[k])
  writeFileSync(files.dupB, bytes.dup)
  for (const f of [files.huge, files.huge2]) {
    writeFileSync(f, '%PDF-1.4\n')
    truncateSync(f, HUGE_BYTES)
  }
  const copies = fixtures.map(f => {
    const to = join(dirs.copies, basename(f))
    copyFileSync(f, to)
    return to
  })
  // Watched files the self-test adds later are older than the 2 s freshness window by then.
  return { files, bytes, sha, dirs, fixtures: copies }
}

function openDb(dir) {
  return new DatabaseSync(join(dir, 'readi.sqlite'), { readOnly: true })
}

/** Staging empty, no orphan managed file, no managed location without its file. */
function libraryState(dir, hashes = {}) {
  const lib = join(dir, 'library')
  const staging = existsSync(join(lib, '.staging')) ? readdirSync(join(lib, '.staging')) : []
  const db = openDb(dir)
  try {
    const managed = db.prepare("SELECT path FROM book_locations WHERE kind = 'managed'").all().map(r => r.path)
    const onDisk = readdirSync(lib).filter(f => f !== '.staging')
    const booksWith = Object.fromEntries(Object.entries(hashes).map(([k, h]) =>
      [k, db.prepare('SELECT COUNT(*) AS n FROM books WHERE sha256 = ?').get(h).n]))
    return {
      staging,
      orphanFiles: onDisk.filter(f => !managed.includes(f)),
      missingManaged: managed.filter(p => !existsSync(join(lib, p))),
      managedCount: managed.length,
      booksWith,
    }
  } finally {
    db.close()
  }
}

const readiPids = binary => spawnSync('pgrep', ['-f', binary], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number)

export async function runM3({ root, app, runPhase, check, notVerified, measured, fixtures }) {
  const binary = join(app, 'Contents/MacOS/readi')
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'readi-m3-')))
  const dir = join(tmp, 'data')
  mkdirSync(dir)
  const input = inputs(root, tmp, fixtures)
  const { files, bytes, sha, dirs } = input
  const hugeSha = await sha256File(files.huge)
  const m3 = { fixtures: input.fixtures, files, sha, dirs, prev: {} }
  const phase = (name, steps) => runPhase(name, { dir, m3, steps })
  const restorePermissions = () => {
    for (const p of [dirs.watchC]) existsSync(p) && chmodSync(p, 0o755)
    for (const p of [files.perm, files.offPerm, files.c1]) existsSync(p) && chmodSync(p, 0o644)
  }

  try {
    // 1. Live import.
    const openWith = { secondInstance: false }
    const live = await phase('m3-live-import', {
      'open-with': async child => {
        const before = new Set(readiPids(binary))
        // --env only applies if LaunchServices starts a new instance; it keeps
        // a stray instance away from the user's real library.
        const stray = join(tmp, 'stray-instance-data')
        const r = spawnSync('open', ['-a', app, '--env', `READI_DATA_DIR=${stray}`, files.openWith], { encoding: 'utf8' })
        openWith.openStatus = r.status
        openWith.openStderr = r.stderr
        await sleep(3000)
        const extra = readiPids(binary).filter(p => p !== child.pid && !before.has(p))
        if (extra.length) {
          openWith.secondInstance = true
          for (const p of extra) process.kill(p, 'SIGKILL')
        }
      },
    })
    const liveLib = libraryState(dir, { huge: hugeSha })
    console.log(JSON.stringify({ live, liveLib, openWith }, null, 2))
    check('m3-live-import phase completed', live.ok, live.error)
    if (live.ok) {
      measured.uiAckMs = live.ack
      measured.importMs = Object.fromEntries(live.perFixture.map(f => [f.file, f.ms]))
      check('import acknowledged in the store within 100 ms', live.ack.storeMs !== null && live.ack.storeMs <= 100, live.ack)
      check('import acknowledgement rendered within 100 ms', live.ack.domMs !== null && live.ack.domMs <= 100, live.ack)
      check('all 5 fixture copies imported', live.perFixture.length === 5 && live.perFixture.every(f => f.state === 'done' && f.outcome === 'imported'), live.perFixture)
      const h = live.huge
      check('huge.pdf still running after 1 s', h.stateBeforeCancel === 'running' && h.ranMs > 1000, h)
      check('progress bar shown for an import running over 1 s', h.progressShown, h)
      check('cancelled import ends in state cancelled', h.state === 'cancelled', h)
      check('cancel leaves no staging file', liveLib.staging.length === 0, liveLib)
      check('cancel leaves no book row for huge.pdf', liveLib.booksWith.huge === 0, liveLib)
      check('no orphan managed file after live import', liveLib.orphanFiles.length === 0 && liveLib.missingManaged.length === 0, liveLib)
      const am = live.alreadyManaged
      check('re-import of typical.epub: already_in_library, same book', am.outcome === 'already_in_library' && am.bookId === am.firstBookId, am)
      check('re-import focuses the existing card (data-focused)', am.focused && am.cardFocused, am)
      const d = live.drop
      check('app drop handler (synthetic tauri://drag-drop, not an OS drag) imports the file', d.state === 'done' && d.outcome === 'imported' && d.bookId !== null, d)
      check('drag-enter shows the drop overlay, drop hides it', d.overlayShown && d.overlayGone, d)
      const ow = live.openWith
      if (ow.verified) check('Open With (open -a) imports the file', ow.state === 'done' && ow.outcome === 'imported', { ...ow, openWith })
      else notVerified('Open With (open -a) imports the file', { ...ow, openWith })
    }

    // 2. Kill mid-copy, 3. recover.
    const killInfo = {}
    const killed = await phase('m3-kill', {
      kill: async child => {
        const staging = join(dir, 'library/.staging')
        const size = () => existsSync(staging) ? readdirSync(staging).reduce((n, f) => n + statSync(join(staging, f)).size, 0) : 0
        const start = Date.now()
        let last = size()
        for (;;) {
          await sleep(100)
          const now = size()
          if (now > last && last > 0) break
          last = now
          if (Date.now() - start > 30_000) break
        }
        killInfo.stagingBytes = size()
        child.kill('SIGKILL')
        await new Promise(r => child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r))
        unlinkSync(files.huge2)
        return 'killed'
      },
    })
    check('m3-kill: app killed mid-copy with a growing staging file', killed.killed && killInfo.stagingBytes > 0, killInfo)
    const recovered = await phase('m3-recover')
    const recLib = libraryState(dir, { huge: hugeSha })
    console.log(JSON.stringify({ killInfo, recovered, recLib }, null, 2))
    check('m3-recover phase completed', recovered.ok, recovered.error)
    if (recovered.ok) {
      check('killed job for a deleted source is failed with an actionable reason', recovered.huge2.state === 'failed' && /moved or deleted.*Import it again/.test(recovered.huge2.error ?? ''), recovered.huge2)
      check('queued job resumes after relaunch and completes', recovered.resumable.state === 'done' && recovered.resumable.bookPresent, recovered.resumable)
      check('after kill: staging empty', recLib.staging.length === 0, recLib)
      check('after kill: every library file is a managed location', recLib.orphanFiles.length === 0, recLib)
      check('after kill: every managed location has its file', recLib.missingManaged.length === 0, recLib)
      check('after kill: no book row for huge2.pdf', recLib.booksWith.huge === 0, recLib)
    }

    // 4. Watched folders while running.
    const watch = await phase('m3-watch-live', {
      add: () => writeFileSync(files.added, bytes.added),
      rename: () => {
        mkdirSync(join(dirs.watchA, 'sub'))
        renameSync(files.rename, files.renamed)
      },
      'move-out': () => renameSync(files.moveout, files.movedOut),
      delete: () => unlinkSync(files.delete),
      change: () => writeFileSync(files.change, bytes.changed),
      chmod: () => chmodSync(files.perm, 0),
    })
    console.log(JSON.stringify({ watch }, null, 2))
    check('m3-watch-live phase completed', watch.ok, watch.error)
    if (watch.ok) {
      const w = watch
      check('same hash in two watched folders: one book, one card, two available locations',
        w.duplicate.books === 1 && w.duplicate.cards === 1 && w.duplicate.locations?.length === 2 && w.duplicate.locations.every(l => l.availability === 'available'), w.duplicate)
      check('live: file added to a watched folder appears', w.add.availability === 'available', w.add)
      check('live: move into a subfolder keeps the book id, new path available',
        w.rename.sameId && w.rename.available && w.rename.paths?.includes(files.renamed) && !w.rename.paths.includes(files.rename), w.rename)
      check('live: move out of watched folders marks the location moved, book Missing', w.moveOut.availability === 'moved' && w.moveOut.available === false && w.moveOut.sameId, w.moveOut)
      check('live: Book Info shows data-availability="moved"', w.moveOut.bookInfoShowsMoved, w.moveOut)
      check('live: delete marks the location moved, book Missing', w.delete.availability === 'moved' && w.delete.available === false && w.delete.sameId, w.delete)
      check('live: bytes changed in place: new book at that path', w.change.newId && w.change.newId !== w.change.oldId && w.change.newAvailable === 'available', w.change)
      check('live: bytes changed in place: old book Missing, keeps its progress', w.change.oldAvailable === false && w.change.oldProgressPage === 2, w.change)
      check('live: chmod 000 file is permission_denied', w.permission.availability === 'permission_denied', w.permission)
      check('explicit import of a watched-only book: added_copy, gains a managed location',
        w.explicit.outcome === 'added_copy' && w.explicit.sameId && w.explicit.kinds?.includes('managed'), w.explicit)
      check('removed watched book stays out after a rescan and is listed in exclusions', w.exclusion.booksAfterRescan === 0 && w.exclusion.excluded, w.exclusion)
      check('removed watched book stays out after its folder is removed, re-added, and rescanned; exclusion still listed',
        w.exclusionReadd?.newFolderId && w.exclusionReadd.booksAfterRescan === 0 && w.exclusionReadd.excluded, w.exclusionReadd)
      check('organization set: collection, folder collection, view', w.organize.collection !== null && w.organize.folderA !== null, w.organize)
      const p = w.palette
      check('⌘K keydown opens the palette', p.opened, p)
      check('palette: typing + Enter runs Mark as Finished exactly once', p.selected === 'book.finished' && p.runs === 1, p)
      check('palette: Mark as Finished took effect and the palette closed', p.finished && p.closed, p)
      const viaRescan = ['add', 'rename', 'moveOut', 'delete', 'change', 'permission'].filter(k => w[k]?.viaRescan)
      check('live changes seen through file events, without a manual rescan', viaRescan.length === 0, viaRescan)
    }

    // 5. Changes while the app is closed.
    m3.prev = watch.ids ?? {}
    writeFileSync(files.offAdded, bytes.offAdded)
    renameSync(files.offRename, files.offRenamed)
    renameSync(files.offMoveout, files.offMovedOut)
    unlinkSync(files.offDelete)
    writeFileSync(files.offChange, bytes.offChanged)
    chmodSync(files.offPerm, 0)
    chmodSync(dirs.watchC, 0)

    // 6. Launch scan.
    const off = await phase('m3-watch-offline')
    const offLib = libraryState(dir)
    console.log(JSON.stringify({ off, offLib }, null, 2))
    check('m3-watch-offline phase completed', off.ok, off.error)
    if (off.ok) {
      check('launch scan ran after relaunch', off.folders.filter(f => f.path !== dirs.watchC).every(f => f.lastScanAfterLaunch), off.folders)
      check('offline: added file appears', off.added.availability === 'available', off.added)
      check('offline: rename keeps the book id, new path available',
        off.rename.sameId && off.rename.availability === 'available' && !off.rename.paths.includes(files.offRename), off.rename)
      check('offline: moved out is moved, book Missing', off.moveOut.availability === 'moved' && off.moveOut.available === false && off.moveOut.sameId, off.moveOut)
      check('offline: deleted is moved, book Missing', off.delete.availability === 'moved' && off.delete.available === false && off.delete.sameId, off.delete)
      check('offline: changed bytes: new book at the path', off.change.newId && off.change.newId !== off.change.oldId && off.change.newAvailability === 'available', off.change)
      check('offline: changed bytes: old book Missing, keeps its progress', off.change.oldAvailable === false && off.change.oldProgressPage === 2, off.change)
      check('offline: chmod 000 file is permission_denied', off.permission.availability === 'permission_denied', off.permission)
      check('offline: chmod 000 folder: location and folder permission_denied',
        off.folderDenied.folderAccess === 'permission_denied' && off.folderDenied.locationAvailability === 'permission_denied', off.folderDenied)
      check('exclusion holds after the launch scan', off.exclusion.heldAfterLaunchScan && off.exclusion.listed, off.exclusion)
      check('restoring the exclusion brings the book back', off.exclusion.returnedAfterRestore, off.exclusion)
      const o = off.organization
      check('manual collection and its 2 books survived restart', o.collection === 'M3 Picks' && JSON.stringify(o.members) === JSON.stringify(o.expectedMembers), o)
      check('folder collection survived restart', o.folderCollection === true && o.derivedCollection, o)
      check('Library view (sort, format, collection) survived restart',
        o.view.sort === 'title' && o.view.format === 'pdf' && o.view.collection_id === m3.prev.pick &&
        o.storeView.sort === 'title' && o.storeView.format === 'pdf' && o.storeView.collection_id === m3.prev.pick, o)
      check('Finished state survived restart', o.finished === 'finished', o)
      check('end of M3: staging empty, no orphan or missing managed file',
        offLib.staging.length === 0 && offLib.orphanFiles.length === 0 && offLib.missingManaged.length === 0, offLib)
    }
  } finally {
    restorePermissions()
    rmSync(tmp, { recursive: true, force: true })
  }
}
