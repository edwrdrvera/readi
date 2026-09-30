import { useState } from "react";
import { X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api, type Availability, type BookSummary } from "@/lib/api";
import { extraction } from "@/lib/extraction";
import { closeBookInfo } from "@/lib/commands";
import { useApp } from "@/lib/store";
import { useExit } from "@/lib/useExit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const AVAILABILITY: Record<Availability, { label: string; detail: string | null }> = {
  available: { label: "Available", detail: null },
  folder_unavailable: { label: "Folder unavailable", detail: "The folder is missing or its disk is not connected" },
  permission_denied: { label: "Permission denied", detail: "Readi can't read this file. Check its permissions in Finder" },
  moved: { label: "Moved or deleted", detail: "Nothing is at this path any more" },
};

const Heading = ({ children }: { children: React.ReactNode }) => <h3 className="text-[11px] font-semibold tracking-[.02em] text-muted-foreground">{children}</h3>;

/** Book details docked beside the grid. */
export function BookInfoPanel() {
  const { shown: id, leaving } = useExit(useApp((s) => s.infoBookId), 150);
  const book = useApp((s) => s.books.find((b) => b.id === id));
  const locations = useApp((s) => (id === null ? undefined : s.locations[id]));
  const locateBook = useApp((s) => s.locateBook);
  const openBook = useApp((s) => s.openBook);
  const inReader = useApp((s) => s.screen.name === "reader" && s.screen.detail.book.id === id);
  const [error, setError] = useState<{ id: number; text: string } | null>(null);
  if (id === null) return null;

  const locate = async () => {
    const picked = await open({ multiple: false, filters: [{ name: "Books", extensions: ["epub", "pdf"] }] });
    if (typeof picked !== "string") return;
    const text = await locateBook(id, picked);
    setError(text === null ? null : { id, text });
  };
  const readable = locations?.find((l) => l.availability === "available");

  return (
    <aside aria-label="Book info" data-testid="book-info" data-leaving={leaving || undefined} inert={leaving} className="info-panel flex w-[300px] shrink-0 flex-col border-l bg-background">
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b pr-2 pl-[18px]">
        <h2 className="text-[13px] font-semibold">Info</h2>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Close info" onClick={closeBookInfo}>
          <X />
        </Button>
      </header>
      {book && (
        <div className="flex flex-col gap-[22px] overflow-y-auto px-[18px] pt-[18px] pb-6 text-[13px]">
          <div className="flex flex-col gap-1">
            <p className="font-semibold">{book.title}</p>
            <p className="text-muted-foreground">{book.authors.join(", ") || "Unknown author"}</p>
          </div>
          <div className="flex gap-2">
            {!inReader && (
              <Button size="sm" disabled={!book.available} onClick={() => void openBook(book.id)}>
                Open
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={!readable} onClick={() => readable && void revealItemInDir(readable.path)}>
              Show in Finder
            </Button>
          </div>
          {!book.available && (
            <p role="alert" className="rounded-md border border-destructive/40 p-3">
              Readi can't find a readable copy of this book. Locate the file to keep reading. Your progress is kept.
            </p>
          )}
          <section className="flex flex-col gap-2">
            <Heading>Locations</Heading>
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
            <Button variant="outline" size="sm" className="self-start" onClick={() => void locate()}>
              Locate…
            </Button>
            {error?.id === id && (
              <p role="alert" className="text-xs text-destructive">
                {error.text}
              </p>
            )}
          </div>
        </div>
      )}
    </aside>
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
      <Heading>Search index</Heading>
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
