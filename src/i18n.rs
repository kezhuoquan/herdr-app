//! Interface language. English is the source catalog and the fallback.
//! `settings.json` `language` overrides the system; absent follows it.
//! Chinese locales use Simplified Chinese until a traditional catalog exists.

use gpui::FontFallbacks;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::OnceLock;

const EN_JSON: &str = include_str!("../defaults/locales/en.json");
const ZH_JSON: &str = include_str!("../defaults/locales/zh-CN.json");

fn catalogs() -> &'static (BTreeMap<String, String>, BTreeMap<String, String>) {
    static CATALOGS: OnceLock<(BTreeMap<String, String>, BTreeMap<String, String>)> = OnceLock::new();
    CATALOGS.get_or_init(|| (load(EN_JSON), load(ZH_JSON)))
}

fn load(text: &str) -> BTreeMap<String, String> {
    serde_json::from_str::<BTreeMap<String, String>>(text).unwrap_or_else(|e| {
        tracing::error!("locale catalog is not a flat string map: {e}");
        BTreeMap::new()
    })
}

/// `"en"` or `"zh-CN"`. An explicit unknown preference is English, not the system.
pub fn resolve(preference: Option<&str>) -> &'static str {
    resolve_with(preference, system_locale().as_deref())
}

pub fn resolve_with(preference: Option<&str>, system: Option<&str>) -> &'static str {
    match preference.map(str::trim).filter(|s| !s.is_empty()) {
        Some("en") => "en",
        Some("zh-CN") => "zh-CN",
        Some(_) => "en",
        None => map_system(system).unwrap_or("en"),
    }
}

/// `zh`, `zh-CN`, `zh-Hans`, and traditional tags until a `zh-TW` catalog exists.
pub fn map_system(tag: Option<&str>) -> Option<&'static str> {
    let tag = tag?.trim();
    if tag.is_empty() || tag == "C" || tag == "POSIX" {
        return None;
    }
    let tag = tag.split(['.', '@']).next().unwrap_or(tag).replace('_', "-");
    let lower = tag.to_ascii_lowercase();
    if lower == "zh" || lower.starts_with("zh-") {
        Some("zh-CN")
    } else {
        None
    }
}

pub fn t(key: &str) -> String {
    lookup(&crate::settings::get().language, key, None)
}

pub fn t_with(key: &str, vars: Option<&Value>) -> String {
    lookup(&crate::settings::get().language, key, vars)
}

pub fn format(key: &str, vars: &[(&str, &str)]) -> String {
    let mut map = Map::new();
    for (k, v) in vars {
        map.insert((*k).to_owned(), Value::String((*v).to_owned()));
    }
    lookup(&crate::settings::get().language, key, Some(&Value::Object(map)))
}

/// Lookup used by tests and the render-test host, independent of live settings.
#[cfg_attr(not(test), allow(dead_code))]
pub fn translate(locale: &str, key: &str, vars: Option<&Value>) -> String {
    lookup(locale, key, vars)
}

fn lookup(locale: &str, key: &str, vars: Option<&Value>) -> String {
    let (en, zh) = catalogs();
    let catalog = if locale == "zh-CN" { zh } else { en };
    let template = catalog.get(key).or_else(|| en.get(key)).map(String::as_str).unwrap_or(key);
    interpolate(template, vars)
}

fn interpolate(template: &str, vars: Option<&Value>) -> String {
    let Some(vars) = vars.and_then(Value::as_object) else {
        return template.to_owned();
    };
    let mut out = String::with_capacity(template.len());
    let bytes = template.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = template[i + 1..].find('}') {
                let name = &template[i + 1..i + 1 + end];
                if !name.is_empty() && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
                    if let Some(value) = vars.get(name).and_then(var_string) {
                        out.push_str(&value);
                        i += end + 2;
                        continue;
                    }
                }
            }
        }
        let ch = template[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

fn var_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The UI font, plus a system CJK face when the interface is Chinese.
/// Geist has no CJK glyphs; the fallback is only for those characters.
pub fn ui_font() -> gpui::Font {
    let mut font = gpui::font(crate::settings::get().ui_font_family.clone());
    font.fallbacks = ui_fallbacks();
    font
}

pub fn ui_fallbacks() -> Option<FontFallbacks> {
    if crate::settings::get().language != "zh-CN" {
        return None;
    }
    let fonts: Vec<String> = cjk_families().iter().map(|s| (*s).to_owned()).collect();
    (!fonts.is_empty()).then(|| FontFallbacks::from_fonts(fonts))
}

fn cjk_families() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &["PingFang SC"]
    }
    #[cfg(windows)]
    {
        &["Microsoft YaHei"]
    }
    #[cfg(target_os = "linux")]
    {
        &["Noto Sans CJK SC", "Source Han Sans SC", "Noto Sans CJK"]
    }
    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        &[]
    }
}

fn system_locale() -> Option<String> {
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    CACHED.get_or_init(detect_system_locale).clone()
}

#[cfg(target_os = "macos")]
fn detect_system_locale() -> Option<String> {
    use std::ffi::c_void;
    use std::os::raw::c_char;
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFLocaleCopyPreferredLanguages() -> *const c_void;
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, idx: isize) -> *const c_void;
        fn CFStringGetCString(s: *const c_void, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFRelease(cf: *const c_void);
    }
    const UTF8: u32 = 0x0800_0100;
    unsafe {
        let langs = CFLocaleCopyPreferredLanguages();
        if langs.is_null() {
            return None;
        }
        let count = CFArrayGetCount(langs);
        if count <= 0 {
            CFRelease(langs);
            return None;
        }
        let s = CFArrayGetValueAtIndex(langs, 0);
        let mut buf = [0u8; 128];
        let ok = CFStringGetCString(s, buf.as_mut_ptr().cast(), buf.len() as isize, UTF8);
        CFRelease(langs);
        if ok == 0 {
            return None;
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        let bytes = buf[..end].to_vec();
        String::from_utf8(bytes).ok()
    }
}

#[cfg(windows)]
fn detect_system_locale() -> Option<String> {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    let mut buf = [0u16; 85];
    let n = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
    if n <= 1 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..n as usize - 1]))
}

#[cfg(all(not(target_os = "macos"), not(windows)))]
fn detect_system_locale() -> Option<String> {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        let Ok(value) = std::env::var(key) else { continue };
        let tag = value.split(['.', '@']).next().unwrap_or("").trim();
        if !tag.is_empty() && tag != "C" && tag != "POSIX" {
            return Some(tag.replace('_', "-"));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn catalogs_share_keys_and_are_flat_strings() {
        let (en, zh) = catalogs();
        assert!(!en.is_empty(), "en.json is empty or not a string map");
        let missing: Vec<_> = en.keys().filter(|k| !zh.contains_key(k.as_str())).collect();
        let extra: Vec<_> = zh.keys().filter(|k| !en.contains_key(k.as_str())).collect();
        assert!(missing.is_empty() && extra.is_empty(), "locale keys differ\nmissing in zh-CN: {missing:?}\nextra in zh-CN: {extra:?}");
    }

    #[test]
    fn missing_key_falls_back_to_english_then_the_key() {
        assert_eq!(translate("zh-CN", "not.a.key", None), "not.a.key");
        assert_eq!(translate("en", "setup.needs_core", None), "Herdr needs herdr-core");
        assert!(translate("zh-CN", "setup.needs_core", None).contains("herdr-core"));
        assert_ne!(translate("zh-CN", "setup.needs_core", None), "setup.needs_core");
    }

    #[test]
    fn interpolation_replaces_named_braces_and_leaves_the_rest() {
        let vars = json!({"have": "0.1.0", "need": 2, "skip": {"no": true}});
        assert_eq!(
            translate("en", "setup.too_old_body", Some(&vars)),
            "Yours is 0.1.0; this Herdr needs 2 or newer. Updating keeps your terminals running."
        );
        assert_eq!(translate("en", "setup.needs_core", Some(&json!({"have": "x"}))), "Herdr needs herdr-core");
        assert!(translate("en", "setup.too_old_body", None).contains("{have}"));
    }

    #[test]
    fn language_follows_the_system_unless_settings_name_one() {
        assert_eq!(resolve_with(None, Some("zh-Hans-CN")), "zh-CN");
        assert_eq!(resolve_with(None, Some("zh_TW.UTF-8")), "zh-CN");
        assert_eq!(resolve_with(None, Some("zh")), "zh-CN");
        assert_eq!(resolve_with(None, Some("en_US.UTF-8")), "en");
        assert_eq!(resolve_with(None, Some("C")), "en");
        assert_eq!(resolve_with(None, None), "en");
        assert_eq!(resolve_with(Some("zh-CN"), Some("en")), "zh-CN");
        assert_eq!(resolve_with(Some("en"), Some("zh-CN")), "en");
        assert_eq!(resolve_with(Some("fr"), Some("zh-CN")), "en");
        assert_eq!(resolve_with(Some("  "), Some("zh-CN")), "zh-CN");
    }
}
