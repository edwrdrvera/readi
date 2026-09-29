import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, type BookSummary } from "./lib/api";
import { useApp } from "./lib/store";
import { importPaths } from "./lib/importing";
import { activeReader } from "./reader/handle";

// Drives the packaged app when READI_SELFTEST is set. scripts/packaged-check.mjs
// runs the "first" phase, force-kills the app, then runs "restore".

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, fn: () => T | Promise<T>, timeoutMs = 60_000): Promise<NonNullable<T>> {
  void api.selftestLog(`wait: ${what} (${document.visibilityState})`);
  const start = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

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

async function openAndWait(id: number) {
  const started = performance.now();
  await useApp.getState().openBook(id);
  const reader = await until("reader", () => (activeReader()?.bookId === id ? activeReader() : null));
  await reader.ready;
  return { reader, openMs: Math.round(performance.now() - started) };
}

async function pdfRendered(page: number) {
  await until(`page ${page} rendered`, () => document.querySelector(`.pdf-host canvas[data-rendered-page="${page}"]`));
}

async function first(fixtures: string[], sha: Record<string, string>) {
  const report: Record<string, unknown> = { phase: "first" };
  const importStart = performance.now();
  const outcomes = await importPaths(fixtures);
  report.importMs = Math.round(performance.now() - importStart);
  report.imports = outcomes.map((o) => (o.status === "failed" ? o : { path: o.path, id: o.result.book.id }));

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
  }

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

  {
    const detail = await api.openBook(typical.id);
    const { reader, openMs } = await openAndWait(typical.id);
    await sleep(300);
    report.epub = { openMs, stored: detail.progress?.locator, restored: reader.location() };
  }
  for (const [key, book] of [["largePdf", large], ["textPdf", text]] as const) {
    const detail = await api.openBook(book.id);
    const stored = detail.progress?.locator;
    const { reader, openMs } = await openAndWait(book.id);
    const page = stored?.format === "pdf" ? stored.page_index : 0;
    await pdfRendered(page);
    const restored = reader.location();
    report[key] = { openMs, stored, restoredPage: restored?.format === "pdf" ? restored.page_index : null };
  }
  report.readingStates = (await api.listBooks()).map((b) => `${b.title}: ${b.reading_state}`);
  await useApp.getState().closeBook();
  report.ok = true;
  return report;
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
    const report = config.phase === "restore" ? await restore(sha) : await first(fixtures, sha);
    await api.selftestReport(report);
  } catch (e) {
    await api.selftestReport({ phase: config.phase, ok: false, error: String(e), stack: (e as Error)?.stack });
  }
}
