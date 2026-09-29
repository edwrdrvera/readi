//! Managed imports. The `import_jobs` table is the source of truth; one worker
//! thread drains it FIFO through queued -> running -> done|failed|cancelled.
use crate::db::{self, now};
use crate::library::{Library, StageError};
use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub enum LibraryEvent {
    ImportJob(ImportJob),
    LibraryChanged,
}

pub type EventSink = Arc<dyn Fn(LibraryEvent) + Send + Sync>;

pub const SOURCE_GONE: &str =
    "The file was moved or deleted before the import finished. Import it again from its new location.";

pub struct Jobs {
    lib: Arc<Library>,
    sink: EventSink,
    cancels: Mutex<HashMap<i64, Arc<AtomicBool>>>,
    pending: Mutex<bool>,
    wake: Condvar,
    started_at: i64,
    progress_interval: Duration,
}

impl Jobs {
    pub fn new(lib: Arc<Library>, sink: EventSink) -> Arc<Self> {
        Self::with_interval(lib, sink, Duration::from_millis(100))
    }

    fn with_interval(lib: Arc<Library>, sink: EventSink, progress_interval: Duration) -> Arc<Self> {
        Arc::new(Self {
            lib,
            sink,
            cancels: Mutex::default(),
            pending: Mutex::new(true),
            wake: Condvar::new(),
            started_at: now(),
            progress_interval,
        })
    }

    pub fn spawn_worker(self: &Arc<Self>) {
        let jobs = self.clone();
        std::thread::Builder::new()
            .name("import".into())
            .spawn(move || loop {
                match jobs.run_next_job() {
                    Ok(Some(_)) => continue,
                    Ok(None) => {}
                    Err(e) => eprintln!("import worker: {e}"),
                }
                let mut pending = jobs.pending.lock().unwrap();
                while !*pending {
                    pending = jobs.wake.wait(pending).unwrap();
                }
                *pending = false;
            })
            .expect("spawn import worker");
    }

    fn emit(&self, event: LibraryEvent) {
        (self.sink)(event)
    }

    /// Records queued jobs and returns at once; all file work happens on the worker.
    pub fn enqueue(&self, paths: Vec<String>) -> Result<Vec<ImportJob>, String> {
        let jobs = {
            let conn = self.lib.conn.lock().unwrap();
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let t = now();
            let mut ids = Vec::with_capacity(paths.len());
            for path in &paths {
                tx.execute("INSERT INTO import_jobs (source_path, state, created_at) VALUES (?1, 'queued', ?2)", params![path, t])
                    .map_err(|e| e.to_string())?;
                ids.push(tx.last_insert_rowid());
            }
            tx.commit().map_err(|e| e.to_string())?;
            ids.into_iter().map(|id| get_job(&conn, id)).collect::<Result<Vec<_>, _>>()?
        };
        for job in &jobs {
            self.emit(LibraryEvent::ImportJob(job.clone()));
        }
        *self.pending.lock().unwrap() = true;
        self.wake.notify_one();
        Ok(jobs)
    }

    /// Unfinished jobs plus jobs finished since this process started.
    pub fn list(&self) -> Result<Vec<ImportJob>, String> {
        let conn = self.lib.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {JOB_COLUMNS} FROM import_jobs WHERE state IN ('queued','running') OR finished_at >= ?1 ORDER BY id"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([self.started_at], job_from_row).map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// A queued job is cancelled at once; a running one stops at its next chunk.
    pub fn cancel(&self, id: i64) -> Result<(), String> {
        self.cancels.lock().unwrap().entry(id).or_default().store(true, Ordering::SeqCst);
        let (cancelled, job) = {
            let conn = self.lib.conn.lock().unwrap();
            let n = conn
                .execute(
                    "UPDATE import_jobs SET state = 'cancelled', finished_at = ?2 WHERE id = ?1 AND state = 'queued'",
                    params![id, now()],
                )
                .map_err(|e| e.to_string())?;
            let job = conn
                .query_row(&format!("SELECT {JOB_COLUMNS} FROM import_jobs WHERE id = ?1"), [id], job_from_row)
                .optional()
                .map_err(|e| e.to_string())?;
            (n == 1, job)
        };
        if job.as_ref().is_none_or(|j| j.state != JobState::Running) {
            self.cancels.lock().unwrap().remove(&id);
        }
        let job = job.ok_or("Import not found")?;
        if cancelled {
            self.emit(LibraryEvent::ImportJob(job));
        }
        Ok(())
    }

    /// Runs the oldest queued job to a final state. Returns None when the queue is empty.
    pub fn run_next_job(&self) -> Result<Option<ImportJob>, String> {
        let Some(mut job) = claim(&self.lib.conn.lock().unwrap())? else {
            return Ok(None);
        };
        let flag = self.cancels.lock().unwrap().entry(job.id).or_default().clone();
        self.emit(LibraryEvent::ImportJob(job.clone()));
        let staged = self.lib.staging_path(&job.id.to_string());
        let result = self.process(&mut job, &flag, &staged);
        let _ = fs::remove_file(&staged);
        self.cancels.lock().unwrap().remove(&job.id);
        let (job, changed) = {
            let conn = self.lib.conn.lock().unwrap();
            let changed = match result {
                Ok(outcome) => outcome != ImportOutcome::AlreadyInLibrary,
                Err(StageError::Cancelled) => {
                    finish(&conn, job.id, JobState::Cancelled, None)?;
                    false
                }
                Err(StageError::Failed(e)) => {
                    finish(&conn, job.id, JobState::Failed, Some(&e))?;
                    false
                }
            };
            (get_job(&conn, job.id)?, changed)
        };
        self.emit(LibraryEvent::ImportJob(job.clone()));
        if changed {
            self.emit(LibraryEvent::LibraryChanged);
        }
        Ok(Some(job))
    }

    fn process(&self, job: &mut ImportJob, cancel: &AtomicBool, staged: &Path) -> Result<ImportOutcome, StageError> {
        let src = PathBuf::from(&job.source_path);
        let format = Format::from_path(&src).ok_or_else(|| "Only .epub and .pdf files can be imported".to_string())?;
        let meta = match fs::symlink_metadata(&src) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(SOURCE_GONE.to_string().into()),
            Err(e) => return Err(format!("Cannot read file: {e}").into()),
        };
        if meta.file_type().is_symlink() {
            return Err("Symbolic links can't be imported. Import the original file instead.".to_string().into());
        }
        if !meta.is_file() {
            return Err("Not a regular file".to_string().into());
        }
        job.bytes_total = Some(meta.len());
        set_progress(&self.lib.conn.lock().unwrap(), job)?;

        let mut last_emit = Instant::now();
        let staged_file = self.lib.stage(&src, staged, format, |done| {
            if cancel.load(Ordering::SeqCst) {
                return false;
            }
            if last_emit.elapsed() >= self.progress_interval {
                last_emit = Instant::now();
                job.bytes_done = done;
                if set_progress(&self.lib.conn.lock().unwrap(), job).is_ok() {
                    self.emit(LibraryEvent::ImportJob(job.clone()));
                }
            }
            true
        })?;

        let title = src.file_stem().map(|s| clean_text(&s.to_string_lossy(), MAX_TITLE)).unwrap_or_default();
        let conn = self.lib.conn.lock().unwrap();
        let mut published = None;
        let result = (|| {
            let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
            let (outcome, book_id) = match db::find_by_hash(&tx, &staged_file.sha)? {
                Some(id) if db::has_managed_location(&tx, id)? => (ImportOutcome::AlreadyInLibrary, id),
                existing => {
                    let rel = self.lib.publish(staged, &staged_file.sha, format)?;
                    published = Some(rel.clone());
                    let id = match existing {
                        Some(id) => id,
                        None => db::insert_book(&tx, &staged_file.sha, format, &title, staged_file.size)?,
                    };
                    db::upsert_location(&tx, id, LocationKind::Managed, &rel, None, staged_file.size, None)?;
                    (if existing.is_some() { ImportOutcome::AddedCopy } else { ImportOutcome::Imported }, id)
                }
            };
            complete(&tx, job.id, outcome, book_id, staged_file.size)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok::<_, String>(outcome)
        })();
        if let (Err(_), Some(rel)) = (&result, published) {
            let _ = fs::remove_file(self.lib.root.join(rel));
        }
        Ok(result?)
    }
}

const JOB_COLUMNS: &str =
    "id, source_path, state, outcome, book_id, error, bytes_done, bytes_total, created_at, started_at, finished_at";

fn job_from_row(r: &rusqlite::Row) -> rusqlite::Result<ImportJob> {
    let state: String = r.get(2)?;
    let outcome: Option<String> = r.get(3)?;
    Ok(ImportJob {
        id: r.get(0)?,
        source_path: r.get(1)?,
        state: JobState::parse(&state),
        outcome: outcome.as_deref().and_then(ImportOutcome::parse),
        book_id: r.get(4)?,
        error: r.get(5)?,
        bytes_done: r.get::<_, i64>(6)? as u64,
        bytes_total: r.get::<_, Option<i64>>(7)?.map(|n| n as u64),
        created_at: r.get(8)?,
        started_at: r.get(9)?,
        finished_at: r.get(10)?,
    })
}

fn get_job(conn: &Connection, id: i64) -> Result<ImportJob, String> {
    conn.query_row(&format!("SELECT {JOB_COLUMNS} FROM import_jobs WHERE id = ?1"), [id], job_from_row)
        .map_err(|e| e.to_string())
}

/// Jobs a killed process left running go back to the queue and are retried
/// from the start, since their staging files are wiped on launch.
pub fn requeue_interrupted(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE import_jobs SET state = 'queued', started_at = NULL, bytes_done = 0 WHERE state = 'running'",
        [],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn claim(conn: &Connection) -> Result<Option<ImportJob>, String> {
    let id: Option<i64> = conn
        .query_row("SELECT id FROM import_jobs WHERE state = 'queued' ORDER BY id LIMIT 1", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(id) = id else { return Ok(None) };
    conn.execute(
        "UPDATE import_jobs SET state = 'running', started_at = ?2, bytes_done = 0 WHERE id = ?1",
        params![id, now()],
    )
    .map_err(|e| e.to_string())?;
    get_job(conn, id).map(Some)
}

fn set_progress(conn: &Connection, job: &ImportJob) -> Result<(), String> {
    conn.execute(
        "UPDATE import_jobs SET bytes_done = ?2, bytes_total = ?3 WHERE id = ?1",
        params![job.id, job.bytes_done as i64, job.bytes_total.map(|n| n as i64)],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn finish(conn: &Connection, id: i64, state: JobState, error: Option<&str>) -> Result<(), String> {
    conn.execute(
        "UPDATE import_jobs SET state = ?2, error = ?3, finished_at = ?4 WHERE id = ?1",
        params![id, state.as_str(), error, now()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Runs in the same transaction as the book and location writes, so a job is
/// never done without its records or its records present without the job done.
fn complete(tx: &Connection, id: i64, outcome: ImportOutcome, book_id: i64, size: u64) -> Result<(), String> {
    tx.execute(
        "UPDATE import_jobs SET state = 'done', outcome = ?2, book_id = ?3, bytes_done = ?4, error = NULL, finished_at = ?5 WHERE id = ?1",
        params![id, outcome.as_str(), book_id, size as i64, now()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::{OnceLock, Weak};

    pub fn import_now(lib: &Arc<Library>, path: &Path) -> ImportJob {
        let jobs = Jobs::new(lib.clone(), Arc::new(|_| {}));
        jobs.enqueue(vec![path.to_string_lossy().into_owned()]).unwrap();
        let job = jobs.run_next_job().unwrap().unwrap();
        assert_eq!(job.state, JobState::Done, "{:?}", job.error);
        job
    }

    type Events = Arc<Mutex<Vec<(Option<JobState>, u64)>>>;

    fn recording(lib: &Arc<Library>, interval: Duration) -> (Arc<Jobs>, Events) {
        let events: Events = Arc::default();
        let e = events.clone();
        let sink: EventSink = Arc::new(move |ev| {
            e.lock().unwrap().push(match ev {
                LibraryEvent::ImportJob(j) => (Some(j.state), j.bytes_done),
                LibraryEvent::LibraryChanged => (None, 0),
            })
        });
        (Jobs::with_interval(lib.clone(), sink, interval), events)
    }

    fn setup() -> (tempfile::TempDir, PathBuf, Arc<Library>) {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let lib = Arc::new(Library::open(&data).unwrap());
        (dir, data, lib)
    }

    fn count(lib: &Library, table: &str) -> i64 {
        lib.conn.lock().unwrap().query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    fn library_files(lib: &Library) -> usize {
        fs::read_dir(&lib.root).unwrap().flatten().filter(|e| e.path().is_file()).count()
            + fs::read_dir(lib.root.join(".staging")).unwrap().count()
    }

    fn pdf(dir: &Path, name: &str, len: usize) -> PathBuf {
        let path = dir.join(name);
        let mut bytes = b"%PDF-1.4 ".to_vec();
        bytes.extend((0..len).map(|i| (i % 251) as u8));
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn job_runs_to_done_with_timing_and_events() {
        let (dir, _, lib) = setup();
        let src = pdf(dir.path(), "Book Title.pdf", 100);
        let (jobs, events) = recording(&lib, Duration::from_millis(100));
        let queued = jobs.enqueue(vec![src.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(queued[0].state, JobState::Queued);
        assert!(queued[0].started_at.is_none());

        let job = jobs.run_next_job().unwrap().unwrap();
        assert_eq!(job.state, JobState::Done);
        assert_eq!(job.outcome, Some(ImportOutcome::Imported));
        assert_eq!(job.bytes_done, 109);
        assert_eq!(job.bytes_total, Some(109));
        let (started, finished) = (job.started_at.unwrap(), job.finished_at.unwrap());
        assert!(job.created_at <= started && started <= finished);
        let book = db::get_book(&lib.conn.lock().unwrap(), job.book_id.unwrap()).unwrap().unwrap();
        assert_eq!(book.title, "Book Title");
        assert!(book.available);
        let states: Vec<_> = events.lock().unwrap().iter().map(|e| e.0).collect();
        assert_eq!(states, vec![Some(JobState::Queued), Some(JobState::Running), Some(JobState::Done), None]);
        assert_eq!(jobs.list().unwrap().len(), 1);
        assert!(jobs.run_next_job().unwrap().is_none());
    }

    #[test]
    fn cancel_mid_copy_leaves_no_files_or_rows() {
        let (dir, _, lib) = setup();
        let src = pdf(dir.path(), "big.pdf", 3 << 20);
        let handle: Arc<OnceLock<Weak<Jobs>>> = Arc::default();
        let h = handle.clone();
        let saw_progress = Arc::new(AtomicBool::new(false));
        let saw = saw_progress.clone();
        let sink: EventSink = Arc::new(move |ev| {
            if let LibraryEvent::ImportJob(j) = ev {
                if j.state == JobState::Running && j.bytes_done > 0 {
                    saw.store(true, Ordering::SeqCst);
                    h.get().unwrap().upgrade().unwrap().cancel(j.id).unwrap();
                }
            }
        });
        let jobs = Jobs::with_interval(lib.clone(), sink, Duration::ZERO);
        handle.set(Arc::downgrade(&jobs)).unwrap();
        jobs.enqueue(vec![src.to_string_lossy().into_owned()]).unwrap();

        let job = jobs.run_next_job().unwrap().unwrap();
        assert!(saw_progress.load(Ordering::SeqCst), "cancelled after copying started");
        assert_eq!(job.state, JobState::Cancelled);
        assert!(job.bytes_done < job.bytes_total.unwrap());
        assert_eq!(library_files(&lib), 0);
        assert_eq!(count(&lib, "books"), 0);
        assert_eq!(count(&lib, "book_locations"), 0);
    }

    #[test]
    fn queued_job_cancels_immediately() {
        let (dir, _, lib) = setup();
        let src = pdf(dir.path(), "a.pdf", 10);
        let (jobs, events) = recording(&lib, Duration::from_millis(100));
        let id = jobs.enqueue(vec![src.to_string_lossy().into_owned()]).unwrap()[0].id;
        jobs.cancel(id).unwrap();
        assert_eq!(events.lock().unwrap().last().unwrap().0, Some(JobState::Cancelled));
        assert!(jobs.run_next_job().unwrap().is_none());
        assert_eq!(count(&lib, "books"), 0);
    }

    #[test]
    fn interrupted_job_is_requeued_on_reopen_and_completes() {
        let (dir, data, lib) = setup();
        let src = pdf(dir.path(), "a.pdf", 10);
        let jobs = Jobs::new(lib.clone(), Arc::new(|_| {}));
        let id = jobs.enqueue(vec![src.to_string_lossy().into_owned()]).unwrap()[0].id;
        claim(&lib.conn.lock().unwrap()).unwrap();
        fs::write(lib.staging_path(&id.to_string()), b"%PDF-partial").unwrap();
        drop(jobs);
        drop(lib);

        let lib = Arc::new(Library::open(&data).unwrap());
        assert_eq!(library_files(&lib), 0);
        let jobs = Jobs::new(lib.clone(), Arc::new(|_| {}));
        assert_eq!(jobs.list().unwrap()[0].state, JobState::Queued);
        let job = jobs.run_next_job().unwrap().unwrap();
        assert_eq!((job.id, job.state, job.outcome), (id, JobState::Done, Some(ImportOutcome::Imported)));
    }

    #[test]
    fn retried_job_with_missing_source_fails_with_reason() {
        let (dir, data, lib) = setup();
        let src = pdf(dir.path(), "a.pdf", 10);
        let jobs = Jobs::new(lib.clone(), Arc::new(|_| {}));
        jobs.enqueue(vec![src.to_string_lossy().into_owned()]).unwrap();
        claim(&lib.conn.lock().unwrap()).unwrap();
        drop(jobs);
        drop(lib);
        fs::remove_file(&src).unwrap();

        let lib = Arc::new(Library::open(&data).unwrap());
        let job = Jobs::new(lib.clone(), Arc::new(|_| {})).run_next_job().unwrap().unwrap();
        assert_eq!(job.state, JobState::Failed);
        assert_eq!(job.error.as_deref(), Some(SOURCE_GONE));
        assert_eq!(library_files(&lib), 0);
        assert_eq!(count(&lib, "books"), 0);
    }

    #[test]
    fn watched_only_hash_gets_a_managed_copy() {
        let (dir, _, lib) = setup();
        let src = pdf(dir.path(), "a.pdf", 10);
        let (sha, size, _) = crate::library::hash_stable(&src).unwrap();
        let book = {
            let conn = lib.conn.lock().unwrap();
            let id = db::insert_book(&conn, &sha, Format::Pdf, "a", size).unwrap();
            db::upsert_location(&conn, id, LocationKind::Watched, &src.to_string_lossy(), None, size, None).unwrap();
            id
        };
        let job = import_now(&lib, &src);
        assert_eq!((job.outcome, job.book_id), (Some(ImportOutcome::AddedCopy), Some(book)));
        assert!(lib.root.join(format!("{sha}.pdf")).exists());
        assert_eq!(count(&lib, "books"), 1);
    }

    #[test]
    fn managed_hash_reports_already_in_library_and_rejects_invalid_files() {
        let (dir, _, lib) = setup();
        let src = pdf(dir.path(), "a.pdf", 10);
        let copy = dir.path().join("renamed.pdf");
        fs::copy(&src, &copy).unwrap();
        let first = import_now(&lib, &src);
        let second = import_now(&lib, &copy);
        assert_eq!(second.outcome, Some(ImportOutcome::AlreadyInLibrary));
        assert_eq!(second.book_id, first.book_id);
        assert!(src.exists(), "source file is never modified");

        let fake = dir.path().join("fake.epub");
        fs::write(&fake, b"not a zip").unwrap();
        let link = dir.path().join("link.pdf");
        std::os::unix::fs::symlink(&src, &link).unwrap();
        let text = dir.path().join("notes.txt");
        fs::write(&text, b"x").unwrap();
        let jobs = Jobs::new(lib.clone(), Arc::new(|_| {}));
        jobs.enqueue([&fake, &link, &text].iter().map(|p| p.to_string_lossy().into_owned()).collect()).unwrap();
        let errors: Vec<_> = (0..3).map(|_| jobs.run_next_job().unwrap().unwrap()).map(|j| (j.state, j.error.unwrap())).collect();
        assert!(errors.iter().all(|(s, _)| *s == JobState::Failed));
        assert_eq!(errors[0].1, "File is not a valid EPUB");
        assert!(errors[1].1.contains("Symbolic links"));
        assert!(errors[2].1.contains("Only .epub and .pdf"));
        assert_eq!(fs::read_dir(lib.root.join(".staging")).unwrap().count(), 0);
        assert_eq!(count(&lib, "books"), 1);
    }
}
