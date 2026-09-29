import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { EVENTS, type BookDetail, type ImportJob } from "./lib/api";
import { extraction } from "./lib/extraction";
import { handleKeydown, runCommand } from "./lib/commands";
import { importPaths } from "./lib/importing";
import { resolvePrefs } from "./lib/prefs";
import { useApp } from "./lib/store";
import { useResolvedTheme } from "./lib/theme";
import { EpubReader } from "./reader/EpubReader";
import { PdfReader } from "./reader/PdfReader";
import { BookInfoSheet } from "@/components/BookInfoSheet";
import { CollectionEditor } from "@/components/CollectionEditor";
import { CommandPalette } from "@/components/CommandPalette";
import { Confirmations } from "@/components/Confirmations";
import { AnnotationEditor } from "@/components/AnnotationEditor";
import { HighlightPopover, useReaderAnnotations } from "@/components/HighlightPopover";
import { LibrarySearch } from "@/components/LibrarySearch";
import { ReaderSidebar } from "@/components/ReaderSidebar";
import { ImportJobs } from "@/components/ImportJobs";
import { Library } from "@/components/Library";
import { ReaderChrome } from "@/components/ReaderChrome";
import { SettingsSheet } from "@/components/SettingsSheet";

function useReaderPrefs() {
  const defaults = useApp((s) => s.defaults);
  const overrides = useApp((s) => s.overrides);
  return useMemo(() => resolvePrefs(defaults, overrides), [defaults, overrides]);
}

function Reader() {
  const screen = useApp((s) => s.screen);
  if (screen.name !== "reader") return null;
  return <OpenBook key={screen.detail.book.id} detail={screen.detail} />;
}

function OpenBook({ detail }: { detail: BookDetail }) {
  const prefs = useReaderPrefs();
  useReaderAnnotations(detail.book.id);
  return (
    <main className="relative flex h-full overflow-hidden bg-reader">
      <ReaderSidebar detail={detail} />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <ReaderChrome detail={detail} prefs={prefs} />
        {detail.book.format === "epub" ? (
          <EpubReader key={detail.book.id} detail={detail} prefs={prefs} />
        ) : (
          <PdfReader key={detail.book.id} detail={detail} prefs={prefs} />
        )}
      </div>
      <HighlightPopover />
      <AnnotationEditor />
    </main>
  );
}

/** html[data-theme] follows the open book's theme, or the default in the Library. */
function useDocumentTheme() {
  const inReader = useApp((s) => s.screen.name === "reader");
  const prefs = useReaderPrefs();
  const defaults = useApp((s) => s.defaults);
  const theme = useResolvedTheme(inReader ? prefs.theme : defaults.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}

export default function App() {
  const screen = useApp((s) => s.screen);
  const notices = useApp((s) => s.notices);
  const [dragging, setDragging] = useState(false);
  useDocumentTheme();

  useEffect(() => {
    const s = useApp.getState();
    void s.refreshLibrary();
    void s.loadDefaults();
    void s.loadUiSettings();
    void s.loadJobs();
    extraction.kick();
    const off = extraction.onChange(() => void useApp.getState().refreshBooks());
    const drop = getCurrentWebview().onDragDropEvent((e) => {
      const { type } = e.payload;
      setDragging(type === "enter" || type === "over");
      if (e.payload.type === "drop") void importPaths(e.payload.paths);
    });
    const menu = listen<string>("menu-command", (e) => runCommand(e.payload));
    const jobs = listen<ImportJob>(EVENTS.importJob, (e) => useApp.getState().receiveJob(e.payload));
    const changed = listen(EVENTS.libraryChanged, () => {
      void useApp.getState().refreshLibrary();
      extraction.kick();
    });
    window.addEventListener("keydown", handleKeydown);
    return () => {
      for (const u of [menu, jobs, changed, drop]) void u.then((f) => f());
      off();
      window.removeEventListener("keydown", handleKeydown);
    };
  }, []);

  return (
    <>
      {screen.name === "library" ? <Library /> : <Reader />}
      <SettingsSheet />
      <BookInfoSheet />
      <Confirmations />
      <CollectionEditor />
      <CommandPalette />
      <LibrarySearch />
      <ImportJobs />
      {dragging && (
        <div data-drop-overlay className="pointer-events-none fixed inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-lg font-medium">
          Drop EPUB or PDF files to import
        </div>
      )}
      <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2" role="status">
        {notices.map((n) => (
          <div key={n} className="max-w-[360px] rounded-lg bg-foreground px-3 py-2 text-[13px] text-background">{n}</div>
        ))}
      </div>
    </>
  );
}
