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

pub const MAX_TITLE: usize = 1024;

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
    fn clean_text_strips_controls_and_truncates_on_boundary() {
        assert_eq!(clean_text("a\u{0}b\n  c", 100), "a b c");
        assert_eq!(clean_text("ééé", 3), "é");
    }
}
