// End-to-end check of the packaged app: import, extract, read, force-kill,
// relaunch, and confirm restored positions. Also serves a canary HTTP server
// that the hostile EPUB points at; any hit means book content reached the network.
// Usage: node scripts/packaged-check.mjs [path/to/Readi.app]
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runM3 } from './packaged-check-m3.mjs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const app = process.argv[2] ?? join(root, 'src-tauri/target/release/bundle/macos/Readi.app')
const binary = join(app, 'Contents/MacOS/readi')
const fixtures = ['typical.epub', 'hostile.epub', 'rtl.epub', 'text.pdf', 'large.pdf'].map(f => join(root, 'fixtures', f))
for (const f of [binary, ...fixtures]) if (!existsSync(f)) throw new Error(`missing ${f} (run pnpm tauri build and pnpm fixtures)`)
const manifest = JSON.parse(readFileSync(join(root, 'fixtures/manifest.json'), 'utf8')).files
const sha = Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, v.sha256]))

const canaryHits = []
const canary = createServer((req, res) => { canaryHits.push(req.url); res.end('') })
await new Promise(r => canary.listen(47831, '127.0.0.1', r))

const dataDir = mkdtempSync(join(tmpdir(), 'readi-check-'))
const sleep = ms => new Promise(r => setTimeout(r, ms))

const phaseTimeout = Number(process.env.READI_PHASE_TIMEOUT ?? 600_000)
const logTail = (report) => existsSync(`${report}.log`) ? readFileSync(`${report}.log`, 'utf8').split('\n').slice(-14).join('\n') : 'no log'
const webkitPids = () => new Set(spawnSync('pgrep', ['-f', 'com.apple.WebKit'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean))

/** `footprint` for the app and the WebKit processes started after `before`: total MB, MB per process, and the raw report. */
async function footprint(pid, before) {
  const pids = [String(pid), ...[...webkitPids()].filter(p => !before.has(p))]
  const out = await new Promise(r => execFile('footprint', pids.flatMap(p => ['-p', p]), { encoding: 'utf8' }, (_e, stdout) => r(stdout ?? '')))
  const unit = { KB: 1 / 1024, MB: 1, GB: 1024 }
  const byProcess = {}
  for (const m of out.matchAll(/^(\S[^\n]*?) \[(\d+)\]:.*Footprint: ([\d.]+) (KB|MB|GB)/gm)) byProcess[`${m[1]} ${m[2]}`] = Math.round(Number(m[3]) * unit[m[4]])
  return { mb: Object.values(byProcess).reduce((a, b) => a + b, 0), byProcess, raw: out }
}

/**
 * Runs one phase to its report, then SIGKILLs the app. `steps` handles the
 * self-test's `fs:<step>` log lines; a handler returning 'killed' ends the phase
 * without a report.
 */
async function runPhase(phase, { dir = dataDir, m3, steps = {}, sampleMemory = false } = {}) {
  const report = join(dir, `${phase}.json`)
  const before = webkitPids()
  const launchedAt = Date.now()
  const child = spawn(binary, [], {
    env: {
      ...process.env,
      READI_DATA_DIR: dir,
      READI_SELFTEST: report,
      READI_SELFTEST_PHASE: phase,
      READI_SELFTEST_FIXTURES: fixtures.join(':'),
      READI_SELFTEST_SHA: JSON.stringify(sha),
      ...(m3 ? { READI_SELFTEST_M3: JSON.stringify({ ...m3, launchedAt }) } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', d => (stderr += d))
  const start = Date.now()
  const handled = new Set()
  let peak = { mb: 0 }
  let sampling = false
  const sampler = sampleMemory && setInterval(async () => {
    if (sampling) return
    sampling = true
    const f = await footprint(child.pid, before).catch(() => ({ mb: 0 }))
    if (f.mb > peak.mb) peak = { ...f, at: Date.now() }
    sampling = false
  }, 500)
  try {
    while (!existsSync(report)) {
      if (child.exitCode !== null) throw new Error(`app exited early: ${stderr}`)
      if (Date.now() - start > phaseTimeout) {
        child.kill('SIGKILL')
        throw new Error(`no report from ${phase}\n${logTail(report)}`)
      }
      const log = existsSync(`${report}.log`) ? readFileSync(`${report}.log`, 'utf8') : ''
      for (const [, step] of log.matchAll(/ fs:(\S+)$/gm)) {
        if (handled.has(step)) continue
        handled.add(step)
        if (!steps[step]) throw new Error(`no handler for fs:${step}`)
        if ((await steps[step](child)) === 'killed') return { phase, killed: true, launchedAt }
      }
      await sleep(200)
    }
  } finally {
    if (sampler) clearInterval(sampler)
  }
  // SIGKILL: no close handler runs, so only already-acknowledged saves can survive.
  child.kill('SIGKILL')
  await new Promise(r => child.once('exit', r))
  const result = JSON.parse(readFileSync(report, 'utf8'))
  if (sampleMemory) {
    result.peakFootprintMb = Math.round(peak.mb)
    result.peakFootprintByProcess = peak.byProcess
    result.peakFootprintAt = peak.at
    if (peak.raw) writeFileSync(join(dir, `${phase}.footprint.txt`), peak.raw)
    if (process.env.READI_FOOTPRINT_OUT && peak.raw) writeFileSync(process.env.READI_FOOTPRINT_OUT, `peak at ${peak.at}\n${peak.raw}\n--- step log\n${readFileSync(`${report}.log`, 'utf8')}`)
  }
  return result
}

const checks = []
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail })
/** Something the run could not prove either way; printed, never a failure. */
const notVerified = (name, detail) => checks.push({ name, ok: true, notVerified: true, detail })
const measured = {}

try {
 // READI_ONLY_M3=1 skips the M2 phases while iterating on M3.
 if (!process.env.READI_ONLY_M3) {
  const first = await runPhase('first', { sampleMemory: true })
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

    const th = restore.theme
    check('default theme Sepia persisted across SIGKILL', th.defaults === 'sepia', th)
    check('Library html[data-theme] is sepia after relaunch', th.library === 'sepia', th)
    check('text PDF per-book Dark override applied after relaunch', th.textPdf === 'dark', th)
    check('EPUB section text color is the Sepia foreground', th.epubBodyColor === th.sepiaFg, th)
    check('Reset on text PDF returns html[data-theme] to sepia', th.textPdfAfterReset === 'sepia', th)
    check('Reset on text PDF clears its stored overrides', Object.keys(th.textPdfOverridesAfterReset ?? {}).length === 0, th)

    const el = restore.epubLayout
    check('EPUB layout restore: anchor taken', el.anchor.length > 0, el)
    for (const [k, label] of [
      ['horizontalToVertical', 'mode horizontal to vertical'],
      ['verticalToHorizontal', 'mode vertical to horizontal'],
      ['singleToDouble', 'spread single to double'],
      ['fontSerif', 'font family serif'],
      ['fontSizePlus2', 'font size +2 steps'],
      ['lineHeight', 'line height 1.9'],
    ]) check(`EPUB passage visible after ${label}`, el[k] === true, el)
    check('EPUB passage visible after window resize', el.windowResize.visible === true, el.windowResize)

    // Vertical mode compares the exact page point; horizontal shows whole pages, so the point is visible iff its page is shown.
    const pl = restore.pdfLayout
    check('PDF anchor is a mid-page point, not a page top', pl.anchorMidPage, pl)
    for (const [k, label] of [
      ['zoom2', 'zoom fit-width to 2x (point)'],
      ['zoomFitPage', 'zoom 2x to fit-page (point)'],
      ['zoomFitWidth', 'zoom fit-page to fit-width (point)'],
      ['verticalToHorizontal', 'mode vertical to horizontal (page)'],
      ['horizontalToVertical', 'mode horizontal to vertical (point)'],
    ]) check(`PDF anchor visible after ${label}`, pl[k]?.visible === true, pl)
    check('PDF anchor visible after window resize (point)', pl.windowResize.visible === true, pl.windowResize)

    const rt = restore.rtl
    check('RTL EPUB reports dir rtl', rt.dir === 'rtl', rt)
    for (const spread of ['single', 'double']) {
      const r = rt[spread]
      check(`RTL ${spread}: goLeft advances`, r.afterGoLeft > r.start, r)
      check(`RTL ${spread}: goRight goes back`, r.afterGoRight < r.afterGoLeft, r)
      check(`RTL ${spread}: ArrowLeft key advances`, r.afterArrowLeft > r.afterGoRight, r)
    }

    const ap = restore.approximate
    check('bogus CFI restores to its saved section, not section 0', ap.section === 3, ap)
    check('bogus CFI restore shows the approximate notice', ap.notices.includes('Restored an approximate position'), ap)
    check('EPUB vertical continuous scroll moved the view', restore.scrollSave.scrolledPx > 0, restore.scrollSave)
    check('EPUB vertical continuous scroll saved within 2 s', restore.scrollSave.firstSaveMs !== null && restore.scrollSave.firstSaveMs <= 2500, restore.scrollSave)
    const bk = restore.back
    check('Back: contents jump moved away', bk.jumpedAway, bk)
    check('Back: returns to the prior CFI', bk.cfiRestored, bk)
    check('Back: prior passage visible', bk.anchorVisible, bk)

    const wo = restore.warmOpen
    measured.warmOpen = { epub: { p95: wo.epub.p95, max: wo.epub.max }, pdf: { p95: wo.pdf.p95, max: wo.pdf.max } }
    measured.peakExtractionFootprintMb = first.peakFootprintMb
    measured.peakFootprintByProcess = first.peakFootprintByProcess
    check('warm open typical.epub x20: p95 < 1000 ms', wo.epub.p95 < 1000, wo.epub)
    check('warm open text.pdf x20: p95 < 1000 ms', wo.pdf.p95 < 1000, wo.pdf)
  }
 }
  await runM3({ root, app, runPhase, check, notVerified, measured, fixtures })
} finally {
  canary.close()
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(JSON.stringify({ measured }, null, 2))
for (const c of checks) console.log(`${c.notVerified ? 'NOT VERIFIED' : c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok && !c.notVerified ? '' : `  ${JSON.stringify(c.detail)}`}`)
process.exit(checks.every(c => c.ok) && checks.length > 2 ? 0 : 1)
