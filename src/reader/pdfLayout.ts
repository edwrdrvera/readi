import type { PdfZoom, Spread } from "../lib/prefs";

/** A page's crop box in PDF points and its /Rotate, as PDF.js reports them. */
export interface PageGeom {
  view: number[];
  rotate: number;
}

export interface Size {
  width: number;
  height: number;
}

type Transform = [number, number, number, number, number, number];

/** The same page-to-viewport transform as PDF.js's PageViewport, with no offset. */
export function viewportTransform(geom: PageGeom, scale: number): Transform {
  const [x0, y0, x1, y1] = geom.view;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rotation = (((geom.rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  const [a, b, c, d] = { 0: [1, 0, 0, -1], 90: [0, 1, 1, 0], 180: [-1, 0, 0, 1], 270: [0, -1, -1, 0] }[rotation];
  const ox = a === 0 ? Math.abs(cy - y0) * scale : Math.abs(cx - x0) * scale;
  const oy = a === 0 ? Math.abs(cx - x0) * scale : Math.abs(cy - y0) * scale;
  return [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
}

export function toViewport(geom: PageGeom, scale: number, x: number, y: number): [number, number] {
  const t = viewportTransform(geom, scale);
  return [x * t[0] + y * t[2] + t[4], x * t[1] + y * t[3] + t[5]];
}

export function toPdf(geom: PageGeom, scale: number, vx: number, vy: number): [number, number] {
  const [a, b, c, d, e, f] = viewportTransform(geom, scale);
  const det = a * d - b * c;
  return [(d * (vx - e) - c * (vy - f)) / det, (a * (vy - f) - b * (vx - e)) / det];
}

/** Displayed size at scale 1, after /Rotate. */
export function pageSize(geom: PageGeom): Size {
  const [x0, y0, x1, y1] = geom.view;
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  return geom.rotate % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

/** Pages shown together in horizontal mode. A double spread shows the first page alone, then pairs. */
export function spreadOf(page: number, spread: Spread, numPages: number): number[] {
  if (spread === "single" || page === 0) return [page];
  const first = page % 2 === 1 ? page : page - 1;
  return first + 1 < numPages ? [first, first + 1] : [first];
}

/** First page of the spread `dir` steps from the one containing `page`, clamped to the book. */
export function stepSpread(page: number, dir: 1 | -1, spread: Spread, numPages: number): number {
  const current = spreadOf(page, spread, numPages);
  const target = dir === 1 ? current[current.length - 1] + 1 : current[0] - 1;
  if (target < 0 || target >= numPages) return current[0];
  return spreadOf(target, spread, numPages)[0];
}

/** Scale for pages laid side by side with `gap` between them inside `avail`. */
export function fitScale(zoom: PdfZoom, pages: Size[], avail: Size, gap: number): number {
  if (typeof zoom === "number") return zoom;
  const width = pages.reduce((s, p) => s + p.width, 0);
  const height = Math.max(...pages.map((p) => p.height));
  const byWidth = Math.max(1, avail.width - gap * (pages.length - 1)) / width;
  return zoom === "fit-width" ? byWidth : Math.min(byWidth, Math.max(1, avail.height) / height);
}

/** Top offsets of stacked pages, and the total height, given each page's displayed height. */
export function stack(heights: number[], pad: number, gap: number): { tops: number[]; total: number } {
  const tops: number[] = [];
  let y = pad;
  for (const h of heights) {
    tops.push(y);
    y += h + gap;
  }
  return { tops, total: heights.length ? y - gap + pad : 2 * pad };
}

/** Index of the page whose slot (including the gap after it) contains offset `y`. */
export function pageAt(tops: number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Printed label beside the physical position, e.g. "iv · 5 of 40". */
export function pageLabel(index: number, numPages: number, labels: string[] | null): string {
  const physical = `${index + 1} of ${numPages}`;
  const printed = labels?.[index];
  return printed && printed !== String(index + 1) ? `${printed} · ${physical}` : physical;
}
