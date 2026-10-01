import { useMemo } from "react";
import { applyView, continueReading, effectiveView } from "@/lib/libraryView";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { BookCard, Cover, percentLabel } from "./BookCard";
import { BookInfoPanel } from "./BookInfoPanel";
import { DrawerTable } from "./DrawerTable";
import { LibraryShelf } from "./LibraryShelf";
import { LibrarySidebar } from "./LibrarySidebar";
import { LibraryFilters, LibraryTopBar } from "./LibraryToolbar";
import { OmniboxProvider, OmniboxResults } from "./Omnibox";

function ContinueReading() {
  const books = useApp((s) => s.books);
  const openBook = useApp((s) => s.openBook);
  const book = useMemo(() => continueReading(books), [books]);
  if (!book) return null;
  const percent = percentLabel(book.percent);
  return (
    <section className="mb-9">
      <h2 className="mb-3.5 text-xs text-muted-foreground">Continue reading</h2>
      <button
        onClick={() => void openBook(book.id)}
        aria-label={`Continue reading ${book.title}`}
        className="flex w-full max-w-[520px] items-center gap-5 rounded-lg border bg-popover p-4 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Cover book={book} small className="w-16 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-semibold">{book.title}</span>
          <span className="truncate text-xs text-muted-foreground">{book.authors.join(", ") || "Unknown author"}</span>
          <span className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted">
            <span className="block h-1 bg-primary" style={{ width: percent }} />
          </span>
          <span className="text-[11px] text-muted-foreground">{percent}</span>
        </span>
      </button>
    </section>
  );
}

export function Library() {
  const books = useApp((s) => s.books);
  const stored = useApp((s) => s.uiSettings.library);
  const collections = useApp((s) => s.collections);
  const searching = useApp((s) => s.search.open);
  const shelf = useApp((s) => s.uiSettings.library_layout === "shelf");
  const view = useMemo(() => effectiveView(stored), [stored]);
  const shown = useMemo(() => applyView(books, view), [books, view]);
  const collection = collections.find((c) => c.id === view.collection_id);
  const drawer = view.format === "pdf";
  const title = collection?.name ?? (drawer ? "Drawer" : "Library");
  const empty =
    books.length === 0 ? "Drop EPUB or PDF files here, or press ⌘O to import." : shown.length === 0 ? "No books match these filters." : null;
  return (
    <div className="flex h-full">
      <LibrarySidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <OmniboxProvider scope="library">
          <LibraryTopBar title={title} />
          {searching ? <OmniboxResults /> : <LibraryFilters />}
        </OmniboxProvider>
        <div className={cn("flex-1 overflow-y-auto px-10 pt-5 pb-10", searching && "hidden")}>
          {!collection && !drawer && <ContinueReading />}
          {empty ? (
            <p className="text-[13px] text-muted-foreground">{empty}</p>
          ) : drawer ? (
            <DrawerTable books={shown} />
          ) : (
            <>
              {!collection && <h2 className="mb-3.5 text-xs text-muted-foreground">All books</h2>}
              {shelf ? (
                <LibraryShelf books={shown} />
              ) : (
              <ul className="grid list-none grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-7 gap-y-8 2xl:grid-cols-6">
                {shown.map((b) => (
                  <BookCard key={b.id} book={b} />
                ))}
              </ul>
              )}
            </>
          )}
        </div>
      </main>
      <BookInfoPanel />
    </div>
  );
}
