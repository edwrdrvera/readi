use crate::db;
use crate::model::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

const MAX_HITS_PER_SEGMENT: usize = 50;
const MAX_HITS: usize = 1000;
const LIBRARY_HITS_PER_BOOK: usize = 3;
const SNIPPET_CONTEXT_CHARS: usize = 40;
const MAX_QUERY_TERMS: usize = 16;

/// A word, or a phrase of consecutive words, as folded tokens.
#[derive(Debug, Clone, PartialEq)]
pub struct Term(pub Vec<String>);

fn is_token_char(c: char) -> bool {
    c.is_alphanumeric() || is_combining_mark(c)
}

/// Case and diacritic folding, close to FTS5 unicode61 with remove_diacritics.
fn fold(word: &str) -> String {
    word.nfd().filter(|c| !is_combining_mark(*c)).flat_map(char::to_lowercase).collect()
}

fn tokens(s: &str) -> Vec<String> {
    s.split(|c: char| !is_token_char(c)).filter(|w| !w.is_empty()).map(fold).filter(|w| !w.is_empty()).collect()
}

/// Plain text to terms. Quotes delimit phrases (an unterminated quote runs to
/// the end); everything else is words. Punctuation, including FTS operators,
/// only separates tokens, and a word that splits into several tokens (such as
/// "don't") is a phrase.
pub fn parse_query(query: &str) -> Vec<Term> {
    let mut terms = Vec::new();
    for (i, part) in query.split('"').enumerate() {
        let chunks: Vec<&str> = if i % 2 == 1 { vec![part] } else { part.split_whitespace().collect() };
        terms.extend(chunks.into_iter().map(tokens).filter(|t| !t.is_empty()).map(Term));
    }
    terms.truncate(MAX_QUERY_TERMS);
    terms
}

/// Every term becomes a quoted FTS5 string, so user text is never syntax.
fn fts_query(terms: &[Term]) -> String {
    terms.iter().map(|t| format!("\"{}\"", t.0.join(" ").replace('"', "\"\""))).collect::<Vec<_>>().join(" ")
}

#[derive(Clone, Copy)]
struct Tok {
    b0: usize,
    b1: usize,
    u0: u32,
    u1: u32,
}

fn scan(text: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut open: Option<(usize, u32)> = None;
    let mut u = 0u32;
    for (b, c) in text.char_indices() {
        match (is_token_char(c), open) {
            (true, None) => open = Some((b, u)),
            (false, Some((b0, u0))) => {
                out.push(Tok { b0, b1: b, u0, u1: u });
                open = None;
            }
            _ => {}
        }
        u += c.len_utf16() as u32;
    }
    if let Some((b0, u0)) = open {
        out.push(Tok { b0, b1: text.len(), u0, u1: u });
    }
    out
}

fn token_eq(raw: &str, folded: &str) -> bool {
    if raw.is_ascii() { raw.eq_ignore_ascii_case(folded) } else { fold(raw) == folded }
}

/// Occurrences of `term` as (byte range, UTF-16 range), at most `limit`, and
/// whether more exist.
fn occurrences(text: &str, term: &Term, limit: usize) -> (Vec<(Tok, Tok)>, bool) {
    let toks = scan(text);
    let n = term.0.len();
    let mut out = Vec::new();
    if n == 0 || toks.len() < n {
        return (out, false);
    }
    for w in toks.windows(n) {
        if w.iter().zip(&term.0).all(|(t, f)| token_eq(&text[t.b0..t.b1], f)) {
            if out.len() == limit {
                return (out, true);
            }
            out.push((w[0], w[n - 1]));
        }
    }
    (out, false)
}

fn contains_term(text: &str, term: &Term) -> bool {
    !occurrences(text, term, 1).0.is_empty()
}

/// About 80 characters around the match with whitespace collapsed, and the
/// match's UTF-16 range inside it.
fn snippet(text: &str, b0: usize, b1: usize) -> (String, [u32; 2]) {
    let mut start = text[..b0].char_indices().rev().take(SNIPPET_CONTEXT_CHARS).last().map_or(b0, |(i, _)| i);
    if start > 0 {
        if let Some(ws) = text[start..b0].find(char::is_whitespace) {
            start += ws;
        }
    }
    let mut end = text[b1..].char_indices().nth(SNIPPET_CONTEXT_CHARS).map_or(text.len(), |(i, _)| b1 + i);
    if end < text.len() {
        if let Some(ws) = text[b1..end].rfind(char::is_whitespace) {
            end = b1 + ws;
        }
    }
    let mut out = String::new();
    let mut len = 0u32;
    let mut pending_space = false;
    let mut m0 = None;
    let mut m1 = 0;
    for (piece, s) in [&text[start..b0], &text[b0..b1], &text[b1..end]].into_iter().enumerate() {
        for c in s.chars() {
            if c.is_whitespace() {
                pending_space = !out.is_empty();
                continue;
            }
            if pending_space {
                out.push(' ');
                len += 1;
                pending_space = false;
            }
            if piece == 1 && m0.is_none() {
                m0 = Some(len);
            }
            out.push(c);
            len += c.len_utf16() as u32;
        }
        if piece == 1 {
            m1 = len;
        }
    }
    (out, [m0.unwrap_or(m1), m1])
}

/// Converts a hit's [start, end) offsets in the segment text to unit points.
/// The end point lies in the unit of the last matched character.
fn unit_range(units: &[[u32; 3]], start: u32, end: u32) -> Option<HitRange> {
    let unit_of = |x: u32| {
        let i = units.partition_point(|u| u[0] <= x);
        let u = *units.get(i.checked_sub(1)?)?;
        (x < u[0] + u[2]).then_some(u)
    };
    let a = unit_of(start)?;
    let b = unit_of(end.checked_sub(1)?)?;
    Some(HitRange { start: [a[1], start - a[0]], end: [b[1], end - b[0]] })
}

struct Segment {
    order: u32,
    label: Option<String>,
    text: String,
    mapping: Option<String>,
}

impl Segment {
    fn from_row(r: &rusqlite::Row) -> rusqlite::Result<Self> {
        Ok(Self { order: r.get("seg_order")?, label: r.get("label")?, text: r.get("text")?, mapping: r.get("mapping")? })
    }

    fn hits(&self, term: &Term, limit: usize) -> (Vec<SearchHit>, bool) {
        let (found, more) = occurrences(&self.text, term, limit);
        let units = self
            .mapping
            .as_deref()
            .and_then(|m| serde_json::from_str::<TextMapping>(m).ok())
            .map(|m| m.units);
        let hits = found
            .into_iter()
            .map(|(a, b)| {
                let (snippet, snippet_match) = snippet(&self.text, a.b0, b.b1);
                SearchHit {
                    order: self.order,
                    label: self.label.clone(),
                    match_text: self.text[a.b0..b.b1].to_string(),
                    snippet,
                    snippet_match,
                    range: units.as_deref().and_then(|u| unit_range(u, a.u0, b.u1)),
                }
            })
            .collect();
        (hits, more)
    }
}

fn index_state(conn: &Connection, id: i64) -> Result<IndexState, String> {
    let state: Option<Option<String>> = conn
        .query_row(
            "SELECT j.state FROM books b LEFT JOIN extraction_jobs j ON j.book_id = b.id WHERE b.id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(IndexState::parse(state.ok_or("Book not found")?.as_deref().unwrap_or("queued")))
}

/// Hits in reading order, grouped by section or page. A multi-term query
/// reports occurrences of its first term in segments that contain every term.
pub fn search_book(conn: &Connection, id: i64, query: &str) -> Result<BookSearch, String> {
    let index_state = index_state(conn, id)?;
    let terms = parse_query(query);
    let mut result = BookSearch { index_state, groups: Vec::new(), truncated: false };
    let Some(first) = terms.first() else { return Ok(result) };
    let mut stmt = conn
        .prepare(
            "SELECT s.seg_order, s.label, s.text, s.mapping FROM text_segments s
             WHERE s.book_id = ?1 AND s.id IN (SELECT rowid FROM book_text WHERE book_text MATCH ?2)
             ORDER BY s.seg_order, s.id",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![id, fts_query(&terms)]).map_err(|e| e.to_string())?;
    let mut total = 0;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if total == MAX_HITS {
            result.truncated = true;
            break;
        }
        let seg = Segment::from_row(row).map_err(|e| e.to_string())?;
        let (hits, more) = seg.hits(first, MAX_HITS_PER_SEGMENT.min(MAX_HITS - total));
        result.truncated |= more;
        total += hits.len();
        if !hits.is_empty() {
            result.groups.push(SearchGroup { order: seg.order, label: seg.label, hits });
        }
    }
    Ok(result)
}

fn index_counts(conn: &Connection) -> Result<(u32, u32, u32), String> {
    conn.query_row(
        "SELECT count(*) FILTER (WHERE state IN ('queued','indexing')),
                count(*) FILTER (WHERE state = 'no_searchable_text'),
                count(*) FILTER (WHERE state = 'failed')
         FROM extraction_jobs",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .map_err(|e| e.to_string())
}

/// Segment ids by book, books ordered by their best segment's bm25 rank.
fn ranked_segments(conn: &Connection, terms: &[Term]) -> Result<Vec<(i64, Vec<i64>)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.book_id, s.id FROM book_text JOIN text_segments s ON s.id = book_text.rowid
             WHERE book_text MATCH ?1 ORDER BY rank",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([fts_query(terms)], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut books: Vec<(i64, Vec<i64>)> = Vec::new();
    let mut at: HashMap<i64, usize> = HashMap::new();
    for row in rows {
        let (book, seg) = row.map_err(|e| e.to_string())?;
        let i = *at.entry(book).or_insert_with(|| {
            books.push((book, Vec::new()));
            books.len() - 1
        });
        books[i].1.push(seg);
    }
    Ok(books)
}

fn best_hits(conn: &Connection, segments: &[i64], term: &Term) -> Result<Vec<SearchHit>, String> {
    let mut stmt = conn
        .prepare_cached("SELECT seg_order, label, text, mapping FROM text_segments WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut hits = Vec::new();
    for &id in segments {
        if hits.len() == LIBRARY_HITS_PER_BOOK {
            break;
        }
        let seg = stmt.query_row([id], Segment::from_row).map_err(|e| e.to_string())?;
        hits.extend(seg.hits(term, LIBRARY_HITS_PER_BOOK - hits.len()).0);
    }
    Ok(hits)
}

/// Books whose title or authors match every term first, then books with text
/// hits by relevance.
pub fn search_library(conn: &Connection, query: &str) -> Result<LibrarySearch, String> {
    let (indexing, no_text, failed) = index_counts(conn)?;
    let mut result = LibrarySearch { results: Vec::new(), indexing, no_text, failed };
    let terms = parse_query(query);
    let Some(first) = terms.first() else { return Ok(result) };
    let ranked = ranked_segments(conn, &terms)?;
    let mut books: HashMap<i64, BookSummary> = db::list_books(conn)?.into_iter().map(|b| (b.id, b)).collect();

    let mut meta: Vec<BookSummary> = books
        .values()
        .filter(|b| terms.iter().all(|t| contains_term(&b.title, t) || b.authors.iter().any(|a| contains_term(a, t))))
        .cloned()
        .collect();
    let rank: HashMap<i64, usize> = ranked.iter().enumerate().map(|(i, (id, _))| (*id, i)).collect();
    meta.sort_by_cached_key(|b| (rank.get(&b.id).copied().unwrap_or(usize::MAX), b.title.to_lowercase(), b.id));
    let segments: HashMap<i64, &[i64]> = ranked.iter().map(|(id, s)| (*id, s.as_slice())).collect();
    for book in meta {
        books.remove(&book.id);
        let hits = match segments.get(&book.id) {
            Some(s) => best_hits(conn, s, first)?,
            None => Vec::new(),
        };
        result.results.push(LibraryBookResult { book, metadata_match: true, hits });
    }
    for (id, segs) in &ranked {
        let Some(book) = books.remove(id) else { continue };
        let hits = best_hits(conn, segs, first)?;
        if !hits.is_empty() {
            result.results.push(LibraryBookResult { book, metadata_match: false, hits });
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{insert_managed_book, replace_text, save_metadata};

    fn words(ws: &[&str]) -> Term {
        Term(ws.iter().map(|w| w.to_string()).collect())
    }

    fn fresh() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("t.sqlite")).unwrap();
        (dir, conn)
    }

    fn seg(order: u32, text: &str) -> TextSegment {
        TextSegment { order, label: Some(format!("S{order}")), text: text.into(), mapping: None }
    }

    fn book(conn: &Connection, sha: &str, title: &str, authors: &[&str], segments: &[TextSegment]) -> i64 {
        let id = insert_managed_book(conn, sha, Format::Epub, title, 10, &format!("{sha}.epub")).unwrap();
        let meta = ExtractedMetadata {
            title: Some(title.into()),
            authors: authors.iter().map(|a| a.to_string()).collect(),
            language: None,
            toc: vec![],
        };
        save_metadata(conn, id, &meta).unwrap();
        replace_text(conn, id, MIN_MAPPED_EXTRACTOR_VERSION, segments).unwrap();
        id
    }

    fn utf16(s: &str, r: [u32; 2]) -> String {
        let u: Vec<u16> = s.encode_utf16().collect();
        String::from_utf16(&u[r[0] as usize..r[1] as usize]).unwrap()
    }

    #[test]
    fn parses_words_phrases_and_unterminated_quotes() {
        assert_eq!(parse_query("  Hello   World "), vec![words(&["hello"]), words(&["world"])]);
        assert_eq!(parse_query(r#"a "Big Cat" b"#), vec![words(&["a"]), words(&["big", "cat"]), words(&["b"])]);
        assert_eq!(parse_query(r#"x "open phrase to end"#), vec![words(&["x"]), words(&["open", "phrase", "to", "end"])]);
        assert_eq!(parse_query("don't"), vec![words(&["don", "t"])]);
        assert_eq!(parse_query(r#"   ""  * - " "#), vec![]);
        assert_eq!(parse_query("Café"), vec![words(&["cafe"])]);
    }

    #[test]
    fn fts_operators_stay_literal() {
        let terms = parse_query(r#"cat NEAR dog* -mouse OR "a AND""#);
        assert_eq!(
            terms,
            vec![words(&["cat"]), words(&["near"]), words(&["dog"]), words(&["mouse"]), words(&["or"]), words(&["a", "and"])]
        );
        assert_eq!(fts_query(&terms), r#""cat" "near" "dog" "mouse" "or" "a and""#);
        let (_d, conn) = fresh();
        let id = book(&conn, "a", "t", &[], &[seg(0, "cat near dog mouse or a and")]);
        for q in ["NEAR", "cat*", "-cat", "\"", "cat AND", "NOT", "(cat", "col:cat", "^cat", "cat + dog"] {
            search_book(&conn, id, q).unwrap_or_else(|e| panic!("{q}: {e}"));
            search_library(&conn, q).unwrap_or_else(|e| panic!("{q}: {e}"));
        }
        assert_eq!(search_book(&conn, id, "NEAR").unwrap().groups.len(), 1);
    }

    #[test]
    fn empty_query_is_an_empty_result() {
        let (_d, conn) = fresh();
        let id = book(&conn, "a", "Cat", &[], &[seg(0, "cat")]);
        let r = search_book(&conn, id, "  ").unwrap();
        assert!(r.groups.is_empty() && !r.truncated);
        assert!(search_library(&conn, "\"\"").unwrap().results.is_empty());
        assert!(search_book(&conn, 99, "cat").is_err());
    }

    #[test]
    fn in_book_hits_are_grouped_in_reading_order() {
        let (_d, conn) = fresh();
        let id = book(&conn, "a", "t", &[], &[seg(2, "cat two cat"), seg(0, "Cat zero"), seg(1, "no match here")]);
        let r = search_book(&conn, id, "CAT").unwrap();
        assert_eq!(r.index_state, IndexState::Ready);
        let got: Vec<(u32, Vec<&str>)> =
            r.groups.iter().map(|g| (g.order, g.hits.iter().map(|h| h.snippet.as_str()).collect())).collect();
        assert_eq!(got, vec![(0, vec!["Cat zero"]), (2, vec!["cat two cat", "cat two cat"])]);
        assert_eq!(r.groups[1].hits[1].snippet_match, [8, 11]);
        assert_eq!(r.groups[0].label.as_deref(), Some("S0"));
        assert_eq!(r.groups[0].hits[0].match_text, "Cat");
    }

    #[test]
    fn phrase_matches_consecutive_words_and_multi_term_needs_all() {
        let (_d, conn) = fresh();
        let id = book(&conn, "a", "t", &[], &[seg(0, "red fox, brown dog"), seg(1, "fox red dog"), seg(2, "red. Fox!")]);
        let orders = |q: &str| search_book(&conn, id, q).unwrap().groups.iter().map(|g| g.order).collect::<Vec<_>>();
        assert_eq!(orders("\"red fox\""), vec![0, 2]);
        assert_eq!(orders("red fox"), vec![0, 1, 2]);
        assert_eq!(orders("dog red"), vec![0, 1]);
        let r = search_book(&conn, id, "\"red fox\"").unwrap();
        assert_eq!(r.groups[1].hits[0].match_text, "red. Fox");
        let r = search_book(&conn, id, "dog red").unwrap();
        assert!(r.groups.iter().flat_map(|g| &g.hits).all(|h| h.match_text == "dog"), "hits are the first term");
    }

    #[test]
    fn caps_hits_and_reports_truncation() {
        let (_d, conn) = fresh();
        let segs: Vec<TextSegment> = (0..25).map(|i| seg(i, &"cat ".repeat(60))).collect();
        let id = book(&conn, "a", "t", &[], &segs);
        let r = search_book(&conn, id, "cat").unwrap();
        assert!(r.truncated);
        assert!(r.groups.iter().all(|g| g.hits.len() == 50));
        assert_eq!(r.groups.iter().map(|g| g.hits.len()).sum::<usize>(), 1000);
        let id = book(&conn, "b", "t", &[], &[seg(0, "dog dog")]);
        assert!(!search_book(&conn, id, "dog").unwrap().truncated);
    }

    #[test]
    fn hit_across_two_units_maps_to_unit_points() {
        let (_d, conn) = fresh();
        let text = "The red fox\njumps";
        let mapping = TextMapping { v: TEXT_MAP_VERSION, units: vec![[0, 1, 4], [4, 3, 7], [12, 5, 5]] };
        let id = book(&conn, "a", "t", &[], &[TextSegment { mapping: Some(mapping), ..seg(0, text) }]);
        let hit = |q: &str| search_book(&conn, id, q).unwrap().groups[0].hits[0].range.clone();
        assert_eq!(hit("\"fox jumps\""), Some(HitRange { start: [3, 4], end: [5, 5] }));
        assert_eq!(hit("the"), Some(HitRange { start: [1, 0], end: [1, 3] }));
        assert_eq!(hit("\"the red\""), Some(HitRange { start: [1, 0], end: [3, 3] }));
        let id = book(&conn, "b", "t", &[], &[seg(0, text)]);
        assert_eq!(search_book(&conn, id, "fox").unwrap().groups[0].hits[0].range, None);
    }

    #[test]
    fn unit_range_rejects_separator_ends() {
        let units = [[0, 0, 3], [4, 1, 3]];
        assert_eq!(unit_range(&units, 3, 4), None);
        assert_eq!(unit_range(&units, 0, 3), Some(HitRange { start: [0, 0], end: [0, 3] }));
        assert_eq!(unit_range(&units, 5, 9), None);
    }

    #[test]
    fn snippet_offsets_are_utf16_with_non_ascii() {
        let (_d, conn) = fresh();
        let text = "😀 é  café  naïve Été 😀";
        let mapping = TextMapping { v: TEXT_MAP_VERSION, units: vec![[0, 0, text.encode_utf16().count() as u32]] };
        let id = book(&conn, "a", "t", &[], &[TextSegment { mapping: Some(mapping), ..seg(0, text) }]);
        for (q, want) in [("CAFE", "café"), ("naive", "naïve"), ("été", "Été"), ("\"cafe naïve\"", "café  naïve")] {
            let h = &search_book(&conn, id, q).unwrap().groups[0].hits[0];
            assert_eq!(h.match_text, want, "{q}");
            assert_eq!(h.snippet, "😀 é café naïve Été 😀");
            assert_eq!(utf16(&h.snippet, h.snippet_match), want.split_whitespace().collect::<Vec<_>>().join(" "), "{q}");
            let r = h.range.as_ref().unwrap();
            assert_eq!(utf16(text, [r.start[1], r.end[1]]), want, "{q}");
        }
    }

    #[test]
    fn snippet_is_bounded_and_starts_on_a_word() {
        let text = format!("{} needle {}", "alpha ".repeat(30), "omega ".repeat(30));
        let b0 = text.find("needle").unwrap();
        let (s, m) = snippet(&text, b0, b0 + 6);
        assert!(s.chars().count() <= 6 + 2 * SNIPPET_CONTEXT_CHARS, "{s}");
        assert!(s.starts_with("alpha") && s.ends_with("omega"), "{s}");
        assert_eq!(utf16(&s, m), "needle");
    }

    #[test]
    fn library_puts_metadata_matches_first_then_relevance() {
        let (_d, conn) = fresh();
        let weak = book(&conn, "a", "Weak", &[], &[seg(0, &format!("whale {}", "filler ".repeat(200)))]);
        let strong = book(&conn, "b", "Strong", &[], &[seg(0, "whale whale whale")]);
        let titled = book(&conn, "c", "The White Whale", &["Herman Melville"], &[seg(0, "nothing")]);
        let authored = book(&conn, "d", "Other", &["Whale Author"], &[seg(0, "whale")]);
        book(&conn, "e", "Unrelated", &[], &[seg(0, "dog")]);
        let r = search_library(&conn, "whale").unwrap();
        let got: Vec<(i64, bool, usize)> = r.results.iter().map(|x| (x.book.id, x.metadata_match, x.hits.len())).collect();
        assert_eq!(got, vec![(authored, true, 1), (titled, true, 0), (strong, false, 3), (weak, false, 1)]);

        let r = search_library(&conn, "white melville").unwrap();
        assert_eq!(r.results.len(), 1, "every term must match title or authors");
        assert!(r.results[0].metadata_match);
        assert!(search_library(&conn, "whale melville").unwrap().results.iter().all(|x| x.book.id == titled));
    }

    #[test]
    fn library_counts_books_that_are_not_searchable() {
        let (_d, conn) = fresh();
        book(&conn, "a", "t", &[], &[seg(0, "cat")]);
        book(&conn, "b", "t", &[], &[seg(0, "  ")]);
        let failed = insert_managed_book(&conn, "c", Format::Pdf, "t", 10, "c.pdf").unwrap();
        db::fail_job(&conn, failed, "bad").unwrap();
        insert_managed_book(&conn, "d", Format::Pdf, "t", 10, "d.pdf").unwrap();
        let indexing = insert_managed_book(&conn, "e", Format::Pdf, "t", 10, "e.pdf").unwrap();
        db::claim_job(&conn, false).unwrap();
        let r = search_library(&conn, "cat").unwrap();
        assert_eq!((r.indexing, r.no_text, r.failed), (2, 1, 1));
        assert_eq!(r.results.len(), 1);
        assert_eq!(search_book(&conn, indexing, "cat").unwrap().index_state, IndexState::Queued);
    }
}
