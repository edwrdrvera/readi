import { describe, expect, it } from "vitest";
import type { Annotation, BookSearch } from "./api";
import { applyAnchorStates, byReadingOrder, filterAnnotations, libraryStatusLines, sameSpot, searchStatus } from "./annotations";

const ann = (id: number, sort_key: number, quote: string | null, note: string | null, anchor_state: Annotation["anchor_state"] = "resolved"): Annotation => ({
  id,
  book_id: 1,
  kind: quote ? "highlight" : "bookmark",
  anchor: { type: "pdf_quads", v: 1, page_index: 0, quads: [] },
  quote,
  context: null,
  color: quote ? "yellow" : null,
  note,
  sort_key,
  anchor_state,
  created_at: 0,
  updated_at: 0,
});

describe("annotation filter", () => {
  const list = [ann(1, 2, "The Whale surfaced", null), ann(2, 1, "a quiet harbor", "Remember THIS", "unresolved"), ann(3, 3, null, null)];

  it("matches quotes and notes case-insensitively, including unresolved ones", () => {
    expect(filterAnnotations(list, "whale").map((a) => a.id)).toEqual([1]);
    expect(filterAnnotations(list, "this").map((a) => a.id)).toEqual([2]);
    expect(filterAnnotations(list, "harbor remember").map((a) => a.id)).toEqual([2]);
    expect(filterAnnotations(list, "  ")).toBe(list);
  });

  it("orders by reading position", () => {
    expect(byReadingOrder(list).map((a) => a.id)).toEqual([2, 1, 3]);
  });

  it("applies resolved states without touching others", () => {
    const next = applyAnchorStates(list, [[1, "unresolved"]]);
    expect(next[0].anchor_state).toBe("unresolved");
    expect(next[1]).toBe(list[1]);
  });
});

describe("search status", () => {
  const r = (index_state: BookSearch["index_state"], hits: number): BookSearch => ({
    index_state,
    truncated: false,
    groups: hits ? [{ order: 0, label: null, hits: [] }] : [],
  });

  it("keeps indexing, no text, failed, and no matches distinct", () => {
    expect(searchStatus("", null)).toBe("idle");
    expect(searchStatus("x", null)).toBe("loading");
    expect(searchStatus("x", r("indexing", 0))).toBe("indexing");
    expect(searchStatus("x", r("queued", 1))).toBe("indexing");
    expect(searchStatus("x", r("no_searchable_text", 0))).toBe("no_text");
    expect(searchStatus("x", r("failed", 0))).toBe("failed");
    expect(searchStatus("x", r("ready", 0))).toBe("no_matches");
    expect(searchStatus("x", r("ready", 1))).toBe("results");
  });

  it("describes library index counts", () => {
    expect(libraryStatusLines({ indexing: 3, no_text: 1, failed: 0 })).toEqual([
      "3 books still indexing. Results may be incomplete",
      "1 book with no searchable text",
    ]);
    expect(libraryStatusLines({ indexing: 0, no_text: 0, failed: 0 })).toEqual([]);
  });
});

describe("sameSpot", () => {
  const pdf = (page_index: number, y: number) => ({ anchor: { type: "position" as const, locator: { format: "pdf" as const, v: 1 as const, page_index, x: 0, y } }, sort_key: page_index + y / 1000 });
  const epub = (section_index: number, f: number) => ({ anchor: { type: "position" as const, locator: { format: "epub" as const, v: 1 as const, cfi: `/6/${section_index}!/4/${f}`, section_index, section_fraction: f } }, sort_key: section_index + f });

  it("treats any scroll position on the same PDF page as the same spot", () => {
    expect(sameSpot(pdf(6, 792), pdf(6, 400))).toBe(true);
    expect(sameSpot(pdf(6, 792), pdf(7, 792))).toBe(false);
  });

  it("matches EPUB positions within 1% of the same section only", () => {
    expect(sameSpot(epub(2, 0.5), epub(2, 0.505))).toBe(true);
    expect(sameSpot(epub(2, 0.5), epub(2, 0.53))).toBe(false);
    expect(sameSpot(epub(2, 0.999), epub(3, 0.0))).toBe(false);
  });

  it("never matches a highlight", () => {
    const h = { anchor: { type: "pdf_quads" as const, v: 1 as const, page_index: 6, quads: [] }, sort_key: 6 };
    expect(sameSpot(h, pdf(6, 0))).toBe(false);
  });
});
