import { describe, expect, it } from "vitest";
import type { BookSummary, LibraryView } from "./api";
import { applyView, authorsOf, DEFAULT_VIEW } from "./libraryView";

function book(id: number, over: Partial<BookSummary> = {}): BookSummary {
  return {
    id,
    sha256: `h${id}`,
    format: "epub",
    title: `Book ${id}`,
    authors: [],
    reading_state: "unread",
    metadata_ready: true,
    index_state: "ready",
    file_size: 1,
    added_at: 100,
    opened_at: null,
    available: true,
    has_cover: false,
  percent: null,
    collection_ids: [],
    ...over,
  };
}

const ids = (books: BookSummary[], view: Partial<LibraryView>) => applyView(books, { ...DEFAULT_VIEW, ...view }).map((b) => b.id);

describe("filters", () => {
  const books = [
    book(1, { format: "pdf", authors: ["Ann", "Bo"], reading_state: "finished", collection_ids: [7] }),
    book(2, { authors: ["Annie"], reading_state: "reading", available: false }),
    book(3, { collection_ids: [8] }),
  ];
  it("filters by format", () => expect(ids(books, { format: "pdf" })).toEqual([1]));
  it("matches any author exactly", () => {
    expect(ids(books, { author: "Bo" })).toEqual([1]);
    expect(ids(books, { author: "Ann" })).toEqual([1]);
  });
  it("filters by reading state", () => expect(ids(books, { reading_state: "reading" })).toEqual([2]));
  it("filters missing and available", () => {
    expect(ids(books, { availability: "missing" })).toEqual([2]);
    expect(ids(books, { availability: "available", sort: "title" })).toEqual([1, 3]);
  });
  it("filters by collection", () => expect(ids(books, { collection_id: 8 })).toEqual([3]));
  it("combines filters", () => expect(ids(books, { format: "pdf", reading_state: "unread" })).toEqual([]));
});

describe("sorts", () => {
  it("recent uses opened_at, else added_at, newest first", () => {
    const books = [book(1, { added_at: 50, opened_at: 300 }), book(2, { added_at: 200 }), book(3, { added_at: 400 })];
    expect(ids(books, { sort: "recent" })).toEqual([3, 1, 2]);
  });
  it("title ignores case and orders numbers naturally", () => {
    const books = [book(1, { title: "vol 10" }), book(2, { title: "Vol 2" }), book(3, { title: "apple" })];
    expect(ids(books, { sort: "title" })).toEqual([3, 2, 1]);
  });
  it("author sorts by first author, unknown last, then title", () => {
    const books = [
      book(1, { title: "B", authors: ["Zed"] }),
      book(2, { title: "A", authors: [] }),
      book(3, { title: "Z", authors: ["amy"] }),
      book(4, { title: "C", authors: ["Amy", "Zed"] }),
    ];
    expect(ids(books, { sort: "author" })).toEqual([4, 3, 1, 2]);
  });
  it("added is newest first", () => {
    const books = [book(1, { added_at: 1 }), book(2, { added_at: 3 }), book(3, { added_at: 2 })];
    expect(ids(books, { sort: "added" })).toEqual([2, 3, 1]);
  });
  it("breaks ties by id in every sort", () => {
    const books = [book(3, { title: "Same" }), book(1, { title: "same" }), book(2, { title: "SAME" })];
    for (const sort of ["recent", "title", "author", "added"] as const) expect(ids(books, { sort })).toEqual([1, 2, 3]);
  });
});

it("authorsOf lists distinct authors in order", () => {
  expect(authorsOf([book(1, { authors: ["b", "A"] }), book(2, { authors: ["A"] })])).toEqual(["A", "b"]);
});
