use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

const MIGRATIONS: &[&str] = &[r#"
CREATE TABLE books (
  id INTEGER PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL CHECK (format IN ('epub','pdf')),
  title TEXT NOT NULL,
  authors TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  file_size INTEGER NOT NULL,
  metadata_ready INTEGER NOT NULL DEFAULT 0,
  reading_state TEXT NOT NULL DEFAULT 'unread' CHECK (reading_state IN ('unread','reading','finished')),
  added_at INTEGER NOT NULL,
  opened_at INTEGER
);
CREATE TABLE watched_folders (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  access_state TEXT NOT NULL DEFAULT 'ok',
  last_scan_at INTEGER
);
CREATE TABLE book_locations (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('managed','watched')),
  path TEXT NOT NULL,
  watched_folder_id INTEGER REFERENCES watched_folders(id) ON DELETE SET NULL,
  availability TEXT NOT NULL DEFAULT 'available',
  observed_size INTEGER,
  observed_mtime INTEGER,
  UNIQUE (kind, path)
);
CREATE TABLE toc_entries (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES toc_entries(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  locator TEXT NOT NULL,
  sort_order INTEGER NOT NULL
);
CREATE TABLE progress (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  locator TEXT NOT NULL,
  percent REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE book_preferences (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  reading_mode TEXT,
  spread TEXT,
  font_family TEXT,
  font_size REAL,
  line_height REAL,
  theme TEXT,
  pdf_zoom TEXT
);
CREATE TABLE annotations (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('highlight','bookmark')),
  locator TEXT NOT NULL,
  quote TEXT,
  context TEXT,
  color TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE collections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual','derived')),
  watched_folder_id INTEGER REFERENCES watched_folders(id) ON DELETE CASCADE
);
CREATE TABLE collection_books (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, book_id)
);
CREATE TABLE watched_exclusions (
  watched_folder_id INTEGER NOT NULL REFERENCES watched_folders(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (watched_folder_id, sha256)
);
CREATE TABLE extraction_jobs (
  book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'queued',
  extractor_version INTEGER,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE text_segments (
  id INTEGER PRIMARY KEY,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  seg_order INTEGER NOT NULL,
  label TEXT,
  text TEXT NOT NULL,
  extractor_version INTEGER NOT NULL
);
CREATE INDEX text_segments_book ON text_segments(book_id, seg_order);
CREATE VIRTUAL TABLE book_text USING fts5(text, content='text_segments', content_rowid='id');
CREATE TRIGGER text_segments_ai AFTER INSERT ON text_segments BEGIN
  INSERT INTO book_text(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER text_segments_ad AFTER DELETE ON text_segments BEGIN
  INSERT INTO book_text(book_text, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#];

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    )
    .map_err(|e| e.to_string())?;
    migrate(&conn, path)?;
    Ok(conn)
}

/// Applies pending migrations, backing the database up first so a failed
/// migration never leaves the user with an empty library.
fn migrate(conn: &Connection, path: &Path) -> Result<(), String> {
    let version: usize = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version >= MIGRATIONS.len() {
        return Ok(());
    }
    if version > 0 {
        let backup = path.with_extension(format!("v{version}.bak"));
        conn.execute("VACUUM INTO ?1", [backup.to_string_lossy()])
            .map_err(|e| format!("backup before migration failed: {e}"))?;
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(version) {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(sql)
            .map_err(|e| format!("migration {} failed: {e}", i + 1))?;
        tx.pragma_update(None, "user_version", i + 1)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn summary_from_row(r: &rusqlite::Row) -> rusqlite::Result<BookSummary> {
    let format: String = r.get("format")?;
    let authors: String = r.get("authors")?;
    let index_state: Option<String> = r.get("index_state")?;
    Ok(BookSummary {
        id: r.get("id")?,
        sha256: r.get("sha256")?,
        format: Format::parse(&format).unwrap_or(Format::Epub),
        title: r.get("title")?,
        authors: serde_json::from_str(&authors).unwrap_or_default(),
        reading_state: r.get("reading_state")?,
        metadata_ready: r.get::<_, i64>("metadata_ready")? != 0,
        index_state: IndexState::parse(index_state.as_deref().unwrap_or("queued")),
        file_size: r.get::<_, i64>("file_size")? as u64,
        added_at: r.get("added_at")?,
        opened_at: r.get("opened_at")?,
    })
}

const SUMMARY_SELECT: &str = "SELECT b.*, j.state AS index_state FROM books b LEFT JOIN extraction_jobs j ON j.book_id = b.id";

pub fn get_book(conn: &Connection, id: i64) -> Result<Option<BookSummary>, String> {
    conn.query_row(&format!("{SUMMARY_SELECT} WHERE b.id = ?1"), [id], summary_from_row)
        .optional()
        .map_err(|e| e.to_string())
}

pub fn find_by_hash(conn: &Connection, sha: &str) -> Result<Option<i64>, String> {
    conn.query_row("SELECT id FROM books WHERE sha256 = ?1", [sha], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

pub fn insert_managed_book(
    conn: &Connection,
    sha: &str,
    format: Format,
    fallback_title: &str,
    size: u64,
    rel_path: &str,
) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let t = now();
    tx.execute(
        "INSERT INTO books (sha256, format, title, file_size, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![sha, format.as_str(), fallback_title, size as i64, t],
    )
    .map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO book_locations (book_id, kind, path, observed_size) VALUES (?1, 'managed', ?2, ?3)",
        params![id, rel_path, size as i64],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO extraction_jobs (book_id, state, updated_at) VALUES (?1, 'queued', ?2)",
        params![id, t],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

pub fn managed_paths(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT path FROM book_locations WHERE kind = 'managed'")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = open(&dir.path().join("t.sqlite")).unwrap();
        (dir, conn)
    }

    #[test]
    fn failed_migration_preserves_existing_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        drop(open(&path).unwrap());
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 0).unwrap();
        drop(conn);
        // user_version 0 means a fresh DB, so no backup and the migration reruns
        // against existing tables, which must fail without destroying data.
        assert!(open(&path).is_err());
        let conn = Connection::open(&path).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM sqlite_master WHERE name='books'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }
}
