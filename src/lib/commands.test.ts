import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookSummary } from "./api";
import { commandContext, commands, paletteCommands, paletteItems } from "./commands";
import { useApp } from "./store";

// Extraction pulls in foliate-js, which needs a DOM.
vi.mock("./extraction", () => ({}));

const book = (id: number, title: string, reading_state: BookSummary["reading_state"], collection_ids: number[] = []): BookSummary => ({
  id,
  sha256: String(id),
  format: "pdf",
  title,
  authors: [],
  reading_state,
  metadata_ready: true,
  index_state: "ready",
  file_size: 1,
  added_at: id,
  opened_at: null,
  available: true,
  has_cover: false,
  collection_ids,
});

describe("palette book commands in the Library", () => {
  beforeEach(() => {
    useApp.setState({
      screen: { name: "library" },
      books: [book(1, "Dune", "unread", [5]), book(2, "Emma", "finished")],
      collections: [{ id: 5, name: "Picks", kind: "manual", watched_folder_id: null }],
      focusedBookId: null,
    });
  });

  const labels = () => paletteCommands(commandContext()).map((c) => [c.id, c.label]);

  it("offers no book actions without a focused card", () => {
    expect(labels().filter(([id]) => id.startsWith("book.") || id.startsWith("collection.add") || id.startsWith("collection.remove"))).toEqual([]);
  });

  it("targets the focused card and names it", () => {
    useApp.setState({ focusedBookId: 1 });
    expect(labels()).toEqual(expect.arrayContaining([
      ["book.finished", "Mark as Finished: Dune"],
      ["collection.remove.5", "Remove from Picks: Dune"],
    ]));
    expect(labels().some(([id]) => id === "book.unread")).toBe(false);

    useApp.setState({ focusedBookId: 2 });
    expect(labels()).toEqual(expect.arrayContaining([
      ["book.unread", "Mark as Unread: Emma"],
      ["collection.add.5", "Add to Picks: Emma"],
    ]));
    expect(labels().some(([id]) => id === "book.finished")).toBe(false);
  });

  it("ignores a focused id that is no longer in the library", () => {
    useApp.setState({ focusedBookId: 9 });
    expect(commandContext().targetBookId).toBeNull();
  });
});

describe("M4 chords", () => {
  const chords = (c: (typeof commands)[number]) => c.shortcuts.map((s) => `${s.meta ? "⌘" : ""}${s.shift ? "⇧" : ""}${s.key.toLowerCase()}`);

  it("binds ⌘F, ⌘⇧F, and ⌘D to keydown, not the menu", () => {
    const find = (id: string) => commands.find((c) => c.id === id)!;
    expect(find("search.book").shortcuts).toEqual([{ key: "f", meta: true }]);
    expect(find("search.library").shortcuts).toEqual([{ key: "f", meta: true, shift: true }]);
    expect(find("bookmark.add").shortcuts).toEqual([{ key: "d", meta: true }]);
  });

  it("gives every chord to exactly one command", () => {
    const all = commands.flatMap(chords);
    expect(all.length).toBe(new Set(all).size);
  });

  it("offers Add Bookmark in the palette only with an open reader", () => {
    useApp.setState({ screen: { name: "library" } });
    expect(paletteItems().some((c) => c.id === "bookmark.add")).toBe(false);
    expect(paletteItems().some((c) => c.id === "search.library")).toBe(true);
  });
});
