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
