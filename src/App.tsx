import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./lib/api";
import { extraction } from "./lib/extraction";
import { useApp } from "./lib/store";
import { EpubReader } from "./reader/EpubReader";
import { PdfReader } from "./reader/PdfReader";
import { activeReader } from "./reader/handle";

export async function importPaths(paths: string[]) {
  const { notify, refreshBooks } = useApp.getState();
  const outcomes = await api.importBooks(paths);
  for (const o of outcomes) {
    if (o.status === "failed") notify(`${o.path.split("/").pop()}: ${o.reason}`);
    else if (o.result.already_in_library) notify(`“${o.result.book.title}” is already in the library`);
  }
  await refreshBooks();
  extraction.kick();
  return outcomes;
}

async function pickAndImport() {
  const picked = await open({ multiple: true, filters: [{ name: "Books", extensions: ["epub", "pdf"] }] });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}

function Library() {
  const books = useApp((s) => s.books);
  const openBook = useApp((s) => s.openBook);
  return (
    <main className="library">
      <header>
        <h1>Library</h1>
        <button onClick={() => void pickAndImport()}>Import…</button>
      </header>
      {books.length === 0 ? (
        <p className="empty">Drop EPUB or PDF files here, or press ⌘O to import.</p>
      ) : (
        <ul className="books">
          {books.map((b) => (
            <li key={b.id}>
              <button className="book" onClick={() => void openBook(b.id)}>
                <span className="title">{b.title}</span>
                <span className="meta">
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

function Reader() {
  const screen = useApp((s) => s.screen);
  const closeBook = useApp((s) => s.closeBook);
  const saveStatus = useApp((s) => s.saveStatus);
  if (screen.name !== "reader") return null;
  const { detail } = screen;
  const back = async () => {
    await activeReader()?.flush();
    closeBook();
  };
  return (
    <main className="reader">
      <header className="reader-chrome">
        <button onClick={() => void back()} aria-label="Back to library">‹ Library</button>
        <span className="reader-title">{detail.book.title}</span>
        {saveStatus?.kind === "error" && (
          <span className="save-error" role="alert">
            Progress not saved. <button onClick={() => void activeReader()?.flush()}>Retry</button>
          </span>
        )}
      </header>
      {detail.book.format === "epub" ? <EpubReader key={detail.book.id} detail={detail} /> : <PdfReader key={detail.book.id} detail={detail} />}
    </main>
  );
}

export default function App() {
  const screen = useApp((s) => s.screen);
  const notices = useApp((s) => s.notices);
  const refreshBooks = useApp((s) => s.refreshBooks);

  useEffect(() => {
    void refreshBooks();
    extraction.kick();
    const off = extraction.onChange(() => void refreshBooks());
    const drop = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "drop") void importPaths(e.payload.paths);
    });
    const keys = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable]")) return;
      if (e.metaKey && e.key === "o") {
        e.preventDefault();
        void pickAndImport();
        return;
      }
      const reader = activeReader();
      if (!reader) return;
      if (e.key === "ArrowRight" || (e.key === " " && !e.shiftKey)) void reader.next();
      else if (e.key === "ArrowLeft" || (e.key === " " && e.shiftKey)) void reader.prev();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", keys);
    return () => {
      off();
      void drop.then((u) => u());
      window.removeEventListener("keydown", keys);
    };
  }, [refreshBooks]);

  return (
    <>
      {screen.name === "library" ? <Library /> : <Reader />}
      <div className="notices" role="status">
        {notices.map((n) => (
          <div key={n} className="notice">{n}</div>
        ))}
      </div>
    </>
  );
}
