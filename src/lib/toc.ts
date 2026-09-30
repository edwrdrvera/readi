import type { BookDetail, TocItem } from "./api";
import type { ReaderPosition } from "./store";

export const flattenToc = (items: TocItem[]): TocItem[] => items.flatMap((i) => [i, ...flattenToc(i.children)]);

/** The contents entry for where the reader is: EPUB by relocate href or section, PDF by the last entry at or before the page. */
export function activeTocItem(detail: BookDetail, flat: TocItem[], position: ReaderPosition, pdfPage: number | null): TocItem | null {
  if (detail.book.format === "pdf") {
    return pdfPage === null ? null : (flat.filter((t) => Number(t.target) <= pdfPage).at(-1) ?? null);
  }
  return (position.tocHref && flat.find((t) => t.target === position.tocHref)) || flat.find((t) => t.target === String(position.sectionIndex)) || null;
}

export type TocSection = "front" | "body" | "back";
export interface TocEntry {
  section: TocSection;
  /** "12" for "Chapter 12: The Summons"; null when the label carries no number. */
  number: string | null;
  title: string;
}

const NUMBERED = /^(?:chapter|ch\.|part|book)\s+(\d+|[ivxlcdm]+)\b\s*[:.\-]?\s*(.*)$/i;
const BARE_NUMBER = /^(\d+)[.:)]\s+(.+)$/;

function parseLabel(label: string): { number: string | null; title: string } {
  const m = label.match(NUMBERED) ?? label.match(BARE_NUMBER);
  if (!m) return { number: null, title: label };
  return { number: m[1].toUpperCase(), title: m[2] || label };
}

/**
 * Top-level entries before the first numbered one are front matter and after
 * the last are back matter. Many EPUBs ship a flat list, so this is the only
 * hierarchy they have. Without any numbered entry, everything is body.
 */
export function outlineToc(items: TocItem[]): Map<TocItem, TocEntry> {
  const parsed = items.map((i) => parseLabel(i.label));
  const first = parsed.findIndex((p) => p.number !== null);
  const last = parsed.findLastIndex((p) => p.number !== null);
  return new Map(
    items.map((item, i) => {
      const section: TocSection = first === -1 || (i >= first && i <= last) ? "body" : i < first ? "front" : "back";
      return [item, { section, ...parsed[i] }];
    }),
  );
}
