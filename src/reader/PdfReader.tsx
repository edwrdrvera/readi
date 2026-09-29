import { useEffect, useRef, useState } from "react";
import type { BookDetail, Locator } from "../lib/api";
import { loadPdf, type PdfDoc } from "../adapters/pdf";
import { useApp } from "../lib/store";
import { setActiveReader } from "./handle";
import { useSaver } from "./useSaver";

/** M1 PDF view: one fitted page at a time. Only the visible page is rendered. */
export function PdfReader({ detail, prefs: _prefs }: { detail: BookDetail; prefs: import("../lib/prefs").Prefs }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const docReady = useRef<{ promise: Promise<PdfDoc>; resolve: (d: PdfDoc) => void } | null>(null);
  if (!docReady.current) {
    let resolve!: (d: PdfDoc) => void;
    docReady.current = { promise: new Promise((r) => (resolve = r)), resolve };
  }
  const saved = detail.progress?.locator;
  const [page, setPage] = useState(saved?.format === "pdf" ? saved.page_index : 0);
  const saver = useSaver(detail.book.id);
  const notify = useApp((s) => s.notify);
  const readyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!readyRef.current) {
    let resolve!: () => void;
    readyRef.current = { promise: new Promise((r) => (resolve = r)), resolve };
  }

  useEffect(() => {
    const task = loadPdf(detail.book.id, detail.book.file_size);
    task.promise.then((d) => {
      setDoc(d);
      docReady.current!.resolve(d);
    }, (e) => notify(`This PDF could not be displayed: ${e?.message ?? e}`));
    return () => void task.destroy();
  }, [detail, notify]);

  const pageCount = doc?.numPages ?? 0;
  const clamped = Math.min(page, Math.max(0, pageCount - 1));

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let renderTask: { cancel(): void; promise: Promise<void> } | null = null;
    (async () => {
      const p = await doc.getPage(clamped + 1);
      if (cancelled) return;
      const el = canvas.current!;
      const base = p.getViewport({ scale: 1 });
      const box = el.parentElement!.getBoundingClientRect();
      const scale = Math.min(box.width / base.width, box.height / base.height);
      const vp = p.getViewport({ scale: scale * devicePixelRatio });
      el.width = vp.width;
      el.height = vp.height;
      el.style.width = `${vp.width / devicePixelRatio}px`;
      el.style.height = `${vp.height / devicePixelRatio}px`;
      renderTask = p.render({ canvas: el, viewport: vp });
      await renderTask.promise;
      p.cleanup();
      if (cancelled) return;
      el.dataset.renderedPage = String(clamped);
      const [x, y] = base.convertToPdfPoint(0, 0);
      const locator: Locator = { format: "pdf", v: 1, page_index: clamped, x, y };
      saver.update(locator, (clamped + 1) / doc.numPages, true);
      readyRef.current!.resolve();
    })().catch((e) => {
      if (!cancelled && e?.name !== "RenderingCancelledException") notify(`Page failed to render: ${e}`);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [doc, clamped, saver, notify]);

  const pageRef = useRef(clamped);
  pageRef.current = clamped;
  useEffect(() => {
    // Navigation waits for the document: clamping against a page count of 0
    // before load would silently send every target to page 0.
    const go = async (i: number) => {
      const d = await docReady.current!.promise;
      setPage(Math.max(0, Math.min(i, d.numPages - 1)));
    };
    setActiveReader({
      bookId: detail.book.id,
      ready: readyRef.current!.promise,
      location: () => ({ format: "pdf", v: 1, page_index: pageRef.current, x: 0, y: 0 }),
      dir: () => "ltr",
      next: () => go(pageRef.current + 1),
      prev: () => go(pageRef.current - 1),
      goLeft: () => go(pageRef.current - 1),
      goRight: () => go(pageRef.current + 1),
      scrollBy: () => {},
      goTo: (t) => go(Number(t)),
      goToLocator: async (l) => (l.format === "pdf" && (await go(l.page_index)), "exact"),
      settled: () => readyRef.current!.promise,
      anchor: () => `p${pageRef.current}@0,0`,
      isVisible: (a) => a.startsWith(`p${pageRef.current}@`),
      flush: () => saver.flush(),
    });
    return () => setActiveReader(null);
  }, [detail.book.id, saver]);

  return (
    <div className="pdf-host">
      <canvas ref={canvas} />
      {pageCount > 0 && (
        <div className="pdf-page-label" aria-live="polite">
          Page {clamped + 1} of {pageCount}
        </div>
      )}
    </div>
  );
}
