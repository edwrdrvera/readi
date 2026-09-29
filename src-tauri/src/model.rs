use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Epub,
    Pdf,
}

impl Format {
    pub fn from_path(path: &std::path::Path) -> Option<Self> {
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "epub" => Some(Self::Epub),
            "pdf" => Some(Self::Pdf),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Epub => "epub",
            Self::Pdf => "pdf",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "epub" => Some(Self::Epub),
            "pdf" => Some(Self::Pdf),
            _ => None,
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Epub => "application/epub+zip",
            Self::Pdf => "application/pdf",
        }
    }
}

/// Reading position. Every locator carries its format and schema version so
/// stored values stay interpretable after the frontend changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "format", rename_all = "lowercase")]
pub enum Locator {
    Epub {
        v: u32,
        cfi: String,
        section_index: u32,
        section_fraction: f64,
    },
    Pdf {
        v: u32,
        page_index: u32,
        x: f64,
        y: f64,
    },
}

pub const LOCATOR_VERSION: u32 = 1;
const MAX_CFI_LEN: usize = 4096;

impl Locator {
    pub fn format(&self) -> Format {
        match self {
            Self::Epub { .. } => Format::Epub,
            Self::Pdf { .. } => Format::Pdf,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        let finite = |f: f64| f.is_finite();
        match self {
            Self::Epub { v, cfi, section_fraction, .. } => {
                if *v != LOCATOR_VERSION {
                    return Err(format!("unsupported locator version {v}"));
                }
                if cfi.len() > MAX_CFI_LEN || !cfi.starts_with("epubcfi(") {
                    return Err("invalid CFI".into());
                }
                if !finite(*section_fraction) || !(0.0..=1.0).contains(section_fraction) {
                    return Err("section_fraction out of range".into());
                }
            }
            Self::Pdf { v, x, y, .. } => {
                if *v != LOCATOR_VERSION {
                    return Err(format!("unsupported locator version {v}"));
                }
                if !finite(*x) || !finite(*y) {
                    return Err("non-finite PDF point".into());
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Progress {
    pub locator: Locator,
    pub percent: f64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexState {
    Queued,
    Indexing,
    Ready,
    NoSearchableText,
    Failed,
}

impl IndexState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Indexing => "indexing",
            Self::Ready => "ready",
            Self::NoSearchableText => "no_searchable_text",
            Self::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "indexing" => Self::Indexing,
            "ready" => Self::Ready,
            "no_searchable_text" => Self::NoSearchableText,
            "failed" => Self::Failed,
            _ => Self::Queued,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct BookSummary {
    pub id: i64,
    pub sha256: String,
    pub format: Format,
    pub title: String,
    pub authors: Vec<String>,
    pub reading_state: String,
    pub metadata_ready: bool,
    pub index_state: IndexState,
    pub file_size: u64,
    pub added_at: i64,
    pub opened_at: Option<i64>,
    /// Derived: true when at least one location is readable. Never stored.
    pub available: bool,
    pub has_cover: bool,
    /// Manual memberships plus derived watched-folder collections.
    pub collection_ids: Vec<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadingState {
    Unread,
    Reading,
    Finished,
}

impl ReadingState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unread => "unread",
            Self::Reading => "reading",
            Self::Finished => "finished",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocationKind {
    Managed,
    Watched,
}

impl LocationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Watched => "watched",
        }
    }

    pub fn parse(s: &str) -> Self {
        if s == "managed" { Self::Managed } else { Self::Watched }
    }
}

/// Why a location can or cannot be read. A book is Missing only when no
/// location is `Available`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Available,
    /// The watched folder itself is gone or unmounted.
    FolderUnavailable,
    /// The file or folder exists but cannot be read.
    PermissionDenied,
    /// Nothing is at the recorded path any more (moved out or deleted).
    Moved,
}

impl Availability {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Available => "available",
            Self::FolderUnavailable => "folder_unavailable",
            Self::PermissionDenied => "permission_denied",
            Self::Moved => "moved",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "available" => Self::Available,
            "folder_unavailable" => Self::FolderUnavailable,
            "permission_denied" => Self::PermissionDenied,
            _ => Self::Moved,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Location {
    pub id: i64,
    pub kind: LocationKind,
    /// Absolute path, resolved from the library root for managed copies.
    pub path: String,
    pub watched_folder_id: Option<i64>,
    pub availability: Availability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Queued,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportOutcome {
    /// A new book with a managed copy.
    Imported,
    /// The hash was known without a managed copy; one was added.
    AddedCopy,
    /// The hash already had a managed copy; the UI focuses it.
    AlreadyInLibrary,
}

impl ImportOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Imported => "imported",
            Self::AddedCopy => "added_copy",
            Self::AlreadyInLibrary => "already_in_library",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "imported" => Some(Self::Imported),
            "added_copy" => Some(Self::AddedCopy),
            "already_in_library" => Some(Self::AlreadyInLibrary),
            _ => None,
        }
    }
}

/// One managed import. Persisted so an interrupted import can be retried or
/// reported on the next launch.
#[derive(Debug, Clone, Serialize)]
pub struct ImportJob {
    pub id: i64,
    pub source_path: String,
    pub state: JobState,
    pub outcome: Option<ImportOutcome>,
    pub book_id: Option<i64>,
    pub error: Option<String>,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CollectionKind {
    Manual,
    Derived,
}

#[derive(Debug, Clone, Serialize)]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub kind: CollectionKind,
    pub watched_folder_id: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FolderAccess {
    Ok,
    Unavailable,
    PermissionDenied,
}

#[derive(Debug, Clone, Serialize)]
pub struct WatchedFolder {
    pub id: i64,
    pub path: String,
    pub access_state: FolderAccess,
    pub last_scan_at: Option<i64>,
    pub show_collection: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Exclusion {
    pub folder_path: String,
    pub sha256: String,
    pub title: String,
    pub excluded_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortKey {
    Recent,
    Title,
    Author,
    Added,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AvailabilityFilter {
    Available,
    Missing,
}

/// Library filters and sort. Absent filters match everything.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryView {
    pub sort: SortKey,
    pub format: Option<Format>,
    pub author: Option<String>,
    pub reading_state: Option<ReadingState>,
    pub availability: Option<AvailabilityFilter>,
    pub collection_id: Option<i64>,
}

impl Default for LibraryView {
    fn default() -> Self {
        Self { sort: SortKey::Recent, format: None, author: None, reading_state: None, availability: None, collection_id: None }
    }
}

/// App-wide UI settings stored as one JSON value in `app_settings`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields, default)]
pub struct UiSettings {
    pub library: LibraryView,
    pub always_show_controls: bool,
}

/// Metadata and contents produced by the JavaScript format adapters.
/// Everything here is untrusted and bounded before it reaches SQLite.
#[derive(Debug, Clone, Deserialize)]
pub struct ExtractedMetadata {
    pub title: Option<String>,
    pub authors: Vec<String>,
    pub language: Option<String>,
    pub toc: Vec<TocItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TocItem {
    pub label: String,
    /// EPUB href or PDF zero-based page index, as text.
    pub target: String,
    #[serde(default)]
    pub children: Vec<TocItem>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TextSegment {
    pub order: u32,
    pub label: Option<String>,
    pub text: String,
    /// Present from extractor version 2. Without it, hits open as approximate.
    #[serde(default)]
    pub mapping: Option<TextMapping>,
}

/// The first extractor version whose segments carry a TextMapping. Older
/// indexes are rebuilt on launch.
pub const MIN_MAPPED_EXTRACTOR_VERSION: u32 = 2;

/// Current text mapping version. See src/lib/textmap.ts.
pub const TEXT_MAP_VERSION: u32 = 1;

/// Maps a segment's indexed text back to its extraction units.
/// Each entry is [start offset in the segment text, unit index, unit length],
/// in UTF-16 code units, sorted by start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextMapping {
    pub v: u32,
    pub units: Vec<[u32; 3]>,
}

/// [unit index, UTF-16 offset inside that unit].
pub type UnitPoint = [u32; 2];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HitRange {
    pub start: UnitPoint,
    pub end: UnitPoint,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchHit {
    pub order: u32,
    pub label: Option<String>,
    pub match_text: String,
    pub snippet: String,
    pub snippet_match: [u32; 2],
    pub range: Option<HitRange>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SearchGroup {
    pub order: u32,
    pub label: Option<String>,
    pub hits: Vec<SearchHit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookSearch {
    pub index_state: IndexState,
    pub groups: Vec<SearchGroup>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibraryBookResult {
    pub book: BookSummary,
    pub metadata_match: bool,
    pub hits: Vec<SearchHit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LibrarySearch {
    pub results: Vec<LibraryBookResult>,
    pub indexing: u32,
    pub no_text: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationKind {
    Highlight,
    Bookmark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HighlightColor {
    Yellow,
    Green,
    Blue,
    Pink,
}

/// Where an annotation points. Bookmarks use `Position`; highlights a range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Anchor {
    Position { locator: Locator },
    EpubRange { v: u32, cfi: String, section_index: u32 },
    PdfQuads { v: u32, page_index: u32, quads: Vec<[f64; 8]> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnchorState {
    Unknown,
    Resolved,
    Unresolved,
}

#[derive(Debug, Clone, Serialize)]
pub struct Annotation {
    pub id: i64,
    pub book_id: i64,
    pub kind: AnnotationKind,
    pub anchor: Anchor,
    pub quote: Option<String>,
    pub context: Option<String>,
    pub color: Option<HighlightColor>,
    pub note: Option<String>,
    pub sort_key: f64,
    pub anchor_state: AnchorState,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewAnnotation {
    pub book_id: i64,
    pub kind: AnnotationKind,
    pub anchor: Anchor,
    pub quote: Option<String>,
    pub context: Option<String>,
    pub color: Option<HighlightColor>,
    pub note: Option<String>,
    pub sort_key: f64,
}

/// `note: Some(None)` clears the note; an absent field is unchanged.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AnnotationPatch {
    pub color: Option<HighlightColor>,
    #[serde(default, deserialize_with = "double_option")]
    pub note: Option<Option<String>>,
}

fn double_option<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}


pub const MAX_TITLE: usize = 1024;
pub const MAX_AUTHORS: usize = 32;
pub const MAX_TOC_ENTRIES: usize = 20_000;
pub const MAX_TOC_DEPTH: usize = 16;
pub const MAX_SEGMENT_BYTES: usize = 1 << 20;
pub const MAX_SEGMENTS: usize = 100_000;

/// Strips control characters and truncates on a char boundary.
pub fn clean_text(s: &str, max: usize) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut end = trimmed.len().min(max);
    while !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    trimmed[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locator_round_trips_with_format_tag() {
        let json = r#"{"format":"pdf","v":1,"page_index":412,"x":10.5,"y":700}"#;
        let loc: Locator = serde_json::from_str(json).unwrap();
        assert_eq!(loc.format(), Format::Pdf);
        loc.validate().unwrap();
    }

    #[test]
    fn locator_rejects_bad_values() {
        let bad = Locator::Epub { v: 1, cfi: "javascript:1".into(), section_index: 0, section_fraction: 0.1 };
        assert!(bad.validate().is_err());
        let bad = Locator::Epub { v: 1, cfi: "epubcfi(/6/4)".into(), section_index: 0, section_fraction: 2.0 };
        assert!(bad.validate().is_err());
        let bad = Locator::Pdf { v: 2, page_index: 0, x: 0.0, y: 0.0 };
        assert!(bad.validate().is_err());
    }

    #[test]
    fn clean_text_strips_controls_and_truncates_on_boundary() {
        assert_eq!(clean_text("a\u{0}b\n  c", 100), "a b c");
        assert_eq!(clean_text("ééé", 3), "é");
    }
}
