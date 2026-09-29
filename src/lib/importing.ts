import { open } from "@tauri-apps/plugin-dialog";
import { api, type ImportJob } from "./api";
import { isTerminal } from "./jobs";
import { useApp } from "./store";

// Events are the main channel; polling covers an event missed before the
// listener was attached.
const POLL_MS = 1000;

function untilTerminal(ids: number[]): Promise<ImportJob[]> {
  const settled = () => {
    const jobs = useApp.getState().jobs;
    return ids.every((id) => !jobs[id] || isTerminal(jobs[id]));
  };
  const snapshot = new Map<number, ImportJob>();
  const record = () => ids.forEach((id) => useApp.getState().jobs[id] && snapshot.set(id, useApp.getState().jobs[id]));
  record();
  if (settled()) return Promise.resolve(ids.map((id) => snapshot.get(id)!));
  return new Promise((resolve) => {
    const finish = () => {
      if (!settled()) return;
      unsubscribe();
      clearInterval(poll);
      resolve(ids.map((id) => snapshot.get(id)!));
    };
    // A dismissed job leaves the store, so its last snapshot is kept here.
    const unsubscribe = useApp.subscribe(() => (record(), finish()));
    const poll = setInterval(() => void useApp.getState().loadJobs(), POLL_MS);
  });
}

/** Resolves once every job it created is done, failed, or cancelled. */
export async function importPaths(paths: string[]): Promise<ImportJob[]> {
  const { setPendingImports, receiveJob, notify } = useApp.getState();
  setPendingImports(1);
  let jobs: ImportJob[];
  try {
    jobs = await api.importBooks(paths);
  } catch (e) {
    notify(`Could not import: ${e}`);
    return [];
  } finally {
    setPendingImports(-1);
  }
  jobs.forEach(receiveJob);
  return untilTerminal(jobs.map((j) => j.id));
}

export async function pickAndImport() {
  const picked = await open({ multiple: true, filters: [{ name: "Books", extensions: ["epub", "pdf"] }] });
  if (picked) await importPaths(Array.isArray(picked) ? picked : [picked]);
}
