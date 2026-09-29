import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { BookDetail, Locator } from "../lib/api";
import { loadPdf, type PdfDoc, type PdfPage } from "../adapters/pdf";
import { backHistory } from "../lib/history";
import type { Prefs } from "../lib/prefs";
import { useApp } from "../lib/store";
import { annotationsPending, setActiveReader, type RestoreQuality } from "./handle";
import { fitScale, pageAt, pageLabel, pageSize, spreadOf, stack, stepSpread, toPdf, toViewport, type PageGeom } from "./pdfLayout";
import { useSaver } from "./useSaver";
import "./pdf.css";

type PdfLocator = Extract<Locator, { format: "pdf" }>;
type Box = { left: number; top: number; width: number; height: number; scale: number };
type Slot = {
  div: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  key: string;
  task: ReturnType<PdfPage["render"]> | null;
  done: Promise<void>;
};

const PAD = 16;
const GAP = 12;
const SCROLL_STEP = 40;

const release = (canvas: HTMLCanvasElement | null) => {
  if (!canvas) return;
  canvas.width = canvas.height = 0;
  canvas.remove();
};

/**
 * Lays out, renders, and tracks the position of one open PDF. The reading
 * position `loc` is the source of truth: every re-layout (prefs, resize, a
 * page size arriving) puts `loc` back at the top-left of the viewport.
 */
class PdfView {
  private geoms: (PageGeom | undefined)[];
  private boxes = new Map<number, Box>();
  private tops: number[] = [];
  private slots = new Map<number, Slot>();
  private layoutSize = { width: -1, height: -1 };
  private placed = { top: -1, left: -1 };
  private current = 0;
  private work: Promise<void> = Promise.resolve();
  private observer: ResizeObserver;
  private destroyed = false;
  private loc: PdfLocator | null = null;

  constructor(
    private doc: PdfDoc,
    first: PageGeom,
    private scroller: HTMLDivElement,
    private content: HTMLDivElement,
    private prefs: Prefs,
    private onMove: (loc: PdfLocator, percent: number, immediate: boolean) => void,
    private onError: (message: string) => void,
  ) {
    this.geoms = new Array(doc.numPages);
    this.geoms[0] = first;
    scroller.addEventListener("scroll", this.onScroll);
    this.observer = new ResizeObserver(() => this.relayoutIfResized());
    this.observer.observe(scroller);
  }

  private get numPages() {
    return this.doc.numPages;
  }

  private get vertical() {
    return this.prefs.reading_mode === "vertical";
  }

  destroy() {
    this.destroyed = true;
    this.observer.disconnect();
    this.scroller.removeEventListener("scroll", this.onScroll);
    for (const i of [...this.slots.keys()]) this.releaseSlot(i);
  }

  private geom(i: number) {
    return this.geoms[i] ?? this.geoms[0]!;
  }

  private async fetchGeom(i: number) {
    if (this.geoms[i]) return;
    const page = await this.doc.getPage(i + 1);
    this.geoms[i] = { view: page.view, rotate: page.rotate };
  }

  private pageTop(i: number): PdfLocator {
    const [x, y] = toPdf(this.geom(i), 1, 0, 0);
    return { format: "pdf", v: 1, page_index: i, x, y };
  }

  private layout() {
    const width = this.scroller.clientWidth;
    const height = this.scroller.clientHeight;
    this.layoutSize = { width, height };
    const avail = { width: width - 2 * PAD, height: height - 2 * PAD };
    const zoom = this.prefs.pdf_zoom;
    this.boxes.clear();
    let contentW: number;
    let contentH: number;
    if (this.vertical) {
      const sizes = Array.from({ length: this.numPages }, (_, i) => {
        const size = pageSize(this.geom(i));
        const scale = fitScale(zoom, [size], avail, 0);
        return { width: size.width * scale, height: size.height * scale, scale };
      });
      const { tops, total } = stack(
        sizes.map((s) => s.height),
        PAD,
        GAP,
      );
      this.tops = tops;
      contentW = Math.max(width, Math.max(...sizes.map((s) => s.width)) + 2 * PAD);
      contentH = total;
      sizes.forEach((s, i) => this.boxes.set(i, { ...s, top: tops[i], left: (contentW - s.width) / 2 }));
    } else {
      const pages = spreadOf(this.current, this.prefs.spread, this.numPages);
      const sizes = pages.map((i) => pageSize(this.geom(i)));
      const scale = fitScale(zoom, sizes, avail, GAP);
      const spreadW = sizes.reduce((s, p) => s + p.width * scale, 0) + GAP * (pages.length - 1);
      contentW = Math.max(width, spreadW + 2 * PAD);
      contentH = Math.max(height, Math.max(...sizes.map((p) => p.height * scale)) + 2 * PAD);
      let x = (contentW - spreadW) / 2;
      pages.forEach((i, k) => {
        const w = sizes[k].width * scale;
        const h = sizes[k].height * scale;
        this.boxes.set(i, { left: x, top: (contentH - h) / 2, width: w, height: h, scale });
        x += w + GAP;
      });
    }
    this.content.style.width = `${contentW}px`;
    this.content.style.height = `${contentH}px`;
    const scale = this.boxes.get(this.current)?.scale;
    // Cmd+Plus/Minus steps from the effective scale when zoom is a fit mode.
    if (scale) this.scroller.closest<HTMLElement>(".pdf-host")?.setAttribute("data-scale", String(Math.round(scale * 1000) / 1000));
  }

  private place() {
    const loc = this.loc!;
    if (this.vertical) {
      const box = this.boxes.get(loc.page_index)!;
      const [vx, vy] = toViewport(this.geom(loc.page_index), box.scale, loc.x, loc.y);
      this.scroller.scrollTop = box.top + vy;
      this.scroller.scrollLeft = box.left + vx;
    } else {
      this.scroller.scrollTop = 0;
      this.scroller.scrollLeft = 0;
    }
    this.placed = { top: this.scroller.scrollTop, left: this.scroller.scrollLeft };
  }

  /** The PDF point at the viewport's top-left in vertical mode, and how far into its page that is. */
  private readScroll(): { loc: PdfLocator; fraction: number } {
    const { scrollTop, scrollLeft } = this.scroller;
    let i = pageAt(this.tops, scrollTop);
    // The gap below a page reads as the top of the next one, so a position
    // rounded a pixel short of a page top stays on that page.
    if (scrollTop >= this.tops[i] + this.boxes.get(i)!.height && i + 1 < this.numPages) i++;
    const box = this.boxes.get(i)!;
    const dx = Math.min(box.width, Math.max(0, scrollLeft - box.left));
    const dy = Math.min(box.height, Math.max(0, scrollTop - box.top));
    const [x, y] = toPdf(this.geom(i), box.scale, dx, dy);
    const fraction = Math.min(1, Math.max(0, (scrollTop - box.top) / box.height));
    return { loc: { format: "pdf", v: 1, page_index: i, x, y }, fraction };
  }

  private percent(fraction: number) {
    return (this.loc!.page_index + fraction) / this.numPages;
  }

  private onScroll = () => {
    if (!this.loc || !this.vertical) return;
    const { scrollTop, scrollLeft } = this.scroller;
    // A scroll event caused by our own placement, including one the browser
    // clamped, must not replace the position we were asked to keep.
    if (Math.abs(scrollTop - this.placed.top) > 1 || Math.abs(scrollLeft - this.placed.left) > 1) {
      this.placed = { top: -1, left: -1 };
      const { loc, fraction } = this.readScroll();
      this.loc = loc;
      this.onMove(loc, this.percent(fraction), false);
    }
    this.work = this.updateWindow();
  };

  private relayout() {
    if (!this.loc || this.destroyed) return;
    this.layout();
    this.place();
    this.work = this.updateWindow();
  }

  private relayoutIfResized() {
    const { clientWidth, clientHeight } = this.scroller;
    if (clientWidth !== this.layoutSize.width || clientHeight !== this.layoutSize.height) this.relayout();
  }

  setPrefs(prefs: Prefs) {
    const modeChanged = this.prefs.reading_mode !== prefs.reading_mode;
    this.prefs = prefs;
    if (!this.loc) return;
    if (modeChanged && !this.vertical) {
      this.current = this.loc.page_index;
      this.loc = this.pageTop(this.current);
    }
    this.relayout();
    if (modeChanged) this.onMove(this.loc, this.percent(0), true);
  }

  private windowPages(): number[] {
    if (!this.vertical) return spreadOf(this.current, this.prefs.spread, this.numPages);
    const { scrollTop, clientHeight } = this.scroller;
    const first = Math.max(0, pageAt(this.tops, scrollTop) - 1);
    const last = Math.min(this.numPages - 1, pageAt(this.tops, scrollTop + clientHeight) + 1);
    return Array.from({ length: last - first + 1 }, (_, k) => first + k);
  }

  private async updateWindow(): Promise<void> {
    const pages = this.windowPages();
    for (const i of [...this.slots.keys()]) if (!pages.includes(i)) this.releaseSlot(i);
    const missing = pages.filter((i) => !this.geoms[i]);
    if (missing.length) {
      await Promise.all(missing.map((i) => this.fetchGeom(i)));
      // Placeholders assumed page 1's size; re-lay out with the real sizes,
      // which puts the reading position back so the passage does not jump.
      this.relayout();
      return this.work;
    }
    await Promise.all(pages.map((i) => this.render(i)));
  }

  private releaseSlot(i: number) {
    const slot = this.slots.get(i)!;
    slot.task?.cancel();
    release(slot.canvas);
    slot.div.remove();
    this.slots.delete(i);
  }

  private render(i: number): Promise<void> {
    const box = this.boxes.get(i)!;
    let slot = this.slots.get(i);
    if (!slot) {
      const div = document.createElement("div");
      div.className = "pdf-page";
      this.content.append(div);
      slot = { div, canvas: null, key: "", task: null, done: Promise.resolve() };
      this.slots.set(i, slot);
    }
    Object.assign(slot.div.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    const dpr = devicePixelRatio || 1;
    const key = `${box.scale}@${dpr}`;
    if (slot.key === key) return slot.done;
    slot.key = key;
    slot.task?.cancel();
    slot.done = this.draw(i, slot, box.scale * dpr, key);
    return slot.done;
  }

  private async draw(i: number, current: Slot, scale: number, key: string) {
    const stale = () => this.slots.get(i) !== current || current.key !== key;
    const page = await this.doc.getPage(i + 1);
    if (stale()) return;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.dataset.page = String(i);
    const task = page.render({ canvas, viewport });
    current.task = task;
    try {
      await task.promise;
    } catch (e) {
      release(canvas);
      if ((e as Error)?.name !== "RenderingCancelledException") this.onError(`Page ${i + 1} failed to render: ${e}`);
      return;
    }
    page.cleanup();
    if (stale()) return release(canvas);
    current.task = null;
    canvas.dataset.renderedPage = String(i);
    release(current.canvas);
    current.canvas = canvas;
    current.div.append(canvas);
  }

  async settled() {
    this.relayoutIfResized();
    for (;;) {
      const w = this.work;
      await w.catch(() => {});
      if (w === this.work) return;
    }
  }

  async goToLocator(target: PdfLocator): Promise<RestoreQuality> {
    const n = this.numPages;
    let i = target.page_index;
    let quality: RestoreQuality = "exact";
    if (!Number.isInteger(i) || i < 0 || i >= n) {
      i = Number.isFinite(i) ? Math.min(n - 1, Math.max(0, Math.round(i))) : 0;
      quality = "approximate";
    }
    await this.fetchGeom(i);
    const keepPoint = quality === "exact" && this.vertical && Number.isFinite(target.x) && Number.isFinite(target.y);
    await this.show(i, keepPoint ? target : this.pageTop(i));
    return quality;
  }

  async showPage(target: number) {
    const i = Math.min(this.numPages - 1, Math.max(0, Math.trunc(target)));
    await this.fetchGeom(i);
    await this.show(i, this.pageTop(i));
  }

  private async show(i: number, loc: PdfLocator) {
    if (!this.vertical) await Promise.all(spreadOf(i, this.prefs.spread, this.numPages).map((p) => this.fetchGeom(p)));
    if (this.destroyed) return;
    this.current = i;
    this.loc = loc;
    this.relayout();
    this.onMove(loc, this.percent(0), true);
    await this.settled();
  }

  async step(dir: 1 | -1) {
    if (!this.loc) return;
    if (!this.vertical) {
      const target = stepSpread(this.current, dir, this.prefs.spread, this.numPages);
      if (target !== this.current) await this.showPage(target);
      return;
    }
    this.scroller.scrollTop += dir * this.scroller.clientHeight;
    this.placed = { top: this.scroller.scrollTop, left: this.scroller.scrollLeft };
    const { loc, fraction } = this.readScroll();
    this.loc = loc;
    this.onMove(loc, this.percent(fraction), true);
    this.work = this.updateWindow();
    await this.settled();
  }

  scrollBy(dir: 1 | -1) {
    if (this.vertical) this.scroller.scrollTop += dir * SCROLL_STEP;
  }

  location(): PdfLocator | null {
    return this.loc;
  }

  anchor(): string {
    const loc = this.loc;
    return loc ? `p${loc.page_index}@${Math.round(loc.x)},${Math.round(loc.y)}` : "";
  }

  isVisible(anchor: string): boolean {
    const m = /^p(\d+)@(-?\d+),(-?\d+)$/.exec(anchor);
    const box = m ? this.boxes.get(Number(m[1])) : undefined;
    if (!m || !box) return false;
    const [vx, vy] = toViewport(this.geom(Number(m[1])), box.scale, Number(m[2]), Number(m[3]));
    const x = box.left + vx - this.scroller.scrollLeft;
    const y = box.top + vy - this.scroller.scrollTop;
    // Anchors are rounded to whole PDF units, so allow that much slack at the edges.
    const slack = box.scale + 1;
    return x >= -slack && y >= -slack && x <= this.scroller.clientWidth + slack && y <= this.scroller.clientHeight + slack;
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

export function PdfReader({ detail, prefs }: { detail: BookDetail; prefs: Prefs }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const viewRef = useRef<PdfView | null>(null);
  const [label, setLabel] = useState("");
  const [pending] = useState(() => ({ view: deferred<PdfView>(), ready: deferred<void>() }));
  const saver = useSaver(detail.book.id);
  const notify = useApp((s) => s.notify);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const bookId = detail.book.id;
  const openedWith = useRef(detail);

  useEffect(() => {
    const opened = openedWith.current;
    let view: PdfView | null = null;
    let cancelled = false;
    const task = loadPdf(bookId, opened.book.file_size);
    (async () => {
      const doc = await task.promise;
      const [first, labels] = await Promise.all([
        doc.getPage(1).then((p) => ({ view: p.view, rotate: p.rotate })),
        doc.getPageLabels().catch(() => null),
      ]);
      if (cancelled) return;
      view = new PdfView(
        doc,
        first,
        scroller.current!,
        content.current!,
        prefsRef.current,
        (loc, percent, immediate) => {
          setLabel(pageLabel(loc.page_index, doc.numPages, labels));
          saver.update(loc, percent, immediate);
        },
        notify,
      );
      viewRef.current = view;
      pending.view.resolve(view);
      const saved = opened.progress?.locator;
      const quality = await view.goToLocator(saved?.format === "pdf" ? saved : { format: "pdf", v: 1, page_index: 0, x: NaN, y: NaN });
      if (quality === "approximate") notify("Restored to the nearest available page");
      pending.ready.resolve();
    })().catch((e) => {
      if (!cancelled) notify(`This PDF could not be displayed: ${e?.message ?? e}`);
    });
    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
      void task.destroy();
    };
  }, [bookId, saver, notify, pending]);

  useLayoutEffect(() => {
    viewRef.current?.setPrefs(prefs);
  }, [prefs]);

  useEffect(() => {
    const view = pending.view.promise;
    setActiveReader({
      ...annotationsPending,
      bookId,
      ready: pending.ready.promise,
      dir: () => "ltr",
      location: () => viewRef.current?.location() ?? null,
      next: async () => (await view).step(1),
      prev: async () => (await view).step(-1),
      goLeft: async () => (await view).step(-1),
      goRight: async () => (await view).step(1),
      scrollBy: (dir) => viewRef.current?.scrollBy(dir),
      goTo: async (target) => {
        const v = await view;
        const page = Number(target);
        if (!Number.isFinite(page)) return;
        backHistory.push(bookId, v.location());
        await v.showPage(page);
      },
      goToLocator: async (locator) => {
        if (locator.format !== "pdf") return "approximate";
        const quality = await (await view).goToLocator(locator);
        if (quality === "approximate") notify("Restored to the nearest available page");
        return quality;
      },
      settled: async () => {
        await pending.ready.promise;
        // Let React commit a prefs change made just before this call.
        await new Promise((r) => setTimeout(r, 0));
        await (await view).settled();
      },
      anchor: () => viewRef.current?.anchor() ?? "",
      isVisible: (a) => viewRef.current?.isVisible(a) ?? false,
      flush: () => saver.flush(),
    });
    return () => setActiveReader(null);
  }, [bookId, saver, notify, pending]);

  return (
    <div className="pdf-host pdf-reader" data-effect={prefs.pdf_effect} data-mode={prefs.reading_mode}>
      <div className="pdf-scroller" ref={scroller}>
        <div className="pdf-content" ref={content} />
      </div>
      {label && (
        <div className="pdf-page-label" aria-live="polite">
          {label}
        </div>
      )}
    </div>
  );
}
