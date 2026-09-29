use crate::db;
use crate::jobs;
use crate::model::*;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::Mutex;

pub const MAX_COVER_BYTES: usize = 1 << 20;

pub struct Library {
    pub root: PathBuf,
    pub covers: PathBuf,
    pub conn: Mutex<Connection>,
}

pub enum StageError {
    Cancelled,
    Failed(String),
}

impl From<String> for StageError {
    fn from(e: String) -> Self {
        Self::Failed(e)
    }
}

pub struct Staged {
    pub sha: String,
    pub size: u64,
}

impl Library {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        let root = data_dir.join("library");
        let covers = data_dir.join("covers");
        fs::create_dir_all(root.join(".staging")).map_err(|e| e.to_string())?;
        fs::create_dir_all(&covers).map_err(|e| e.to_string())?;
        let conn = db::open(&data_dir.join("readi.sqlite"))?;
        db::requeue_unmapped(&conn)?;
        let lib = Self { root, covers, conn: Mutex::new(conn) };
        lib.reconcile()?;
        Ok(lib)
    }

    pub fn resolve(&self, kind: LocationKind, path: &str) -> PathBuf {
        match kind {
            LocationKind::Managed => self.root.join(path),
            LocationKind::Watched => PathBuf::from(path),
        }
    }

    pub fn staging_path(&self, name: &str) -> PathBuf {
        self.root.join(".staging").join(name)
    }

    pub fn cover_path(&self, id: i64) -> PathBuf {
        self.covers.join(id.to_string())
    }

    /// Converges whatever an interrupted run left behind: interrupted imports
    /// go back to the queue, staging is emptied, and managed files and covers
    /// that no record points to are deleted.
    fn reconcile(&self) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        jobs::requeue_interrupted(&conn)?;
        for entry in fs::read_dir(self.root.join(".staging")).map_err(|e| e.to_string())?.flatten() {
            let _ = fs::remove_file(entry.path());
        }
        let known: std::collections::HashSet<String> = db::managed_paths(&conn)?.into_iter().collect();
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_file() && !known.contains(&name) {
                let _ = fs::remove_file(entry.path());
            }
        }
        let covers: std::collections::HashSet<String> =
            db::ready_cover_ids(&conn)?.into_iter().map(|id| id.to_string()).collect();
        for entry in fs::read_dir(&self.covers).map_err(|e| e.to_string())?.flatten() {
            if !covers.contains(&entry.file_name().to_string_lossy().to_string()) {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    /// Copies `src` into staging while hashing and checks the format's magic
    /// bytes. The caller removes `staged` whatever the result.
    pub fn stage(
        &self,
        src: &Path,
        staged: &Path,
        format: Format,
        on_chunk: impl FnMut(u64) -> bool,
    ) -> Result<Staged, StageError> {
        let (sha, size, magic) = copy_and_hash(src, staged, on_chunk)?;
        let valid = match format {
            Format::Pdf => magic.starts_with(b"%PDF-"),
            Format::Epub => magic.starts_with(b"PK\x03\x04"),
        };
        if !valid {
            return Err(StageError::Failed(format!("File is not a valid {}", format.as_str().to_uppercase())));
        }
        Ok(Staged { sha, size })
    }

    /// Moves a staged file to its managed path and returns that path relative
    /// to the library root. Publishing precedes the record commit, so a crash
    /// in between leaves only an unreferenced file for `reconcile`.
    pub fn publish(&self, staged: &Path, sha: &str, format: Format) -> Result<String, String> {
        let rel = format!("{sha}.{}", format.as_str());
        fs::rename(staged, self.root.join(&rel)).map_err(|e| e.to_string())?;
        Ok(rel)
    }

    pub fn locations(&self, id: i64) -> Result<Vec<Location>, String> {
        let mut locations = db::locations(&self.conn.lock().unwrap(), id)?;
        for l in &mut locations {
            l.path = self.resolve(l.kind, &l.path).to_string_lossy().into_owned();
        }
        Ok(locations)
    }

    /// Deletes the book's records, then its managed copies and cover. Files go
    /// only after the commit, so no record ever points at a partly deleted
    /// file; a crash in between leaves files that `reconcile` removes.
    pub fn remove_book(&self, id: i64) -> Result<(), String> {
        let managed = {
            let conn = self.conn.lock().unwrap();
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let managed = db::managed_paths_of(&tx, id)?;
            db::delete_book_with_exclusions(&tx, id)?;
            tx.commit().map_err(|e| e.to_string())?;
            managed
        };
        for rel in managed {
            let _ = fs::remove_file(self.root.join(rel));
        }
        let _ = fs::remove_file(self.cover_path(id));
        Ok(())
    }

    pub fn remove_managed_copy(&self, id: i64) -> Result<(), String> {
        let rel = {
            let conn = self.conn.lock().unwrap();
            let locations = db::locations(&conn, id)?;
            let managed = locations
                .iter()
                .find(|l| l.kind == LocationKind::Managed)
                .ok_or("This book has no managed copy.")?;
            if locations.len() == 1 {
                return Err("The managed copy is this book's only file. Remove the book from the library instead.".into());
            }
            db::delete_location(&conn, managed.id)?;
            managed.path.clone()
        };
        let _ = fs::remove_file(self.root.join(rel));
        Ok(())
    }

    /// Relinks a book to a user-chosen file with identical bytes: a watched
    /// location when the file is inside a watched folder, otherwise a new
    /// managed copy.
    pub fn locate_book(&self, id: i64, path: &Path) -> Result<BookSummary, String> {
        let book = db::get_book(&self.conn.lock().unwrap(), id)?.ok_or("Book not found")?;
        let path = fs::canonicalize(path).map_err(|e| format!("Cannot read file: {e}"))?;
        let mismatch = || format!("This file's contents differ from \u{201c}{}\u{201d}.", book.title);
        let folders = db::watched_folder_paths(&self.conn.lock().unwrap())?;
        let folder = folders.into_iter().find_map(|(fid, fpath)| {
            let canon = fs::canonicalize(fpath).ok()?;
            let prefix = format!("{}{MAIN_SEPARATOR}", canon.to_string_lossy().trim_end_matches(MAIN_SEPARATOR));
            path.to_string_lossy().starts_with(&prefix).then_some(fid)
        });
        match folder {
            Some(folder_id) => {
                let (sha, size, mtime) = hash_stable(&path)?;
                if sha != book.sha256 {
                    return Err(mismatch());
                }
                let conn = self.conn.lock().unwrap();
                let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
                let loc = db::upsert_location(&tx, id, LocationKind::Watched, &path.to_string_lossy(), Some(folder_id), size, Some(mtime))?;
                db::delete_unavailable_watched(&tx, id, loc)?;
                tx.commit().map_err(|e| e.to_string())?;
            }
            None => {
                let staged = self.staging_path(&format!("locate-{}", uuid::Uuid::new_v4()));
                let result = self.add_managed_copy(id, &book, &path, &staged, mismatch);
                let _ = fs::remove_file(&staged);
                result?;
            }
        }
        db::get_book(&self.conn.lock().unwrap(), id)?.ok_or_else(|| "Book not found".into())
    }

    fn add_managed_copy(
        &self,
        id: i64,
        book: &BookSummary,
        src: &Path,
        staged: &Path,
        mismatch: impl Fn() -> String,
    ) -> Result<(), String> {
        let staged_file = match self.stage(src, staged, book.format, |_| true) {
            Ok(s) => s,
            Err(StageError::Failed(e)) => return Err(e),
            Err(StageError::Cancelled) => unreachable!("locate never cancels"),
        };
        if staged_file.sha != book.sha256 {
            return Err(mismatch());
        }
        let conn = self.conn.lock().unwrap();
        let rel = self.publish(staged, &staged_file.sha, book.format)?;
        db::upsert_location(&conn, id, LocationKind::Managed, &rel, None, staged_file.size, None)?;
        Ok(())
    }

    pub fn submit_cover(&self, id: i64, bytes: Option<Vec<u8>>) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        db::get_book(&conn, id)?.ok_or("Book not found")?;
        let Some(bytes) = bytes else {
            let _ = fs::remove_file(self.cover_path(id));
            return db::set_cover_state(&conn, id, "none");
        };
        if bytes.len() > MAX_COVER_BYTES {
            return Err("Cover is larger than 1 MiB".into());
        }
        if cover_mime(&bytes).is_none() {
            return Err("Cover must be PNG or JPEG".into());
        }
        let tmp = self.covers.join(format!("{id}.tmp"));
        fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        fs::rename(&tmp, self.cover_path(id)).map_err(|e| e.to_string())?;
        db::set_cover_state(&conn, id, "ready")
    }
}

pub fn cover_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else {
        None
    }
}

/// Copies while hashing. `on_chunk` receives the bytes copied so far before
/// each 1 MiB chunk and returns false to cancel.
fn copy_and_hash(
    src: &Path,
    dest: &Path,
    mut on_chunk: impl FnMut(u64) -> bool,
) -> Result<(String, u64, Vec<u8>), StageError> {
    let mut input = fs::File::open(src).map_err(|e| format!("Cannot open file: {e}"))?;
    let mut output = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    let mut magic = Vec::new();
    loop {
        if !on_chunk(size) {
            return Err(StageError::Cancelled);
        }
        let n = input.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if magic.len() < 8 {
            magic.extend_from_slice(&buf[..n.min(8 - magic.len())]);
        }
        hasher.update(&buf[..n]);
        output.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        size += n as u64;
    }
    output.sync_all().map_err(|e| e.to_string())?;
    Ok((hex::encode(hasher.finalize()), size, magic))
}

pub fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Hashes a file in place, retrying when its size or mtime changes during the
/// read. Returns (sha256, size, mtime in ms).
pub fn hash_stable(path: &Path) -> Result<(String, u64, i64), String> {
    let stat = || fs::metadata(path).map(|m| (m.len(), mtime_ms(&m))).map_err(|e| format!("Cannot read file: {e}"));
    for _ in 0..3 {
        let before = stat()?;
        let mut file = fs::File::open(path).map_err(|e| format!("Cannot open file: {e}"))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        if stat()? == before {
            return Ok((hex::encode(hasher.finalize()), before.0, before.1));
        }
    }
    Err("The file kept changing while it was read. Try again when it is finished.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::tests::import_now;
    use std::sync::Arc;

    fn setup() -> (tempfile::TempDir, Arc<Library>) {
        let dir = tempfile::tempdir().unwrap();
        let lib = Arc::new(Library::open(&dir.path().join("data")).unwrap());
        (dir, lib)
    }

    fn add_watched(lib: &Library, folder: &Path, file: &Path, book: i64) {
        let conn = lib.conn.lock().unwrap();
        conn.execute("INSERT INTO watched_folders (path) VALUES (?1)", [folder.to_string_lossy()]).unwrap();
        let fid = conn.last_insert_rowid();
        db::upsert_location(&conn, book, LocationKind::Watched, &file.to_string_lossy(), Some(fid), 1, None).unwrap();
    }

    #[test]
    fn reconcile_removes_orphans_but_keeps_referenced_files() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let src = dir.path().join("a.pdf");
        fs::write(&src, b"%PDF-1.4").unwrap();
        let kept = {
            let lib = Arc::new(Library::open(&data).unwrap());
            let id = import_now(&lib, &src).book_id.unwrap();
            fs::write(lib.root.join("orphan.pdf"), b"x").unwrap();
            fs::write(lib.root.join(".staging/partial"), b"x").unwrap();
            fs::write(lib.covers.join("999"), b"x").unwrap();
            let sha = db::get_book(&lib.conn.lock().unwrap(), id).unwrap().unwrap().sha256;
            lib.root.join(format!("{sha}.pdf"))
        };
        let lib = Library::open(&data).unwrap();
        assert!(kept.exists());
        assert!(!lib.root.join("orphan.pdf").exists());
        assert!(!lib.root.join(".staging/partial").exists());
        assert!(!lib.covers.join("999").exists());
    }

    #[test]
    fn remove_book_excludes_hash_deletes_managed_and_cover_and_keeps_watched_original() {
        let (dir, lib) = setup();
        let src = dir.path().join("a.pdf");
        fs::write(&src, b"%PDF-1.4 x").unwrap();
        let id = import_now(&lib, &src).book_id.unwrap();
        let folder = dir.path().join("watched");
        fs::create_dir(&folder).unwrap();
        let original = folder.join("a.pdf");
        fs::copy(&src, &original).unwrap();
        add_watched(&lib, &folder, &original, id);
        lib.submit_cover(id, Some(b"\x89PNG\r\n\x1a\nrest".to_vec())).unwrap();
        let managed = lib.locations(id).unwrap().into_iter().find(|l| l.kind == LocationKind::Managed).unwrap();

        lib.remove_book(id).unwrap();

        assert!(!Path::new(&managed.path).exists());
        assert!(!lib.cover_path(id).exists());
        assert!(original.exists(), "watched original is never deleted");
        let conn = lib.conn.lock().unwrap();
        assert!(db::get_book(&conn, id).unwrap().is_none());
        let (sha, title): (String, String) =
            conn.query_row("SELECT sha256, title FROM watched_exclusions", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(title, "a");
        assert_eq!(sha.len(), 64);
        let locs: i64 = conn.query_row("SELECT count(*) FROM book_locations", [], |r| r.get(0)).unwrap();
        assert_eq!(locs, 0);
    }

    #[test]
    fn remove_managed_copy_refuses_the_only_location() {
        let (dir, lib) = setup();
        let src = dir.path().join("a.pdf");
        fs::write(&src, b"%PDF-1.4 x").unwrap();
        let id = import_now(&lib, &src).book_id.unwrap();
        let managed = lib.locations(id).unwrap().remove(0);
        assert!(lib.remove_managed_copy(id).unwrap_err().contains("only file"));
        assert!(Path::new(&managed.path).exists());

        let folder = dir.path().join("w");
        fs::create_dir(&folder).unwrap();
        fs::copy(&src, folder.join("a.pdf")).unwrap();
        add_watched(&lib, &folder, &folder.join("a.pdf"), id);
        lib.remove_managed_copy(id).unwrap();
        assert!(!Path::new(&managed.path).exists());
        let kinds: Vec<_> = lib.locations(id).unwrap().into_iter().map(|l| l.kind).collect();
        assert_eq!(kinds, vec![LocationKind::Watched]);
    }

    #[test]
    fn locate_rejects_other_bytes_and_relinks_matching_file() {
        let (dir, lib) = setup();
        let src = dir.path().join("a.pdf");
        fs::write(&src, b"%PDF-1.4 x").unwrap();
        let id = import_now(&lib, &src).book_id.unwrap();
        let folder = fs::canonicalize(dir.path()).unwrap().join("w");
        fs::create_dir(&folder).unwrap();
        add_watched(&lib, &folder, &folder.join("old.pdf"), id);
        lib.conn.lock().unwrap().execute("UPDATE book_locations SET availability = 'moved' WHERE kind = 'watched'", []).unwrap();

        let other = folder.join("other.pdf");
        fs::write(&other, b"%PDF-1.4 y").unwrap();
        assert_eq!(lib.locate_book(id, &other).unwrap_err(), "This file's contents differ from \u{201c}a\u{201d}.");

        fs::create_dir(folder.join("sub")).unwrap();
        let moved = folder.join("sub").join("new.pdf");
        fs::copy(&src, &moved).unwrap();
        assert!(lib.locate_book(id, &moved).unwrap().available);
        let watched: Vec<_> = lib.locations(id).unwrap().into_iter().filter(|l| l.kind == LocationKind::Watched).collect();
        assert_eq!(watched.len(), 1, "the stale watched location is replaced");
        assert_eq!(watched[0].path, moved.to_string_lossy());
        assert_eq!(watched[0].availability, Availability::Available);

        lib.remove_managed_copy(id).unwrap();
        let outside = dir.path().join("elsewhere.pdf");
        fs::copy(&src, &outside).unwrap();
        lib.locate_book(id, &outside).unwrap();
        let kinds: Vec<_> = lib.locations(id).unwrap().into_iter().map(|l| l.kind).collect();
        assert!(kinds.contains(&LocationKind::Managed), "outside watched folders a managed copy is made");
        assert_eq!(fs::read_dir(lib.root.join(".staging")).unwrap().count(), 0);
    }

    #[test]
    fn cover_accepts_png_or_jpeg_only() {
        let (dir, lib) = setup();
        let src = dir.path().join("a.pdf");
        fs::write(&src, b"%PDF-1.4 x").unwrap();
        let id = import_now(&lib, &src).book_id.unwrap();
        assert!(lib.submit_cover(id, Some(b"GIF89a".to_vec())).is_err());
        assert!(lib.submit_cover(id, Some(vec![0xff; MAX_COVER_BYTES + 1])).is_err());
        assert_eq!(db::claim_cover(&lib.conn.lock().unwrap()).unwrap(), Some(id));
        lib.submit_cover(id, Some(b"\xff\xd8\xff\xe0".to_vec())).unwrap();
        assert!(db::get_book(&lib.conn.lock().unwrap(), id).unwrap().unwrap().has_cover);
        assert_eq!(db::claim_cover(&lib.conn.lock().unwrap()).unwrap(), None);
    }
}
