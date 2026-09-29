import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Anchor, AnchorState, Annotation, BookDetail, HighlightColor, Locator, SearchHit, UnitPoint } from "../lib/api";
import { loadPdf, readTextContent, TextLayer, type PdfDoc, type PdfPage, type PdfTextContent } from "../adapters/pdf";
import { backHistory } from "../lib/history";
import type { Prefs } from "../lib/prefs";
import { useApp } from "../lib/store";
import { setActiveReader, type RestoreQuality, type SelectionInfo } from "./handle";
import {
  collapse,
  pageSegment,
  pointInQuad,
  quadPolygon,
  quadTop,
  rectToQuad,
  sameText,
  segmentOffset,
  sortKey,
  type Quad,
} from "./pdfAnchors";
import { fitScale, pageAt, pageLabel, pageSize, spreadOf, stack, stepSpread, toPdf, toViewport, type PageGeom } from "./pdfLayout";
import { useSaver } from "./useSaver";
import "./pdf.css";

type PdfLocator = Extract<Locator, { format: "pdf" }>;
type Box = { left: number; top: number; width: number; height: number; scale: number };
type PageText = {
  content: PdfTextContent;
  /** The text layer's span for each text item, by item index. Empty items have a span that is never attached. */
  spans: HTMLElement[];
  seg: ReturnType<typeof pageSegment>;
  layer: HTMLDivElement;
};
type Slot = {
  div: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  key: string;
  task: ReturnType<PdfPage["render"]> | null;
  done: Promise<void>;
  marks: SVGSVGElement;
  page: PdfPage | null;
  textLayer: TextLayer | null;
  textScale: number;
  text: Promise<PageText | null>;
  /** Set once `text` resolves, for synchronous readers. */
  pageText: PageText | null;
};
type Highlight = { id: number; color: HighlightColor; quads: Quad[] };

const PAD = 16;
const GAP = 12;
const SCROLL_STEP = 40;
const SVG = "http://www.w3.org/2000/svg";
const SEARCH_MARK_MS = 2500;
const QUOTE_LIMIT = 4096;
const CONTEXT = 100;

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
  private highlights = new Map<number, Highlight[]>();
  private searchMark: { page: number; quads: Quad[] } | null = null;
  private searchTimer = 0;

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
    content.addEventListener("click", this.onClick);
    content.addEventListener("pointerdown", this.onPointerDown);
    document.addEventListener("pointerup", this.onPointerUp);
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
    this.content.removeEventListener("click", this.onClick);
    this.content.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("pointerup", this.onPointerUp);
    clearTimeout(this.searchTimer);
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
    slot.textLayer?.cancel();
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
      div.dataset.page = String(i);
      const marks = document.createElementNS(SVG, "svg");
      marks.setAttribute("class", "pdf-marks");
      div.append(marks);
      this.content.append(div);
      slot = { div, canvas: null, key: "", task: null, done: Promise.resolve(), marks, page: null, textLayer: null, textScale: 0, text: Promise.resolve(null), pageText: null };
      this.slots.set(i, slot);
      slot.text = this.buildText(i, slot);
    }
    Object.assign(slot.div.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
    slot.div.style.setProperty("--total-scale-factor", String(box.scale));
    const dpr = devicePixelRatio || 1;
    const key = `${box.scale}@${dpr}`;
    if (slot.key === key) return slot.done;
    slot.key = key;
    this.rescaleText(slot, box.scale);
    this.drawMarks(i);
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
    current.div.prepend(canvas);
  }

  private async buildText(i: number, slot: Slot): Promise<PageText | null> {
    const stale = () => this.slots.get(i) !== slot;
    try {
      const page = await this.doc.getPage(i + 1);
      const content = await readTextContent(page);
      if (stale()) return null;
      const scale = this.boxes.get(i)?.scale ?? 1;
      const layer = document.createElement("div");
      layer.className = "textLayer";
      const textLayer = new TextLayer({ textContentSource: content as never, container: layer, viewport: page.getViewport({ scale }) });
      Object.assign(slot, { page, textLayer, textScale: scale });
      slot.div.append(layer);
      await textLayer.render();
      if (stale()) return null;
      const end = document.createElement("div");
      end.className = "endOfContent";
      layer.append(end);
      this.rescaleText(slot, this.boxes.get(i)?.scale ?? scale);
      // TextLayer makes one span per text item in order; no marked content is requested, so none are skipped.
      slot.pageText = { content, spans: textLayer.textDivs, seg: pageSegment(content.items), layer };
      return slot.pageText;
    } catch (e) {
      if (!stale()) console.warn(`Page ${i + 1} text layer failed`, e);
      return null;
    }
  }

  private rescaleText(slot: Slot, scale: number) {
    if (!slot.textLayer || !slot.page || slot.textScale === scale) return;
    slot.textScale = scale;
    slot.textLayer.update({ viewport: slot.page.getViewport({ scale }) });
  }

  private drawMarks(i: number) {
    const slot = this.slots.get(i);
    const box = this.boxes.get(i);
    if (!slot || !box) return;
    const geom = this.geom(i);
    const svg = slot.marks;
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    svg.replaceChildren();
    const add = (q: Quad, cls: string, attrs: Record<string, string>) => {
      const poly = document.createElementNS(SVG, "polygon");
      poly.setAttribute("points", quadPolygon(geom, box.scale, q).map((p) => p.join(",")).join(" "));
      poly.setAttribute("class", cls);
      for (const [k, v] of Object.entries(attrs)) poly.setAttribute(k, v);
      svg.append(poly);
    };
    for (const h of this.highlights.get(i) ?? []) for (const q of h.quads) add(q, "pdf-hl", { "data-color": h.color, "data-id": String(h.id) });
    if (this.searchMark?.page === i) for (const q of this.searchMark.quads) add(q, "pdf-search-mark", {});
  }

  private validPage(i: number) {
    return Number.isInteger(i) && i >= 0 && i < this.numPages;
  }

  setAnnotations(list: Annotation[]): Array<[number, AnchorState]> {
    this.highlights.clear();
    const states = list.map((a): [number, AnchorState] => {
      const anchor = a.anchor;
      if (anchor.type === "pdf_quads" && a.kind === "highlight") {
        if (!this.validPage(anchor.page_index)) return [a.id, "unresolved"];
        const list = this.highlights.get(anchor.page_index) ?? [];
        list.push({ id: a.id, color: a.color ?? "yellow", quads: anchor.quads });
        this.highlights.set(anchor.page_index, list);
        return [a.id, "resolved"];
      }
      if (anchor.type === "position" && anchor.locator.format === "pdf") return [a.id, this.validPage(anchor.locator.page_index) ? "resolved" : "unresolved"];
      return [a.id, "unresolved"];
    });
    for (const i of this.slots.keys()) this.drawMarks(i);
    return states;
  }

  /** Quads covering the text between two unit points of a rendered page. */
  private pointsToQuads(i: number, text: PageText, [u0, o0]: UnitPoint, [u1, o1]: UnitPoint): Quad[] {
    const slot = this.slots.get(i);
    const box = this.boxes.get(i);
    if (!slot || !box) return [];
    const origin = slot.div.getBoundingClientRect();
    const quads: Quad[] = [];
    for (let k = u0; k <= u1; k++) {
      const node = text.spans[k]?.firstChild;
      if (!node || !text.spans[k].isConnected) continue;
      const len = node.textContent?.length ?? 0;
      const range = document.createRange();
      range.setStart(node, k === u0 ? Math.min(o0, len) : 0);
      range.setEnd(node, k === u1 ? Math.min(o1, len) : len);
      for (const r of range.getClientRects()) {
        if (r.width < 0.5 || r.height < 0.5) continue;
        const rel = { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top };
        quads.push(rectToQuad(this.geom(i), box.scale, rel));
      }
    }
    return quads;
  }

  /** Brings a quad of page `i` into view, about a third of the way down. */
  private async reveal(i: number, q: Quad) {
    const box = this.boxes.get(i);
    if (!box) return;
    const pts = quadPolygon(this.geom(i), box.scale, q);
    const top = Math.min(...pts.map((p) => p[1]));
    const left = Math.min(...pts.map((p) => p[0]));
    const { clientWidth, clientHeight } = this.scroller;
    const vx = left + box.left > clientWidth * 0.8 ? Math.max(0, left - clientWidth / 3) : 0;
    const vy = Math.max(0, top - clientHeight / 3);
    if (this.vertical) {
      const [x, y] = toPdf(this.geom(i), box.scale, vx, vy);
      await this.show(i, { format: "pdf", v: 1, page_index: i, x, y });
      return;
    }
    if (box.height > clientHeight) this.scroller.scrollTop = box.top + vy;
    if (vx) this.scroller.scrollLeft = box.left + vx;
  }

  private async pageText(i: number) {
    await this.settled();
    return (await this.slots.get(i)?.text) ?? null;
  }

  async showHit(hit: SearchHit): Promise<RestoreQuality> {
    const i = Math.min(this.numPages - 1, Math.max(0, Math.trunc(hit.order)));
    await this.showPage(i);
    if (!hit.range || i !== hit.order) return "approximate";
    const text = await this.pageText(i);
    if (!text) return "approximate";
    const s = segmentOffset(text.seg.mapping, hit.range.start);
    const e = segmentOffset(text.seg.mapping, hit.range.end);
    if (s === null || e === null || e < s || !sameText(text.seg.text.slice(s, e), hit.match_text)) return "approximate";
    const quads = this.pointsToQuads(i, text, hit.range.start, hit.range.end);
    if (!quads.length) return "approximate";
    clearTimeout(this.searchTimer);
    const previous = this.searchMark?.page;
    this.searchMark = { page: i, quads };
    if (previous !== undefined && previous !== i) this.drawMarks(previous);
    this.drawMarks(i);
    this.searchTimer = window.setTimeout(() => {
      this.searchMark = null;
      this.drawMarks(i);
    }, SEARCH_MARK_MS);
    await this.reveal(i, quads[0]);
    return "exact";
  }

  async showAnnotation(a: Annotation): Promise<RestoreQuality> {
    const anchor = a.anchor;
    if (anchor.type === "position") return anchor.locator.format === "pdf" ? this.goToLocator(anchor.locator) : "approximate";
    if (anchor.type !== "pdf_quads") return "approximate";
    await this.showPage(anchor.page_index);
    if (!this.validPage(anchor.page_index)) return "approximate";
    if (anchor.quads[0]) await this.reveal(anchor.page_index, anchor.quads[0]);
    return "exact";
  }

  /** The current selection inside a text layer, clipped to the page where it starts. */
  selection(): SelectionInfo | null {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0).cloneRange();
    const start = range.startContainer;
    const el = start.nodeType === Node.ELEMENT_NODE ? (start as Element) : start.parentElement;
    const pageDiv = el?.closest<HTMLElement>(".pdf-page");
    if (!pageDiv || !this.content.contains(pageDiv)) return null;
    const i = Number(pageDiv.dataset.page);
    const text = this.slots.get(i)?.pageText;
    if (!text || !text.layer.contains(start)) return null;
    if (!text.layer.contains(range.endContainer)) range.setEnd(text.layer, text.layer.childNodes.length);
    const points: UnitPoint[] = [];
    text.spans.forEach((span, k) => {
      const node = span.firstChild;
      if (!node || !span.isConnected || !range.intersectsNode(node)) return;
      const len = node.textContent?.length ?? 0;
      const from = node === range.startContainer ? range.startOffset : 0;
      const to = node === range.endContainer ? range.endOffset : len;
      if (to <= from) return;
      if (!points.length) points.push([k, from]);
      points[1] = [k, to];
    });
    if (points.length < 2) return null;
    const s = segmentOffset(text.seg.mapping, points[0]);
    const e = segmentOffset(text.seg.mapping, points[1]);
    const quads = this.pointsToQuads(i, text, points[0], points[1]);
    if (s === null || e === null || !quads.length) return null;
    const quote = collapse(text.seg.text.slice(s, e)).slice(0, QUOTE_LIMIT);
    const context = collapse(text.seg.text.slice(Math.max(0, s - CONTEXT), e + CONTEXT));
    const origin = pageDiv.getBoundingClientRect();
    const box = this.boxes.get(i)!;
    const rects = quads.map((q) => quadPolygon(this.geom(i), box.scale, q)).flat();
    const xs = rects.map((p) => p[0] + origin.left);
    const ys = rects.map((p) => p[1] + origin.top);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const anchor: Anchor = { type: "pdf_quads", v: 1, page_index: i, quads };
    return {
      anchor,
      quote,
      context,
      sort_key: sortKey(i, this.geom(i), quadTop(quads[0])),
      rect: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y },
    };
  }

  clearSelection() {
    const sel = document.getSelection();
    if (sel?.anchorNode && this.content.contains(sel.anchorNode)) sel.removeAllRanges();
  }

  bookmark(): { anchor: Anchor; quote: string | null; sort_key: number } | null {
    const loc = this.loc;
    if (!loc) return null;
    const text = this.slots.get(loc.page_index)?.pageText;
    let quote: string | null = null;
    if (text) {
      const at = this.vertical ? this.visibleTextStart(text) : 0;
      quote = collapse(text.seg.text.slice(at, at + 200)).slice(0, 80) || null;
    }
    return { anchor: { type: "position", locator: loc }, quote, sort_key: sortKey(loc.page_index, this.geom(loc.page_index), loc.y) };
  }

  /** Segment offset of the first text item whose span starts below the top of the viewport. */
  private visibleTextStart(text: PageText): number {
    const top = this.scroller.getBoundingClientRect().top;
    const k = text.spans.findIndex((s) => s.isConnected && s.textContent && s.getBoundingClientRect().top >= top);
    return (k >= 0 && segmentOffset(text.seg.mapping, [k, 0])) || 0;
  }

  private onClick = (e: MouseEvent) => {
    if (!document.getSelection()?.isCollapsed) return;
    const pageDiv = (e.target as Element | null)?.closest<HTMLElement>(".pdf-page");
    if (!pageDiv) return;
    const i = Number(pageDiv.dataset.page);
    const box = this.boxes.get(i);
    const list = this.highlights.get(i);
    if (!box || !list?.length) return;
    const origin = pageDiv.getBoundingClientRect();
    const [x, y] = toPdf(this.geom(i), box.scale, e.clientX - origin.left, e.clientY - origin.top);
    const hit = [...list].reverse().find((h) => h.quads.some((q) => pointInQuad(q, x, y)));
    if (hit) window.dispatchEvent(new CustomEvent("readi:annotation-click", { detail: { id: hit.id } }));
  };

  // As PDF.js's viewer does: while dragging, stretch the layer's end marker over
  // the page so a drag into a gap between spans does not select to the page end.
  private onPointerDown = (e: PointerEvent) => {
    (e.target as Element | null)?.closest(".textLayer")?.classList.add("selecting");
  };

  private onPointerUp = () => {
    for (const el of this.content.querySelectorAll(".textLayer.selecting")) el.classList.remove("selecting");
  };

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
      showHit: async (hit) => {
        const v = await view;
        backHistory.push(bookId, v.location());
        return v.showHit(hit);
      },
      showAnnotation: async (a) => {
        const v = await view;
        backHistory.push(bookId, v.location());
        return v.showAnnotation(a);
      },
      setAnnotations: async (list) => (await view).setAnnotations(list),
      onSelection: (cb) => {
        let last: SelectionInfo | null = null;
        let frame = 0;
        const check = () => {
          frame = 0;
          const next = viewRef.current?.selection() ?? null;
          if (!next && !last) return;
          if (next && last && JSON.stringify(next) === JSON.stringify(last)) return;
          last = next;
          cb(next);
        };
        const onChange = () => {
          if (!frame) frame = requestAnimationFrame(check);
        };
        document.addEventListener("selectionchange", onChange);
        return () => {
          cancelAnimationFrame(frame);
          document.removeEventListener("selectionchange", onChange);
        };
      },
      clearSelection: () => viewRef.current?.clearSelection(),
      bookmark: () => viewRef.current?.bookmark() ?? null,
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
