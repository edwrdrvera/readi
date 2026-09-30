import { api, type Annotation, type BookSummary, type HighlightColor, type SearchHit } from "./lib/api";
import { hitCount, searchStatus } from "./lib/annotations";
import { extraction } from "./lib/extraction";
import { showHit } from "./lib/jumps";
import { importPaths } from "./lib/importing";
import { useApp } from "./lib/store";
import { collapse } from "./reader/epubAnchors";
import { activeReader, type ReaderHandle } from "./reader/handle";
import { openAndWait, sleep, until } from "./selftestKit";

// M4 phases, run by scripts/packaged-check-m4.mjs against a fresh data dir.

interface M4Config {
  fixtures: string[];
  /** Values reported by earlier phases. */
  prev: Record<string, unknown>;
}

type Report = Record<string, unknown>;
type Ids = Record<"typical" | "rtl" | "text" | "image" | "large", number>;

const FIXTURE_KEYS: Array<[keyof Ids, string]> = [
  ["typical", "typical.epub"],
  ["rtl", "rtl.epub"],
  ["text", "text.pdf"],
  ["image", "image.pdf"],
  ["large", "large.pdf"],
];
const TERMINAL = new Set(["ready", "no_searchable_text", "failed"]);
const EPUB_HIT_OUTLINE = 'g[stroke="#f59e0b"]';
const EPUB_FILL: Record<HighlightColor, string> = { yellow: "#f5c400", green: "#2fb344", blue: "#3b82f6", pink: "#ec4899" };
const NOTE = "orphaned marginalia about the lighthouse";
const HIGHLIGHT_NOTE = "note written in the editor";

const q = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const tid = (id: string) => `[data-testid="${id}"]`;
const s = () => useApp.getState();

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const chord = (key: string, shift = false) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: shift ? key.toUpperCase() : key, metaKey: true, shiftKey: shift, bubbles: true }));

async function bookIds(sha: Record<string, string>): Promise<Ids> {
  const books = await api.listBooks();
  return Object.fromEntries(FIXTURE_KEYS.map(([k, f]) => [k, books.find((b) => b.sha256 === sha[f])!.id])) as Ids;
}

const indexState = async (id: number) => (await api.listBooks()).find((b) => b.id === id)?.index_state;

async function allIndexed(timeoutMs: number): Promise<BookSummary[]> {
  return until("every book indexed", async () => {
    const books = await api.listBooks();
    return books.every((b) => TERMINAL.has(b.index_state)) ? books : null;
  }, timeoutMs);
}

/** Notices shown since the phase started. */
function noticeLog() {
  const seen: string[] = [];
  useApp.subscribe((st, prev) => {
    const last = st.notices.at(-1);
    if (last !== undefined && st.notices !== prev.notices && (st.notices.length > prev.notices.length || last !== prev.notices.at(-1))) seen.push(last);
  });
  return {
    mark: () => seen.length,
    since: (at: number) => seen.slice(at),
  };
}
type Notices = ReturnType<typeof noticeLog>;

async function openBook(id: number) {
  await s().closeBook();
  await until("library", () => s().screen.name === "library", 10_000);
  return (await openAndWait(id)).reader;
}

/** ⌘F, then types the query and waits until the panel shows what the backend returns for it. */
async function findInBook(bookId: number, query: string) {
  chord("f");
  const input = await until("search input", () => q<HTMLInputElement>(tid("search-input")), 5000);
  const focused = await until("search input focused", () => document.activeElement === input, 3000).catch(() => false);
  const expected = await api.searchBook(bookId, query);
  const state = searchStatus(query, expected);
  const count = hitCount(expected);
  setValue(input, query);
  await until(`search panel for ${query}`, () => {
    const status = q(tid("search-status"));
    return status?.dataset.state === state && qa(tid("search-result")).length === count;
  }, 20_000);
  const results = qa(tid("search-result"));
  return {
    focused,
    state,
    expected,
    results,
    orders: results.map((r) => Number(r.dataset.order)),
    marks: results.map((r) => collapse(q("mark", r)?.textContent ?? "").toLowerCase()),
  };
}


type FoliateContents = { doc: Document | null; index: number; overlayer?: { element: SVGSVGElement } };
type FoliateView = HTMLElement & { renderer: { getContents(): FoliateContents[] }; lastLocation?: { range?: Range } };
const foliate = () => q<FoliateView>(".epub-host foliate-view");
const epubOverlays = (sel: string) => (foliate()?.renderer.getContents() ?? []).flatMap((c) => (c.overlayer ? qa(sel, c.overlayer.element) : []));
const epubVisibleText = () => collapse(foliate()?.lastLocation?.range?.toString() ?? "");
const epubSection = (r: ReaderHandle) => {
  const l = r.location();
  return l?.format === "epub" ? l.section_index : null;
};
const pdfPageIndex = (r: ReaderHandle) => {
  const l = r.location();
  return l?.format === "pdf" ? l.page_index : null;
};

const pdfPage = (i: number) => q(`.pdf-page[data-page="${i}"]`);
const textSpans = (i: number) => {
  const page = pdfPage(i);
  return page ? qa(".textLayer span", page).filter((el) => el.firstChild?.nodeType === Node.TEXT_NODE) : [];
};
function inViewport(el: Element) {
  const r = el.getBoundingClientRect();
  const v = q(".pdf-scroller")!.getBoundingClientRect();
  return r.width > 0 && r.bottom > v.top && r.top < v.bottom && r.right > v.left && r.left < v.right;
}
const spanWith = (i: number, text: string) => textSpans(i).find((el) => collapse(el.textContent ?? "").toLowerCase().includes(text.toLowerCase())) ?? null;

type Box = { left: number; top: number; right: number; bottom: number };
const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
const area = (b: Box) => Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
/** Share of `a` covered by `b`. */
function covered(a: Box, b: Box) {
  const i = { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
  return area(a) > 0 ? Math.round((area(i) / area(a)) * 100) / 100 : 0;
}
function unionBox(rects: DOMRect[]): Box {
  return rects.reduce<Box>(
    (u, r) => ({ left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

/** Up to `words` whole words from the start of a text node. */
function wordRange(node: Text, words: number) {
  const text = node.data;
  let end = 0;
  let seen = 0;
  const re = /\S+/g;
  for (let m = re.exec(text); m && seen < words; m = re.exec(text), seen++) end = m.index + m[0].length;
  const start = text.search(/\S/);
  const range = node.ownerDocument.createRange();
  range.setStart(node, Math.max(0, start));
  range.setEnd(node, end);
  return range;
}

function select(range: Range) {
  const sel = range.startContainer.ownerDocument!.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return collapse(range.toString());
}

/** First visible EPUB text node of a paragraph, with a few words selected. */
function epubVisibleRange(words: number) {
  const start = foliate()?.lastLocation?.range?.startContainer;
  const doc = start?.ownerDocument;
  if (!start || !doc) throw new Error("no visible EPUB range");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  walker.currentNode = start;
  for (let n: Node | null = start.nodeType === Node.TEXT_NODE ? start : walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.parentElement?.closest("p") && t.data.trim().split(/\s+/).length > words + 2) return wordRange(t, words);
  }
  throw new Error("no paragraph text in view");
}

async function openEditor(id: number) {
  window.dispatchEvent(new CustomEvent("readi:annotation-click", { detail: { id } }));
  return until(`editor for ${id}`, () => q(`${tid("annotation-editor")}[data-id="${id}"]`), 5000);
}

async function writeNote(bookId: number, id: number, note: string) {
  const editor = await openEditor(id);
  const field = q<HTMLTextAreaElement>(tid("note-editor"), editor)!;
  setValue(field, note);
  const saved = await until("note saved", () => q(tid("note-status"), editor)?.dataset.state === "saved", 10_000).catch(() => false);
  s().setEditing(null);
  const row = (await api.listAnnotations(bookId)).find((a) => a.id === id);
  return { saved, dbNote: row?.note ?? null };
}

const snapshot = (list: Annotation[]) =>
  list.map((a) => ({ id: a.id, kind: a.kind, color: a.color, note: a.note, quote: a.quote, anchor_state: a.anchor_state, anchor: a.anchor }));

async function runStep(results: Report, name: string, fn: () => Promise<Report>) {
  try {
    results[name] = await fn();
  } catch (e) {
    results[name] = { error: String(e) };
  }
}

async function index(m4: M4Config, sha: Record<string, string>): Promise<Report> {
  const report: Report = { phase: "m4-index" };
  const t0 = performance.now();
  const transitions: Record<number, Record<string, number>> = {};
  const poll = setInterval(async () => {
    for (const b of await api.listBooks()) {
      const t = (transitions[b.id] ??= {});
      t[b.index_state] ??= Math.round(performance.now() - t0);
    }
  }, 50);
  const jobs = await importPaths(m4.fixtures);
  report.imports = jobs.map((j) => ({ file: j.source_path.split("/").pop(), state: j.state, outcome: j.outcome }));
  const ids = await bookIds(sha);
  report.ids = ids;

  await runStep(report, "whileIndexing", async () => {
    await openBook(ids.large);
    const word = await findInBook(ids.large, "fixture");
    const noMatch = await findInBook(ids.large, "qqqzzqx");
    const largeState = await indexState(ids.large);
    await s().closeBook();
    chord("f", true);
    const input = await until("library search input", () => q<HTMLInputElement>(tid("library-search-input")), 5000);
    const expected = await api.searchLibrary("harbor");
    setValue(input, "harbor");
    const status = await until("library status", () => q(tid("library-search-status")), 10_000);
    const largeStateAfter = await indexState(ids.large);
    s().setSearch({ open: false, query: "" });
    return {
      focused: word.focused,
      wordState: word.state,
      noMatchState: noMatch.state,
      largeState,
      libraryStatus: status.textContent,
      libraryIndexing: expected.indexing,
      largeStateAfter,
    };
  });

  await until("large.pdf indexing", async () => (await indexState(ids.large)) === "indexing", 300_000);
  await sleep(2000);
  clearInterval(poll);
  report.transitions = Object.fromEntries(FIXTURE_KEYS.map(([k]) => [k, transitions[ids[k]]]));
  report.states = Object.fromEntries(await Promise.all(FIXTURE_KEYS.map(async ([k]) => [k, await indexState(ids[k])])));
  report.ok = true;
  return report;
}

async function epubSearch(ids: Ids, notices: Notices): Promise<Report> {
  const reader = await openBook(ids.typical);
  const startSection = epubSection(reader);
  const needle = await findInBook(ids.typical, "zephyrquill");
  const upper = await findInBook(ids.typical, "ZEPHYRQUILL");
  const words = await findInBook(ids.typical, "harbor morning");
  const phrase = await findInBook(ids.typical, '"harbor morning"');
  const none = await findInBook(ids.typical, "qqqzzqx");
  const again = await findInBook(ids.typical, "zephyrquill");
  const at = notices.mark();
  const target = again.expected.groups[0]?.hits[0];
  again.results[0].click();
  const shown = await until("hit visible", () => epubVisibleText().includes("zephyrquill"), 10_000).catch(() => false);
  const outlined = await until("hit outlined", () => epubOverlays(EPUB_HIT_OUTLINE).length > 0, 5000).catch(() => false);
  await sleep(300);
  const clicked = { section: epubSection(reader), shown, outlined, notices: notices.since(at) };

  const corrupt: SearchHit = { ...target, range: target.range && { start: [target.range.start[0], target.range.start[1] + 3], end: target.range.end } };
  await reader.goTo(0);
  await sleep(300);
  const direct = await reader.showHit(corrupt);
  const directSection = epubSection(reader);
  await reader.goTo(0);
  await sleep(300);
  const at2 = notices.mark();
  await showHit(ids.typical, corrupt);
  await sleep(300);
  return {
    startSection,
    focused: needle.focused,
    needle: { state: needle.state, count: needle.results.length, orders: needle.orders },
    upper: { state: upper.state, count: upper.results.length },
    words: { count: words.results.length, truncated: words.expected.truncated, orders: words.orders, groups: words.expected.groups.map((g) => g.order), marks: [...new Set(words.marks)] },
    phrase: { count: phrase.results.length, orders: phrase.orders, marks: [...new Set(phrase.marks)], matchTexts: [...new Set(phrase.expected.groups.flatMap((g) => g.hits.map((h) => collapse(h.match_text).toLowerCase())))] },
    none: { state: none.state },
    target: { order: target?.order, hasRange: !!target?.range },
    clicked,
    corrupt: { direct, directSection, viaJump: { section: epubSection(reader), notices: notices.since(at2) } },
  };
}

async function pdfSearch(ids: Ids, notices: Notices): Promise<Report> {
  const reader = await openBook(ids.text);
  const word = await findInBook(ids.text, "cartographer");
  const words = await findInBook(ids.text, "cartographer paper");
  const phrase = await findInBook(ids.text, '"cartographer paper"');
  const upper = await findInBook(ids.text, "CARTOGRAPHER");
  const none = await findInBook(ids.text, "qqqzzqx");
  const page = await findInBook(ids.text, '"page 25"');
  const target = page.expected.groups[0]?.hits[0];
  const at = notices.mark();
  page.results[0].click();
  const onPage = await until("page 25 shown", () => pdfPageIndex(reader) === 24, 10_000).catch(() => false);
  const span = await until("hit span", () => spanWith(24, "page 25"), 10_000).catch(() => null);
  const mark = await until("search mark", () => q("polygon.pdf-search-mark", pdfPage(24) ?? document), 3000).catch(() => null);
  const spanBox = span ? boxOf(span.getBoundingClientRect()) : null;
  const markBox = mark ? boxOf(mark.getBoundingClientRect()) : null;
  const clicked = {
    page: pdfPageIndex(reader),
    onPage,
    spanInViewport: span ? inViewport(span) : false,
    markDrawn: mark !== null,
    markOverSpan: spanBox && markBox ? covered(markBox, spanBox) : 0,
    notices: [] as string[],
  };
  await sleep(300);
  clicked.notices = notices.since(at);

  const corrupt: SearchHit = { ...target, range: target.range && { start: [target.range.start[0], target.range.start[1] + 2], end: target.range.end } };
  await reader.goTo(0);
  await reader.settled();
  const direct = await reader.showHit(corrupt);
  const directPage = pdfPageIndex(reader);
  await reader.goTo(0);
  await reader.settled();
  const at2 = notices.mark();
  await showHit(ids.text, corrupt);
  await sleep(300);
  return {
    focused: word.focused,
    word: { count: word.results.length, orders: word.orders, groups: word.expected.groups.map((g) => g.order) },
    words: { count: words.results.length, marks: [...new Set(words.marks)] },
    phrase: { count: phrase.results.length, orders: phrase.orders, marks: [...new Set(phrase.marks)] },
    upper: { count: upper.results.length },
    none: { state: none.state },
    page: { count: page.results.length, orders: page.orders, targetOrder: target?.order },
    clicked,
    corrupt: { direct, directPage, viaJump: { page: pdfPageIndex(reader), notices: notices.since(at2) } },
  };
}

async function librarySearch(ids: Ids, notices: Notices): Promise<Report> {
  await openBook(ids.typical);
  chord("f", true);
  const input = await until("library search input", () => q<HTMLInputElement>(tid("library-search-input")), 5000);
  const focused = await until("library input focused", () => document.activeElement === input, 3000).catch(() => false);
  const expected = await api.searchLibrary("cartographer");
  setValue(input, "cartographer");
  await until("library results", () => qa(tid("library-result")).length === expected.results.length && expected.results.length > 0, 10_000);
  const groups = qa(tid("library-result")).map((g) => ({
    bookId: Number(g.dataset.bookId),
    metadata: g.dataset.metadataMatch === "true",
    hits: qa(tid("library-hit"), g).length,
  }));
  const textGroup = q(`${tid("library-result")}[data-book-id="${ids.text}"]`);
  const hit = expected.results.find((r) => r.book.id === ids.text)?.hits[0];
  const at = notices.mark();
  q(tid("library-hit"), textGroup ?? document)?.click();
  const reader = await until("text.pdf reader", () => (activeReader()?.bookId === ids.text ? activeReader() : null), 15_000);
  await reader.ready;
  const onPage = await until("hit page", () => pdfPageIndex(reader) === hit?.order, 10_000).catch(() => false);
  const span = await until("hit span", () => (hit ? spanWith(hit.order, hit.match_text) : null), 10_000).catch(() => null);
  const mark = await until("search mark", () => (hit ? q("polygon.pdf-search-mark", pdfPage(hit.order) ?? document) : null), 3000).catch(() => null);
  await sleep(300);
  return {
    focused,
    groups,
    uniqueBooks: new Set(groups.map((g) => g.bookId)).size === groups.length,
    typicalId: ids.typical,
    hitOrder: hit?.order ?? null,
    opened: { bookId: reader.bookId, page: pdfPageIndex(reader), onPage, spanInViewport: span ? inViewport(span) : false, markDrawn: mark !== null, notices: notices.since(at) },
  };
}

async function failAndRetry(ids: Ids): Promise<Report> {
  const report: Report = {};
  await api.failExtraction(ids.text, "selftest: forced failure");
  await s().refreshBooks();
  await openBook(ids.text);
  const failed = await findInBook(ids.text, "cartographer");
  const retryButton = q(tid("search-retry"));
  retryButton?.click();
  const ready = await until("text.pdf ready after Retry", async () => (await indexState(ids.text)) === "ready", 60_000).catch(() => false);
  const after = await until("results after retry", () => q(tid("search-status"))?.dataset.state === "results", 10_000).catch(() => false);
  report.searchRetry = { state: failed.state, retryShown: retryButton !== null, ready, resultsShown: after };

  await s().closeBook();
  await api.failExtraction(ids.rtl, "selftest: forced failure");
  await s().refreshBooks();
  const badge = await until("failed badge", () => q(`[data-book-id="${ids.rtl}"] ${tid("index-state")}`)?.dataset.state === "failed", 5000).catch(() => false);
  s().showBookInfo(ids.rtl);
  const section = await until("Book Info index", () => q(tid("book-index")), 5000);
  const infoState = section.dataset.state;
  const retry = q(tid("index-retry"), section);
  retry?.click();
  const rtlReady = await until("rtl.epub ready after Retry", async () => (await indexState(ids.rtl)) === "ready", 60_000).catch(() => false);
  const infoAfter = await until("Book Info shows ready", () => q(tid("book-index"))?.dataset.state === "ready", 5000).catch(() => false);
  s().showBookInfo(null);
  report.bookInfoRetry = { badge, infoState, retryShown: retry !== null, ready: rtlReady, infoAfter };
  return report;
}

const QUERIES = ["zephyrquill", '"harbor morning"', "cartographer paper", "lantern", "qqqzzqx"];

async function reindex(ids: Ids): Promise<Report> {
  const probe = await api.createAnnotation({
    book_id: ids.typical,
    kind: "bookmark",
    anchor: { type: "position", locator: { format: "epub", v: 1, cfi: "epubcfi(/6/8!/4/2/1:0)", section_index: 3, section_fraction: 0 } },
    quote: "reindex probe",
    context: null,
    color: null,
    note: "reindex probe note",
    sort_key: 3,
  });
  await api.saveProgress(ids.typical, { format: "epub", v: 1, cfi: "epubcfi(/6/10!/4/2/1:0)", section_index: 4, section_fraction: 0.25 }, 0.4);
  const state = async (id: number) => ({
    results: JSON.stringify(await Promise.all(QUERIES.map((qq) => api.searchBook(id, qq)))),
    progress: JSON.stringify((await api.openBook(id)).progress?.locator ?? null),
    annotations: JSON.stringify(await api.listAnnotations(id)),
  });
  const before = await state(ids.typical);

  await s().closeBook();
  s().showBookInfo(ids.typical);
  const rebuild = await until("rebuild button", () => q(tid("index-rebuild")), 5000);
  let sawRebuild = false;
  const watch = setInterval(async () => ((await indexState(ids.typical)) !== "ready" ? (sawRebuild = true) : null), 5);
  rebuild.click();
  await sleep(1500);
  await until("typical ready after rebuild", async () => (await indexState(ids.typical)) === "ready", 60_000);
  clearInterval(watch);
  s().showBookInfo(null);
  const after = await state(ids.typical);

  const largeQuery = '"fixture page 598"';
  const largeBefore = JSON.stringify(await api.searchBook(ids.large, largeQuery));
  const t0 = performance.now();
  await api.reindexBook(ids.large);
  extraction.kick();
  const midState = await api.searchBook(ids.large, largeQuery);
  await until("large ready after reindex", async () => (await indexState(ids.large)) === "ready", 600_000);
  const largeMs = Math.round(performance.now() - t0);
  const largeAfter = JSON.stringify(await api.searchBook(ids.large, largeQuery));
  await api.deleteAnnotation(probe.id);
  return {
    sawRebuild,
    resultsSame: before.results === after.results,
    progressSame: before.progress === after.progress,
    annotationsSame: before.annotations === after.annotations,
    progress: after.progress,
    large: { ms: largeMs, midIndexState: midState.index_state, midGroups: midState.groups.length, same: largeBefore === largeAfter, hits: JSON.parse(largeAfter).groups.length },
  };
}

async function latency(ids: Ids): Promise<Report> {
  const library = ["cartographer", "harbor", '"silver lantern"', "zephyrquill", "keeper island", "qqqzzqx", "Readi", '"quiet harbor"', "north evening stone", "fixture page"];
  const book: Array<[number, string]> = [
    [ids.typical, "harbor"],
    [ids.typical, '"harbor morning"'],
    [ids.typical, "zephyrquill"],
    [ids.typical, "qqqzzqx"],
    [ids.text, "cartographer"],
    [ids.text, '"page 25"'],
    [ids.large, '"fixture page 598"'],
    [ids.large, "fixture"],
    [ids.rtl, "הנהר"],
    [ids.image, "harbor"],
  ];
  const ms: Array<{ query: string; ms: number }> = [];
  for (const query of library) {
    const t = performance.now();
    await api.searchLibrary(query);
    ms.push({ query: `library ${query}`, ms: Math.round((performance.now() - t) * 10) / 10 });
  }
  for (const [id, query] of book) {
    const t = performance.now();
    await api.searchBook(id, query);
    ms.push({ query: `book ${id} ${query}`, ms: Math.round((performance.now() - t) * 10) / 10 });
  }
  const sorted = ms.map((m) => m.ms).sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.ceil(sorted.length * p) - 1];
  return { n: ms.length, p50: pick(0.5), p95: pick(0.95), max: sorted[sorted.length - 1], books: (await api.listBooks()).length, samples: ms };
}

async function search(sha: Record<string, string>): Promise<Report> {
  const report: Report = { phase: "m4-search" };
  const notices = noticeLog();
  const t0 = performance.now();
  const ids = await bookIds(sha);
  report.ids = ids;
  report.resumedStateAtLaunch = await indexState(ids.large);
  const books = await allIndexed(600_000);
  report.resumeMs = Math.round(performance.now() - t0);
  report.states = Object.fromEntries(FIXTURE_KEYS.map(([k]) => [k, books.find((b) => b.id === ids[k])?.index_state]));
  await s().refreshBooks();
  report.cardBadges = Object.fromEntries(FIXTURE_KEYS.map(([k]) => [k, q(`[data-book-id="${ids[k]}"] ${tid("index-state")}`)?.dataset.state ?? null]));

  await runStep(report, "imageNoText", async () => {
    await openBook(ids.image);
    const r = await findInBook(ids.image, "harbor");
    return { state: r.state, text: q(tid("search-status"))?.textContent ?? null };
  });
  await runStep(report, "largeAfterIndexing", async () => {
    await openBook(ids.large);
    const r = await findInBook(ids.large, "qqqzzqx");
    return { noMatchState: r.state };
  });
  await runStep(report, "epub", () => epubSearch(ids, notices));
  await runStep(report, "pdf", () => pdfSearch(ids, notices));
  await runStep(report, "library", () => librarySearch(ids, notices));
  await runStep(report, "failRetry", () => failAndRetry(ids));
  await runStep(report, "reindex", () => reindex(ids));
  await runStep(report, "latency", () => latency(ids));
  await s().closeBook();
  report.ok = true;
  return report;
}

async function epubHighlight(ids: Ids): Promise<Report> {
  const reader = await openBook(ids.typical);
  await reader.goTo(1);
  await sleep(500);
  const range = epubVisibleRange(6);
  const selected = select(range);
  const popover = await until("highlight popover", () => q(tid("highlight-popover")), 5000).catch(() => null);
  const before = new Set((await api.listAnnotations(ids.typical)).map((a) => a.id));
  q(tid("highlight-color-green"))?.click();
  const created = await until("green highlight stored", async () => (await api.listAnnotations(ids.typical)).find((a) => !before.has(a.id)), 5000);
  const drawn = await until("green overlay", () => epubOverlays(`g[fill="${EPUB_FILL.green}"]`).length > 0, 5000).catch(() => false);
  const note = await writeNote(ids.typical, created.id, `green ${HIGHLIGHT_NOTE}`);
  return { popover: popover !== null, selected, id: created.id, color: created.color, quote: created.quote, kind: created.kind, anchorType: created.anchor.type, drawn, note };
}

async function pdfHighlight(ids: Ids): Promise<Report> {
  const reader = await openBook(ids.text);
  await reader.goTo(2);
  await reader.settled();
  const spans = await until("text layer on page 3", () => (textSpans(2).length > 5 ? textSpans(2) : null), 10_000);
  const k = spans.findIndex((el, i) => i > 0 && (el.textContent ?? "").trim().split(/\s+/).length > 6);
  const node = spans[k].firstChild as Text;
  const range = wordRange(node, 3);
  const selected = select(range);
  const selBox = unionBox([...range.getClientRects()]);
  const popover = await until("highlight popover", () => q(tid("highlight-popover")), 5000).catch(() => null);
  const before = new Set((await api.listAnnotations(ids.text)).map((a) => a.id));
  q(tid("highlight-color-green"))?.click();
  const created = await until("PDF highlight stored", async () => (await api.listAnnotations(ids.text)).find((a) => !before.has(a.id)), 5000);
  const poly = () => q<SVGPolygonElement>(`polygon.pdf-hl[data-id="${created.id}"]`);
  const drawn = await until("PDF highlight drawn", poly, 5000).catch(() => null);
  const drawnBox = drawn ? boxOf(drawn.getBoundingClientRect()) : null;
  const note = await writeNote(ids.text, created.id, `pdf ${HIGHLIGHT_NOTE}`);

  await s().setOverride("pdf_zoom", 2);
  await reader.settled();
  await sleep(300);
  const zoomedSpan = textSpans(2)[k]?.firstChild as Text | undefined;
  const zoomedRange = zoomedSpan ? wordRange(zoomedSpan, 3) : null;
  const zoomedSel = zoomedRange ? unionBox([...zoomedRange.getClientRects()]) : null;
  const zoomedPoly = poly();
  const zoomedBox = zoomedPoly ? boxOf(zoomedPoly.getBoundingClientRect()) : null;
  await s().resetOverrides();
  await reader.settled();

  await openEditor(created.id);
  q(tid("editor-color-blue"))?.click();
  const blue = await until("color blue stored", async () => (await api.listAnnotations(ids.text)).find((a) => a.id === created.id)?.color === "blue", 5000).catch(() => false);
  const blueDrawn = await until("blue drawn", () => poly()?.dataset.color === "blue", 5000).catch(() => false);
  s().setEditing(null);

  const spare = spans.findIndex((el, i) => i > k + 1 && (el.textContent ?? "").trim().split(/\s+/).length > 6);
  select(wordRange(textSpans(2)[spare].firstChild as Text, 2));
  await until("popover for the second highlight", () => q(tid("highlight-popover")), 5000);
  q(tid("highlight-add-note"))?.click();
  const second = await until("second highlight editor", () => q(tid("annotation-editor")), 5000);
  const secondId = Number(second.dataset.id);
  q<HTMLButtonElement>('button[aria-label="Delete highlight"]', second)?.click();
  const undoShown = await until("undo bar for the deletion", () => q(`${tid("undo-bar")}[data-kind="delete-annotation"]`), 3000).catch(() => null);
  await s().flushPending();
  const deleted = await until("second highlight deleted", async () => !(await api.listAnnotations(ids.text)).some((a) => a.id === secondId), 5000).catch(() => false);
  const undrawn = await until("second highlight undrawn", () => !q(`polygon.pdf-hl[data-id="${secondId}"]`), 5000).catch(() => false);
  return {
    popover: popover !== null,
    selected,
    id: created.id,
    color: created.color,
    quote: created.quote,
    anchorType: created.anchor.type,
    drawn: drawn !== null,
    drawnOverSelection: drawnBox ? covered(drawnBox, selBox) : 0,
    zoomedOverSelection: zoomedBox && zoomedSel ? covered(zoomedBox, zoomedSel) : 0,
    zoomGrowth: drawnBox && zoomedBox ? Math.round(((zoomedBox.right - zoomedBox.left) / (drawnBox.right - drawnBox.left)) * 100) / 100 : null,
    note,
    blue,
    blueDrawn,
    second: { id: secondId, deleted, undrawn, undoShown: undoShown !== null },
  };
}

async function bookmarks(ids: Ids): Promise<Report> {
  const out: Report = {};
  for (const key of ["image", "typical"] as const) {
    const reader = await openBook(ids[key]);
    await reader.goTo(1);
    await sleep(500);
    const before = new Set((await api.listAnnotations(ids[key])).map((a) => a.id));
    chord("d");
    const row = await until(`${key} bookmark`, async () => (await api.listAnnotations(ids[key])).find((a) => !before.has(a.id)), 5000).catch(() => null);
    out[key] = row ? { id: row.id, kind: row.kind, anchorType: row.anchor.type, quote: row.quote } : null;
  }
  return out;
}

async function unresolved(ids: Ids, notices: Notices): Promise<Report> {
  const reader = await openBook(ids.typical);
  await reader.goTo(3);
  await sleep(500);
  const loc = reader.location();
  if (loc?.format !== "epub") throw new Error("no EPUB location");
  const base = { book_id: ids.typical, kind: "highlight" as const, color: "pink" as const, sort_key: 3 };
  const orphan = await api.createAnnotation({
    ...base,
    anchor: { type: "epub_range", v: 1, cfi: loc.cfi, section_index: loc.section_index },
    quote: "The needle word is zephyrquill.",
    context: null,
    note: NOTE,
  });
  const recovered = await api.createAnnotation({
    ...base,
    sort_key: 6,
    anchor: { type: "epub_range", v: 1, cfi: "epubcfi(/6/999!/4/2/1:0)", section_index: 6 },
    quote: "The needle word is zephyrquill.",
    context: null,
    note: null,
  });
  await s().loadAnnotations(ids.typical);
  s().setSidebar({ open: true, tab: "annotations" });
  const item = (id: number) => q(`${tid("annotation-item")}[data-id="${id}"]`);
  const states = await until("anchor states in the list", () => {
    const a = item(orphan.id)?.dataset.anchorState;
    const b = item(recovered.id)?.dataset.anchorState;
    return a && a !== "unknown" && b && b !== "unknown" ? { orphan: a, recovered: b } : null;
  }, 10_000).catch(() => ({ orphan: item(orphan.id)?.dataset.anchorState, recovered: item(recovered.id)?.dataset.anchorState }));
  const drawnRecovered = s().annotations.find((a) => a.id === recovered.id)?.anchor_state;
  const filter = q<HTMLInputElement>(tid("annotation-filter"))!;
  setValue(filter, "lighthouse marginalia");
  await sleep(200);
  const filtered = qa(tid("annotation-item")).map((el) => Number(el.dataset.id));
  setValue(filter, "");
  await sleep(100);

  await reader.goTo(0);
  await sleep(300);
  const at = notices.mark();
  q<HTMLButtonElement>("button", item(orphan.id)!)?.click();
  await sleep(1500);
  const orphanOpen = { section: epubSection(reader), notices: notices.since(at) };

  await reader.goTo(0);
  await sleep(300);
  const at2 = notices.mark();
  q<HTMLButtonElement>("button", item(recovered.id)!)?.click();
  const recoveredVisible = await until("recovered passage visible", () => epubVisibleText().includes("zephyrquill"), 5000).catch(() => false);
  await sleep(500);
  const recoveredOpen = { section: epubSection(reader), visible: recoveredVisible, drawn: epubOverlays(`g[fill="${EPUB_FILL.pink}"]`).length > 0, notices: notices.since(at2) };
  s().setSidebar({ open: false });

  const db = await api.listAnnotations(ids.typical);
  return {
    ids: { orphan: orphan.id, recovered: recovered.id },
    listed: states,
    storeRecovered: drawnRecovered,
    dbStates: { orphan: db.find((a) => a.id === orphan.id)?.anchor_state, recovered: db.find((a) => a.id === recovered.id)?.anchor_state },
    filtered,
    orphanOpen,
    recoveredOpen,
  };
}

async function annotate(sha: Record<string, string>): Promise<Report> {
  const report: Report = { phase: "m4-annotate" };
  const notices = noticeLog();
  const ids = await bookIds(sha);
  report.ids = ids;
  await runStep(report, "epubHighlight", () => epubHighlight(ids));
  await runStep(report, "pdfHighlight", () => pdfHighlight(ids));
  await runStep(report, "bookmarks", () => bookmarks(ids));
  await runStep(report, "unresolved", () => unresolved(ids, notices));
  await s().closeBook();
  report.snapshot = Object.fromEntries(await Promise.all(FIXTURE_KEYS.map(async ([k]) => [k, snapshot(await api.listAnnotations(ids[k]))])));
  report.ok = true;
  return report;
}

async function restart(m4: M4Config, sha: Record<string, string>): Promise<Report> {
  const report: Report = { phase: "m4-restart" };
  const notices = noticeLog();
  const ids = await bookIds(sha);
  const prev = m4.prev as { epubId: number; pdfId: number; orphanId: number; recoveredId: number };
  report.snapshot = Object.fromEntries(await Promise.all(FIXTURE_KEYS.map(async ([k]) => [k, snapshot(await api.listAnnotations(ids[k]))])));

  await runStep(report, "epubRedraw", async () => {
    const reader = await openBook(ids.typical);
    const green = (await api.listAnnotations(ids.typical)).find((a) => a.id === prev.epubId)!;
    await reader.showAnnotation(green);
    const drawn = await until("green overlay after restart", () => epubOverlays(`g[fill="${EPUB_FILL.green}"]`).length > 0, 10_000).catch(() => false);
    s().setSidebar({ open: true, tab: "annotations" });
    const listed = await until("annotation states", () => {
      const st = (id: number) => q(`${tid("annotation-item")}[data-id="${id}"]`)?.dataset.anchorState;
      const a = st(prev.orphanId);
      const b = st(prev.recoveredId);
      return a && a !== "unknown" && b && b !== "unknown" ? { orphan: a, recovered: b } : null;
    }, 10_000).catch(() => null);
    s().setSidebar({ open: false });
    const r = await findInBook(ids.typical, "zephyrquill");
    return { drawn, listed, search: { state: r.state, count: r.results.length } };
  });
  await runStep(report, "pdfRedraw", async () => {
    const reader = await openBook(ids.text);
    const hl = (await api.listAnnotations(ids.text)).find((a) => a.id === prev.pdfId)!;
    await reader.showAnnotation(hl);
    const drawn = await until("PDF highlight after restart", () => q(`polygon.pdf-hl[data-id="${prev.pdfId}"]`), 10_000).catch(() => null);
    return { drawn: drawn !== null, color: drawn?.dataset.color ?? null };
  });
  await runStep(report, "large", async () => {
    const reader = await openBook(ids.large);
    const r = await findInBook(ids.large, '"fixture page 598"');
    const hit = r.expected.groups[0]?.hits[0];
    const at = notices.mark();
    r.results[0]?.click();
    const onPage = await until("far page shown", () => pdfPageIndex(reader) === 597, 20_000).catch(() => false);
    const span = await until("far hit span", () => spanWith(597, "page 598"), 20_000).catch(() => null);
    const mark = await until("far search mark", () => q("polygon.pdf-search-mark", pdfPage(597) ?? document), 3000).catch(() => null);
    await sleep(300);
    return { count: r.results.length, order: hit?.order ?? null, onPage, page: pdfPageIndex(reader), spanInViewport: span ? inViewport(span) : false, markDrawn: mark !== null, notices: notices.since(at) };
  });
  await s().closeBook();
  report.ok = true;
  return report;
}

export function runM4Phase(phase: string, config: unknown, sha: Record<string, string>): Promise<Report> {
  const m4 = config as M4Config;
  switch (phase) {
    case "m4-index":
      return index(m4, sha);
    case "m4-search":
      return search(sha);
    case "m4-annotate":
      return annotate(sha);
    case "m4-restart":
      return restart(m4, sha);
    default:
      throw new Error(`unknown phase ${phase}`);
  }
}
