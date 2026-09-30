import { useMemo } from "react";
import { Moon, Plus, Search, Settings, Sun } from "lucide-react";
import type { LibraryView, SortKey } from "@/lib/api";
import { pickAndImport } from "@/lib/importing";
import { authorsOf, DEFAULT_VIEW, hasFilters } from "@/lib/libraryView";
import { useApp } from "@/lib/store";
import { useResolvedTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { openSettings } from "./SettingsSheet";

const ANY = "any";
const TRIGGER = "h-7 max-w-44 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-muted";

function Filter<T extends string>({ label, value, options, onChange }: { label: string; value: T | null; options: [T, string][]; onChange(v: T | null): void }) {
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? null : (v as T))}>
      <SelectTrigger aria-label={label} className={TRIGGER}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{`Any ${label.toLowerCase()}`}</SelectItem>
        {options.map(([v, text]) => (
          <SelectItem key={v} value={v}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const SORTS: [SortKey, string][] = [
  ["recent", "Recent"],
  ["title", "Title"],
  ["author", "Author"],
  ["added", "Date added"],
];

function ThemeToggle() {
  const pref = useApp((s) => s.defaults.theme);
  const setDefault = useApp((s) => s.setDefault);
  const dark = useResolvedTheme(pref) === "dark";
  return (
    <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Toggle dark mode" onClick={() => void setDefault("theme", dark ? "light" : "dark")}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

export function LibraryTopBar({ title }: { title: string }) {
  const openSearch = useApp((s) => s.setLibrarySearchOpen);
  return (
    <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-3 border-b px-6">
      <h1 data-tauri-drag-region className="flex-1 truncate text-[15px] font-semibold">
        {title}
      </h1>
      <button
        onClick={() => openSearch(true)}
        className="flex h-7 w-[220px] items-center gap-1.5 rounded-md bg-muted px-2.5 text-[13px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Search library"
      >
        <Search className="size-3.5" />
        Search
      </button>
      <ThemeToggle />
      <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Import" onClick={() => void pickAndImport()}>
        <Plus />
      </Button>
      <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Settings" onClick={openSettings}>
        <Settings />
      </Button>
    </header>
  );
}

export function LibraryFilters() {
  const view = useApp((s) => s.uiSettings.library);
  const books = useApp((s) => s.books);
  const setView = useApp((s) => s.setView);
  const authors = useMemo(() => authorsOf(books), [books]);
  const set = (patch: Partial<LibraryView>) => void setView(patch);
  return (
    <div className="flex flex-wrap items-center gap-1 px-[34px] pt-3" role="toolbar" aria-label="Filters">
      <Filter label="Author" value={view.author} options={authors.map((a) => [a, a])} onChange={(author) => set({ author })} />
      <Filter
        label="State"
        value={view.reading_state}
        options={[["unread", "Unread"], ["reading", "Reading"], ["finished", "Finished"]]}
        onChange={(reading_state) => set({ reading_state })}
      />
      <Filter label="Availability" value={view.availability} options={[["available", "Available"], ["missing", "Missing"]]} onChange={(availability) => set({ availability })} />
      {hasFilters(view) && (
        <Button variant="link" size="sm" className="h-7 text-xs" onClick={() => set({ ...DEFAULT_VIEW, sort: view.sort, format: view.format, collection_id: view.collection_id })}>
          Clear filters
        </Button>
      )}
      <span className="flex-1" />
      <Select value={view.sort} onValueChange={(v) => set({ sort: v as SortKey })}>
        <SelectTrigger aria-label="Sort by" className={TRIGGER}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {SORTS.map(([v, text]) => (
            <SelectItem key={v} value={v}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
