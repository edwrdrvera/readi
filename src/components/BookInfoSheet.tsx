import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, type Availability, type BookSummary } from "@/lib/api";
import { extraction } from "@/lib/extraction";
import { useApp } from "@/lib/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const AVAILABILITY: Record<Availability, { label: string; detail: string | null }> = {
  available: { label: "Available", detail: null },
  folder_unavailable: { label: "Folder unavailable", detail: "The folder is missing or its disk is not connected" },
  permission_denied: { label: "Permission denied", detail: "Readi can't read this file. Check its permissions in Finder" },
  moved: { label: "Moved or deleted", detail: "Nothing is at this path any more" },
};

export function BookInfoSheet() {
  const id = useApp((s) => s.infoBookId);
  const book = useApp((s) => s.books.find((b) => b.id === s.infoBookId));
  const locations = useApp((s) => (id === null ? undefined : s.locations[id]));
  const showBookInfo = useApp((s) => s.showBookInfo);
  const locateBook = useApp((s) => s.locateBook);
  const [error, setError] = useState<string | null>(null);

  const locate = async () => {
    if (id === null) return;
    const picked = await open({ multiple: false, filters: [{ name: "Books", extensions: ["epub", "pdf"] }] });
    if (typeof picked !== "string") return;
    setError(await locateBook(id, picked));
  };

  return (
    <Sheet
      open={id !== null}
      onOpenChange={(o) => {
        if (!o) {
          showBookInfo(null);
          setError(null);
        }
      }}
    >
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{book?.title ?? "Book Info"}</SheetTitle>
          <SheetDescription>{book ? book.authors.join(", ") || "Unknown author" : ""}</SheetDescription>
        </SheetHeader>
        {book && (
          <div className="flex flex-col gap-4 px-4 pb-6 text-sm">
            {!book.available && (
              <p role="alert" className="rounded-md border border-destructive/40 p-3">
                Readi can't find a readable copy of this book. Locate the file to keep reading; your progress is kept.
              </p>
            )}
            <section className="flex flex-col gap-2">
              <h3 className="font-semibold">Locations</h3>
              {locations === undefined ? (
                <p className="text-muted-foreground">Loading…</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {locations.map((l) => {
                    const a = AVAILABILITY[l.availability];
                    return (
                      <li key={l.id} className="flex flex-col gap-1" data-availability={l.availability}>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{l.kind === "managed" ? "Readi’s copy" : "Watched folder"}</Badge>
                          <Badge variant={l.availability === "available" ? "secondary" : "destructive"}>{a.label}</Badge>
                        </div>
                        <code className="text-xs break-all text-muted-foreground">{l.path}</code>
                        {a.detail && <span className="text-xs">{a.detail}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <SearchIndex book={book} />
            <div className="flex flex-col gap-1.5">
              <Button variant="outline" className="self-start" onClick={() => void locate()}>
                Locate…
              </Button>
              {error && (
                <p role="alert" className="text-xs text-destructive">
                  {error}
                </p>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

const INDEX_TEXT: Record<BookSummary["index_state"], string> = {
  queued: "Waiting to be indexed. Search results may be incomplete until it finishes.",
  indexing: "Indexing. Search results may be incomplete until it finishes.",
  ready: "Ready.",
  no_searchable_text: "This book has no searchable text (for example, a scanned PDF).",
  failed: "Indexing failed.",
};

function SearchIndex({ book }: { book: BookSummary }) {
  const mutate = useApp((s) => s.mutate);
  const run = (label: string, fn: () => Promise<void>) =>
    void mutate(label, fn).then((ok) => {
      if (ok) extraction.kick();
    });
  return (
    <section className="flex flex-col gap-2" data-testid="book-index" data-state={book.index_state}>
      <h3 className="font-semibold">Search index</h3>
      <p className={book.index_state === "failed" ? "text-destructive" : "text-muted-foreground"}>{INDEX_TEXT[book.index_state]}</p>
      <div className="flex gap-2">
        {book.index_state === "failed" && (
          <Button variant="outline" size="sm" data-testid="index-retry" onClick={() => run("Could not retry indexing", () => api.retryExtraction(book.id))}>
            Retry
          </Button>
        )}
        {(book.index_state === "ready" || book.index_state === "no_searchable_text") && (
          <Button variant="outline" size="sm" data-testid="index-rebuild" onClick={() => run("Could not rebuild the search index", () => api.reindexBook(book.id))}>
            Rebuild search index
          </Button>
        )}
      </div>
    </section>
  );
}
