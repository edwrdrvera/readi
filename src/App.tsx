import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api } from "./lib/api";
import { useApp } from "./lib/store";

export async function importPaths(paths: string[]) {
  const { notify, refreshBooks } = useApp.getState();
  const outcomes = await api.importBooks(paths);
  for (const o of outcomes) {
    if (o.status === "failed") notify(`${o.path.split("/").pop()}: ${o.reason}`);
    else if (o.result.already_in_library) notify(`“${o.result.book.title}” is already in the library`);
  }
  await refreshBooks();
  return outcomes;
}

async function pickAndImport() {
  const picked = await open({ multiple: true, filters: [{ name: "Books", extensions: ["epub", "pdf"] }] });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}

function Library() {
  const books = useApp((s) => s.books);
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
              <button className="book">
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

export default function App() {
  const notices = useApp((s) => s.notices);
  const refreshBooks = useApp((s) => s.refreshBooks);

  useEffect(() => {
    void refreshBooks();
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
    };
    window.addEventListener("keydown", keys);
    return () => {
      void drop.then((u) => u());
      window.removeEventListener("keydown", keys);
    };
  }, [refreshBooks]);

  return (
    <>
      <Library />
      <div className="notices" role="status">
        {notices.map((n) => (
          <div key={n} className="notice">{n}</div>
        ))}
      </div>
    </>
  );
}
