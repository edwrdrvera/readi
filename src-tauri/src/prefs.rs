//! Reading preferences. Global defaults live in `app_settings` as versioned
//! JSON; per-book overrides live in `book_preferences`, one nullable column per
//! key. Every value is parsed into a validated type before it is stored.

use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReadingMode {
    Vertical,
    Horizontal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Spread {
    Single,
    Double,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemePref {
    System,
    Light,
    Dark,
    Sepia,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontFamily {
    Publisher,
    Serif,
    Sans,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PdfEffect {
    None,
    Sepia,
    Invert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PageWidth {
    Narrow,
    #[default]
    Medium,
    Wide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    #[default]
    Left,
    Justify,
}

macro_rules! bounded {
    ($name:ident, $min:expr, $max:expr) => {
        #[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
        #[serde(try_from = "f64", into = "f64")]
        pub struct $name(f64);

        impl TryFrom<f64> for $name {
            type Error = String;
            fn try_from(v: f64) -> Result<Self, String> {
                if v.is_finite() && ($min..=$max).contains(&v) {
                    Ok(Self(v))
                } else {
                    Err(format!("{} must be between {} and {}", stringify!($name), $min, $max))
                }
            }
        }

        impl From<$name> for f64 {
            fn from(v: $name) -> f64 {
                v.0
            }
        }
    };
}

bounded!(FontSize, 12.0, 36.0);
bounded!(LineHeight, 1.0, 2.5);
bounded!(PdfScale, 0.25, 5.0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfFit {
    FitWidth,
    FitPage,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PdfZoom {
    Fit(PdfFit),
    Scale(PdfScale),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Prefs {
    pub reading_mode: ReadingMode,
    pub spread: Spread,
    pub theme: ThemePref,
    pub font_family: FontFamily,
    pub font_size: FontSize,
    pub line_height: LineHeight,
    pub pdf_zoom: PdfZoom,
    pub pdf_effect: PdfEffect,
    /// Added after v1 defaults were stored; absent keys take the default.
    #[serde(default)]
    pub page_width: PageWidth,
    #[serde(default)]
    pub text_align: TextAlign,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            reading_mode: ReadingMode::Horizontal,
            spread: Spread::Single,
            theme: ThemePref::System,
            font_family: FontFamily::Publisher,
            font_size: FontSize(18.0),
            line_height: LineHeight(1.6),
            pdf_zoom: PdfZoom::Fit(PdfFit::FitPage),
            pdf_effect: PdfEffect::None,
            page_width: PageWidth::Medium,
            text_align: TextAlign::Left,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Overrides {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reading_mode: Option<ReadingMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spread: Option<Spread>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<ThemePref>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<FontFamily>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_size: Option<FontSize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_height: Option<LineHeight>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_zoom: Option<PdfZoom>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pdf_effect: Option<PdfEffect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_width: Option<PageWidth>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_align: Option<TextAlign>,
}

/// Also the `book_preferences` column name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrefKey {
    ReadingMode,
    Spread,
    Theme,
    FontFamily,
    FontSize,
    LineHeight,
    PdfZoom,
    PdfEffect,
    PageWidth,
    TextAlign,
}

impl PrefKey {
    const ALL: [PrefKey; 10] = [
        Self::ReadingMode,
        Self::Spread,
        Self::Theme,
        Self::FontFamily,
        Self::FontSize,
        Self::LineHeight,
        Self::PdfZoom,
        Self::PdfEffect,
        Self::PageWidth,
        Self::TextAlign,
    ];

    fn column(self) -> &'static str {
        match self {
            Self::ReadingMode => "reading_mode",
            Self::Spread => "spread",
            Self::Theme => "theme",
            Self::FontFamily => "font_family",
            Self::FontSize => "font_size",
            Self::LineHeight => "line_height",
            Self::PdfZoom => "pdf_zoom",
            Self::PdfEffect => "pdf_effect",
            Self::PageWidth => "page_width",
            Self::TextAlign => "text_align",
        }
    }
}

#[derive(Debug, Serialize)]
pub struct PrefsState {
    pub defaults: Prefs,
    pub overrides: Overrides,
}

const DEFAULTS_KEY: &str = "reading_defaults";
const DEFAULTS_VERSION: u64 = 1;

pub fn get_defaults(conn: &Connection) -> Result<Prefs, String> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", [DEFAULTS_KEY], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = raw else { return Ok(Prefs::default()) };
    let mut obj: Map<String, Value> = serde_json::from_str(&raw).unwrap_or_default();
    // An unknown version or a corrupt value falls back to defaults instead of
    // blocking every book from opening.
    if obj.remove("v").and_then(|v| v.as_u64()) != Some(DEFAULTS_VERSION) {
        return Ok(Prefs::default());
    }
    Ok(serde_json::from_value(Value::Object(obj)).unwrap_or_default())
}

pub fn set_defaults(conn: &Connection, prefs: &Prefs) -> Result<(), String> {
    let Value::Object(mut obj) = serde_json::to_value(prefs).map_err(|e| e.to_string())? else {
        unreachable!("Prefs serializes to an object")
    };
    obj.insert("v".into(), DEFAULTS_VERSION.into());
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![DEFAULTS_KEY, Value::Object(obj).to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Number(n) => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => SqlValue::Text(s.clone()),
        _ => SqlValue::Null,
    }
}

fn from_sql(v: SqlValue) -> Value {
    match v {
        SqlValue::Real(f) => serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        SqlValue::Integer(i) => Value::from(i),
        // pdf_zoom is TEXT so it can hold either a fit mode or a scale.
        SqlValue::Text(s) => s.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map(Value::Number).unwrap_or(Value::String(s)),
        _ => Value::Null,
    }
}

pub fn get_overrides(conn: &Connection, book_id: i64) -> Result<Overrides, String> {
    let cols = PrefKey::ALL.map(PrefKey::column).join(", ");
    let row: Option<Vec<SqlValue>> = conn
        .query_row(&format!("SELECT {cols} FROM book_preferences WHERE book_id = ?1"), [book_id], |r| {
            (0..PrefKey::ALL.len()).map(|i| r.get::<_, SqlValue>(i)).collect()
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let mut out = Map::new();
    for (key, v) in PrefKey::ALL.iter().zip(row.unwrap_or_default()) {
        let v = from_sql(v);
        if v.is_null() {
            continue;
        }
        // A stored value that no longer validates is dropped, not fatal.
        let one = Map::from_iter([(key.column().to_string(), v)]);
        if serde_json::from_value::<Overrides>(Value::Object(one.clone())).is_ok() {
            out.extend(one);
        }
    }
    serde_json::from_value(Value::Object(out)).map_err(|e| e.to_string())
}

/// Sets one override, or clears it when `value` is null. A row whose
/// overrides are all cleared is deleted.
pub fn set_book_pref(conn: &Connection, book_id: i64, key: PrefKey, value: Value) -> Result<(), String> {
    let col = key.column();
    let stored = if value.is_null() {
        SqlValue::Null
    } else {
        let one = Map::from_iter([(col.to_string(), value)]);
        let parsed: Overrides = serde_json::from_value(Value::Object(one)).map_err(|e| e.to_string())?;
        let Value::Object(normalized) = serde_json::to_value(parsed).map_err(|e| e.to_string())? else { unreachable!() };
        to_sql(&normalized[col])
    };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT OR IGNORE INTO book_preferences (book_id) VALUES (?1)", [book_id])
        .map_err(|e| e.to_string())?;
    tx.execute(&format!("UPDATE book_preferences SET {col} = ?2 WHERE book_id = ?1"), params![book_id, stored])
        .map_err(|e| e.to_string())?;
    let all_null = PrefKey::ALL.map(|k| format!("{} IS NULL", k.column())).join(" AND ");
    tx.execute(&format!("DELETE FROM book_preferences WHERE book_id = ?1 AND {all_null}"), [book_id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn reset_book_prefs(conn: &Connection, book_id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM book_preferences WHERE book_id = ?1", [book_id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use crate::model::Format;
    use serde_json::json;

    fn fresh() -> (tempfile::TempDir, Connection, i64) {
        let dir = tempfile::tempdir().unwrap();
        let conn = db::open(&dir.path().join("t.sqlite")).unwrap();
        let id = db::insert_managed_book(&conn, "abc", Format::Epub, "t", 10, "abc.epub").unwrap();
        (dir, conn, id)
    }

    fn rows(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM book_preferences", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn defaults_round_trip() {
        let (_d, conn, _) = fresh();
        assert_eq!(get_defaults(&conn).unwrap(), Prefs::default());
        let prefs: Prefs = serde_json::from_value(json!({
            "reading_mode": "vertical", "spread": "double", "theme": "sepia", "font_family": "serif",
            "font_size": 22, "line_height": 1.7, "pdf_zoom": 1.44, "pdf_effect": "invert",
            "page_width": "wide", "text_align": "justify"
        }))
        .unwrap();
        set_defaults(&conn, &prefs).unwrap();
        assert_eq!(get_defaults(&conn).unwrap(), prefs);
        let stored: String = conn.query_row("SELECT value FROM app_settings WHERE key = 'reading_defaults'", [], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap()["v"], 1);
    }

    #[test]
    fn override_set_and_clear() {
        let (_d, conn, id) = fresh();
        set_book_pref(&conn, id, PrefKey::Theme, json!("dark")).unwrap();
        set_book_pref(&conn, id, PrefKey::PdfZoom, json!("fit-width")).unwrap();
        set_book_pref(&conn, id, PrefKey::FontSize, json!(24)).unwrap();
        set_book_pref(&conn, id, PrefKey::PageWidth, json!("narrow")).unwrap();
        set_book_pref(&conn, id, PrefKey::TextAlign, json!("justify")).unwrap();
        let o = get_overrides(&conn, id).unwrap();
        assert_eq!(
            serde_json::to_value(&o).unwrap(),
            json!({ "theme": "dark", "font_size": 24.0, "pdf_zoom": "fit-width", "page_width": "narrow", "text_align": "justify" })
        );
        set_book_pref(&conn, id, PrefKey::PageWidth, Value::Null).unwrap();
        set_book_pref(&conn, id, PrefKey::TextAlign, Value::Null).unwrap();
        set_book_pref(&conn, id, PrefKey::PdfZoom, json!(2.5)).unwrap();
        assert_eq!(get_overrides(&conn, id).unwrap().pdf_zoom, Some(PdfZoom::Scale(PdfScale(2.5))));
        set_book_pref(&conn, id, PrefKey::Theme, Value::Null).unwrap();
        assert_eq!(get_overrides(&conn, id).unwrap().theme, None);
        set_book_pref(&conn, id, PrefKey::FontSize, Value::Null).unwrap();
        set_book_pref(&conn, id, PrefKey::PdfZoom, Value::Null).unwrap();
        assert_eq!(rows(&conn), 0, "clearing the last override removes the row");
    }

    #[test]
    fn reset_removes_the_row() {
        let (_d, conn, id) = fresh();
        set_book_pref(&conn, id, PrefKey::Spread, json!("double")).unwrap();
        assert_eq!(rows(&conn), 1);
        reset_book_prefs(&conn, id).unwrap();
        assert_eq!(rows(&conn), 0);
        assert_eq!(get_overrides(&conn, id).unwrap(), Overrides::default());
    }

    #[test]
    fn invalid_values_rejected() {
        let (_d, conn, id) = fresh();
        for (key, value) in [
            (PrefKey::FontSize, json!(11)),
            (PrefKey::FontSize, json!(37)),
            (PrefKey::LineHeight, json!(0.9)),
            (PrefKey::LineHeight, json!(2.6)),
            (PrefKey::PdfZoom, json!(0.2)),
            (PrefKey::PdfZoom, json!(5.1)),
            (PrefKey::PdfZoom, json!("fit-height")),
            (PrefKey::Theme, json!("neon")),
            (PrefKey::ReadingMode, json!(1)),
            (PrefKey::PageWidth, json!("huge")),
            (PrefKey::PageWidth, json!(620)),
            (PrefKey::TextAlign, json!("right")),
        ] {
            assert!(set_book_pref(&conn, id, key, value.clone()).is_err(), "{key:?} = {value}");
        }
        assert_eq!(rows(&conn), 0);
        assert!(serde_json::from_value::<PrefKey>(json!("font_size; DROP TABLE books")).is_err());
        let bad = json!({ "reading_mode": "vertical", "spread": "single", "theme": "system", "font_family": "sans",
            "font_size": 50, "line_height": 1.5, "pdf_zoom": "fit-page", "pdf_effect": "none" });
        assert!(serde_json::from_value::<Prefs>(bad).is_err());
    }

    #[test]
    fn v1_defaults_without_new_keys_still_load() {
        let (_d, conn, _) = fresh();
        let v1 = json!({ "v": 1, "reading_mode": "vertical", "spread": "double", "theme": "sepia", "font_family": "serif",
            "font_size": 22, "line_height": 1.7, "pdf_zoom": "fit-width", "pdf_effect": "sepia" });
        conn.execute("INSERT INTO app_settings (key, value) VALUES ('reading_defaults', ?1)", [v1.to_string()]).unwrap();
        let got = get_defaults(&conn).unwrap();
        assert_eq!(got.theme, ThemePref::Sepia);
        assert_eq!(got.font_size, FontSize(22.0));
        assert_eq!(got.page_width, PageWidth::Medium);
        assert_eq!(got.text_align, TextAlign::Left);
    }

    #[test]
    fn survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        let prefs = Prefs { theme: ThemePref::Dark, ..Prefs::default() };
        {
            let conn = db::open(&path).unwrap();
            let id = db::insert_managed_book(&conn, "abc", Format::Pdf, "t", 10, "abc.pdf").unwrap();
            set_defaults(&conn, &prefs).unwrap();
            set_book_pref(&conn, id, PrefKey::PdfEffect, json!("sepia")).unwrap();
        }
        let conn = db::open(&path).unwrap();
        assert_eq!(get_defaults(&conn).unwrap(), prefs);
        assert_eq!(get_overrides(&conn, 1).unwrap().pdf_effect, Some(PdfEffect::Sepia));
    }
}
