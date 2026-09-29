import { open } from "@tauri-apps/plugin-dialog";
import { api } from "./api";
import { extraction } from "./extraction";
import { useApp } from "./store";

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

export async function pickAndImport() {
  const picked = await open({ multiple: true, filters: [{ name: "Books", extensions: ["epub", "pdf"] }] });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}
