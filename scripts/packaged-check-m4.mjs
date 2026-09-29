// M4 part of the packaged check: indexing, search, and annotations against a
// fresh data dir. Each phase ends with a SIGKILL; node reads the database
// between phases.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const FIXTURES = ['typical.epub', 'rtl.epub', 'text.pdf', 'image.pdf', 'large.pdf']
const KEYS = ['typical', 'rtl', 'text', 'image', 'large']
const APPROX_HIT = 'Opened the section; the exact match could not be located'
const APPROX_ANNOTATION = 'Opened the section or page; the exact passage could not be located'

/** Per book: job state and version, and its segments' count, versions, mappings, and id range. */
function indexRows(dir, sha) {
  const db = new DatabaseSync(join(dir, 'readi.sqlite'), { readOnly: true })
  try {
    return Object.fromEntries(KEYS.map((k, i) => {
      const { id } = db.prepare('SELECT id FROM books WHERE sha256 = ?').get(sha[FIXTURES[i]])
      const job = db.prepare('SELECT state, extractor_version AS version FROM extraction_jobs WHERE book_id = ?').get(id)
      const seg = db.prepare(`SELECT count(*) AS n, count(DISTINCT extractor_version) AS versions, min(extractor_version) AS version,
        count(*) FILTER (WHERE mapping IS NULL) AS unmapped, min(id) AS minId, max(id) AS maxId FROM text_segments WHERE book_id = ?`).get(id)
      const mappingOk = seg.n === 0 || (() => {
        const m = JSON.parse(db.prepare('SELECT mapping FROM text_segments WHERE book_id = ? AND mapping IS NOT NULL LIMIT 1').get(id)?.mapping ?? 'null')
        return m !== null && typeof m === 'object'
      })()
      return [k, { id, job: { ...job }, segments: { ...seg }, mappingOk }]
    }))
  } finally {
    db.close()
  }
}

function annotationRows(dir) {
  const db = new DatabaseSync(join(dir, 'readi.sqlite'), { readOnly: true })
  try {
    return db.prepare('SELECT id, book_id, kind, color, note, anchor_state FROM annotations ORDER BY id').all().map(r => ({ ...r }))
  } finally {
    db.close()
  }
}

/** Word tokens, so a phrase may span punctuation as FTS5 phrases do. */
const tokens = s => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')
const canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x)
const nonDecreasing = xs => xs.every((x, i) => i === 0 || xs[i - 1] <= x)
const noApprox = notices => !notices.some(n => n === APPROX_HIT || n === APPROX_ANNOTATION || /approximate/i.test(n))

export async function runM4({ root, runPhase, check, notVerified, measured }) {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'readi-m4-')))
  const dir = join(tmp, 'data')
  mkdirSync(dir)
  const fixtures = FIXTURES.map(f => join(root, 'fixtures', f))
  const sha = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(root, 'fixtures/manifest.json'), 'utf8')).files).map(([k, v]) => [k, v.sha256]))
  const phase = (name, prev = {}, opts = {}) => runPhase(name, { dir, m3: { fixtures, prev }, ...opts })
  const m4 = {}
  measured.m4 = m4

  try {
    const idx = await phase('m4-index')
    const killed = indexRows(dir, sha)
    console.log(JSON.stringify({ idx, killed }, null, 2))
    check('m4-index phase completed', idx.ok, idx.error)
    if (idx.ok) {
      const w = idx.whileIndexing
      check('large.pdf queued or indexing while searched', ['queued', 'indexing'].includes(w.largeState) && ['queued', 'indexing'].includes(w.largeStateAfter), w)
      check('⌘F opens in-book search and focuses the field', w.focused, w)
      check('in-book search on an indexing book: data-state=indexing', w.wordState === 'indexing', w)
      check('in-book no-match query on an indexing book says indexing, not no_matches', w.noMatchState === 'indexing', w)
      check('library search while indexing: status counts indexing books', w.libraryIndexing > 0 && /still indexing/.test(w.libraryStatus ?? ''), w)
      const t = idx.transitions
      m4.indexMs = Object.fromEntries(['typical', 'rtl', 'text', 'image'].map(k => [k, t[k]?.indexing !== undefined && (t[k].ready ?? t[k].no_searchable_text) !== undefined ? (t[k].ready ?? t[k].no_searchable_text) - t[k].indexing : null]))
      check('SIGKILL landed while large.pdf was indexing (DB state indexing)', killed.large.job.state === 'indexing', killed.large)
      m4.largeSegmentsAtKill = killed.large.segments.n
    }

    const srch = await phase('m4-search')
    const searched = indexRows(dir, sha)
    console.log(JSON.stringify({ srch, searched }, null, 2))
    check('m4-search phase completed', srch.ok, srch.error)
    if (srch.ok) {
      const st = srch.states
      check('after relaunch, interrupted large.pdf index resumes and completes', srch.resumedStateAtLaunch !== 'ready' && st.large === 'ready', { at: srch.resumedStateAtLaunch, st })
      m4.largeResumeMs = srch.resumeMs
      check('EPUBs and text.pdf index ready', st.typical === 'ready' && st.rtl === 'ready' && st.text === 'ready', st)
      check('image.pdf index is no_searchable_text', st.image === 'no_searchable_text', st)
      check('large.pdf (600 pages, one text line each) index is ready', st.large === 'ready', st)
      check('Library card badge shows no_searchable_text for image.pdf', srch.cardBadges.image === 'no_searchable_text', srch.cardBadges)
      check('in-book search on image.pdf: data-state=no_text', srch.imageNoText?.state === 'no_text', srch.imageNoText)
      check('no-match query after indexing: data-state=no_matches', srch.largeAfterIndexing?.noMatchState === 'no_matches', srch.largeAfterIndexing)

      const e = srch.epub ?? {}
      check('EPUB search completed', !e.error, e.error)
      if (!e.error) {
        check('EPUB ⌘F focuses the search field', e.focused, e)
        check('EPUB needle: one result in section 6', e.needle.count === 1 && e.needle.orders[0] === 6, e.needle)
        check('EPUB search is case-insensitive', e.upper.count === e.needle.count && e.upper.state === 'results', e.upper)
        check('EPUB results ordered by section (data-order non-decreasing)', nonDecreasing(e.words.orders) && nonDecreasing(e.phrase.orders) && e.words.groups.length > 1, { words: e.words.groups, phrase: e.phrase.orders.slice(0, 40) })
        check('EPUB quoted phrase matches only the phrase; words match separately', e.phrase.count > 0 && e.phrase.count < e.words.count && e.phrase.marks.every(m => tokens(m) === 'harbor morning') && e.phrase.matchTexts.every(m => tokens(m) === 'harbor morning') && e.words.marks.every(m => m === 'harbor'), { words: e.words, phrase: e.phrase })
        check('EPUB no-match query: data-state=no_matches', e.none.state === 'no_matches', e.none)
        check('EPUB result opens the exact range: section 6, text visible, hit outlined, no approximate notice', e.clicked.section === 6 && e.clicked.shown && e.clicked.outlined && noApprox(e.clicked.notices), e.clicked)
        check('EPUB hit with a corrupted range returns approximate and opens its section', e.corrupt.direct === 'approximate' && e.corrupt.directSection === 6, e.corrupt)
        check('EPUB corrupted hit through the jump shows the approximate notice', e.corrupt.viaJump.section === 6 && e.corrupt.viaJump.notices.includes(APPROX_HIT), e.corrupt)
      }

      const p = srch.pdf ?? {}
      check('PDF search completed', !p.error, p.error)
      if (!p.error) {
        check('PDF ⌘F focuses the search field', p.focused, p)
        check('PDF results ordered and grouped by page', nonDecreasing(p.word.orders) && p.word.groups.length > 1 && new Set(p.word.groups).size === p.word.groups.length, p.word)
        check('PDF search is case-insensitive', p.upper.count === p.word.count && p.word.count > 0, { word: p.word.count, upper: p.upper.count })
        check('PDF quoted phrase matches only the phrase', p.phrase.count > 0 && p.phrase.count < p.words.count && p.phrase.marks.every(m => tokens(m) === 'cartographer paper'), { words: p.words, phrase: p.phrase })
        check('PDF no-match query: data-state=no_matches', p.none.state === 'no_matches', p.none)
        check('PDF "page 25": one result on page index 24', p.page.count === 1 && p.page.targetOrder === 24, p.page)
        check('PDF result opens page 25 with the matching text-layer span in view and marked, no approximate notice',
          p.clicked.page === 24 && p.clicked.spanInViewport && p.clicked.markDrawn && p.clicked.markOverSpan > 0.5 && noApprox(p.clicked.notices), p.clicked)
        check('PDF hit with a corrupted range returns approximate and opens its page', p.corrupt.direct === 'approximate' && p.corrupt.directPage === 24, p.corrupt)
        check('PDF corrupted hit through the jump shows the approximate notice', p.corrupt.viaJump.page === 24 && p.corrupt.viaJump.notices.includes(APPROX_HIT), p.corrupt)
      }

      const l = srch.library ?? {}
      check('library search completed', !l.error, l.error)
      if (!l.error) {
        check('⌘⇧F opens library search and focuses the field', l.focused, l)
        check('library: metadata match (title word) first', l.groups[0]?.bookId === l.typicalId && l.groups[0].metadata && l.groups.slice(1).every(g => !g.metadata), l.groups)
        check('library: text hits grouped by book, one group per book', l.uniqueBooks && l.groups.filter(g => g.hits > 0).length > 1, l.groups)
        check('library: clicking a text hit in another book opens that book at the match',
          l.opened.bookId === srch.ids.text && l.opened.page === l.hitOrder && l.opened.spanInViewport && l.opened.markDrawn && noApprox(l.opened.notices), l.opened)
      }

      const f = srch.failRetry ?? {}
      check('fail/retry completed', !f.error, f.error)
      if (!f.error) {
        check('failed index: search panel shows failed with Retry', f.searchRetry.state === 'failed' && f.searchRetry.retryShown, f.searchRetry)
        check('search-retry returns the book to ready with results', f.searchRetry.ready && f.searchRetry.resultsShown, f.searchRetry)
        check('failed index: Library card badge and Book Info show failed with Retry', f.bookInfoRetry.badge && f.bookInfoRetry.infoState === 'failed' && f.bookInfoRetry.retryShown, f.bookInfoRetry)
        check('Book Info index-retry returns the book to ready', f.bookInfoRetry.ready && f.bookInfoRetry.infoAfter, f.bookInfoRetry)
      }

      const r = srch.reindex ?? {}
      check('reindex completed', !r.error, r.error)
      if (!r.error) {
        check('index-rebuild replaced the segments (new segment ids)', searched.typical.segments.minId > killed.typical.segments.maxId, { before: killed.typical.segments, after: searched.typical.segments, sawRebuild: r.sawRebuild })
        check('results identical after rebuild', r.resultsSame, r)
        check('progress untouched by rebuild', r.progressSame, r)
        check('annotations untouched by rebuild', r.annotationsSame, r)
        check('large.pdf reindex: old results served while rebuilding, identical after', r.large.same && r.large.hits === 1 && r.large.midGroups === 1, r.large)
        m4.largeFullIndexMs = r.large.ms
      }

      const lat = srch.latency ?? {}
      check('latency run completed', !lat.error, lat.error)
      if (!lat.error) {
        m4.searchLatency = { n: lat.n, p50: lat.p50, p95: lat.p95, max: lat.max, corpus: `the ${lat.books}-book fixture library (not the spec's 100-book corpus)` }
        check('search latency in the app (20 queries incl. IPC, fixture library): p95 < 500 ms', lat.n === 20 && lat.p95 < 500, m4.searchLatency)
        notVerified('search p95 on the spec\'s 100-book/10M-word corpus in the packaged app', 'the packaged check uses the fixture library; run `cd src-tauri && cargo test --release -- --ignored --nocapture search_perf` for the 10M-word corpus')
      }

      const rows = searched
      check('every segment of every book shares one extractor_version, and it is 2', KEYS.every(k => rows[k].segments.n === 0 || (rows[k].segments.versions === 1 && rows[k].segments.version === 2)), rows)
      check('extraction jobs record extractor_version 2', KEYS.every(k => rows[k].job.version === 2), rows)
      check('every stored segment has mapping JSON', KEYS.every(k => rows[k].segments.unmapped === 0 && rows[k].mappingOk), rows)
      check('image.pdf has no segments; the other books do', rows.image.segments.n === 0 && ['typical', 'rtl', 'text', 'large'].every(k => rows[k].segments.n > 0), rows)
    }

    const ann = await phase('m4-annotate')
    const annDb = annotationRows(dir)
    console.log(JSON.stringify({ ann, annDb }, null, 2))
    check('m4-annotate phase completed', ann.ok, ann.error)
    if (ann.ok) {
      const e = ann.epubHighlight ?? {}
      check('EPUB highlight completed', !e.error, e.error)
      if (!e.error) {
        check('EPUB selection shows the highlight popover', e.popover, e)
        check('EPUB green highlight stored with the selected quote', e.color === 'green' && e.kind === 'highlight' && e.anchorType === 'epub_range' && e.quote === e.selected, e)
        check('EPUB highlight overlay drawn', e.drawn, e)
        check('EPUB note saved through the editor and stored', e.note.saved && e.note.dbNote?.startsWith('green note'), e.note)
      }
      const p = ann.pdfHighlight ?? {}
      check('PDF highlight completed', !p.error, p.error)
      if (!p.error) {
        check('PDF text-layer selection shows the highlight popover', p.popover, p)
        check('PDF green highlight stored with the selected quote', p.color === 'green' && p.anchorType === 'pdf_quads' && p.quote === p.selected, p)
        check('PDF highlight drawn over the selection', p.drawn && p.drawnOverSelection > 0.8, p)
        check('PDF highlight still covers the selected text after zoom 2x', p.zoomedOverSelection > 0.8 && p.zoomGrowth > 1.2, p)
        check('PDF note saved through the editor and stored', p.note.saved && p.note.dbNote?.startsWith('pdf note'), p.note)
        check('highlight color edited to blue, stored and redrawn', p.blue && p.blueDrawn, p)
        check('highlight deleted from the editor: row and drawing gone', p.second.deleted && p.second.undrawn, p.second)
      }
      const b = ann.bookmarks ?? {}
      check('⌘D bookmark on image-only PDF', b.image?.kind === 'bookmark' && b.image.anchorType === 'position', b)
      check('⌘D bookmark in EPUB', b.typical?.kind === 'bookmark' && b.typical.anchorType === 'position', b)
      const u = ann.unresolved ?? {}
      check('unresolved anchors completed', !u.error, u.error)
      if (!u.error) {
        check('quote missing from its section: listed as unresolved', u.listed.orphan === 'unresolved' && u.dbStates.orphan === 'unresolved', u)
        check('bogus CFI with a unique quote recovers to resolved', u.listed.recovered === 'resolved' && u.dbStates.recovered === 'resolved', u)
        check('annotation filter finds the unresolved one by its note', u.filtered.length === 1 && u.filtered[0] === u.ids.orphan, u.filtered)
        check('opening the unresolved annotation goes to its section with the approximate notice', u.orphanOpen.section === 3 && u.orphanOpen.notices.includes(APPROX_ANNOTATION), u.orphanOpen)
        check('opening the recovered annotation shows its passage, drawn, no notice', u.recoveredOpen.section === 6 && u.recoveredOpen.visible && u.recoveredOpen.drawn && noApprox(u.recoveredOpen.notices), u.recoveredOpen)
      }
    }

    const prev = {
      snapshot: ann.snapshot,
      epubId: ann.epubHighlight?.id,
      pdfId: ann.pdfHighlight?.id,
      orphanId: ann.unresolved?.ids?.orphan,
      recoveredId: ann.unresolved?.ids?.recovered,
    }
    const rs = await phase('m4-restart', prev, { sampleMemory: true })
    console.log(JSON.stringify({ rs }, null, 2))
    check('m4-restart phase completed', rs.ok, rs.error)
    if (rs.ok) {
      check('annotations, notes, colors, bookmarks, and anchor states identical after SIGKILL', canonical(rs.snapshot) === canonical(prev.snapshot), { before: prev.snapshot, after: rs.snapshot })
      check('EPUB highlight redrawn after restart', rs.epubRedraw?.drawn, rs.epubRedraw)
      check('anchor states shown after restart (unresolved / resolved)', rs.epubRedraw?.listed?.orphan === 'unresolved' && rs.epubRedraw.listed.recovered === 'resolved', rs.epubRedraw)
      check('search works after restart', rs.epubRedraw?.search?.count === 1, rs.epubRedraw)
      check('PDF highlight redrawn after restart in blue', rs.pdfRedraw?.drawn && rs.pdfRedraw.color === 'blue', rs.pdfRedraw)
      const lg = rs.large ?? {}
      check('large.pdf search hit on page 598 opens that page with the span in view, no notice',
        lg.count === 1 && lg.order === 597 && lg.page === 597 && lg.spanInViewport && lg.markDrawn && noApprox(lg.notices), lg)
      m4.peakFootprintMb = rs.peakFootprintMb
      m4.peakFootprintByProcess = rs.peakFootprintByProcess
    }

    notVerified('real ⌘F / ⌘⇧F / ⌘D keystrokes and Edit menu items', 'driven by synthetic KeyboardEvent on window; agents have no Accessibility access')
    notVerified('real mouse text selection and clicks on highlights', 'selections are programmatic DOM ranges; highlight clicks dispatch readi:annotation-click')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
