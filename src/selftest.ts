import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { api, type BookSummary } from "./lib/api";
import { useApp } from "./lib/store";
import { importPaths } from "./lib/importing";
import { activeReader, type ReaderHandle } from "./reader/handle";
import { goBack } from "./lib/commands";
import { THEME_COLORS, type PrefKey, type Prefs } from "./lib/prefs";
import type { Locator } from "./lib/api";
import { openAndWait, sleep, until } from "./selftestKit";
import { runM3Phase } from "./selftestM3";
import { runM4Phase } from "./selftestM4";

// Drives the packaged app when READI_SELFTEST is set. scripts/packaged-check.mjs
// runs the "first" phase, force-kills the app, then runs "restore".

function lagMonitor() {
  let max = 0;
  let last = performance.now();
  const t = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 50);
    last = now;
  }, 50);
  return () => (clearInterval(t), Math.round(max));
}

const byName = (books: BookSummary[], sha: Record<string, string>, name: string) =>
  books.find((b) => b.sha256 === sha[name])!;

async function pdfRendered(page: number) {
  await until(`page ${page} rendered`, () => document.querySelector(`.pdf-host canvas[data-rendered-page="${page}"]`));
}

async function first(fixtures: string[], sha: Record<string, string>) {
  const report: Record<string, unknown> = { phase: "first" };
  const importStart = performance.now();
  const jobs = await importPaths(fixtures);
  report.importMs = Math.round(performance.now() - importStart);
  report.imports = jobs.map((j) =>
    j.state === "done" ? { path: j.source_path, id: j.book_id } : { path: j.source_path, status: "failed", reason: j.error ?? j.state },
  );

  const stopLag = lagMonitor();
  const extractStart = performance.now();
  const books = await until(
    "extraction with the reader closed",
    async () => {
      const list = await api.listBooks();
      return list.every((b) => b.index_state !== "queued" && b.index_state !== "indexing") ? list : null;
    },
    300_000,
  );
  report.extraction = {
    readerOpenDuringExtraction: activeReader() !== null,
    ms: Math.round(performance.now() - extractStart),
    maxEventLoopLagMs: stopLag(),
    books: books.map((b) => ({ title: b.title, authors: b.authors, index: b.index_state, metadata: b.metadata_ready })),
  };

  const typical = byName(books, sha, "typical.epub");
  const large = byName(books, sha, "large.pdf");
  const text = byName(books, sha, "text.pdf");
  const hostile = byName(books, sha, "hostile.epub");
  report.search = {
    typicalNeedle: await api.countTextMatches(typical.id, "zephyrquill"),
    textPdfWord: await api.countTextMatches(text.id, "cartographer"),
  };
  report.toc = {
    typical: (await api.openBook(typical.id)).toc.length,
    text: (await api.openBook(text.id)).toc.map((t) => `${t.label}@${t.target}`),
  };

  {
    const { reader, openMs } = await openAndWait(typical.id);
    await reader.goTo(5);
    for (let i = 0; i < 3; i++) {
      await reader.next();
      await sleep(150);
    }
    await sleep(300);
    await reader.flush();
    report.epub = { openMs, saved: reader.location() };
  }

  {
    const { reader } = await openAndWait(hostile.id);
    const chapters = [];
    for (let i = 0; i < 6; i++) {
      await reader.goTo(i);
      await sleep(800);
      const docs = reader.documents?.() ?? [];
      chapters.push({
        index: i,
        rendered: docs.some((d) => (d.body?.textContent ?? "").length > 50),
        pwned: document.body.dataset.pwned ?? null,
        scripts: docs.reduce((n, d) => n + d.scripts.length, 0),
        tauriInFrame: docs.some((d) => "__TAURI_INTERNALS__" in (d.defaultView ?? {})),
        remoteImagesLoaded: docs.flatMap((d) => Array.from(d.images)).filter((im) => /^https?:/.test(im.src) && im.naturalWidth > 0).length,
      });
    }
    report.hostile = { chapters };
  }

  {
    const before = await api.transportStats(large.id);
    const { reader, openMs } = await openAndWait(large.id);
    await reader.goTo(412);
    await pdfRendered(412);
    await reader.flush();
    const after = await api.transportStats(large.id);
    report.largePdf = {
      openMs,
      fileBytes: large.file_size,
      extractionBytes: before.bytes,
      readingBytes: after.bytes - before.bytes,
      readingRequests: after.requests - before.requests,
      saved: reader.location(),
    };
  }

  {
    const { reader } = await openAndWait(text.id);
    await reader.goTo(17);
    await pdfRendered(17);
    await reader.flush();
    report.textPdf = { saved: reader.location() };
    await useApp.getState().setOverride("theme", "dark");
  }
  await useApp.getState().setDefault("theme", "sepia");

  await activeReader()?.flush();
  await useApp.getState().closeBook();
  report.ok = true;
  return report;
}

async function restore(sha: Record<string, string>) {
  const report: Record<string, unknown> = { phase: "restore" };
  const books = await api.listBooks();
  const typical = byName(books, sha, "typical.epub");
  const large = byName(books, sha, "large.pdf");
  const text = byName(books, sha, "text.pdf");
  const rtl = byName(books, sha, "rtl.epub");
  const theme: Record<string, unknown> = {};
  report.theme = theme;
  theme.defaults = (await api.getPrefs()).defaults.theme;
  theme.library = await until("library theme", () => (document.documentElement.dataset.theme === "sepia" ? "sepia" : null), 10_000).catch(
    () => document.documentElement.dataset.theme,
  );

  {
    const detail = await api.openBook(typical.id);
    const { reader, openMs } = await openAndWait(typical.id);
    await sleep(300);
    report.epub = { openMs, stored: detail.progress?.locator, restored: reader.location() };
    const body = reader.documents?.()[0]?.body;
    theme.epubBodyColor = body ? getComputedStyle(body).color : null;
    theme.sepiaFg = hexToRgb(THEME_COLORS.sepia.fg);
  }
  for (const [key, book] of [["largePdf", large], ["textPdf", text]] as const) {
    const detail = await api.openBook(book.id);
    const stored = detail.progress?.locator;
    const { reader, openMs } = await openAndWait(book.id);
    const page = stored?.format === "pdf" ? stored.page_index : 0;
    await pdfRendered(page);
    const restored = reader.location();
    report[key] = { openMs, stored, restoredPage: restored?.format === "pdf" ? restored.page_index : null };
    if (book === text) {
      theme.textPdf = document.documentElement.dataset.theme;
      await useApp.getState().resetOverrides();
      await sleep(100);
      theme.textPdfAfterReset = document.documentElement.dataset.theme;
      theme.textPdfOverridesAfterReset = (await api.getPrefs(text.id)).overrides;
    }
  }
  report.readingStates = (await api.listBooks()).map((b) => `${b.title}: ${b.reading_state}`);
  await useApp.getState().closeBook();
  report.epubLayout = await epubLayoutRestore(typical.id);
  report.pdfLayout = await pdfLayoutRestore(text.id);
  report.rtl = await rtlOrder(rtl.id);
  report.approximate = await approximateRestore(typical.id);
  report.scrollSave = await verticalScrollSave(typical.id);
  report.back = await backHistoryCheck(typical.id);
  await useApp.getState().closeBook();
  report.warmOpen = { epub: await warmOpens(typical.id), pdf: await warmOpens(text.id) };
  report.ok = true;
  return report;
}

/** Opens a book 20 times from the Library; p95 and max of open-to-ready. */
async function warmOpens(id: number) {
  const ms: number[] = [];
  for (let i = 0; i < 20; i++) {
    ms.push((await openAndWait(id)).openMs);
    await useApp.getState().closeBook();
    await until("library", () => useApp.getState().screen.name === "library");
  }
  const sorted = [...ms].sort((a, b) => a - b);
  return { ms, p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted[sorted.length - 1] };
}

function hexToRgb(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

async function applyPref<K extends PrefKey>(reader: ReaderHandle, key: K, value: Prefs[K] | null) {
  await useApp.getState().setOverride(key, value);
  await reader.settled();
}

async function resizedVisible(reader: ReaderHandle, anchor: string) {
  const win = getCurrentWindow();
  const original = await win.innerSize();
  const logical = original.toLogical(await win.scaleFactor());
  await win.setSize(new LogicalSize(Math.round(logical.width * 0.75), Math.round(logical.height * 0.8)));
  await sleep(300);
  await reader.settled();
  const resized = await win.innerSize();
  const visible = reader.isVisible(anchor);
  await win.setSize(original);
  await sleep(300);
  await reader.settled();
  return { visible, from: `${original.width}x${original.height}`, to: `${resized.width}x${resized.height}` };
}

async function epubLayoutRestore(id: number) {
  const { reader } = await openAndWait(id);
  await applyPref(reader, "reading_mode", "horizontal");
  await reader.goTo(4);
  await reader.next();
  await reader.next();
  await reader.settled();
  const anchor = reader.anchor();
  const steps: Array<[string, () => Promise<void>]> = [
    ["horizontalToVertical", () => applyPref(reader, "reading_mode", "vertical")],
    ["verticalToHorizontal", () => applyPref(reader, "reading_mode", "horizontal")],
    ["singleToDouble", () => applyPref(reader, "spread", "double")],
    ["fontSerif", () => applyPref(reader, "font_family", "serif")],
    ["fontSizePlus2", async () => {
      await applyPref(reader, "font_size", 20);
      await applyPref(reader, "font_size", 22);
    }],
    ["lineHeight", () => applyPref(reader, "line_height", 1.9)],
  ];
  const results: Record<string, unknown> = { anchor };
  for (const [name, run] of steps) {
    await run();
    results[name] = reader.isVisible(anchor);
  }
  results.windowResize = await resizedVisible(reader, anchor);
  await useApp.getState().resetOverrides();
  await reader.settled();
  await useApp.getState().closeBook();
  return results;
}

function pdfProbe(reader: ReaderHandle) {
  const sc = document.querySelector<HTMLElement>(".pdf-scroller");
  return {
    at: reader.anchor(),
    vis: document.visibilityState,
    scroll: sc ? `${Math.round(sc.scrollTop)}/${sc.scrollHeight}/${sc.clientWidth}x${sc.clientHeight}` : null,
    mode: document.querySelector<HTMLElement>(".pdf-host")?.dataset.mode,
  };
}

async function pdfLayoutRestore(id: number) {
  const { reader } = await openAndWait(id);
  await applyPref(reader, "reading_mode", "vertical");
  await applyPref(reader, "pdf_zoom", "fit-width");
  await reader.goTo(5);
  const pageTop = reader.anchor();
  const afterGoTo = pdfProbe(reader);
  for (let i = 0; i < 3; i++) reader.scrollBy(1);
  await sleep(300);
  await reader.settled();
  const anchor = reader.anchor();
  const results: Record<string, unknown> = { anchor, afterGoTo, afterScroll: pdfProbe(reader), anchorMidPage: anchor.startsWith("p5@") && anchor !== pageTop };
  const steps: Array<[string, () => Promise<void>]> = [
    ["zoom2", () => applyPref(reader, "pdf_zoom", 2)],
    ["zoomFitPage", () => applyPref(reader, "pdf_zoom", "fit-page")],
    ["zoomFitWidth", () => applyPref(reader, "pdf_zoom", "fit-width")],
    ["verticalToHorizontal", () => applyPref(reader, "reading_mode", "horizontal")],
    ["horizontalToVertical", () => applyPref(reader, "reading_mode", "vertical")],
  ];
  for (const [name, run] of steps) {
    await run();
    results[name] = { visible: reader.isVisible(anchor), ...pdfProbe(reader) };
  }
  results.windowResize = await resizedVisible(reader, anchor);
  await useApp.getState().resetOverrides();
  await reader.settled();
  await useApp.getState().closeBook();
  return results;
}

const order = (l: Locator | null) => (l?.format === "epub" ? l.section_index + Math.min(l.section_fraction, 0.999) : -1);

async function moved(reader: ReaderHandle, from: Locator | null, act: () => unknown) {
  const before = JSON.stringify(from);
  await act();
  await until("relocate", () => JSON.stringify(reader.location()) !== before, 5000).catch(() => null);
  await sleep(200);
  return reader.location();
}

async function rtlOrder(id: number) {
  const { reader } = await openAndWait(id);
  const results: Record<string, unknown> = { dir: reader.dir() };
  for (const spread of ["single", "double"] as const) {
    await applyPref(reader, "spread", spread);
    await reader.goTo(1);
    await sleep(300);
    const start = reader.location();
    const left = await moved(reader, start, () => reader.goLeft());
    const right = await moved(reader, left, () => reader.goRight());
    const key = await moved(reader, right, () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" })));
    results[spread] = {
      start: order(start),
      afterGoLeft: order(left),
      afterGoRight: order(right),
      afterArrowLeft: order(key),
    };
  }
  await useApp.getState().resetOverrides();
  await useApp.getState().closeBook();
  return results;
}

async function approximateRestore(id: number) {
  const bogus: Locator = { format: "epub", v: 1, cfi: "epubcfi(/6/999!/4/2/1:0)", section_index: 3, section_fraction: 0.4 };
  await api.saveProgress(id, bogus, 0.5);
  const { reader } = await openAndWait(id);
  await sleep(300);
  const loc = reader.location();
  const notices = useApp.getState().notices;
  await useApp.getState().closeBook();
  return { section: loc?.format === "epub" ? loc.section_index : null, notices };
}

async function verticalScrollSave(id: number) {
  const { reader } = await openAndWait(id);
  await applyPref(reader, "reading_mode", "vertical");
  await reader.goTo(2);
  await reader.settled();
  await reader.flush();
  await sleep(1000);
  const initial = JSON.stringify((await api.openBook(id)).progress?.locator);
  const start = performance.now();
  let firstSaveMs: number | null = null;
  let scroller = reader.documents?.()[0]?.defaultView?.frameElement?.parentElement ?? null;
  while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1) scroller = scroller.parentElement;
  const scrollStart = scroller?.scrollTop ?? null;
  const scroll = setInterval(() => scroller && (scroller.scrollTop += 10), 50);
  while (performance.now() - start < 3000) {
    await sleep(100);
    if (firstSaveMs === null && JSON.stringify((await api.openBook(id)).progress?.locator) !== initial) {
      firstSaveMs = Math.round(performance.now() - start);
    }
  }
  clearInterval(scroll);
  const endLoc = reader.location();
  const scrolledPx = scroller && scrollStart !== null ? scroller.scrollTop - scrollStart : null;
  await useApp.getState().resetOverrides();
  await useApp.getState().closeBook();
  return { firstSaveMs, scrolledPx, vis: document.visibilityState, endLoc };
}

async function backHistoryCheck(id: number) {
  const { reader } = await openAndWait(id);
  await reader.goTo(1);
  await reader.next();
  await sleep(300);
  const before = reader.location();
  const anchor = reader.anchor();
  const toc = (await api.openBook(id)).toc;
  await reader.goTo(toc[toc.length - 1].target);
  await sleep(300);
  const jumped = reader.location();
  await goBack();
  await sleep(300);
  const after = reader.location();
  const anchorVisible = reader.isVisible(anchor);
  await useApp.getState().closeBook();
  return {
    jumpedAway: JSON.stringify(jumped) !== JSON.stringify(before),
    cfiRestored: before?.format === "epub" && after?.format === "epub" && after.cfi === before.cfi,
    anchorVisible,
    before,
    after,
  };
}

export async function runSelfTestIfEnabled() {
  const config = await api.selftestConfig().catch(() => null);
  if (!config) return;
  // Fixture hashes let the check find books without trusting extracted titles.
  const { fixtures, sha256: sha } = config;
  // WebKit pauses requestAnimationFrame, which PDF.js rendering waits on, while
  // the window is occluded; a spawned test process starts behind other windows.
  await getCurrentWindow().setFocus();
  // setFocus does not help when the window opens on another Space, so frames
  // are driven by timers whenever WebKit reports the page hidden.
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    document.visibilityState === "hidden" ? (setTimeout(() => cb(performance.now()), 16) as unknown as number) : raf(cb);
  addEventListener("error", (e) => void api.selftestLog(`error: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno} ${e.error?.stack ?? ""}`));
  useApp.subscribe((s, prev) => s.notices.filter((n) => !prev.notices.includes(n)).forEach((n) => void api.selftestLog(`notice: ${n}`)));
  addEventListener("unhandledrejection", (e) => void api.selftestLog(`rejection: ${e.reason?.stack ?? e.reason}`));
  setInterval(async () => {
    const books = await api.listBooks();
    void api.selftestLog(`heartbeat ${document.visibilityState} ${books.map((b) => `${b.id}:${b.index_state}`).join(" ")}`);
  }, 5000);
  try {
    const report = config.phase.startsWith("m3-")
      ? await runM3Phase(config.phase, config.m3)
      : config.phase.startsWith("m4-")
        ? await runM4Phase(config.phase, config.m3, sha)
        : config.phase === "restore"
        ? await restore(sha)
        : await first(fixtures, sha);
    await api.selftestReport(report);
  } catch (e) {
    await api.selftestReport({ phase: config.phase, ok: false, error: String(e), stack: (e as Error)?.stack });
  }
}
