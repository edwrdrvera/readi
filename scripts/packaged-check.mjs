// End-to-end check of the packaged app: import, extract, read, force-kill,
// relaunch, and confirm restored positions. Also serves a canary HTTP server
// that the hostile EPUB points at; any hit means book content reached the network.
// Usage: node scripts/packaged-check.mjs [path/to/Readi.app]
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const app = process.argv[2] ?? join(root, 'src-tauri/target/release/bundle/macos/Readi.app')
const binary = join(app, 'Contents/MacOS/readi')
const fixtures = ['typical.epub', 'hostile.epub', 'text.pdf', 'large.pdf'].map(f => join(root, 'fixtures', f))
for (const f of [binary, ...fixtures]) if (!existsSync(f)) throw new Error(`missing ${f} (run pnpm tauri build and pnpm fixtures)`)
const manifest = JSON.parse(readFileSync(join(root, 'fixtures/manifest.json'), 'utf8')).files
const sha = Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, v.sha256]))

const canaryHits = []
const canary = createServer((req, res) => { canaryHits.push(req.url); res.end('') })
await new Promise(r => canary.listen(47831, '127.0.0.1', r))

const dataDir = mkdtempSync(join(tmpdir(), 'readi-check-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function runPhase(phase) {
  const report = join(dataDir, `${phase}.json`)
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      READI_DATA_DIR: dataDir,
      READI_SELFTEST: report,
      READI_SELFTEST_PHASE: phase,
      READI_SELFTEST_FIXTURES: fixtures.join(':'),
      READI_SELFTEST_SHA: JSON.stringify(sha),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  const start = Date.now()
  while (!existsSync(report)) {
    if (child.exitCode !== null) throw new Error(`app exited early: ${stderr}`)
    if (Date.now() - start > Number(process.env.READI_PHASE_TIMEOUT ?? 600_000)) {
      child.kill("SIGKILL")
      const log = existsSync(`${report}.log`) ? readFileSync(`${report}.log`, "utf8").split("\n").slice(-14).join("\n") : "no log"
      throw new Error(`no report from ${phase}\n${log}`)
    }
    await sleep(200)
  }
  // SIGKILL: no close handler runs, so only already-acknowledged saves can survive.
  child.kill('SIGKILL')
  await new Promise(r => child.once('exit', r))
  return JSON.parse(readFileSync(report, 'utf8'))
}

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })

try {
  const first = await runPhase('first')
  const restore = await runPhase('restore')
  console.log(JSON.stringify({ first, restore, canaryHits }, null, 2))

  check('first phase completed', first.ok, first.error)
  check('restore phase completed', restore.ok, restore.error)
  if (first.ok && restore.ok) {
    check('all fixtures imported', first.imports.every(i => i.status !== 'failed'), first.imports)
    check('extraction finished while no reader was open', first.extraction.readerOpenDuringExtraction === false)
    check('every book indexed', first.extraction.books.every(b => b.index === 'ready' && b.metadata), first.extraction.books)
    check('EPUB metadata from OPF', first.extraction.books.some(b => b.title === 'The Cartographer Fixture' && b.authors[0] === 'Readi Project'))
    check('PDF metadata from info dictionary', first.extraction.books.some(b => b.title === 'Readi Text Fixture'))
    check('EPUB text searchable', first.search.typicalNeedle === 1, first.search)
    check('PDF outline extracted', first.toc.text.join() === 'Section 1@0,Section 2@10,Section 3@20,Section 4@30', first.toc.text)
    const ch = first.hostile.chapters
    check("every hostile chapter rendered", ch.length === 6 && ch.every(c => c.rendered), ch)
    check("hostile EPUB ran no script", ch.every(c => c.pwned === null), ch)
    check("Tauri IPC not exposed to book frames", ch.every(c => !c.tauriInFrame), ch)
    check("no remote image loaded", ch.every(c => c.remoteImagesLoaded === 0), ch)
    check('no book-triggered network request', canaryHits.length === 0, canaryHits)
    const lp = first.largePdf
    check('large PDF opened and read by ranges, not whole file', lp.readingBytes < lp.fileBytes * 0.1, lp)
    check('EPUB position restored after SIGKILL', restore.epub.restored?.cfi === first.epub.saved?.cfi, restore.epub)
    check('large PDF page restored after SIGKILL', restore.largePdf.restoredPage === 412, restore.largePdf)
    check('text PDF page restored after SIGKILL', restore.textPdf.restoredPage === 17, restore.textPdf)
  }
} finally {
  canary.close()
  rmSync(dataDir, { recursive: true, force: true })
}

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  ${JSON.stringify(c.detail)}`}`)
process.exit(checks.every(c => c.ok) && checks.length > 2 ? 0 : 1)
