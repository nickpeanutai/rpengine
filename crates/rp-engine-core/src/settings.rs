use wasm_bindgen::prelude::*;

const MOONSHINE: &[&str] = &["en", "ar", "es", "ja", "ko", "vi", "uk", "zh"];
const SUPERTONIC: &[&str] = &["en", "ko", "es", "pt", "fr", "de", "it", "pl", "ru", "nl", "cs", "ar", "zh", "ja", "hu", "tr", "fi", "sk", "da", "hr", "el", "sv", "nb", "he", "uk", "id", "ms", "vi", "th", "ro", "bg"];
const VOICES: &[&str] = &["M1", "M2", "M3", "M4", "M5", "F1", "F2", "F3", "F4", "F5"];

#[wasm_bindgen] pub fn valid_moonshine_language(value: &str) -> bool { MOONSHINE.contains(&value) }
#[wasm_bindgen] pub fn valid_supertonic_language(value: &str) -> bool { SUPERTONIC.contains(&value) }
#[wasm_bindgen] pub fn valid_voice(value: &str) -> bool { VOICES.contains(&value) }
#[wasm_bindgen] pub fn default_moonshine_language(locale: &str) -> String {
    let prefix = locale.split(['-', '_']).next().unwrap_or_default().to_ascii_lowercase();
    if valid_moonshine_language(&prefix) { prefix } else { "en".into() }
}

#[cfg(test)] mod tests { use super::*; #[test] fn selects_locale() { assert_eq!(default_moonshine_language("zh-CN"), "zh"); assert_eq!(default_moonshine_language("fr-FR"), "en"); } }
