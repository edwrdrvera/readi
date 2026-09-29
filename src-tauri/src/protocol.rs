//! `book://localhost/<book id>` serves registered book files and
//! `book://localhost/<book id>/cover` their covers. Paths are never taken from
//! the URL; the id is looked up in the database.
use crate::db;
use crate::library::{cover_mime, Library};
use crate::model::Format;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::Mutex;
use tauri::http::{header, Request, Response, StatusCode};

pub const MAX_RANGE: u64 = 4 << 20;
pub const MAX_WHOLE_EPUB: u64 = 512 << 20;

#[derive(Default, serde::Serialize, Clone, Copy)]
pub struct Stats {
    pub requests: u64,
    pub bytes: u64,
}

#[derive(Default)]
pub struct TransportStats(pub Mutex<HashMap<i64, Stats>>);

pub fn parse_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            (len.saturating_sub(n), len.checked_sub(1)?)
        }
        (s, "") => (s.parse().ok()?, len.checked_sub(1)?),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(len.checked_sub(1)?)),
    };
    (start <= end && end < len).then_some((start, end))
}

fn respond(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap()
}

/// `rescan` is called when a watched file no longer matches what the last
/// scan verified, so the library catches up with the change.
pub fn handle(lib: &Library, stats: &TransportStats, req: &Request<Vec<u8>>, rescan: &dyn Fn()) -> Response<Vec<u8>> {
    if req.method() == "OPTIONS" {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET")
            .body(vec![])
            .unwrap();
    }
    let path = req.uri().path().trim_start_matches('/');
    if let Some(id) = path.strip_suffix("/cover").and_then(|id| id.parse::<i64>().ok()) {
        return cover(lib, id);
    }
    let Ok(id) = path.parse::<i64>() else {
        return respond(StatusCode::NOT_FOUND, vec![]);
    };
    let location = db::book_location(&lib.conn.lock().unwrap(), id);
    let Ok(Some(loc)) = location else {
        return respond(StatusCode::NOT_FOUND, vec![]);
    };
    let format = loc.format;
    let watched = loc.kind == crate::model::LocationKind::Watched;
    let file_path = lib.resolve(loc.kind, &loc.path);
    let Ok(mut file) = std::fs::File::open(&file_path) else {
        if watched {
            rescan();
        }
        return respond(StatusCode::GONE, vec![]);
    };
    let meta = file.metadata().ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    if watched {
        let mtime = meta.as_ref().map(crate::watch::mtime_ms);
        if loc.observed_size != Some(len as i64) || loc.observed_mtime != mtime {
            rescan();
            return respond(StatusCode::CONFLICT, vec![]);
        }
    }
    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok());

    let (status, start, end) = match range {
        Some(r) => match parse_range(r, len) {
            Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e.min(s + MAX_RANGE - 1)),
            None => return respond(StatusCode::RANGE_NOT_SATISFIABLE, vec![]),
        },
        // PDFs are only ever read in bounded ranges; EPUB archives are read whole.
        None if format == Format::Epub && len <= MAX_WHOLE_EPUB && len > 0 => (StatusCode::OK, 0, len - 1),
        None => return respond(StatusCode::RANGE_NOT_SATISFIABLE, vec![]),
    };
    let mut body = vec![0u8; (end - start + 1) as usize];
    if file.seek(SeekFrom::Start(start)).and_then(|_| file.read_exact(&mut body)).is_err() {
        return respond(StatusCode::INTERNAL_SERVER_ERROR, vec![]);
    }
    {
        let mut s = stats.0.lock().unwrap();
        let e = s.entry(id).or_default();
        e.requests += 1;
        e.bytes += body.len() as u64;
    }
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, format.mime())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Range, Content-Length, Accept-Ranges")
        .body(body)
        .unwrap()
}

fn cover(lib: &Library, id: i64) -> Response<Vec<u8>> {
    let Ok(bytes) = std::fs::read(lib.cover_path(id)) else {
        return respond(StatusCode::NOT_FOUND, vec![]);
    };
    let Some(mime) = cover_mime(&bytes) else {
        return respond(StatusCode::NOT_FOUND, vec![]);
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(bytes)
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lib_with_pdf(bytes: &[u8]) -> (tempfile::TempDir, std::sync::Arc<Library>) {
        let dir = tempfile::tempdir().unwrap();
        let lib = std::sync::Arc::new(Library::open(dir.path()).unwrap());
        let src = dir.path().join("x.pdf");
        std::fs::write(&src, bytes).unwrap();
        crate::jobs::tests::import_now(&lib, &src);
        (dir, lib)
    }

    fn get(lib: &Library, uri: &str, range: Option<&str>) -> Response<Vec<u8>> {
        let mut b = Request::builder().uri(uri);
        if let Some(r) = range {
            b = b.header("Range", r);
        }
        handle(lib, &TransportStats::default(), &b.body(vec![]).unwrap(), &|| {})
    }

    #[test]
    fn parses_ranges() {
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=50-500", 100), Some((50, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 100), None);
    }

    #[test]
    fn serves_only_requested_bytes_of_registered_books() {
        let data: Vec<u8> = b"%PDF-".iter().copied().chain((0..10_000u32).map(|i| i as u8)).collect();
        let (_d, lib) = lib_with_pdf(&data);
        let r = get(&lib, "book://localhost/1", Some("bytes=100-199"));
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.body().as_slice(), &data[100..200]);
        assert_eq!(r.headers()["content-range"], format!("bytes 100-199/{}", data.len()));
        assert_eq!(get(&lib, "book://localhost/1", None).status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[test]
    fn rejects_paths_and_unknown_ids() {
        let (_d, lib) = lib_with_pdf(b"%PDF-1.4");
        for uri in [
            "book://localhost/2",
            "book://localhost/..%2F..%2Fetc%2Fpasswd",
            "book://localhost/../readi.sqlite",
            "book://localhost/1/../../readi.sqlite",
            "book://localhost/%2Fetc%2Fpasswd",
        ] {
            assert_eq!(get(&lib, uri, Some("bytes=0-3")).status(), StatusCode::NOT_FOUND, "{uri}");
        }
    }

    #[test]
    fn serves_covers_with_sniffed_type() {
        let (_d, lib) = lib_with_pdf(b"%PDF-1.4");
        assert_eq!(get(&lib, "book://localhost/1/cover", None).status(), StatusCode::NOT_FOUND);
        lib.submit_cover(1, Some(b"\x89PNG\r\n\x1a\nbody".to_vec())).unwrap();
        let r = get(&lib, "book://localhost/1/cover", None);
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()["content-type"], "image/png");
        assert_eq!(get(&lib, "book://localhost/../1/cover", None).status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn caps_range_size() {
        let data = vec![b'%'; (MAX_RANGE * 2) as usize];
        let mut d = b"%PDF-".to_vec();
        d.extend(data);
        let (_d, lib) = lib_with_pdf(&d);
        let r = get(&lib, "book://localhost/1", Some("bytes=0-"));
        assert_eq!(r.body().len() as u64, MAX_RANGE);
    }
}
