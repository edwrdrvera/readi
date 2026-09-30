import { ChevronLeft } from "lucide-react";
import { closeSettings } from "@/lib/commands";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { PrefsForm } from "./PrefsForm";
import { LibrarySidebar } from "./LibrarySidebar";
import { AlwaysShowControlsSetting, ExcludedBooksSettings, WatchedFoldersSettings } from "./LibrarySettings";

const SECTIONS = [
  ["settings-reading", "Reading"],
  ["settings-folders", "Watched folders"],
  ["settings-excluded", "Excluded books"],
] as const;

export const SectionLabel = ({ id, children }: { id?: string; children: React.ReactNode }) => (
  <h2 id={id} className="pt-7 pb-1 text-[11px] font-semibold tracking-[.02em] text-muted-foreground first:pt-0">
    {children}
  </h2>
);

/** Global reading defaults and library sources. Books with their own settings keep them. */
export function SettingsPage() {
  const defaults = useApp((s) => s.defaults);
  const setDefault = useApp((s) => s.setDefault);
  const fromReader = useApp((s) => s.screen.name === "settings" && s.screen.back.name === "reader");
  const form = (groups: ("layout" | "text" | "pdf")[]) => <PrefsForm inline values={defaults} groups={groups} onChange={(k, v) => void setDefault(k, v)} />;
  return (
    <div className="flex h-full" data-testid="settings-page">
      <LibrarySidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <header data-tauri-drag-region className="flex h-[52px] shrink-0 items-center gap-2 border-b px-4">
          <Button variant="ghost" size="icon-sm" className="size-7" aria-label={fromReader ? "Back to book" : "Back"} onClick={closeSettings}>
            <ChevronLeft />
          </Button>
          <h1 data-tauri-drag-region id="settings-title" tabIndex={-1} className="flex-1 truncate text-[15px] font-semibold outline-none">
            Settings
          </h1>
        </header>
        <div className="flex min-h-0 flex-1 gap-10 overflow-y-auto px-10 pt-7 pb-10">
          <nav aria-label="Settings sections" className="sticky top-0 flex w-40 shrink-0 flex-col gap-0.5 self-start">
            {SECTIONS.map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(id)?.scrollIntoView({ block: "start" });
                }}
                className="pressable flex h-[30px] items-center rounded-md px-2.5 text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="flex w-full max-w-[560px] flex-col">
            <p className="pb-5 text-[13px] text-muted-foreground">Defaults for every book. Changes made while reading a book apply to that book only.</p>
            <SectionLabel id="settings-reading">Reading</SectionLabel>
            {form(["layout"])}
            <AlwaysShowControlsSetting />
            <SectionLabel>EPUB text</SectionLabel>
            {form(["text"])}
            <SectionLabel>PDF</SectionLabel>
            {form(["pdf"])}
            <WatchedFoldersSettings />
            <ExcludedBooksSettings />
          </div>
        </div>
      </main>
    </div>
  );
}
