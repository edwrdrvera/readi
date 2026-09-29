import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, type BookSummary, type ImportJob, type Location } from "./lib/api";
import { commandRuns } from "./lib/commands";
import { importPaths } from "./lib/importing";
import { isTerminal } from "./lib/jobs";
import { useApp } from "./lib/store";
import { openAndWait, sleep, until } from "./selftestKit";

// M3 phases, run by scripts/packaged-check.mjs against a fresh data dir.
// The webview cannot touch the filesystem: for each outside change it logs
// `fs:<step>`, node performs it, and the phase waits for the library to show it.

interface M3Config {
  fixtures: string[];
  files: Record<string, string>;
  sha: Record<string, string>;
  dirs: Record<"watchA" | "watchB" | "watchC" | "outside", string>;
  /** Node's clock when it spawned this phase. */
  launchedAt: number;
  /** Book ids reported by m3-watch-live, for m3-watch-offline. */
  prev: Record<string, number>;
}

type Report = Record<string, unknown>;

const base = (p: string) => p.split("/").pop()!;
const fsStep = (step: string) => api.selftestLog(`fs:${step}`);
const books = () => api.listBooks();
const bookBySha = async (sha: string) => (await books()).filter((b) => b.sha256 === sha);

async function locationAt(sha: string, path: string): Promise<{ book: BookSummary; loc: Location } | null> {
  const [book] = await bookBySha(sha);
  if (!book) return null;
  const loc = (await api.getLocations(book.id)).find((l) => l.path === path);
  return loc ? { book, loc } : null;
}

/** Waits for a watcher-driven state; after `hintMs` without it, asks for one rescan and records that it did. */
async function watched<T>(what: string, fn: () => Promise<T>, hintMs = 12_000) {
  const start = performance.now();
  let viaRescan = false;
  const value = await until(
    what,
    async () => {
      if (!viaRescan && performance.now() - start > hintMs) {
        viaRescan = true;
        await api.rescanWatchedFolders();
      }
      return fn();
    },
    60_000,
  );
  return { value, viaRescan, ms: Math.round(performance.now() - start) };
}

async function runStep(results: Report, name: string, fn: () => Promise<Report>) {
  try {
    results[name] = await fn();
  } catch (e) {
    results[name] = { error: String(e) };
  }
}

const jobFor = (path: string) => Object.values(useApp.getState().jobs).find((j) => j.source_path === path);

async function liveImport(m3: M3Config): Promise<Report> {
  const report: Report = { phase: "m3-live-import" };

  let domAt: number | null = null;
  const imports = () => document.querySelector('section[aria-label="Imports"]');
  const observer = new MutationObserver(() => domAt === null && imports() && (domAt = performance.now()));
  observer.observe(document.body, { childList: true, subtree: true });
  let storeAt: number | null = null;
  const unsubscribe = useApp.subscribe((s) => {
    const acknowledged = s.pendingImports > 0 || Object.values(s.jobs).some((j) => j.state === "queued" || j.state === "running");
    if (storeAt === null && acknowledged) storeAt = performance.now();
  });
  const t0 = performance.now();
  const pending = importPaths(m3.fixtures);
  await until("import acknowledgement in the DOM", () => domAt !== null, 5000).catch(() => null);
  observer.disconnect();
  unsubscribe();
  report.ack = {
    storeMs: storeAt === null ? null : Math.round((storeAt - t0) * 10) / 10,
    domMs: domAt === null ? null : Math.round((domAt - t0) * 10) / 10,
  };
  const jobs = await pending;
  report.perFixture = jobs.map((j) => ({
    file: base(j.source_path),
    state: j.state,
    outcome: j.outcome,
    ms: j.finished_at !== null && j.started_at !== null ? j.finished_at - j.started_at : null,
  }));

  await runStep(report, "huge", async () => {
    const huge = m3.files.huge;
    const pendingHuge = importPaths([huge]);
    const job = await until("huge.pdf running for over 1 s, or finished", () => {
      const j = jobFor(huge);
      if (!j) return null;
      if (isTerminal(j)) return j;
      return j.state === "running" && j.started_at !== null && Date.now() - j.started_at > 1100 ? j : null;
    }, 60_000);
    const progress = await until("progress bar for huge.pdf", () => document.querySelector(`[aria-label="Importing ${base(huge)}"][role="progressbar"]`), 3000).catch(() => null);
    const ranMs = job.started_at !== null ? Date.now() - job.started_at : null;
    await useApp.getState().cancelImport(job.id);
    const [final] = await pendingHuge;
    return { stateBeforeCancel: job.state, ranMs, progressShown: progress !== null, bytesDone: jobFor(huge)?.bytes_done ?? null, bytesTotal: job.bytes_total, state: final?.state };
  });

  const typicalJob = jobs.find((j) => base(j.source_path) === "typical.epub");
  await runStep(report, "alreadyManaged", async () => {
    const [again] = await importPaths([typicalJob!.source_path]);
    const focused = await until("focus on the existing book", () => useApp.getState().focusedBookId === again.book_id, 5000).catch(() => false);
    const card = await until("focused card", () => document.querySelector(`[data-book-id="${again.book_id}"][data-focused="true"]`), 5000).catch(() => null);
    return { outcome: again.outcome, bookId: again.book_id, firstBookId: typicalJob?.book_id, focused, cardFocused: card !== null };
  });

  await runStep(report, "drop", async () => {
    const paths = [m3.files.drop];
    const target = { kind: "Webview" as const, label: getCurrentWebview().label };
    await emitTo(target, "tauri://drag-enter", { paths, position: { x: 200, y: 200 } });
    const overlay = await until("drop overlay", () => document.querySelector("[data-drop-overlay]"), 3000).catch(() => null);
    await emitTo(target, "tauri://drag-drop", { paths, position: { x: 200, y: 200 } });
    const job = await until("dropped job done", () => {
      const j = jobFor(m3.files.drop);
      return j && isTerminal(j) ? j : null;
    }, 30_000);
    const overlayGone = await until("overlay hidden", () => !document.querySelector("[data-drop-overlay]"), 3000).catch(() => false);
    const [book] = await bookBySha(m3.sha.drop);
    return { overlayShown: overlay !== null, overlayGone, state: job.state, outcome: job.outcome, bookId: book?.id ?? null };
  });

  await runStep(report, "openWith", async () => {
    await fsStep("open-with");
    const name = base(m3.files.openWith);
    const job = await until(
      "Open With job",
      async () => (await api.listImportJobs()).find((j) => base(j.source_path) === name && isTerminal(j)),
      30_000,
    ).catch(() => null);
    const [book] = await bookBySha(m3.sha.openWith);
    return job ? { verified: true, state: job.state, outcome: job.outcome, path: job.source_path, bookId: book?.id ?? null } : { verified: false };
  });

  report.ok = true;
  return report;
}

async function kill(m3: M3Config): Promise<Report> {
  void importPaths([m3.files.huge2, m3.files.resumable]);
  await until("import started", () => jobFor(m3.files.huge2), 10_000);
  await fsStep("kill");
  // Node SIGKILLs the app once the staging file grows.
  await sleep(10 * 60_000);
  return { phase: "m3-kill", ok: false, error: "not killed" };
}

async function recover(m3: M3Config): Promise<Report> {
  const find = (all: ImportJob[], path: string) => all.find((j) => j.source_path === path);
  const { huge2, resumable } = await until("recovered jobs terminal", async () => {
    const all = await api.listImportJobs();
    const h = find(all, m3.files.huge2);
    const r = find(all, m3.files.resumable);
    return h && r && isTerminal(h) && isTerminal(r) ? { huge2: h, resumable: r } : null;
  }, 120_000);
  const [book] = await bookBySha(m3.sha.resumable);
  const failedRow = await until("failed job row", () => document.querySelector('[data-job-state="failed"]'), 5000).catch(() => null);
  return {
    phase: "m3-recover",
    huge2: { state: huge2.state, error: huge2.error },
    resumable: { state: resumable.state, outcome: resumable.outcome, bookId: resumable.book_id, bookPresent: book?.id === resumable.book_id },
    failedRowText: failedRow?.textContent ?? null,
    ok: true,
  };
}

const PROGRESS_PAGE = 2;

async function watchLive(m3: M3Config): Promise<Report> {
  const { files, sha, dirs } = m3;
  const report: Report = { phase: "m3-watch-live" };
  const ids: Record<string, number> = {};
  report.ids = ids;
  const s = () => useApp.getState();
  for (const d of [dirs.watchA, dirs.watchB, dirs.watchC]) await s().addFolder(d);
  const initial = ["dup", "rename", "moveout", "delete", "change", "perm", "explicit", "exclude", "c1", "offRename", "offMoveout", "offDelete", "offChange", "offPerm"];
  await until("initial scan", async () => {
    const all = await books();
    return initial.every((k) => all.some((b) => b.sha256 === sha[k]));
  }, 120_000);
  const all = await books();
  for (const k of initial) ids[k] = all.find((b) => b.sha256 === sha[k])!.id;
  report.folders = (await api.listWatchedFolders()).map((f) => ({ path: f.path, access: f.access_state, scanned: f.last_scan_at !== null }));

  await runStep(report, "duplicate", async () => {
    const copies = await bookBySha(sha.dup);
    const locs = await api.getLocations(ids.dup);
    await s().refreshLibrary();
    const cards = await until("dup card", () => document.querySelectorAll(`[data-book-id="${ids.dup}"]`).length || null, 5000).catch(() => 0);
    return { books: copies.length, locations: locs.map((l) => ({ path: l.path, kind: l.kind, availability: l.availability })), cards };
  });

  await runStep(report, "add", async () => {
    await fsStep("add");
    const r = await watched("added file", () => locationAt(sha.added, files.added));
    ids.added = r.value.book.id;
    return { availability: r.value.loc.availability, available: r.value.book.available, viaRescan: r.viaRescan, ms: r.ms };
  });

  await runStep(report, "rename", async () => {
    await fsStep("rename");
    const r = await watched("renamed into subfolder", async () => {
      const at = await locationAt(sha.rename, files.renamed);
      return at?.loc.availability === "available" ? at : null;
    });
    const locs = await api.getLocations(r.value.book.id);
    return { sameId: r.value.book.id === ids.rename, paths: locs.map((l) => l.path), available: r.value.book.available, viaRescan: r.viaRescan, ms: r.ms };
  });

  const missing = async (key: string, step: string) => {
    await fsStep(step);
    const r = await watched(`${step} marks moved`, async () => {
      const at = await locationAt(sha[key], files[key]);
      return at?.loc.availability === "moved" ? at : null;
    });
    return { availability: r.value.loc.availability, available: r.value.book.available, sameId: r.value.book.id === ids[key], viaRescan: r.viaRescan, ms: r.ms };
  };
  await runStep(report, "moveOut", async () => {
    const r = await missing("moveout", "move-out");
    s().showBookInfo(ids.moveout);
    const info = await until("Book Info shows moved", () => document.querySelector('[data-availability="moved"]'), 5000).catch(() => null);
    s().showBookInfo(null);
    return { ...r, bookInfoShowsMoved: info !== null };
  });
  await runStep(report, "delete", () => missing("delete", "delete"));

  await runStep(report, "change", async () => {
    await api.saveProgress(ids.change, { format: "pdf", v: 1, page_index: PROGRESS_PAGE, x: 0, y: 0 }, 0.3);
    await api.saveProgress(ids.offChange, { format: "pdf", v: 1, page_index: PROGRESS_PAGE, x: 0, y: 0 }, 0.3);
    await fsStep("change");
    const r = await watched("changed bytes become a new book", () => locationAt(sha.changed, files.change));
    const old = (await books()).find((b) => b.id === ids.change);
    const oldProgress = (await api.openBook(ids.change)).progress;
    return {
      newId: r.value.book.id,
      oldId: ids.change,
      newAvailable: r.value.loc.availability,
      oldAvailable: old?.available ?? null,
      oldProgressPage: oldProgress?.locator.format === "pdf" ? oldProgress.locator.page_index : null,
      viaRescan: r.viaRescan,
      ms: r.ms,
    };
  });

  await runStep(report, "permission", async () => {
    await fsStep("chmod");
    const r = await watched("permission denied", async () => {
      const at = await locationAt(sha.perm, files.perm);
      return at?.loc.availability === "permission_denied" ? at : null;
    });
    return { availability: r.value.loc.availability, viaRescan: r.viaRescan, ms: r.ms };
  });

  await runStep(report, "explicit", async () => {
    const [job] = await importPaths([files.explicit]);
    const locs = await api.getLocations(ids.explicit);
    return { outcome: job.outcome, sameId: job.book_id === ids.explicit, kinds: locs.map((l) => l.kind).sort() };
  });

  await runStep(report, "exclusion", async () => {
    await api.removeBook(ids.exclude);
    await s().refreshLibrary();
    const scanBefore = Math.max(...(await api.listWatchedFolders()).map((f) => f.last_scan_at ?? 0));
    await api.rescanWatchedFolders();
    await until("rescan after removal", async () => Math.max(...(await api.listWatchedFolders()).map((f) => f.last_scan_at ?? 0)) > scanBefore, 30_000);
    await sleep(500);
    const excl = await api.listExclusions();
    return { booksAfterRescan: (await bookBySha(sha.exclude)).length, excluded: excl.some((e) => e.sha256 === sha.exclude) };
  });

  await runStep(report, "exclusionReadd", async () => {
    const folderA = (await api.listWatchedFolders()).find((f) => f.path === dirs.watchA);
    if (!folderA) throw new Error("watchA is not a watched folder");
    await api.removeWatchedFolder(folderA.id);
    await s().addFolder(dirs.watchA);
    const readded = await until("watchA rescanned", async () => {
      const f = (await api.listWatchedFolders()).find((f) => f.path === dirs.watchA);
      return f && f.id !== folderA.id && f.last_scan_at !== null && (await locationAt(sha.offRename, files.offRename))?.loc.availability === "available" ? f : null;
    }, 60_000);
    await api.rescanWatchedFolders();
    await until("rescan after re-add", async () => ((await api.listWatchedFolders()).find((f) => f.id === readded.id)?.last_scan_at ?? 0) > readded.last_scan_at!, 30_000);
    await sleep(500);
    const excl = await api.listExclusions();
    return {
      newFolderId: readded.id !== folderA.id,
      booksAfterRescan: (await bookBySha(sha.exclude)).length,
      excluded: excl.some((e) => e.sha256 === sha.exclude && e.folder_path === dirs.watchA),
    };
  });

  await runStep(report, "organize", async () => {
    await s().createCollection("M3 Picks", [ids.dup, ids.explicit]);
    const pick = s().collections.find((c) => c.name === "M3 Picks");
    const folderA = s().folders.find((f) => f.path === dirs.watchA);
    if (folderA) await s().setFolderCollection(folderA.id, true);
    if (pick) await s().setView({ sort: "title", format: "pdf", collection_id: pick.id });
    ids.pick = pick?.id ?? -1;
    ids.folderA = folderA?.id ?? -1;
    return { collection: pick?.id ?? null, folderA: folderA?.id ?? null, view: s().uiSettings.library };
  });

  await runStep(report, "palette", async () => {
    const id = ids.rename;
    await openAndWait(id);
    const before = commandRuns["book.finished"] ?? 0;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    const input = await until("palette input", () => document.querySelector<HTMLInputElement>("[cmdk-input]"), 5000);
    const opened = s().paletteOpen;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "Mark as Finished");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const selected = await until("Mark as Finished selected", () => {
      const el = document.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]');
      return el?.dataset.commandId === "book.finished" ? el : null;
    }, 5000);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const finished = await until("book finished", async () => (await books()).find((b) => b.id === id)?.reading_state === "finished", 5000).catch(() => false);
    // The exit animation, and so the unmount, stalls while the window is hidden; data-state flips at once.
    const dialogClosed = () => {
      const dialog = document.querySelector("[cmdk-input]")?.closest<HTMLElement>('[role="dialog"]');
      return !dialog || dialog.dataset.state === "closed";
    };
    const closed = await until("palette closed", () => !s().paletteOpen && dialogClosed(), 3000).catch(() => false);
    const runs = (commandRuns["book.finished"] ?? 0) - before;
    await s().closeBook();
    return { opened, selected: selected.dataset.commandId, runs, finished, closed };
  });

  report.ok = true;
  return report;
}

async function watchOffline(m3: M3Config): Promise<Report> {
  const { files, sha, dirs, prev } = m3;
  const report: Report = { phase: "m3-watch-offline" };
  const scan = await until("launch scan", async () => {
    const folders = await api.listWatchedFolders();
    const a = folders.find((f) => f.path === dirs.watchA);
    const b = folders.find((f) => f.path === dirs.watchB);
    return a && b && (a.last_scan_at ?? 0) > m3.launchedAt && (b.last_scan_at ?? 0) > m3.launchedAt ? folders : null;
  }, 120_000);
  report.folders = scan.map((f) => ({ path: f.path, access: f.access_state, lastScanAfterLaunch: (f.last_scan_at ?? 0) > m3.launchedAt }));
  // A launch scan may defer files younger than 2 s; allow the retry to land.
  const settled = <T>(what: string, fn: () => Promise<T>) => until(what, fn, 30_000).catch(() => null);

  await runStep(report, "added", async () => {
    const at = await settled("offline added", () => locationAt(sha.offAdded, files.offAdded));
    return { availability: at?.loc.availability ?? null };
  });
  await runStep(report, "rename", async () => {
    const at = await settled("offline rename", async () => {
      const r = await locationAt(sha.offRename, files.offRenamed);
      return r?.loc.availability === "available" ? r : null;
    });
    const locs = at ? await api.getLocations(at.book.id) : [];
    return { sameId: at?.book.id === prev.offRename, paths: locs.map((l) => l.path), availability: at?.loc.availability ?? null };
  });
  for (const [name, key] of [["moveOut", "offMoveout"], ["delete", "offDelete"]] as const) {
    await runStep(report, name, async () => {
      const at = await settled(`offline ${name}`, async () => {
        const r = await locationAt(sha[key], files[key]);
        return r?.loc.availability === "moved" ? r : null;
      });
      return { availability: at?.loc.availability ?? null, available: at?.book.available ?? null, sameId: at?.book.id === prev[key] };
    });
  }
  await runStep(report, "change", async () => {
    const at = await settled("offline change", () => locationAt(sha.offChanged, files.offChange));
    const old = (await books()).find((b) => b.id === prev.offChange);
    const oldProgress = (await api.openBook(prev.offChange)).progress;
    return {
      newId: at?.book.id ?? null,
      oldId: prev.offChange,
      newAvailability: at?.loc.availability ?? null,
      oldAvailable: old?.available ?? null,
      oldProgressPage: oldProgress?.locator.format === "pdf" ? oldProgress.locator.page_index : null,
    };
  });
  await runStep(report, "permission", async () => {
    const at = await settled("offline chmod", async () => {
      const r = await locationAt(sha.offPerm, files.offPerm);
      return r?.loc.availability === "permission_denied" ? r : null;
    });
    return { availability: at?.loc.availability ?? (await locationAt(sha.offPerm, files.offPerm))?.loc.availability ?? null };
  });
  await runStep(report, "folderDenied", async () => {
    const r = await settled("watchC denied", async () => {
      const folder = (await api.listWatchedFolders()).find((f) => f.path === dirs.watchC);
      const at = await locationAt(sha.c1, files.c1);
      return folder?.access_state === "permission_denied" && at?.loc.availability === "permission_denied" ? { folder, at } : null;
    });
    const folder = (await api.listWatchedFolders()).find((f) => f.path === dirs.watchC);
    const at = await locationAt(sha.c1, files.c1);
    return { folderAccess: r?.folder.access_state ?? folder?.access_state ?? null, locationAvailability: r?.at.loc.availability ?? at?.loc.availability ?? null };
  });
  await runStep(report, "exclusion", async () => {
    const held = (await bookBySha(sha.exclude)).length === 0;
    const excl = (await api.listExclusions()).find((e) => e.sha256 === sha.exclude);
    if (excl) await useApp.getState().restoreExclusion(excl);
    const back = await until("restored book returns", async () => (await bookBySha(sha.exclude)).length === 1, 30_000).catch(() => false);
    return { heldAfterLaunchScan: held, listed: excl !== undefined, returnedAfterRestore: back };
  });
  await runStep(report, "organization", async () => {
    const collections = await api.listCollections();
    const all = await books();
    const pick = collections.find((c) => c.id === prev.pick);
    const folderA = (await api.listWatchedFolders()).find((f) => f.id === prev.folderA);
    const derived = collections.find((c) => c.kind === "derived" && c.watched_folder_id === prev.folderA);
    const members = all.filter((b) => b.collection_ids.includes(prev.pick)).map((b) => b.id).sort();
    return {
      collection: pick?.name ?? null,
      members,
      expectedMembers: [prev.dup, prev.explicit].sort(),
      folderCollection: folderA?.show_collection ?? null,
      derivedCollection: derived !== undefined,
      view: (await api.getUiSettings()).library,
      storeView: useApp.getState().uiSettings.library,
      finished: all.find((b) => b.id === prev.rename)?.reading_state ?? null,
    };
  });
  report.ok = true;
  return report;
}

export function runM3Phase(phase: string, config: unknown): Promise<Report> {
  const m3 = config as M3Config;
  switch (phase) {
    case "m3-live-import":
      return liveImport(m3);
    case "m3-kill":
      return kill(m3);
    case "m3-recover":
      return recover(m3);
    case "m3-watch-live":
      return watchLive(m3);
    case "m3-watch-offline":
      return watchOffline(m3);
    default:
      throw new Error(`unknown phase ${phase}`);
  }
}
