import type { UnitPoint } from "../lib/api";
import { buildSegment, normalizeUnit, type SegmentUnit, type TextMapping } from "../lib/textmap";
import { toPdf, toViewport, type PageGeom } from "./pdfLayout";

/** PDF QuadPoints order: upper-left, upper-right, lower-left, lower-right, as x,y pairs in page user space. */
export type Quad = [number, number, number, number, number, number, number, number];

export interface PdfTextItem {
  str: string;
  hasEOL: boolean;
}

/** Every text item is a unit, empty ones included, so item indexes are unit indexes. */
export function pdfUnits(items: PdfTextItem[]): SegmentUnit[] {
  // Line ends often arrive on an empty item, so a break carries until the next item with text.
  let eol = false;
  return items.map((it) => {
    const sep = eol ? "\n" : " ";
    eol = it.str ? it.hasEOL : eol || it.hasEOL;
    return { text: it.str, sep };
  });
}

export const pageSegment = (items: PdfTextItem[]) => buildSegment(pdfUnits(items));

/** Offset in the segment text of a unit point, or null when the point is not inside a mapped unit. */
export function segmentOffset(mapping: TextMapping, [unit, offset]: UnitPoint): number | null {
  const entry = mapping.units.find((u) => u[1] === unit);
  if (!entry || offset < 0 || offset > entry[2]) return null;
  return entry[0] + offset;
}

/** Unit point for a segment offset, the inverse of segmentOffset. */
export function unitPointAt(mapping: TextMapping, offset: number): UnitPoint | null {
  for (const [start, unit, len] of mapping.units) if (offset >= start && offset <= start + len) return [unit, offset - start];
  return null;
}

export const sameText = (a: string, b: string) => normalizeUnit(a).toLowerCase() === normalizeUnit(b).toLowerCase();

export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** A viewport-space rectangle relative to the page's top-left, as a quad in PDF user space. */
export function rectToQuad(geom: PageGeom, scale: number, r: { left: number; top: number; right: number; bottom: number }): Quad {
  const ul = toPdf(geom, scale, r.left, r.top);
  const ur = toPdf(geom, scale, r.right, r.top);
  const ll = toPdf(geom, scale, r.left, r.bottom);
  const lr = toPdf(geom, scale, r.right, r.bottom);
  return [...ul, ...ur, ...ll, ...lr];
}

/** The quad's corners in viewport space, in drawing order around the outline. */
export function quadPolygon(geom: PageGeom, scale: number, q: Quad): Array<[number, number]> {
  return [
    toViewport(geom, scale, q[0], q[1]),
    toViewport(geom, scale, q[2], q[3]),
    toViewport(geom, scale, q[6], q[7]),
    toViewport(geom, scale, q[4], q[5]),
  ];
}

export function pointInQuad(q: Quad, x: number, y: number): boolean {
  const pts = [
    [q[0], q[1]],
    [q[2], q[3]],
    [q[6], q[7]],
    [q[4], q[5]],
  ];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Reading-order key: the page index plus how far down the page `y` (PDF user space) is, in [0, 1). */
export function sortKey(pageIndex: number, geom: PageGeom, y: number): number {
  const [, y0, , y1] = geom.view;
  const h = Math.abs(y1 - y0) || 1;
  const f = 1 - (y - Math.min(y0, y1)) / h;
  return pageIndex + Math.min(0.999999, Math.max(0, Number.isFinite(f) ? f : 0));
}

export const quadTop = (q: Quad) => Math.max(q[1], q[3], q[5], q[7]);
