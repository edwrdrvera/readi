use crate::db::now;
use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension};

const MAX_QUOTE: usize = 4 << 10;
const MAX_CONTEXT: usize = 2 << 10;
const MAX_NOTE: usize = 64 << 10;
const MAX_CFI_LEN: usize = 4096;
const MAX_QUADS: usize = 512;

fn to_json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap()
}

/// Serde's lowercase names double as the stored text.
fn from_str<T: serde::de::DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(s.into())).ok()
}

fn as_str<T: serde::Serialize>(v: T) -> String {
    match serde_json::to_value(v).unwrap() {
        serde_json::Value::String(s) => s,
        _ => unreachable!(),
    }
}

/// Notes keep their line breaks; other control characters are dropped.
fn clean_note(note: Option<String>) -> Result<Option<String>, String> {
    let Some(note) = note else { return Ok(None) };
    if note.len() > MAX_NOTE {
        return Err("Note is too long".into());
    }
    let note: String = note.chars().filter(|c| !c.is_control() || matches!(c, '\n' | '\t')).collect();
    Ok(Some(note).filter(|n| !n.trim().is_empty()))
}

fn validate_anchor(kind: AnnotationKind, anchor: &Anchor, format: Format) -> Result<(), String> {
    match (kind, anchor) {
        (AnnotationKind::Bookmark, Anchor::Position { locator }) => {
            locator.validate()?;
            if locator.format() != format {
                return Err("locator format does not match book".into());
            }
        }
        (AnnotationKind::Highlight, Anchor::EpubRange { v, cfi, .. }) => {
            if format != Format::Epub || *v != LOCATOR_VERSION || cfi.len() > MAX_CFI_LEN || !cfi.starts_with("epubcfi(") {
                return Err("invalid EPUB range".into());
            }
        }
        (AnnotationKind::Highlight, Anchor::PdfQuads { v, quads, .. }) => {
            if format != Format::Pdf
                || *v != LOCATOR_VERSION
                || !(1..=MAX_QUADS).contains(&quads.len())
                || !quads.iter().flatten().all(|f| f.is_finite())
            {
                return Err("invalid PDF quads".into());
            }
        }
        _ => return Err("anchor does not match annotation kind".into()),
    }
    Ok(())
}

fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Option<Annotation>> {
    let kind: String = r.get("kind")?;
    let anchor: String = r.get("locator")?;
    let color: Option<String> = r.get("color")?;
    let state: String = r.get("anchor_state")?;
    let (Some(kind), Ok(anchor)) = (from_str(&kind), serde_json::from_str(&anchor)) else { return Ok(None) };
    Ok(Some(Annotation {
        id: r.get("id")?,
        book_id: r.get("book_id")?,
        kind,
        anchor,
        quote: r.get("quote")?,
        context: r.get("context")?,
        color: color.as_deref().and_then(from_str),
        note: r.get("note")?,
        sort_key: r.get("sort_key")?,
        anchor_state: from_str(&state).unwrap_or(AnchorState::Unknown),
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    }))
}

fn get(conn: &Connection, id: i64) -> Result<Annotation, String> {
    conn.query_row("SELECT * FROM annotations WHERE id = ?1", [id], from_row)
        .optional()
        .map_err(|e| e.to_string())?
        .flatten()
        .ok_or_else(|| "Annotation not found".into())
}

/// In reading order. Rows whose anchor can no longer be parsed are skipped.
pub fn list(conn: &Connection, book_id: i64) -> Result<Vec<Annotation>, String> {
    let mut stmt = conn
        .prepare("SELECT * FROM annotations WHERE book_id = ?1 ORDER BY sort_key, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([book_id], from_row).map_err(|e| e.to_string())?;
    rows.filter_map(|r| r.transpose()).collect::<Result<_, _>>().map_err(|e| e.to_string())
}

pub fn create(conn: &Connection, a: NewAnnotation) -> Result<Annotation, String> {
    let format: Option<String> = conn
        .query_row("SELECT format FROM books WHERE id = ?1", [a.book_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let format = format.and_then(|f| Format::parse(&f)).ok_or("Book not found")?;
    validate_anchor(a.kind, &a.anchor, format)?;
    match (a.kind, a.color) {
        (AnnotationKind::Highlight, None) => return Err("highlights need a color".into()),
        (AnnotationKind::Bookmark, Some(_)) => return Err("bookmarks have no color".into()),
        _ => {}
    }
    if !a.sort_key.is_finite() {
        return Err("non-finite sort key".into());
    }
    let quote = a.quote.map(|q| clean_text(&q, MAX_QUOTE));
    let context = a.context.map(|c| clean_text(&c, MAX_CONTEXT));
    let note = clean_note(a.note)?;
    let t = now();
    conn.execute(
        "INSERT INTO annotations (book_id, kind, locator, quote, context, color, note, sort_key, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![a.book_id, as_str(a.kind), to_json(&a.anchor), quote, context, a.color.map(as_str), note, a.sort_key, t],
    )
    .map_err(|e| e.to_string())?;
    get(conn, conn.last_insert_rowid())
}

pub fn update(conn: &Connection, id: i64, patch: AnnotationPatch) -> Result<Annotation, String> {
    let current = get(conn, id)?;
    if patch.color.is_some() && current.kind == AnnotationKind::Bookmark {
        return Err("bookmarks have no color".into());
    }
    let note = match patch.note {
        Some(n) => clean_note(n)?,
        None => current.note,
    };
    let color = patch.color.or(current.color);
    conn.execute(
        "UPDATE annotations SET color = ?2, note = ?3, updated_at = max(?4, updated_at + 1) WHERE id = ?1",
        params![id, color.map(as_str), note, now()],
    )
    .map_err(|e| e.to_string())?;
    get(conn, id)
}

pub fn delete(conn: &Connection, id: i64) -> Result<(), String> {
    match conn.execute("DELETE FROM annotations WHERE id = ?1", [id]).map_err(|e| e.to_string())? {
        0 => Err("Annotation not found".into()),
        _ => Ok(()),
    }
}

/// Unknown ids are ignored: the annotation may have been deleted meanwhile.
pub fn set_anchor_states(conn: &Connection, states: &[(i64, AnchorState)]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (id, state) in states {
        tx.execute("UPDATE annotations SET anchor_state = ?2 WHERE id = ?1", params![id, as_str(*state)])
            .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, insert_managed_book};

    fn fresh() -> (tempfile::TempDir, Connection, i64, i64) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("t.sqlite")).unwrap();
        let epub = insert_managed_book(&conn, "e", Format::Epub, "e", 10, "e.epub").unwrap();
        let pdf = insert_managed_book(&conn, "p", Format::Pdf, "p", 10, "p.pdf").unwrap();
        (dir, conn, epub, pdf)
    }

    fn epub_highlight(book_id: i64, sort_key: f64) -> NewAnnotation {
        NewAnnotation {
            book_id,
            kind: AnnotationKind::Highlight,
            anchor: Anchor::EpubRange { v: 1, cfi: "epubcfi(/6/4!/4/2,/1:0,/1:5)".into(), section_index: 2 },
            quote: Some("  hello\n world ".into()),
            context: Some("say hello world".into()),
            color: Some(HighlightColor::Yellow),
            note: None,
            sort_key,
        }
    }

    fn bookmark(book_id: i64, locator: Locator) -> NewAnnotation {
        NewAnnotation {
            book_id,
            kind: AnnotationKind::Bookmark,
            anchor: Anchor::Position { locator },
            quote: None,
            context: None,
            color: None,
            note: Some("line one\nline two\u{7}".into()),
            sort_key: 1.0,
        }
    }

    fn pdf_highlight(book_id: i64, quads: Vec<[f64; 8]>) -> NewAnnotation {
        NewAnnotation {
            anchor: Anchor::PdfQuads { v: 1, page_index: 3, quads },
            color: Some(HighlightColor::Blue),
            ..epub_highlight(book_id, 3.5)
        }
    }

    #[test]
    fn creates_lists_in_reading_order_and_round_trips_json() {
        let (_d, conn, epub, pdf) = fresh();
        let later = create(&conn, epub_highlight(epub, 2.5)).unwrap();
        let earlier = create(&conn, epub_highlight(epub, 0.25)).unwrap();
        let mark = create(&conn, bookmark(pdf, Locator::Pdf { v: 1, page_index: 0, x: 0.0, y: 1.0 })).unwrap();
        assert_eq!(later.quote.as_deref(), Some("hello world"));
        assert_eq!(later.anchor_state, AnchorState::Unknown);
        assert_eq!(mark.note.as_deref(), Some("line one\nline two"));
        let ids: Vec<i64> = list(&conn, epub).unwrap().iter().map(|a| a.id).collect();
        assert_eq!(ids, vec![earlier.id, later.id]);
        let json = serde_json::to_value(&list(&conn, pdf).unwrap()[0]).unwrap();
        assert_eq!(json["anchor"]["type"], "position");
        assert_eq!(json["anchor"]["locator"]["format"], "pdf");
        assert_eq!(json["kind"], "bookmark");
        assert_eq!(json["color"], serde_json::Value::Null);
        let q = create(&conn, pdf_highlight(pdf, vec![[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]])).unwrap();
        assert_eq!(serde_json::to_value(&q).unwrap()["anchor"]["type"], "pdf_quads");
        assert_eq!(serde_json::to_value(&q).unwrap()["color"], "blue");
    }

    #[test]
    fn rejects_invalid_annotations() {
        let (_d, conn, epub, pdf) = fresh();
        let bad = [
            ("missing book", epub_highlight(999, 0.0)),
            ("epub range on pdf", epub_highlight(pdf, 0.0)),
            ("no color", NewAnnotation { color: None, ..epub_highlight(epub, 0.0) }),
            ("non-finite sort key", epub_highlight(epub, f64::NAN)),
            (
                "bad cfi",
                NewAnnotation { anchor: Anchor::EpubRange { v: 1, cfi: "javascript:x".into(), section_index: 0 }, ..epub_highlight(epub, 0.0) },
            ),
            (
                "long cfi",
                NewAnnotation {
                    anchor: Anchor::EpubRange { v: 1, cfi: format!("epubcfi({})", "/2".repeat(3000)), section_index: 0 },
                    ..epub_highlight(epub, 0.0)
                },
            ),
            (
                "bad version",
                NewAnnotation { anchor: Anchor::EpubRange { v: 2, cfi: "epubcfi(/6)".into(), section_index: 0 }, ..epub_highlight(epub, 0.0) },
            ),
            ("no quads", pdf_highlight(pdf, vec![])),
            ("too many quads", pdf_highlight(pdf, vec![[0.0; 8]; 513])),
            ("nan quad", pdf_highlight(pdf, vec![[0.0, f64::INFINITY, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]])),
            ("quads on epub", pdf_highlight(epub, vec![[0.0; 8]])),
            ("bookmark on wrong format", bookmark(epub, Locator::Pdf { v: 1, page_index: 0, x: 0.0, y: 0.0 })),
            (
                "bad bookmark locator",
                bookmark(epub, Locator::Epub { v: 1, cfi: "epubcfi(/6)".into(), section_index: 0, section_fraction: 3.0 }),
            ),
            (
                "bookmark with color",
                NewAnnotation { color: Some(HighlightColor::Pink), ..bookmark(pdf, Locator::Pdf { v: 1, page_index: 0, x: 0.0, y: 0.0 }) },
            ),
            (
                "highlight with position",
                NewAnnotation { kind: AnnotationKind::Highlight, color: Some(HighlightColor::Pink), ..bookmark(pdf, Locator::Pdf { v: 1, page_index: 0, x: 0.0, y: 0.0 }) },
            ),
            ("huge note", NewAnnotation { note: Some("x".repeat(MAX_NOTE + 1)), ..epub_highlight(epub, 0.0) }),
        ];
        for (why, a) in bad {
            assert!(create(&conn, a).is_err(), "{why}");
        }
        assert!(list(&conn, epub).unwrap().is_empty() && list(&conn, pdf).unwrap().is_empty());
        let long = create(&conn, NewAnnotation { quote: Some("q".repeat(10_000)), ..epub_highlight(epub, 0.0) }).unwrap();
        assert_eq!(long.quote.unwrap().len(), MAX_QUOTE);
        create(&conn, pdf_highlight(pdf, vec![[0.0; 8]; 512])).unwrap();
    }

    #[test]
    fn updates_color_and_note_and_deletes() {
        let (_d, conn, epub, pdf) = fresh();
        let a = create(&conn, epub_highlight(epub, 0.0)).unwrap();
        let noted: AnnotationPatch = serde_json::from_str(r#"{"note":"hi"}"#).unwrap();
        let b = update(&conn, a.id, noted).unwrap();
        assert_eq!((b.note.as_deref(), b.color), (Some("hi"), Some(HighlightColor::Yellow)));
        assert!(b.updated_at > a.updated_at);
        let recolor: AnnotationPatch = serde_json::from_str(r#"{"color":"green"}"#).unwrap();
        let c = update(&conn, a.id, recolor).unwrap();
        assert_eq!((c.note.as_deref(), c.color), (Some("hi"), Some(HighlightColor::Green)), "absent note is unchanged");
        let cleared: AnnotationPatch = serde_json::from_str(r#"{"note":null}"#).unwrap();
        assert_eq!(update(&conn, a.id, cleared).unwrap().note, None);

        let m = create(&conn, bookmark(pdf, Locator::Pdf { v: 1, page_index: 0, x: 0.0, y: 0.0 })).unwrap();
        assert!(update(&conn, m.id, AnnotationPatch { color: Some(HighlightColor::Pink), note: None }).is_err());
        assert!(update(&conn, 999, AnnotationPatch::default()).is_err());

        delete(&conn, a.id).unwrap();
        assert!(delete(&conn, a.id).is_err());
        assert_eq!(list(&conn, epub).unwrap().len(), 0);
    }

    #[test]
    fn sets_anchor_states_together() {
        let (_d, conn, epub, _) = fresh();
        let a = create(&conn, epub_highlight(epub, 0.0)).unwrap();
        let b = create(&conn, epub_highlight(epub, 1.0)).unwrap();
        let states: Vec<(i64, AnchorState)> = serde_json::from_str(&format!(
            r#"[[{}, "resolved"], [{}, "unresolved"], [999, "resolved"]]"#,
            a.id, b.id
        ))
        .unwrap();
        set_anchor_states(&conn, &states).unwrap();
        let got: Vec<AnchorState> = list(&conn, epub).unwrap().iter().map(|a| a.anchor_state).collect();
        assert_eq!(got, vec![AnchorState::Resolved, AnchorState::Unresolved]);
    }
}
