import { useEffect, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Settings } from "lucide-react";
import { extraction } from "./lib/extraction";
import { handleKeydown, runCommand } from "./lib/commands";
import { importPaths, pickAndImport } from "./lib/importing";
import { resolvePrefs } from "./lib/prefs";
import { useApp } from "./lib/store";
import { useResolvedTheme } from "./lib/theme";
import { EpubReader } from "./reader/EpubReader";
import { PdfReader } from "./reader/PdfReader";
import { Button } from "@/components/ui/button";
import { ContentsSidebar } from "@/components/ContentsSidebar";
import { ReaderChrome } from "@/components/ReaderChrome";
import { SettingsSheet, openSettings } from "@/components/SettingsSheet";

function Library() {
  const books = useApp((s) => s.books);
  const openBook = useApp((s) => s.openBook);
  return (
    <main className="mx-auto max-w-[900px] px-8 py-6">
      <header className="flex items-center gap-2">
        <h1 className="flex-1 text-[22px] font-semibold">Library</h1>
        <Button variant="outline" size="sm" onClick={() => void pickAndImport()}>Import…</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Settings" onClick={openSettings}>
          <Settings />
        </Button>
      </header>
      {books.length === 0 ? (
        <p className="text-muted-foreground">Drop EPUB or PDF files here, or press ⌘O to import.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {books.map((b) => (
            <li key={b.id}>
              <button className="flex w-full flex-col gap-0.5 border-b px-3 py-2.5 text-left hover:bg-muted" onClick={() => void openBook(b.id)}>
                <span className="font-semibold">{b.title}</span>
                <span className="text-xs text-muted-foreground">
                  {b.authors.join(", ") || "Unknown author"} · {b.format.toUpperCase()} · {b.reading_state}
                  {b.index_state !== "ready" && ` · index ${b.index_state.replace(/_/g, " ")}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function useReaderPrefs() {
  const defaults = useApp((s) => s.defaults);
  const overrides = useApp((s) => s.overrides);
  return useMemo(() => resolvePrefs(defaults, overrides), [defaults, overrides]);
}

function Reader() {
  const screen = useApp((s) => s.screen);
  const prefs = useReaderPrefs();
  if (screen.name !== "reader") return null;
  const { detail } = screen;
  return (
    <main className="relative flex h-full overflow-hidden bg-reader">
      <ContentsSidebar detail={detail} />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <ReaderChrome detail={detail} prefs={prefs} />
        {detail.book.format === "epub" ? (
          <EpubReader key={detail.book.id} detail={detail} prefs={prefs} />
        ) : (
          <PdfReader key={detail.book.id} detail={detail} prefs={prefs} />
        )}
      </div>
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
  const refreshBooks = useApp((s) => s.refreshBooks);
  const loadDefaults = useApp((s) => s.loadDefaults);
  useDocumentTheme();

  useEffect(() => {
    void refreshBooks();
    void loadDefaults();
    extraction.kick();
    const off = extraction.onChange(() => void refreshBooks());
    const drop = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") void importPaths(e.payload.paths);
    });
    const menu = listen<string>("menu-command", (e) => runCommand(e.payload));
    window.addEventListener("keydown", handleKeydown);
    return () => {
      void menu.then((u) => u());
      off();
      void drop.then((u) => u());
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [refreshBooks, loadDefaults]);

  return (
    <>
      {screen.name === "library" ? <Library /> : <Reader />}
      <SettingsSheet />
      <div className="fixed right-4 bottom-4 z-50 flex flex-col gap-2" role="status">
        {notices.map((n) => (
          <div key={n} className="max-w-[360px] rounded-lg bg-foreground px-3 py-2 text-[13px] text-background">{n}</div>
        ))}
      </div>
    </>
  );
}
