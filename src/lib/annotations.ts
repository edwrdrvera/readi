import type { Anchor, Annotation, AnchorState, BookSearch, SearchGroup } from "./api";

export const byReadingOrder = (list: Annotation[]) => [...list].sort((a, b) => a.sort_key - b.sort_key || a.id - b.id);

/** Case-insensitive match over quotes and notes; every whitespace-separated term must appear. */
/** A PDF bookmark is per page; an EPUB one matches within 1% of the same section, so a nudge of the scroll position still counts as the same spot. */
export function sameSpot(a: Pick<Annotation, "anchor" | "sort_key">, b: { anchor: Anchor; sort_key: number }): boolean {
  if (a.anchor.type !== "position" || b.anchor.type !== "position") return false;
  const [x, y] = [a.anchor.locator, b.anchor.locator];
  if (x.format === "pdf" && y.format === "pdf") return x.page_index === y.page_index;
  if (x.format === "epub" && y.format === "epub") return x.section_index === y.section_index && Math.abs(a.sort_key - b.sort_key) < 0.01;
  return false;
}

export function filterAnnotations(list: Annotation[], query: string): Annotation[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return list;
  return list.filter((a) => {
    const hay = `${a.quote ?? ""}\n${a.note ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

export function applyAnchorStates(list: Annotation[], states: Array<[number, AnchorState]>): Annotation[] {
  const m = new Map(states);
  return list.map((a) => (m.has(a.id) && m.get(a.id) !== a.anchor_state ? { ...a, anchor_state: m.get(a.id)! } : a));
}

/** Where a bookmark or highlight is, for lists: "Page N" for PDF, otherwise the section position. */
export function positionLabel(a: Annotation): string {
  const anchor = a.anchor;
  if (anchor.type === "pdf_quads") return `Page ${anchor.page_index + 1}`;
  if (anchor.type === "position" && anchor.locator.format === "pdf") return `Page ${anchor.locator.page_index + 1}`;
  const section = anchor.type === "epub_range" ? anchor.section_index : anchor.type === "position" && anchor.locator.format === "epub" ? anchor.locator.section_index : 0;
  return `Section ${section + 1}`;
}

export type SearchStatus = "idle" | "loading" | "indexing" | "no_text" | "failed" | "no_matches" | "results";

/** What the search panel shows for a result. Only a ready index turns an empty result into "No matches". */
export function searchStatus(query: string, result: BookSearch | null): SearchStatus {
  if (query.trim() === "") return "idle";
  if (!result) return "loading";
  switch (result.index_state) {
    case "queued":
    case "indexing":
      return "indexing";
    case "no_searchable_text":
      return "no_text";
    case "failed":
      return "failed";
    case "ready":
      return result.groups.length === 0 ? "no_matches" : "results";
  }
}

export const groupLabel = (g: SearchGroup, format: "epub" | "pdf") => (format === "pdf" ? `Page ${g.order + 1}` : g.label || `Section ${g.order + 1}`);

export const hitCount = (r: BookSearch) => r.groups.reduce((n, g) => n + g.hits.length, 0);

/** Status lines for library search, such as "3 books still indexing. Results may be incomplete". */
export function libraryStatusLines(s: { indexing: number; no_text: number; failed: number }): string[] {
  const books = (n: number) => `${n} ${n === 1 ? "book" : "books"}`;
  const out: string[] = [];
  if (s.indexing) out.push(`${books(s.indexing)} still indexing. Results may be incomplete`);
  if (s.no_text) out.push(`${books(s.no_text)} with no searchable text`);
  if (s.failed) out.push(`${books(s.failed)} could not be indexed`);
  return out;
}
