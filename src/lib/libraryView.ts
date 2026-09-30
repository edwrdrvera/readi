import type { BookSummary, LibraryView } from "./api";

export const DEFAULT_VIEW: LibraryView = {
  sort: "recent",
  format: null,
  author: null,
  reading_state: null,
  availability: null,
  collection_id: null,
};

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

type Compare = (a: BookSummary, b: BookSummary) => number;

const byTitle: Compare = (a, b) => collator.compare(a.title, b.title);

const byAuthor: Compare = (a, b) => {
  const x = a.authors[0];
  const y = b.authors[0];
  if (x === undefined || y === undefined) return (x === undefined ? 1 : 0) - (y === undefined ? 1 : 0);
  return collator.compare(x, y);
};

const recency = (b: BookSummary) => b.opened_at ?? b.added_at;

const SORTS: Record<LibraryView["sort"], Compare[]> = {
  recent: [(a, b) => recency(b) - recency(a)],
  title: [byTitle],
  author: [byAuthor, byTitle],
  added: [(a, b) => b.added_at - a.added_at],
};

export function matchesView(b: BookSummary, view: LibraryView): boolean {
  return (
    (view.format === null || b.format === view.format) &&
    (view.author === null || b.authors.includes(view.author)) &&
    (view.reading_state === null || b.reading_state === view.reading_state) &&
    (view.availability === null || b.available === (view.availability === "available")) &&
    (view.collection_id === null || b.collection_ids.includes(view.collection_id))
  );
}

export function applyView(books: BookSummary[], view: LibraryView): BookSummary[] {
  const keys = [...SORTS[view.sort], (a: BookSummary, b: BookSummary) => a.id - b.id];
  return books
    .filter((b) => matchesView(b, view))
    .sort((a, b) => {
      for (const k of keys) {
        const d = k(a, b);
        if (d !== 0) return d;
      }
      return 0;
    });
}

export function authorsOf(books: BookSummary[]): string[] {
  return [...new Set(books.flatMap((b) => b.authors))].sort(collator.compare);
}

/** True when a filter other than the collection or format hides some books. */
export const hasFilters = (view: LibraryView) => view.author !== null || view.reading_state !== null || view.availability !== null;

/** The sidebar nav owns format: Library is EPUBs, Drawer is PDFs. A stored view
 * from before the nav (no collection, no format) opens on Library. */
export const effectiveView = (view: LibraryView): LibraryView =>
  view.collection_id === null && view.format === null ? { ...view, format: "epub" } : view;

/** Most recently opened EPUB the user is partway through. */
export const continueReading = (books: BookSummary[]): BookSummary | undefined =>
  books
    .filter((b) => b.format === "epub" && b.reading_state === "reading" && b.opened_at !== null)
    .reduce<BookSummary | undefined>((best, b) => (best && best.opened_at! >= b.opened_at! ? best : b), undefined);
