import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type BookDetail, type BookSearch, type SearchHit } from "@/lib/api";
import { groupLabel, hitCount, searchStatus } from "@/lib/annotations";
import { extraction } from "@/lib/extraction";
import { showHit } from "@/lib/jumps";
import { useApp } from "@/lib/store";
import { Snippet } from "./Snippet";

const DEBOUNCE_MS = 150;

export function SearchTab({ detail }: { detail: BookDetail }) {
  const bookId = detail.book.id;
  const query = useApp((s) => s.bookQuery);
  const setQuery = useApp((s) => s.setBookQuery);
  // Refetch as indexing progresses, so partial results grow and the status settles.
  const indexState = useApp((s) => s.books.find((b) => b.id === bookId)?.index_state);
  const [result, setResult] = useState<{ query: string; data: BookSearch } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (query.trim() === "") return;
    let live = true;
    const t = setTimeout(() => {
      api
        .searchBook(bookId, query)
        .then((data) => live && (setResult({ query, data }), setError(null)))
        .catch((e) => live && setError(String(e)));
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [bookId, query, indexState, nonce]);

  const data = result && result.query.trim() !== "" && query.trim() !== "" ? result.data : null;
  const status = searchStatus(query, data);
  const fmt = detail.book.format;

  const open = async (hit: SearchHit) => {
    await showHit(bookId, hit);
  };

  const retry = async () => {
    try {
      await api.retryExtraction(bookId);
      extraction.kick();
      await useApp.getState().refreshBooks();
    } catch (e) {
      setError(String(e));
    }
    setNonce((n) => n + 1);
  };

  let index = 0;
  return (
    <div className="flex flex-col gap-1.5 p-2">
      <Input
        data-testid="search-input"
        type="search"
        aria-label="Search in this book"
        aria-describedby="search-hint"
        placeholder="Search in book"
        className="h-8 px-2.5 text-xs"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const first = data?.groups[0]?.hits[0];
            if (first) {
              e.preventDefault();
              void open(first);
            }
          }
        }}
      />
      <p id="search-hint" className="px-1 text-[11px] leading-snug text-muted-foreground">
        Words match regardless of case; “quotes” match a phrase. Languages written without spaces may not match every word.
      </p>
      {error && (
        <p role="alert" className="px-1 text-[11px] text-destructive">
          Search failed: {error}
        </p>
      )}
      {status !== "idle" && status !== "loading" && (
        <div data-testid="search-status" data-state={status} role="status" className="px-1 text-[11px] text-muted-foreground">
          {status === "indexing" && "Still indexing. Results may be incomplete"}
          {status === "no_text" && "This book has no searchable text (for example, a scanned PDF)"}
          {status === "failed" && (
            <span className="flex items-center gap-2 text-destructive">
              Indexing this book failed.
              <Button variant="outline" size="sm" data-testid="search-retry" onClick={() => void retry()}>
                Retry
              </Button>
            </span>
          )}
          {status === "no_matches" && "No matches"}
          {status === "results" && data && `${hitCount(data)} ${hitCount(data) === 1 ? "match" : "matches"}`}
          {data?.truncated && <span className="block">Showing the first {hitCount(data)} matches</span>}
        </div>
      )}
      {data && data.groups.length > 0 && (
        <ul aria-label="Search results" className="m-0 flex list-none flex-col gap-2 p-0">
          {data.groups.map((g) => (
            <li key={g.order}>
              <h3 className="px-1 pb-0.5 text-[11px] font-semibold text-muted-foreground">{groupLabel(g, fmt)}</h3>
              <ul className="m-0 flex list-none flex-col p-0">
                {g.hits.map((hit, i) => {
                  const n = index++;
                  return (
                    <li key={i}>
                      <button
                        data-testid="search-result"
                        data-order={hit.order}
                        data-index={n}
                        className="w-full rounded-md px-2 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => void open(hit)}
                      >
                        <Snippet hit={hit} className="text-xs" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
