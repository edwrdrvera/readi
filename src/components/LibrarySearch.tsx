import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type LibrarySearch as Result, type SearchHit } from "@/lib/api";
import { libraryStatusLines } from "@/lib/annotations";
import { takeLibrarySearchOpener } from "@/lib/commands";
import { openBookAt } from "@/lib/jumps";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Snippet } from "./Snippet";

const DEBOUNCE_MS = 150;

type Option = { key: string; bookId: number; hit: SearchHit | null };

/** ⌘⇧F from anywhere: title, author, and text matches across the library. */
export function LibrarySearch() {
  const open = useApp((s) => s.librarySearchOpen);
  const setOpen = useApp((s) => s.setLibrarySearchOpen);
  const indexStates = useApp((s) => s.books.map((b) => b.index_state).join());
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const opening = useRef(false);

  useEffect(() => {
    if (!open || query.trim() === "") return setResult(null);
    let live = true;
    const t = setTimeout(() => {
      api
        .searchLibrary(query)
        .then((r) => live && (setResult(r), setError(null)))
        .catch((e) => live && setError(String(e)));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [open, query, indexStates]);

  const options = useMemo<Option[]>(
    () =>
      (result?.results ?? []).flatMap((r) => [
        ...(r.metadata_match || r.hits.length === 0 ? [{ key: `${r.book.id}-book`, bookId: r.book.id, hit: null }] : []),
        ...r.hits.map((hit, i) => ({ key: `${r.book.id}-${i}`, bookId: r.book.id, hit })),
      ]),
    [result],
  );
  useEffect(() => setActive(0), [result]);

  const choose = (o: Option) => {
    opening.current = true;
    setOpen(false);
    void openBookAt(o.bookId, o.hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (options.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      setActive(next);
      document.getElementById(`libsearch-${options[next].key}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(options[active]);
    }
  };

  const status = result ? libraryStatusLines(result) : [];
  const optionProps = (o: Option) => {
    const i = options.indexOf(o);
    return {
      id: `libsearch-${o.key}`,
      role: "option" as const,
      "aria-selected": i === active,
      "data-active": i === active,
      tabIndex: -1,
      onMouseMove: () => setActive(i),
      onClick: () => choose(o),
      className: cn("flex w-full cursor-default flex-col gap-0.5 rounded-md px-2 py-1.5 text-left", i === active && "bg-accent text-accent-foreground"),
    };
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) opening.current = false;
      }}
    >
      <DialogContent
        className="flex max-h-[70vh] flex-col gap-3 p-4 sm:max-w-xl"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const target = takeLibrarySearchOpener();
          if (!opening.current) target?.focus();
        }}
      >
        <DialogTitle>Search Library</DialogTitle>
        <DialogDescription className="text-xs">
          Titles, authors, and book text. Words match regardless of case; “quotes” match a phrase.
        </DialogDescription>
        <Input
          data-testid="library-search-input"
          type="search"
          role="combobox"
          aria-label="Search library"
          aria-expanded={options.length > 0}
          aria-controls="library-search-results"
          aria-activedescendant={options[active] ? `libsearch-${options[active].key}` : undefined}
          placeholder="Search titles, authors, and text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        {error && (
          <p role="alert" className="text-xs text-destructive">
            Search failed: {error}
          </p>
        )}
        {result && (
          <div data-testid="library-search-status" role="status" className="text-xs text-muted-foreground">
            {status.map((line) => (
              <p key={line}>{line}</p>
            ))}
            {result.results.length === 0 && <p>No matches</p>}
          </div>
        )}
        <div id="library-search-results" role="listbox" aria-label="Library results" className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {result?.results.map((r) => {
            const mine = options.filter((o) => o.bookId === r.book.id);
            return (
              <div key={r.book.id} role="group" aria-label={r.book.title} data-testid="library-result" data-book-id={r.book.id} data-metadata-match={r.metadata_match} className="mb-3">
                <div className="px-2 pb-1 text-[13px] font-semibold">
                  {r.book.title}
                  <span className="ml-2 font-normal text-muted-foreground">{r.book.authors.join(", ")}</span>
                </div>
                {mine.map((o) =>
                  o.hit ? (
                    <div key={o.key} data-testid="library-hit" {...optionProps(o)}>
                      {o.hit.label && <span className="text-[11px] text-muted-foreground">{o.hit.label}</span>}
                      {!o.hit.label && r.book.format === "pdf" && <span className="text-[11px] text-muted-foreground">Page {o.hit.order + 1}</span>}
                      <Snippet hit={o.hit} />
                    </div>
                  ) : (
                    <div key={o.key} data-testid="library-open-book" {...optionProps(o)}>
                      <span className="text-[13px]">{r.metadata_match ? "Title or author matches" : "Open book"}</span>
                    </div>
                  ),
                )}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
