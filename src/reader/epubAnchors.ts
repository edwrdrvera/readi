import type { UnitPoint } from "../lib/api";
import { buildSegment, epubTextNodes, epubUnits, type TextMapping } from "../lib/textmap";

export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

export const QUOTE_MAX_BYTES = 4096;
const CONTEXT_CHARS = 100;

/** Offset in the segment text of a point inside a mapped unit. */
export function offsetOf(mapping: TextMapping, [unit, off]: UnitPoint): number | null {
  const e = mapping.units.find(([, i]) => i === unit);
  if (!e || off < 0 || off > e[2]) return null;
  return e[0] + off;
}

/**
 * The unit point for a segment offset. An offset inside a separator snaps
 * forward to the next unit's start ("start") or back to the previous unit's end ("end").
 */
export function pointAt(mapping: TextMapping, offset: number, bias: "start" | "end"): UnitPoint | null {
  const units = mapping.units;
  if (bias === "start") {
    for (const [start, i, len] of units) if (offset < start + len) return [i, Math.max(0, offset - start)];
    return null;
  }
  for (let k = units.length - 1; k >= 0; k--) {
    const [start, i, len] = units[k];
    if (offset > start) return [i, Math.min(len, offset - start)];
  }
  return null;
}

export type QuoteMatch = { start: number; end: number } | "none" | "ambiguous";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function commonPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}
const commonSuffix = (a: string, b: string) => commonPrefix([...a].reverse().join(""), [...b].reverse().join(""));

/**
 * Finds a stored quote in section text, tolerating whitespace differences.
 * Several matches are told apart by how much of the stored context surrounds
 * each; a tie stays ambiguous.
 */
export function findQuote(text: string, quote: string, context: string | null): QuoteMatch {
  const words = collapse(quote).split(" ").filter(Boolean);
  if (!words.length) return "none";
  const matches = [...text.matchAll(new RegExp(words.map(escape).join("\\s+"), "g"))].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  if (matches.length === 0) return "none";
  if (matches.length === 1) return matches[0];
  const ctx = collapse(context ?? "");
  const q = collapse(quote);
  const center = (ctx.length - q.length) / 2;
  let at = -1;
  for (let i = ctx.indexOf(q); i >= 0; i = ctx.indexOf(q, i + 1)) {
    if (at < 0 || Math.abs(i - center) < Math.abs(at - center)) at = i;
  }
  if (at < 0) return "ambiguous";
  const before = ctx.slice(0, at).trim();
  const after = ctx.slice(at + q.length).trim();
  const scored = matches
    .map((m) => ({
      m,
      score:
        commonSuffix(collapse(text.slice(Math.max(0, m.start - before.length * 2 - 16), m.start)), before) +
        commonPrefix(collapse(text.slice(m.end, m.end + after.length * 2 + 16)), after),
    }))
    .sort((a, b) => b.score - a.score);
  if (scored[0].score === 0 || scored[0].score === scored[1].score) return "ambiguous";
  return scored[0].m;
}

/** Whitespace-collapsed quote cut to at most QUOTE_MAX_BYTES of UTF-8. */
export function boundQuote(s: string): string {
  let q = collapse(s);
  const enc = new TextEncoder();
  while (enc.encode(q).length > QUOTE_MAX_BYTES) q = q.slice(0, Math.floor(q.length * 0.9));
  return q;
}

/** True when a range's text is the stored quote, or begins with it when the quote was cut at its bound. */
export function quoteMatches(rangeText: string, quote: string): boolean {
  const r = collapse(rangeText);
  const q = collapse(quote);
  if (!q) return false;
  if (r === q) return true;
  return new TextEncoder().encode(q).length >= QUOTE_MAX_BYTES * 0.8 && r.startsWith(q);
}

export function contextAround(text: string, start: number, end: number): string {
  return collapse(text.slice(Math.max(0, start - CONTEXT_CHARS), end + CONTEXT_CHARS));
}

/** A section document's indexed text with the text nodes it came from. */
export interface SectionText {
  doc: Document;
  nodes: Text[];
  indexOf: Map<Text, number>;
  text: string;
  mapping: TextMapping;
}

const cache = new WeakMap<Document, SectionText>();

/** Section text is fixed for a document's lifetime, so it is computed once per document. */
export function sectionText(doc: Document): SectionText {
  let st = cache.get(doc);
  if (!st) {
    const nodes = epubTextNodes(doc);
    const { text, mapping } = buildSegment(epubUnits(nodes));
    st = { doc, nodes, indexOf: new Map(nodes.map((n, i) => [n, i])), text, mapping };
    cache.set(doc, st);
  }
  return st;
}

export function rangeFromPoints(st: SectionText, start: UnitPoint, end: UnitPoint): Range | null {
  const a = st.nodes[start[0]];
  const b = st.nodes[end[0]];
  if (!a || !b || start[1] > a.length || end[1] > b.length) return null;
  const range = st.doc.createRange();
  try {
    range.setStart(a, start[1]);
    range.setEnd(b, end[1]);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

export function rangeFromOffsets(st: SectionText, start: number, end: number): Range | null {
  const a = pointAt(st.mapping, start, "start");
  const b = pointAt(st.mapping, end, "end");
  return a && b ? rangeFromPoints(st, a, b) : null;
}

function offsetOfBoundary(st: SectionText, container: Node, offset: number): number | null {
  let from: number;
  let off = 0;
  const own = container.nodeType === Node.TEXT_NODE ? st.indexOf.get(container as Text) : undefined;
  if (own !== undefined) {
    from = own;
    off = offset;
  } else {
    const probe = st.doc.createRange();
    probe.setStart(container, offset);
    from = st.nodes.findIndex((n) => probe.comparePoint(n, 0) >= 0);
    if (from < 0) return st.text.length;
  }
  const e = st.mapping.units.find(([, i]) => i >= from);
  if (!e) return st.text.length;
  return e[1] === from ? e[0] + Math.min(off, e[2]) : e[0];
}

/** The range's [start, end) in the section's indexed text. */
export function offsetsOfRange(st: SectionText, range: Range): [number, number] | null {
  if (range.startContainer.ownerDocument !== st.doc && range.startContainer !== st.doc) return null;
  const s = offsetOfBoundary(st, range.startContainer, range.startOffset);
  const e = offsetOfBoundary(st, range.endContainer, range.endOffset);
  return s === null || e === null || e < s ? null : [s, e];
}
