import { useMemo } from "react";
import { applyView, effectiveView } from "@/lib/libraryView";
import { useApp } from "@/lib/store";
import { BookCard } from "./BookCard";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryFilters, LibraryTopBar } from "./LibraryToolbar";

export function Library() {
  const books = useApp((s) => s.books);
  const stored = useApp((s) => s.uiSettings.library);
  const collections = useApp((s) => s.collections);
  const view = useMemo(() => effectiveView(stored), [stored]);
  const shown = useMemo(() => applyView(books, view), [books, view]);
  const title = collections.find((c) => c.id === view.collection_id)?.name ?? (view.format === "pdf" ? "Drawer" : "Library");
  return (
    <div className="flex h-full">
      <LibrarySidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <LibraryTopBar title={title} />
        <LibraryFilters />
        <div className="flex-1 overflow-y-auto px-10 pt-5 pb-10">
          {books.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">Drop EPUB or PDF files here, or press ⌘O to import.</p>
          ) : shown.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No books match these filters.</p>
          ) : (
            <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-3 gap-y-5">
              {shown.map((b) => (
                <BookCard key={b.id} book={b} />
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
