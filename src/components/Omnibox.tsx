import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { api, type LibrarySearch as Result, type SearchHit } from "@/lib/api";
import { libraryStatusLines } from "@/lib/annotations";
import { closeSearch, matchCommands, runFromPalette, type Command } from "@/lib/commands";
import { openBookAt } from "@/lib/jumps";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Snippet } from "./Snippet";

const DEBOUNCE_MS = 150;
const KEY_GLYPHS: Record<string, string> = { "\\": "\\", "[": "[", "=": "+", "-": "−", ",": "," };

function shortcutText(c: Command) {
  const s = c.shortcuts.find((x) => x.meta);
  if (!s) return null;
  return `${s.shift ? "⇧" : ""}⌘${KEY_GLYPHS[s.key] ?? s.key.toUpperCase()}`;
}

type Option = { key: string } & ({ type: "action"; command: Command } | { type: "passage"; bookId: number; hit: SearchHit | null });

export type OmniboxScope = "library" | "reader";

function useOmniboxState(scope: OmniboxScope) {
  const { open, query } = useApp((s) => s.search);
  const setSearch = useApp((s) => s.setSearch);
  // Re-derive actions when anything a contextual command depends on changes.
  const screen = useApp((s) => s.screen);
  const books = useApp((s) => s.books);
  const collections = useApp((s) => s.collections);
  const view = useApp((s) => s.uiSettings.library);
  const focused = useApp((s) => s.focusedBookId);
  const indexStates = useApp((s) => s.books.map((b) => b.index_state).join());
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const actions = useMemo(() => (open ? matchCommands(query) : []), [open, query, screen, books, collections, view, focused]);

  useEffect(() => {
    if (scope !== "library" || !open || query.trim() === "") return setResult(null);
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
  }, [scope, open, query, indexStates]);

  const options = useMemo<Option[]>(
    () => [
      ...actions.map((command): Option => ({ key: `cmd-${command.id}`, type: "action", command })),
      ...(result?.results ?? []).flatMap((r): Option[] => [
        ...(r.metadata_match || r.hits.length === 0 ? [{ key: `${r.book.id}-book`, type: "passage" as const, bookId: r.book.id, hit: null }] : []),
        ...r.hits.map((hit, i) => ({ key: `${r.book.id}-${i}`, type: "passage" as const, bookId: r.book.id, hit })),
      ]),
    ],
    [actions, result],
  );
  useEffect(() => setActive(0), [options]);

  const choose = (o: Option) => {
    closeSearch({ restoreFocus: o.type === "action" });
    if (o.type === "action") runFromPalette(o.command);
    else void openBookAt(o.bookId, o.hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      return closeSearch({ restoreFocus: true });
    }
    if (options.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      setActive(next);
      document.getElementById(`omni-${options[next].key}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(options[active]);
    }
  };

  const optionProps = (o: Option) => {
    const i = options.indexOf(o);
    return {
      id: `omni-${o.key}`,
      role: "option" as const,
      "aria-selected": i === active,
      "data-active": i === active,
      tabIndex: -1,
      // Keeps focus in the field so Return and the arrows keep working.
      onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
      onMouseMove: () => setActive(i),
      onClick: () => choose(o),
      className: cn("flex w-full cursor-default rounded-md px-2.5 text-left text-[13px]", i === active && "bg-accent text-accent-foreground"),
    };
  };

  return { scope, open, query, setSearch, result, error, options, active, onKeyDown, optionProps };
}

type OmniboxState = ReturnType<typeof useOmniboxState>;
const Ctx = createContext<OmniboxState | null>(null);
const useOmnibox = () => useContext(Ctx)!;

export function OmniboxProvider({ scope, children }: { scope: OmniboxScope; children: ReactNode }) {
  return <Ctx.Provider value={useOmniboxState(scope)}>{children}</Ctx.Provider>;
}

export function OmniboxInput({ className, autoFocus }: { className?: string; autoFocus?: boolean }) {
  const { scope, open, query, setSearch, options, active, onKeyDown } = useOmnibox();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label className={cn("flex h-7 items-center gap-1.5 rounded-md bg-muted px-2.5 text-[13px] text-muted-foreground focus-within:ring-2 focus-within:ring-ring", className)}>
      <Search className="size-3.5 shrink-0" />
      <input
        ref={ref}
        data-testid={scope === "library" ? "library-search-input" : "command-input"}
        type="search"
        role="combobox"
        aria-label={scope === "library" ? "Search library" : "Commands"}
        aria-expanded={open && options.length > 0}
        aria-controls="omnibox-results"
        aria-activedescendant={open && options[active] ? `omni-${options[active].key}` : undefined}
        placeholder={scope === "library" ? "Search" : "Type a command"}
        autoFocus={autoFocus}
        value={query}
        onFocus={() => !open && setSearch({ open: true })}
        onBlur={() => query.trim() === "" && setSearch({ open: false })}
        onChange={(e) => setSearch({ open: true, query: e.target.value })}
        onKeyDown={onKeyDown}
        className="h-full min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
    </label>
  );
}

const GroupLabel = ({ children }: { children: ReactNode }) => <h2 className="px-2.5 pt-3 pb-1.5 text-[11px] font-semibold tracking-[.02em] text-muted-foreground first:pt-0">{children}</h2>;

function Actions() {
  const { options, optionProps } = useOmnibox();
  const actions = options.filter((o) => o.type === "action");
  if (actions.length === 0) return null;
  return (
    <div role="group" aria-label="Actions">
      <GroupLabel>Actions</GroupLabel>
      {actions.map((o) => (
        <div key={o.key} data-testid="command-item" data-command-id={o.command.id} {...optionProps(o)} className={cn(optionProps(o).className, "h-8 items-center justify-between gap-4")}>
          <span className="truncate">{o.command.label}</span>
          {shortcutText(o.command) && <kbd className="font-sans text-[11px] text-muted-foreground">{shortcutText(o.command)}</kbd>}
        </div>
      ))}
    </div>
  );
}

/** The library body while the field is open: matching actions, then passages. */
export function OmniboxResults() {
  const { query, result, error, options, optionProps } = useOmnibox();
  const status = result ? libraryStatusLines(result) : [];
  return (
    <div id="omnibox-results" role="listbox" aria-label="Search results" className="flex-1 overflow-y-auto px-8 pt-5 pb-10">
      <Actions />
      {error && (
        <p role="alert" className="px-2.5 pt-3 text-xs text-destructive">
          Search failed: {error}
        </p>
      )}
      {query.trim() === "" && <p className="px-2.5 pt-3 text-xs text-muted-foreground">Search titles, authors, and book text. Words match regardless of case; “quotes” match a phrase.</p>}
      {result && (
        <>
          <GroupLabel>Books</GroupLabel>
          <div data-testid="library-search-status" role="status" className="px-2.5 pb-2 text-xs text-muted-foreground">
            {status.map((line) => (
              <p key={line}>{line}</p>
            ))}
            {result.results.length === 0 && <p>No matches</p>}
          </div>
        </>
      )}
      {result?.results.map((r) => {
        const mine = options.filter((o) => o.type === "passage" && o.bookId === r.book.id);
        return (
          <div key={r.book.id} role="group" aria-label={r.book.title} data-testid="library-result" data-book-id={r.book.id} data-metadata-match={r.metadata_match} className="mb-3">
            <div className="px-2.5 pb-1 text-[13px] font-semibold">
              {r.book.title}
              <span className="ml-2 font-normal text-muted-foreground">{r.book.authors.join(", ")}</span>
            </div>
            {mine.map((o) =>
              o.type === "passage" && o.hit ? (
                <div key={o.key} data-testid="library-hit" {...optionProps(o)} className={cn(optionProps(o).className, "flex-col gap-0.5 py-1.5")}>
                  {o.hit.label && <span className="text-[11px] text-muted-foreground">{o.hit.label}</span>}
                  {!o.hit.label && r.book.format === "pdf" && <span className="text-[11px] text-muted-foreground">Page {o.hit.order + 1}</span>}
                  <Snippet hit={o.hit} />
                </div>
              ) : (
                <div key={o.key} data-testid="library-open-book" {...optionProps(o)} className={cn(optionProps(o).className, "py-1.5")}>
                  {r.metadata_match ? "Title or author matches" : "Open book"}
                </div>
              ),
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The reader's toolbar field lists actions only, in a list under the field. */
export function OmniboxActionsList() {
  const { open, options } = useOmnibox();
  if (!open) return null;
  return (
    <div id="omnibox-results" role="listbox" aria-label="Actions" className="absolute top-full left-1/2 z-30 mt-1 max-h-[60vh] w-[420px] -translate-x-1/2 overflow-y-auto rounded-lg border bg-popover p-1.5 shadow-md">
      {options.length === 0 ? <p className="px-2.5 py-2 text-[13px] text-muted-foreground">No matching actions</p> : <Actions />}
    </div>
  );
}
