//! Watched folders. Notify events are only hints: every change is found by
//! reconciling a fresh filesystem snapshot against the database, so a missed
//! or duplicated event never leaves the library wrong.
use crate::db;
use crate::library::Library;
use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const QUIET: Duration = Duration::from_millis(500);
const FRESH_MS: i64 = 2000;
const STABLE_TRIES: usize = 3;
const FRESH_RETRY: Duration = Duration::from_millis(2500);
const UNAVAILABLE_RETRY: Duration = Duration::from_secs(30);

// ---- snapshot ----

#[derive(Debug, Clone, PartialEq)]
pub struct FileEntry {
    pub folder_id: i64,
    pub size: u64,
    pub mtime: i64,
    pub readable: bool,
}

#[derive(Debug, Default)]
pub struct Snapshot {
    pub folders: HashMap<i64, FolderAccess>,
    pub files: HashMap<String, FileEntry>,
    pub denied_dirs: Vec<PathBuf>,
}

impl Snapshot {
    fn under_denied_dir(&self, path: &str) -> bool {
        self.denied_dirs.iter().any(|d| Path::new(path).starts_with(d))
    }
}

pub fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

/// Walks every folder, attributing each file to the deepest registered folder
/// by pruning nested roots, which are walked on their own.
pub fn snapshot(folders: &[(i64, PathBuf)]) -> Snapshot {
    let roots: HashSet<&Path> = folders.iter().map(|(_, p)| p.as_path()).collect();
    let mut snap = Snapshot::default();
    for (id, root) in folders {
        let access = match fs::symlink_metadata(root) {
            Ok(m) if m.is_dir() => match fs::read_dir(root) {
                Ok(_) => FolderAccess::Ok,
                Err(e) if e.kind() == ErrorKind::PermissionDenied => FolderAccess::PermissionDenied,
                Err(_) => FolderAccess::Unavailable,
            },
            Ok(_) => FolderAccess::Unavailable,
            Err(e) if e.kind() == ErrorKind::PermissionDenied => FolderAccess::PermissionDenied,
            Err(_) => FolderAccess::Unavailable,
        };
        snap.folders.insert(*id, access);
        if access != FolderAccess::Ok {
            continue;
        }
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                snap.denied_dirs.push(dir);
                continue;
            };
            for entry in entries.flatten() {
                if is_hidden(&entry.file_name()) {
                    continue;
                }
                let path = entry.path();
                let Ok(meta) = fs::symlink_metadata(&path) else { continue };
                if meta.is_dir() {
                    if !roots.contains(path.as_path()) {
                        stack.push(path);
                    }
                } else if meta.is_file() && Format::from_path(&path).is_some() {
                    snap.files.insert(
                        path.to_string_lossy().into_owned(),
                        FileEntry {
                            folder_id: *id,
                            size: meta.len(),
                            mtime: mtime_ms(&meta),
                            readable: fs::File::open(&path).is_ok(),
                        },
                    );
                }
            }
        }
    }
    snap
}

// ---- database state ----

#[derive(Debug, Clone)]
pub struct LocRow {
    pub id: i64,
    pub book_id: i64,
    pub sha256: String,
    pub path: String,
    pub folder_id: Option<i64>,
    pub availability: Availability,
    pub size: Option<i64>,
    pub mtime: Option<i64>,
}

#[derive(Debug, Default)]
pub struct DbState {
    pub folders: Vec<WatchedFolder>,
    pub locations: Vec<LocRow>,
    pub exclusions: HashSet<(i64, String)>,
}

fn access_str(a: FolderAccess) -> &'static str {
    match a {
        FolderAccess::Ok => "ok",
        FolderAccess::Unavailable => "unavailable",
        FolderAccess::PermissionDenied => "permission_denied",
    }
}

fn parse_access(s: &str) -> FolderAccess {
    match s {
        "ok" => FolderAccess::Ok,
        "permission_denied" => FolderAccess::PermissionDenied,
        _ => FolderAccess::Unavailable,
    }
}

fn err(e: impl ToString) -> String {
    e.to_string()
}

fn folder_from_row(r: &rusqlite::Row) -> rusqlite::Result<WatchedFolder> {
    Ok(WatchedFolder {
        id: r.get(0)?,
        path: r.get(1)?,
        access_state: parse_access(&r.get::<_, String>(2)?),
        last_scan_at: r.get(3)?,
        show_collection: r.get::<_, i64>(4)? != 0,
    })
}

const FOLDER_SELECT: &str = "SELECT id, path, access_state, last_scan_at, show_collection FROM watched_folders";

pub fn list_folders(conn: &Connection) -> Result<Vec<WatchedFolder>, String> {
    let mut stmt = conn.prepare(&format!("{FOLDER_SELECT} ORDER BY path")).map_err(err)?;
    let rows = stmt.query_map([], folder_from_row).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

fn load(conn: &Connection) -> Result<DbState, String> {
    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.book_id, b.sha256, l.path, l.watched_folder_id, l.availability, l.observed_size, l.observed_mtime
             FROM book_locations l JOIN books b ON b.id = l.book_id WHERE l.kind = 'watched' ORDER BY l.id",
        )
        .map_err(err)?;
    let locations = stmt
        .query_map([], |r| {
            Ok(LocRow {
                id: r.get(0)?,
                book_id: r.get(1)?,
                sha256: r.get(2)?,
                path: r.get(3)?,
                folder_id: r.get(4)?,
                availability: Availability::parse(&r.get::<_, String>(5)?),
                size: r.get(6)?,
                mtime: r.get(7)?,
            })
        })
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    let mut stmt = conn.prepare("SELECT watched_folder_id, sha256 FROM watched_exclusions").map_err(err)?;
    let exclusions = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(err)?
        .collect::<Result<_, _>>()
        .map_err(err)?;
    Ok(DbState { folders: list_folders(conn)?, locations, exclusions })
}

// ---- hashing ----

#[derive(Debug, Clone, PartialEq)]
pub struct Hashed {
    pub sha256: String,
    pub size: u64,
    pub mtime: i64,
}

fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buf[..n]);
    }
}

/// Hashes only if size and mtime are the same before and after, so a file
/// still being written is never recorded under a partial hash.
fn hash_stable(path: &Path) -> Option<Hashed> {
    for _ in 0..STABLE_TRIES {
        let before = fs::symlink_metadata(path).ok()?;
        let sha256 = hash_file(path).ok()?;
        let after = fs::symlink_metadata(path).ok()?;
        if before.len() == after.len() && mtime_ms(&before) == mtime_ms(&after) {
            return Some(Hashed { sha256, size: after.len(), mtime: mtime_ms(&after) });
        }
    }
    None
}

fn unchanged(loc: &LocRow, f: &FileEntry) -> bool {
    loc.availability == Availability::Available && loc.size == Some(f.size as i64) && loc.mtime == Some(f.mtime)
}

/// Paths whose content must be known before planning.
fn paths_to_hash(state: &DbState, snap: &Snapshot, now: i64) -> Vec<String> {
    let known: HashMap<&str, &LocRow> = state.locations.iter().map(|l| (l.path.as_str(), l)).collect();
    snap.files
        .iter()
        .filter(|(_, f)| f.readable)
        .filter(|(p, f)| match known.get(p.as_str()) {
            Some(loc) => !unchanged(loc, f),
            None => now - f.mtime >= FRESH_MS,
        })
        .map(|(p, _)| p.clone())
        .collect()
}

// ---- planning ----

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    SetFolderAccess { folder_id: i64, access: FolderAccess },
    SetAvailability { location_id: i64, availability: Availability },
    /// Same content at the same path; only the observed stat changed.
    Refresh { location_id: i64, folder_id: i64, size: u64, mtime: i64 },
    /// The book's file now lives at another path.
    Relink { location_id: i64, book_id: i64, path: String, folder_id: i64, size: u64, mtime: i64 },
    /// Points `path` at the book with this hash, creating the book if needed.
    /// On a known path this is a new content version.
    Link { sha256: String, path: String, folder_id: i64, size: u64, mtime: i64 },
    Delete { location_id: i64 },
}

#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    pub actions: Vec<Action>,
    /// Some files were too fresh or unstable to hash; scan again soon.
    pub deferred: bool,
}

pub fn plan(state: &DbState, snap: &Snapshot, hashes: &HashMap<String, Hashed>, now: i64) -> Plan {
    let mut out = Plan::default();
    let excluded = |folder: i64, sha: &str| state.exclusions.contains(&(folder, sha.to_string()));

    for f in &state.folders {
        let access = snap.folders.get(&f.id).copied().unwrap_or(FolderAccess::Unavailable);
        if access != f.access_state {
            out.actions.push(Action::SetFolderAccess { folder_id: f.id, access });
        }
    }

    let set = |out: &mut Plan, loc: &LocRow, availability: Availability| {
        if loc.availability != availability {
            out.actions.push(Action::SetAvailability { location_id: loc.id, availability });
        }
    };
    let mut vanished: Vec<&LocRow> = Vec::new();
    for loc in &state.locations {
        let Some(folder_id) = loc.folder_id else { continue };
        match snap.folders.get(&folder_id) {
            Some(FolderAccess::Ok) => {}
            Some(FolderAccess::PermissionDenied) => {
                set(&mut out, loc, Availability::PermissionDenied);
                continue;
            }
            _ => {
                set(&mut out, loc, Availability::FolderUnavailable);
                continue;
            }
        }
        let Some(file) = snap.files.get(&loc.path) else {
            if snap.under_denied_dir(&loc.path) {
                set(&mut out, loc, Availability::PermissionDenied);
            } else {
                vanished.push(loc);
            }
            continue;
        };
        if !file.readable {
            set(&mut out, loc, Availability::PermissionDenied);
            continue;
        }
        if unchanged(loc, file) {
            if loc.folder_id != Some(file.folder_id) {
                out.actions.push(Action::Refresh { location_id: loc.id, folder_id: file.folder_id, size: file.size, mtime: file.mtime });
            }
            continue;
        }
        let Some(h) = hashes.get(&loc.path) else {
            out.deferred = true;
            continue;
        };
        if h.sha256 == loc.sha256 {
            out.actions.push(Action::Refresh { location_id: loc.id, folder_id: file.folder_id, size: h.size, mtime: h.mtime });
        } else if excluded(file.folder_id, &h.sha256) {
            out.actions.push(Action::Delete { location_id: loc.id });
        } else {
            out.actions.push(Action::Link {
                sha256: h.sha256.clone(),
                path: loc.path.clone(),
                folder_id: file.folder_id,
                size: h.size,
                mtime: h.mtime,
            });
        }
    }

    let known: HashSet<&str> = state.locations.iter().map(|l| l.path.as_str()).collect();
    let mut new_files: Vec<(&String, &FileEntry)> =
        snap.files.iter().filter(|(p, f)| f.readable && !known.contains(p.as_str())).collect();
    new_files.sort_by(|a, b| a.0.cmp(b.0));
    let mut relinked: HashSet<i64> = HashSet::new();
    for (path, file) in new_files {
        if now - file.mtime < FRESH_MS {
            out.deferred = true;
            continue;
        }
        let Some(h) = hashes.get(path) else {
            out.deferred = true;
            continue;
        };
        if excluded(file.folder_id, &h.sha256) {
            continue;
        }
        let candidate = vanished.iter().find(|l| l.sha256 == h.sha256 && !relinked.contains(&l.id));
        if let Some(loc) = candidate {
            relinked.insert(loc.id);
            out.actions.push(Action::Relink {
                location_id: loc.id,
                book_id: loc.book_id,
                path: path.clone(),
                folder_id: file.folder_id,
                size: h.size,
                mtime: h.mtime,
            });
        } else {
            out.actions.push(Action::Link {
                sha256: h.sha256.clone(),
                path: path.clone(),
                folder_id: file.folder_id,
                size: h.size,
                mtime: h.mtime,
            });
        }
    }
    for loc in vanished {
        if !relinked.contains(&loc.id) {
            set(&mut out, loc, Availability::Moved);
        }
    }
    out
}

// ---- apply ----

fn title_of(path: &str) -> String {
    Path::new(path).file_stem().map(|s| clean_text(&s.to_string_lossy(), MAX_TITLE)).unwrap_or_default()
}

fn link(tx: &Connection, sha: &str, path: &str, folder_id: i64, size: u64, mtime: i64) -> Result<bool, String> {
    let still_excluded = tx
        .query_row("SELECT 1 FROM watched_exclusions WHERE watched_folder_id = ?1 AND sha256 = ?2", params![folder_id, sha], |_| Ok(()))
        .optional()
        .map_err(err)?
        .is_some();
    if still_excluded {
        return Ok(false);
    }
    let Some(format) = Format::from_path(Path::new(path)) else { return Ok(false) };
    let book = match db::find_by_hash(tx, sha)? {
        Some(id) => id,
        None => db::insert_book(tx, sha, format, &title_of(path), size)?,
    };
    db::upsert_location(tx, book, LocationKind::Watched, path, Some(folder_id), size, Some(mtime))?;
    Ok(true)
}

/// Applies the plan in one transaction. Every statement is conditioned on the
/// rows it read, so a command that changed them during hashing wins.
fn apply(conn: &Connection, actions: &[Action], folder_ids: &[i64], now: i64) -> Result<bool, String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    let live: HashSet<i64> = {
        let mut stmt = tx.prepare("SELECT id FROM watched_folders").map_err(err)?;
        let ids = stmt.query_map([], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
        ids
    };
    let mut changed = false;
    for a in actions {
        let n = match a {
            Action::SetFolderAccess { folder_id, access } => tx
                .execute("UPDATE watched_folders SET access_state = ?2 WHERE id = ?1", params![folder_id, access_str(*access)])
                .map_err(err)?,
            Action::SetAvailability { location_id, availability } => tx
                .execute(
                    "UPDATE book_locations SET availability = ?2 WHERE id = ?1 AND kind = 'watched'",
                    params![location_id, availability.as_str()],
                )
                .map_err(err)?,
            Action::Refresh { location_id, folder_id, size, mtime } if live.contains(folder_id) => tx
                .execute(
                    "UPDATE book_locations SET availability = 'available', watched_folder_id = ?2, observed_size = ?3, observed_mtime = ?4
                     WHERE id = ?1 AND kind = 'watched'",
                    params![location_id, folder_id, *size as i64, mtime],
                )
                .map_err(err)?,
            Action::Relink { location_id, book_id, path, folder_id, size, mtime } if live.contains(folder_id) => tx
                .execute(
                    "UPDATE book_locations SET path = ?3, watched_folder_id = ?4, availability = 'available', observed_size = ?5, observed_mtime = ?6
                     WHERE id = ?1 AND book_id = ?2 AND kind = 'watched'
                       AND NOT EXISTS (SELECT 1 FROM book_locations WHERE kind = 'watched' AND path = ?3)",
                    params![location_id, book_id, path, folder_id, *size as i64, mtime],
                )
                .map_err(err)?,
            Action::Link { sha256, path, folder_id, size, mtime } if live.contains(folder_id) => {
                link(&tx, sha256, path, *folder_id, *size, *mtime)? as usize
            }
            Action::Delete { location_id } => {
                tx.execute("DELETE FROM book_locations WHERE id = ?1 AND kind = 'watched'", [location_id]).map_err(err)?
            }
            _ => 0,
        };
        changed |= n > 0;
    }
    for id in folder_ids {
        tx.execute("UPDATE watched_folders SET last_scan_at = ?2 WHERE id = ?1", params![id, now]).map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(changed)
}

#[derive(Debug, Default, PartialEq)]
pub struct Outcome {
    pub changed: bool,
    pub retry_after: Option<Duration>,
}

/// One full reconcile. The connection lock is held only to read state and to
/// apply the result, never while walking or hashing.
pub fn reconcile(lib: &Library) -> Result<Outcome, String> {
    let state = load(&lib.conn.lock().unwrap())?;
    let roots: Vec<(i64, PathBuf)> = state.folders.iter().map(|f| (f.id, PathBuf::from(&f.path))).collect();
    let snap = snapshot(&roots);
    let now = db::now();
    let hashes: HashMap<String, Hashed> = paths_to_hash(&state, &snap, now)
        .into_iter()
        .filter_map(|p| hash_stable(Path::new(&p)).map(|h| (p, h)))
        .collect();
    let plan = plan(&state, &snap, &hashes, now);
    let ids: Vec<i64> = roots.iter().map(|(id, _)| *id).collect();
    let changed = apply(&lib.conn.lock().unwrap(), &plan.actions, &ids, now)?;
    let unavailable = snap.folders.values().any(|a| *a != FolderAccess::Ok);
    let retry_after = if plan.deferred {
        Some(FRESH_RETRY)
    } else if unavailable {
        Some(UNAVAILABLE_RETRY)
    } else {
        None
    };
    Ok(Outcome { changed, retry_after })
}

// ---- folder operations ----

pub fn add_folder(conn: &Connection, path: &str) -> Result<WatchedFolder, String> {
    let canon = fs::canonicalize(path).map_err(|e| format!("Cannot open folder: {e}"))?;
    if !canon.is_dir() {
        return Err("Not a folder".into());
    }
    let canon = canon.to_string_lossy().into_owned();
    let exists = conn
        .query_row("SELECT 1 FROM watched_folders WHERE path = ?1", [&canon], |_| Ok(()))
        .optional()
        .map_err(err)?;
    if exists.is_some() {
        return Err(format!("{canon} is already a watched folder"));
    }
    conn.execute("INSERT INTO watched_folders (path) VALUES (?1)", [&canon]).map_err(err)?;
    conn.query_row(&format!("{FOLDER_SELECT} WHERE id = ?1"), [conn.last_insert_rowid()], folder_from_row)
        .map_err(err)
}

/// Detaches the folder's locations and derived collection; books, progress,
/// preferences, and annotations stay.
pub fn remove_folder(conn: &Connection, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute("DELETE FROM book_locations WHERE watched_folder_id = ?1", [id]).map_err(err)?;
    tx.execute("DELETE FROM watched_folders WHERE id = ?1", [id]).map_err(err)?;
    tx.commit().map_err(err)
}

pub fn set_collection(conn: &Connection, id: i64, enabled: bool) -> Result<(), String> {
    let path: String = conn
        .query_row("SELECT path FROM watched_folders WHERE id = ?1", [id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or("Folder not found")?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    if enabled {
        let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(path.clone());
        tx.execute(
            "INSERT INTO collections (name, kind, watched_folder_id) SELECT ?1, 'derived', ?2
             WHERE NOT EXISTS (SELECT 1 FROM collections WHERE kind = 'derived' AND watched_folder_id = ?2)",
            params![name, id],
        )
        .map_err(err)?;
    } else {
        tx.execute("DELETE FROM collections WHERE kind = 'derived' AND watched_folder_id = ?1", [id]).map_err(err)?;
    }
    tx.execute("UPDATE watched_folders SET show_collection = ?2 WHERE id = ?1", params![id, enabled]).map_err(err)?;
    tx.commit().map_err(err)
}

pub fn exclusions(conn: &Connection) -> Result<Vec<Exclusion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT e.watched_folder_id, f.path, e.sha256, e.title, e.excluded_at
             FROM watched_exclusions e JOIN watched_folders f ON f.id = e.watched_folder_id ORDER BY e.excluded_at DESC",
        )
        .map_err(err)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Exclusion { watched_folder_id: r.get(0)?, folder_path: r.get(1)?, sha256: r.get(2)?, title: r.get(3)?, excluded_at: r.get(4)? })
        })
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

pub fn delete_exclusion(conn: &Connection, folder_id: i64, sha256: &str) -> Result<(), String> {
    conn.execute("DELETE FROM watched_exclusions WHERE watched_folder_id = ?1 AND sha256 = ?2", params![folder_id, sha256])
        .map(|_| ())
        .map_err(err)
}

// ---- reconcile thread ----

#[derive(Debug, Clone, Copy, PartialEq)]
enum Msg {
    Changed,
    FoldersChanged,
}

/// Handle to the single reconcile thread. Every request lands in one channel,
/// so reconciles never overlap and bursts collapse into one pass.
pub struct Scanner(Sender<Msg>);

impl Scanner {
    pub fn rescan(&self) {
        let _ = self.0.send(Msg::Changed);
    }

    fn folders_changed(&self) {
        let _ = self.0.send(Msg::FoldersChanged);
    }
}

pub fn start(app: AppHandle, lib: Arc<Library>) -> Scanner {
    let (tx, rx) = mpsc::channel();
    let hint = tx.clone();
    std::thread::spawn(move || {
        use notify::Watcher;
        let mut watcher = notify::recommended_watcher(move |_: notify::Result<notify::Event>| {
            let _ = hint.send(Msg::Changed);
        })
        .map_err(|e| eprintln!("folder watcher unavailable: {e}"))
        .ok();
        let mut watched: Vec<PathBuf> = Vec::new();
        let mut rewatch = true;
        loop {
            if rewatch {
                if let Some(w) = watcher.as_mut() {
                    for p in watched.drain(..) {
                        let _ = w.unwatch(&p);
                    }
                    let folders = list_folders(&lib.conn.lock().unwrap()).unwrap_or_default();
                    for f in folders {
                        let p = PathBuf::from(f.path);
                        if w.watch(&p, notify::RecursiveMode::Recursive).is_ok() {
                            watched.push(p);
                        }
                    }
                }
            }
            let retry = match reconcile(&lib) {
                Ok(o) => {
                    if o.changed {
                        let _ = app.emit("library-changed", ());
                    }
                    o.retry_after
                }
                Err(e) => {
                    eprintln!("watched folder reconcile failed: {e}");
                    None
                }
            };
            let first = match retry {
                Some(t) => rx.recv_timeout(t),
                None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            rewatch = match first {
                Ok(m) => m == Msg::FoldersChanged,
                // A remounted volume sends no event on the old watch; re-register.
                Err(RecvTimeoutError::Timeout) => true,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            loop {
                match rx.recv_timeout(QUIET) {
                    Ok(m) => rewatch |= m == Msg::FoldersChanged,
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        }
    });
    Scanner(tx)
}

// ---- commands ----

type Lib<'a> = State<'a, Arc<Library>>;

#[tauri::command]
pub fn list_watched_folders(lib: Lib) -> Result<Vec<WatchedFolder>, String> {
    list_folders(&lib.conn.lock().unwrap())
}

#[tauri::command]
pub fn add_watched_folder(lib: Lib, scanner: State<Scanner>, path: String) -> Result<WatchedFolder, String> {
    let folder = add_folder(&lib.conn.lock().unwrap(), &path)?;
    scanner.folders_changed();
    Ok(folder)
}

#[tauri::command]
pub fn remove_watched_folder(app: AppHandle, lib: Lib, scanner: State<Scanner>, id: i64) -> Result<(), String> {
    remove_folder(&lib.conn.lock().unwrap(), id)?;
    scanner.folders_changed();
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
pub fn set_folder_collection(app: AppHandle, lib: Lib, id: i64, enabled: bool) -> Result<(), String> {
    set_collection(&lib.conn.lock().unwrap(), id, enabled)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
pub fn rescan_watched_folders(scanner: State<Scanner>) {
    scanner.rescan();
}

#[tauri::command]
pub fn list_exclusions(lib: Lib) -> Result<Vec<Exclusion>, String> {
    exclusions(&lib.conn.lock().unwrap())
}

#[tauri::command]
pub fn restore_exclusion(lib: Lib, scanner: State<Scanner>, folder_id: i64, sha256: String) -> Result<(), String> {
    delete_exclusion(&lib.conn.lock().unwrap(), folder_id, &sha256)?;
    scanner.rescan();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::SystemTime;

    struct Env {
        dir: tempfile::TempDir,
        lib: Library,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(&dir.path().join("data")).unwrap();
        Env { dir, lib }
    }

    impl Env {
        fn folder(&self, name: &str) -> (i64, PathBuf) {
            let p = self.dir.path().join(name);
            fs::create_dir_all(&p).unwrap();
            let f = add_folder(&self.lib.conn.lock().unwrap(), p.to_str().unwrap()).unwrap();
            (f.id, PathBuf::from(f.path))
        }
        fn scan(&self) -> Outcome {
            reconcile(&self.lib).unwrap()
        }
        /// (location id, book id, path, availability) for watched locations.
        fn locs(&self) -> Vec<(i64, i64, String, Availability)> {
            let conn = self.lib.conn.lock().unwrap();
            load(&conn).unwrap().locations.into_iter().map(|l| (l.id, l.book_id, l.path, l.availability)).collect()
        }
        fn books(&self) -> i64 {
            self.lib.conn.lock().unwrap().query_row("SELECT count(*) FROM books", [], |r| r.get(0)).unwrap()
        }
        fn access(&self, id: i64) -> FolderAccess {
            let conn = self.lib.conn.lock().unwrap();
            list_folders(&conn).unwrap().into_iter().find(|f| f.id == id).unwrap().access_state
        }
    }

    fn write_old(path: &Path, bytes: &[u8], age_secs: u64) {
        fs::write(path, bytes).unwrap();
        let f = fs::File::options().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(age_secs)).unwrap();
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    fn pdf_progress(lib: &Library, book: i64) {
        let loc = Locator::Pdf { v: 1, page_index: 3, x: 1.0, y: 2.0 };
        db::save_progress(&lib.conn.lock().unwrap(), book, &loc, 0.3).unwrap();
    }

    #[test]
    fn launch_scan_adds_books_and_second_scan_is_noop() {
        let e = env();
        let (_, root) = e.folder("a");
        fs::create_dir(root.join("sub")).unwrap();
        write_old(&root.join("one.pdf"), b"%PDF-1", 60);
        write_old(&root.join("sub/two.epub"), b"PK\x03\x04two", 60);
        write_old(&root.join("notes.txt"), b"x", 60);
        write_old(&root.join(".hidden.pdf"), b"%PDF-hidden", 60);
        assert!(e.scan().changed);
        assert_eq!(e.books(), 2);
        let titles: Vec<String> = db::list_books(&e.lib.conn.lock().unwrap()).unwrap().into_iter().map(|b| b.title).collect();
        assert!(titles.contains(&"two".to_string()));
        assert_eq!(e.scan(), Outcome::default());
    }

    #[test]
    fn duplicate_bytes_in_two_folders_share_one_book() {
        let e = env();
        let (_, a) = e.folder("a");
        let (_, b) = e.folder("b");
        write_old(&a.join("x.pdf"), b"%PDF-same", 60);
        write_old(&b.join("y.pdf"), b"%PDF-same", 60);
        e.scan();
        let locs = e.locs();
        assert_eq!(locs.len(), 2);
        assert_eq!(locs[0].1, locs[1].1);
        assert_eq!(e.books(), 1);
    }

    #[test]
    fn rename_within_and_move_between_folders_relink() {
        let e = env();
        let (_, a) = e.folder("a");
        let (b_id, b) = e.folder("b");
        write_old(&a.join("x.pdf"), b"%PDF-x", 60);
        e.scan();
        let (loc, book, ..) = e.locs()[0].clone();
        pdf_progress(&e.lib, book);

        fs::rename(a.join("x.pdf"), a.join("renamed.pdf")).unwrap();
        assert!(e.scan().changed);
        assert_eq!(e.locs(), vec![(loc, book, s(&a.join("renamed.pdf")), Availability::Available)]);

        fs::rename(a.join("renamed.pdf"), b.join("moved.pdf")).unwrap();
        e.scan();
        assert_eq!(e.locs(), vec![(loc, book, s(&b.join("moved.pdf")), Availability::Available)]);
        assert_eq!(e.books(), 1);
        let conn = e.lib.conn.lock().unwrap();
        assert_eq!(load(&conn).unwrap().locations[0].folder_id, Some(b_id));
        assert!(db::get_progress(&conn, book).unwrap().is_some());
    }

    #[test]
    fn move_outside_or_delete_marks_moved_and_return_relinks() {
        let e = env();
        let (_, a) = e.folder("a");
        write_old(&a.join("x.pdf"), b"%PDF-x", 60);
        write_old(&a.join("y.pdf"), b"%PDF-y", 60);
        e.scan();
        let outside = e.dir.path().join("x.pdf");
        fs::rename(a.join("x.pdf"), &outside).unwrap();
        fs::remove_file(a.join("y.pdf")).unwrap();
        e.scan();
        assert!(e.locs().iter().all(|l| l.3 == Availability::Moved));
        assert!(db::list_books(&e.lib.conn.lock().unwrap()).unwrap().iter().all(|b| !b.available));
        assert!(!e.scan().changed);

        fs::rename(&outside, a.join("back.pdf")).unwrap();
        e.scan();
        let back = e.locs().into_iter().find(|l| l.2 == s(&a.join("back.pdf"))).unwrap();
        assert_eq!(back.3, Availability::Available);
        assert_eq!(e.books(), 2);
    }

    #[test]
    fn changed_bytes_make_a_new_version() {
        let e = env();
        let (_, a) = e.folder("a");
        let p = a.join("x.pdf");
        write_old(&p, b"%PDF-v1", 60);
        e.scan();
        let (loc, old, ..) = e.locs()[0].clone();
        pdf_progress(&e.lib, old);
        write_old(&p, b"%PDF-version2", 30);
        assert!(e.scan().changed);
        let (loc2, new, path, av) = e.locs()[0].clone();
        assert_eq!((loc2, path, av), (loc, s(&p), Availability::Available));
        assert_ne!(new, old);
        let conn = e.lib.conn.lock().unwrap();
        assert!(db::get_progress(&conn, old).unwrap().is_some());
        assert!(!db::get_book(&conn, old).unwrap().unwrap().available);
        assert!(db::get_book(&conn, new).unwrap().unwrap().available);
    }

    #[test]
    fn unreadable_file_and_folder_are_permission_denied() {
        let e = env();
        let (id, a) = e.folder("a");
        let p = a.join("x.pdf");
        write_old(&p, b"%PDF-x", 60);
        e.scan();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o000)).unwrap();
        e.scan();
        let denied = e.locs()[0].3;
        fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(denied, Availability::PermissionDenied);
        e.scan();
        assert_eq!(e.locs()[0].3, Availability::Available);

        fs::set_permissions(&a, fs::Permissions::from_mode(0o000)).unwrap();
        e.scan();
        let (access, loc) = (e.access(id), e.locs()[0].3);
        fs::set_permissions(&a, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(access, FolderAccess::PermissionDenied);
        assert_eq!(loc, Availability::PermissionDenied);
    }

    #[test]
    fn folder_renamed_away_is_unavailable() {
        let e = env();
        let (id, a) = e.folder("a");
        write_old(&a.join("x.pdf"), b"%PDF-x", 60);
        e.scan();
        fs::rename(&a, e.dir.path().join("gone")).unwrap();
        let o = e.scan();
        assert_eq!(e.access(id), FolderAccess::Unavailable);
        assert_eq!(e.locs()[0].3, Availability::FolderUnavailable);
        assert_eq!(o.retry_after, Some(UNAVAILABLE_RETRY));
    }

    #[test]
    fn symlinks_are_skipped() {
        let e = env();
        let (_, a) = e.folder("a");
        let target = e.dir.path().join("real.pdf");
        write_old(&target, b"%PDF-real", 60);
        std::os::unix::fs::symlink(&target, a.join("link.pdf")).unwrap();
        std::os::unix::fs::symlink(e.dir.path(), a.join("loop")).unwrap();
        e.scan();
        assert_eq!(e.books(), 0);
    }

    #[test]
    fn nested_folders_give_one_location_per_file() {
        let e = env();
        let (_, outer) = e.folder("outer");
        let (inner_id, inner) = e.folder("outer/inner");
        write_old(&outer.join("o.pdf"), b"%PDF-o", 60);
        write_old(&inner.join("i.pdf"), b"%PDF-i", 60);
        e.scan();
        let conn = e.lib.conn.lock().unwrap();
        let locs = load(&conn).unwrap().locations;
        assert_eq!(locs.len(), 2);
        let i = locs.iter().find(|l| l.path.ends_with("i.pdf")).unwrap();
        assert_eq!(i.folder_id, Some(inner_id));
    }

    #[test]
    fn exclusion_suppresses_readding_until_restored() {
        let e = env();
        let (id, a) = e.folder("a");
        write_old(&a.join("x.pdf"), b"%PDF-x", 60);
        e.scan();
        let (_, book, ..) = e.locs()[0].clone();
        let sha = {
            let conn = e.lib.conn.lock().unwrap();
            let sha: String = conn.query_row("SELECT sha256 FROM books WHERE id = ?1", [book], |r| r.get(0)).unwrap();
            conn.execute(
                "INSERT INTO watched_exclusions (watched_folder_id, sha256, title, excluded_at) VALUES (?1, ?2, 'x', 1)",
                params![id, sha],
            )
            .unwrap();
            conn.execute("DELETE FROM books WHERE id = ?1", [book]).unwrap();
            sha
        };
        e.scan();
        e.scan();
        assert_eq!(e.books(), 0);
        let ex = exclusions(&e.lib.conn.lock().unwrap()).unwrap();
        assert_eq!((ex.len(), ex[0].folder_path.clone()), (1, s(&a)));
        delete_exclusion(&e.lib.conn.lock().unwrap(), id, &sha).unwrap();
        e.scan();
        assert_eq!(e.books(), 1);
    }

    #[test]
    fn removing_a_folder_keeps_books_and_progress() {
        let e = env();
        let (id, a) = e.folder("a");
        write_old(&a.join("x.pdf"), b"%PDF-x", 60);
        e.scan();
        let (_, book, ..) = e.locs()[0].clone();
        pdf_progress(&e.lib, book);
        set_collection(&e.lib.conn.lock().unwrap(), id, true).unwrap();
        set_collection(&e.lib.conn.lock().unwrap(), id, true).unwrap();
        {
            let conn = e.lib.conn.lock().unwrap();
            let b = db::get_book(&conn, book).unwrap().unwrap();
            assert_eq!(b.collection_ids.len(), 1);
            remove_folder(&conn, id).unwrap();
            let n: i64 = conn.query_row("SELECT count(*) FROM collections", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 0);
            let b = db::get_book(&conn, book).unwrap().unwrap();
            assert!(!b.available);
            assert!(db::get_progress(&conn, book).unwrap().is_some());
        }
        assert!(e.locs().is_empty());
        e.scan();
        assert!(e.locs().is_empty());
    }

    #[test]
    fn duplicate_folder_is_rejected() {
        let e = env();
        let (_, a) = e.folder("a");
        let again = add_folder(&e.lib.conn.lock().unwrap(), &format!("{}/.", a.display()));
        assert!(again.unwrap_err().contains("already"));
    }

    #[test]
    fn fresh_file_is_deferred() {
        let e = env();
        let (_, a) = e.folder("a");
        fs::write(a.join("new.pdf"), b"%PDF-new").unwrap();
        let o = e.scan();
        assert_eq!(o.retry_after, Some(FRESH_RETRY));
        assert_eq!(e.books(), 0);
    }

    #[test]
    fn protocol_rejects_a_watched_file_changed_since_scan() {
        let e = env();
        let (_, a) = e.folder("a");
        let p = a.join("x.pdf");
        write_old(&p, b"%PDF-original", 60);
        e.scan();
        let (_, book, ..) = e.locs()[0].clone();
        let req = |lib: &Library, hits: &std::cell::Cell<u32>| {
            let r = tauri::http::Request::builder()
                .uri(format!("book://localhost/{book}"))
                .header("Range", "bytes=0-3")
                .body(vec![])
                .unwrap();
            crate::protocol::handle(lib, &Default::default(), &r, &|| hits.set(hits.get() + 1)).status()
        };
        let hits = std::cell::Cell::new(0);
        assert_eq!(req(&e.lib, &hits), tauri::http::StatusCode::PARTIAL_CONTENT);
        write_old(&p, b"%PDF-edited!!", 10);
        assert_eq!(req(&e.lib, &hits), tauri::http::StatusCode::CONFLICT);
        assert_eq!(hits.get(), 1);
    }
}
