use crate::db;
use crate::model::*;
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct Library {
    pub root: PathBuf,
    pub conn: Mutex<Connection>,
}

impl Library {
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        let root = data_dir.join("library");
        fs::create_dir_all(root.join(".staging")).map_err(|e| e.to_string())?;
        let conn = db::open(&data_dir.join("readi.sqlite"))?;
        let lib = Self { root, conn: Mutex::new(conn) };
        lib.reconcile()?;
        Ok(lib)
    }

    pub fn resolve(&self, kind: &str, path: &str) -> PathBuf {
        if kind == "managed" { self.root.join(path) } else { PathBuf::from(path) }
    }

    /// Removes staging leftovers and managed files no record points to,
    /// which is what an interrupted import leaves behind.
    fn reconcile(&self) -> Result<(), String> {
        for entry in fs::read_dir(self.root.join(".staging")).map_err(|e| e.to_string())?.flatten() {
            let _ = fs::remove_file(entry.path());
        }
        let known: std::collections::HashSet<String> =
            db::managed_paths(&self.conn.lock().unwrap())?.into_iter().collect();
        for entry in fs::read_dir(&self.root).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_file() && !known.contains(&name) {
                let _ = fs::remove_file(entry.path());
            }
        }
        Ok(())
    }

    pub fn import(&self, src: &Path) -> Result<ImportResult, String> {
        let format = Format::from_path(src).ok_or("Only .epub and .pdf files can be imported")?;
        let meta = fs::symlink_metadata(src).map_err(|e| format!("Cannot read file: {e}"))?;
        if !meta.is_file() {
            return Err("Not a regular file".into());
        }
        let staged = self.root.join(".staging").join(uuid::Uuid::new_v4().to_string());
        let result = self.stage_and_publish(src, &staged, format);
        let _ = fs::remove_file(&staged);
        result
    }

    fn stage_and_publish(&self, src: &Path, staged: &Path, format: Format) -> Result<ImportResult, String> {
        let (sha, size, magic) = copy_and_hash(src, staged)?;
        let valid = match format {
            Format::Pdf => magic.starts_with(b"%PDF-"),
            Format::Epub => magic.starts_with(b"PK\x03\x04"),
        };
        if !valid {
            return Err(format!("File is not a valid {}", format.as_str().to_uppercase()));
        }
        let conn = self.conn.lock().unwrap();
        if let Some(id) = db::find_by_hash(&conn, &sha)? {
            let book = db::get_book(&conn, id)?.ok_or("missing book")?;
            return Ok(ImportResult { book, already_in_library: true });
        }
        let rel = format!("{sha}.{}", format.as_str());
        let dest = self.root.join(&rel);
        fs::rename(staged, &dest).map_err(|e| e.to_string())?;
        let title = src.file_stem().map(|s| clean_text(&s.to_string_lossy(), MAX_TITLE)).unwrap_or_default();
        let id = match db::insert_managed_book(&conn, &sha, format, &title, size, &rel) {
            Ok(id) => id,
            Err(e) => {
                let _ = fs::remove_file(&dest);
                return Err(e);
            }
        };
        let book = db::get_book(&conn, id)?.ok_or("missing book")?;
        Ok(ImportResult { book, already_in_library: false })
    }
}

fn copy_and_hash(src: &Path, dest: &Path) -> Result<(String, u64, Vec<u8>), String> {
    let mut input = fs::File::open(src).map_err(|e| format!("Cannot open file: {e}"))?;
    let mut output = fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut size = 0u64;
    let mut magic = Vec::new();
    loop {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_dedupes_by_hash_and_rejects_bad_magic() {
        let dir = tempfile::tempdir().unwrap();
        let lib = Library::open(dir.path()).unwrap();
        let src = dir.path().join("a.pdf");
        fs::write(&src, b"%PDF-1.4 hello").unwrap();
        let copy = dir.path().join("renamed.pdf");
        fs::copy(&src, &copy).unwrap();
        let first = lib.import(&src).unwrap();
        assert!(!first.already_in_library);
        assert_eq!(first.book.title, "a");
        let second = lib.import(&copy).unwrap();
        assert!(second.already_in_library);
        assert_eq!(second.book.id, first.book.id);
        assert!(src.exists(), "source file is never modified");

        let fake = dir.path().join("fake.epub");
        fs::write(&fake, b"not a zip").unwrap();
        assert!(lib.import(&fake).is_err());
        assert_eq!(fs::read_dir(lib.root.join(".staging")).unwrap().count(), 0);
    }

    #[test]
    fn reconcile_removes_orphans_but_keeps_referenced_files() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.pdf");
        fs::write(&src, b"%PDF-1.4").unwrap();
        let kept = {
            let lib = Library::open(dir.path()).unwrap();
            let r = lib.import(&src).unwrap();
            fs::write(lib.root.join("orphan.pdf"), b"x").unwrap();
            fs::write(lib.root.join(".staging/partial"), b"x").unwrap();
            lib.root.join(format!("{}.pdf", r.book.sha256))
        };
        let lib = Library::open(dir.path()).unwrap();
        assert!(kept.exists());
        assert!(!lib.root.join("orphan.pdf").exists());
        assert!(!lib.root.join(".staging/partial").exists());
    }
}
