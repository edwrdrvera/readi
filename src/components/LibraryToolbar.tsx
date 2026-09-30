import { useMemo } from "react";
import { Settings } from "lucide-react";
import type { LibraryView, SortKey } from "@/lib/api";
import { pickAndImport } from "@/lib/importing";
import { authorsOf, DEFAULT_VIEW, hasFilters } from "@/lib/libraryView";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { openSettings } from "./SettingsSheet";

const ANY = "any";

function Filter<T extends string>({ label, value, options, onChange }: { label: string; value: T | null; options: [T, string][]; onChange(v: T | null): void }) {
  return (
    <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? null : (v as T))}>
      <SelectTrigger aria-label={label} className="max-w-44">
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

export function LibraryToolbar({ title }: { title: string }) {
  const view = useApp((s) => s.uiSettings.library);
  const books = useApp((s) => s.books);
  const setView = useApp((s) => s.setView);
  const authors = useMemo(() => authorsOf(books), [books]);
  const set = (patch: Partial<LibraryView>) => void setView(patch);
  return (
    <header className="flex flex-col gap-3 px-6 pt-5 pb-3">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 truncate text-[22px] font-semibold">{title}</h1>
        <Button variant="outline" size="sm" onClick={() => void pickAndImport()}>
          Import…
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={openSettings}>
          <Settings />
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Filters">
        <Filter label="Author" value={view.author} options={authors.map((a) => [a, a])} onChange={(author) => set({ author })} />
        <Filter
          label="State"
          value={view.reading_state}
          options={[["unread", "Unread"], ["reading", "Reading"], ["finished", "Finished"]]}
          onChange={(reading_state) => set({ reading_state })}
        />
        <Filter label="Availability" value={view.availability} options={[["available", "Available"], ["missing", "Missing"]]} onChange={(availability) => set({ availability })} />
        {hasFilters(view) && (
          <Button variant="link" size="sm" onClick={() => set({ ...DEFAULT_VIEW, sort: view.sort, format: view.format, collection_id: view.collection_id })}>
            Clear filters
          </Button>
        )}
        <span className="flex-1" />
        <Select value={view.sort} onValueChange={(v) => set({ sort: v as SortKey })}>
          <SelectTrigger aria-label="Sort by">
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
    </header>
  );
}
