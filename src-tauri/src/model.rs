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
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub book: BookSummary,
    pub already_in_library: bool,
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
