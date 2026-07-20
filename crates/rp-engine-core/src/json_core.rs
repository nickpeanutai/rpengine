use crate::js_error;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use wasm_bindgen::prelude::*;

const PROTOCOL: &str = "gemtavern.rp_engine";
const PROTOCOL_VERSION: i64 = 3;
const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;

pub(crate) fn parse_json(source: &str) -> Result<Value, String> {
    serde_json::from_str(source).map_err(|error| error.to_string())
}

fn utf16_cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub(crate) fn canonical_value(value: &Value) -> String {
    match value {
        Value::Array(values) => format!("[{}]", values.iter().map(canonical_value).collect::<Vec<_>>().join(",")),
        Value::Object(values) => {
            let mut keys: Vec<_> = values.keys().collect();
            keys.sort_by(|left, right| utf16_cmp(left, right));
            let fields = keys.into_iter().map(|key| {
                format!("{}:{}", serde_json::to_string(key).unwrap_or_default(), canonical_value(&values[key]))
            }).collect::<Vec<_>>().join(",");
            format!("{{{fields}}}")
        }
        _ => serde_json::to_string(value).unwrap_or_else(|_| "null".into()),
    }
}

#[wasm_bindgen]
pub fn canonical_json(source: &str) -> Result<String, JsError> {
    parse_json(source).map(|value| canonical_value(&value)).map_err(js_error)
}

#[wasm_bindgen]
pub fn canonical_hash(source: &str) -> Result<String, JsError> {
    let canonical = canonical_json(source)?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, String> {
    value.as_object().ok_or_else(|| format!("{path} must be an object."))
}

fn required_string(object: &Map<String, Value>, key: &str, path: &str) -> Result<(), String> {
    if object.get(key).and_then(Value::as_str).is_none() { return Err(format!("{path}.{key} must be a string.")); }
    Ok(())
}

fn string_array(value: Option<&Value>, path: &str) -> Result<(), String> {
    let values = value.and_then(Value::as_array).ok_or_else(|| format!("{path} must be an array of strings."))?;
    if values.iter().any(|value| !value.is_string()) { return Err(format!("{path} must be an array of strings.")); }
    Ok(())
}

fn optional_type(value: Option<&Value>, expected: &str, path: &str) -> Result<(), String> {
    let Some(value) = value else { return Ok(()); };
    let valid = match expected { "string" => value.is_string(), "number" => value.is_number(), "boolean" => value.is_boolean(), _ => false };
    if valid { Ok(()) } else { Err(format!("{path} must be a {expected}.")) }
}

pub(crate) fn validate_card_value(card: &Value) -> Result<(), String> {
    let root = object(card, "card")?;
    if root.get("spec").and_then(Value::as_str) != Some("chara_card_v2") { return Err("spec must be \"chara_card_v2\".".into()); }
    if root.get("spec_version").and_then(Value::as_str) != Some("2.0") { return Err("spec_version must be \"2.0\".".into()); }
    let data = object(root.get("data").ok_or("data must be an object.")?, "data")?;
    for field in ["name", "description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions", "creator", "character_version"] {
        required_string(data, field, "data")?;
    }
    if data.get("name").and_then(Value::as_str).unwrap_or_default().trim().is_empty() { return Err("data.name must not be empty.".into()); }
    string_array(data.get("alternate_greetings"), "data.alternate_greetings")?;
    string_array(data.get("tags"), "data.tags")?;
    object(data.get("extensions").ok_or("data.extensions must be an object.")?, "data.extensions")?;
    if let Some(book_value) = data.get("character_book") {
        let book = object(book_value, "data.character_book")?;
        for (field, expected) in [("name", "string"), ("description", "string"), ("scan_depth", "number"), ("token_budget", "number"), ("recursive_scanning", "boolean")] {
            optional_type(book.get(field), expected, &format!("data.character_book.{field}"))?;
        }
        object(book.get("extensions").ok_or("data.character_book.extensions must be an object.")?, "data.character_book.extensions")?;
        let entries = book.get("entries").and_then(Value::as_array).ok_or("data.character_book.entries must be an array.")?;
        for (index, entry_value) in entries.iter().enumerate() {
            let path = format!("data.character_book.entries[{index}]");
            let entry = object(entry_value, &path)?;
            string_array(entry.get("keys"), &format!("{path}.keys"))?;
            required_string(entry, "content", &path)?;
            object(entry.get("extensions").ok_or_else(|| format!("{path}.extensions must be an object."))?, &format!("{path}.extensions"))?;
            if !entry.get("enabled").is_some_and(Value::is_boolean) { return Err(format!("{path}.enabled must be a boolean.")); }
            if !entry.get("insertion_order").is_some_and(Value::is_number) { return Err(format!("{path}.insertion_order must be a number.")); }
            for (field, expected) in [("case_sensitive", "boolean"), ("name", "string"), ("priority", "number"), ("id", "number"), ("comment", "string"), ("selective", "boolean"), ("constant", "boolean")] {
                optional_type(entry.get(field), expected, &format!("{path}.{field}"))?;
            }
            if entry.contains_key("secondary_keys") { string_array(entry.get("secondary_keys"), &format!("{path}.secondary_keys"))?; }
            if let Some(position) = entry.get("position") {
                if position.as_str() != Some("before_char") && position.as_str() != Some("after_char") { return Err(format!("{path}.position must be before_char or after_char.")); }
            }
        }
    }
    Ok(())
}

#[wasm_bindgen]
pub fn validate_character_card(source: &str) -> Result<(), JsError> {
    let value = parse_json(source).map_err(js_error)?;
    validate_card_value(&value).map_err(|error| js_error(format!("Invalid Character Card V2: {error}")))
}

fn pointer_tokens(pointer: &str) -> Result<Vec<String>, String> {
    if pointer.is_empty() { return Ok(Vec::new()); }
    if !pointer.starts_with('/') { return Err("Invalid JSON Pointer.".into()); }
    Ok(pointer[1..].split('/').map(|token| token.replace("~1", "/").replace("~0", "~")).collect())
}

fn array_index(token: &str, length: usize, allow_end: bool) -> Result<usize, String> {
    if token.is_empty() || (token.len() > 1 && token.starts_with('0')) { return Err("JSON Patch array index is out of range.".into()); }
    let value = token.parse::<usize>().map_err(|_| "JSON Patch array index is out of range.".to_string())?;
    if value > length || (!allow_end && value == length) { return Err("JSON Patch array index is out of range.".into()); }
    Ok(value)
}

fn read_pointer<'a>(root: &'a Value, path: &str) -> Result<&'a Value, String> {
    let mut current = root;
    for token in pointer_tokens(path)? {
        current = match current {
            Value::Array(values) => values.get(array_index(&token, values.len(), false)?).ok_or("JSON Patch path does not exist.")?,
            Value::Object(values) => values.get(&token).ok_or("JSON Patch path does not exist.")?,
            _ => return Err("JSON Patch path does not exist.".into()),
        };
    }
    Ok(current)
}

fn parent_mut<'a>(root: &'a mut Value, path: &str) -> Result<(&'a mut Value, String), String> {
    let tokens = pointer_tokens(path)?;
    let key = tokens.last().cloned().ok_or("Invalid JSON Patch path.")?;
    let mut current = root;
    for token in &tokens[..tokens.len() - 1] {
        current = match current {
            Value::Array(values) => {
                let length = values.len();
                let index = array_index(token, length, false)?;
                values.get_mut(index).ok_or("JSON Patch path does not exist.")?
            }
            Value::Object(values) => values.get_mut(token).ok_or("JSON Patch path does not exist.")?,
            _ => return Err("JSON Patch parent is not a container.".into()),
        };
    }
    Ok((current, key))
}

fn set_pointer(root: &mut Value, path: &str, value: Value, replace: bool) -> Result<(), String> {
    if path.is_empty() { *root = value; return Ok(()); }
    let (parent, key) = parent_mut(root, path)?;
    match parent {
        Value::Array(values) => {
            if key == "-" && !replace { values.push(value); return Ok(()); }
            let index = array_index(&key, values.len(), !replace)?;
            if replace { values[index] = value; } else { values.insert(index, value); }
        }
        Value::Object(values) => {
            if replace && !values.contains_key(&key) { return Err("JSON Patch replace path does not exist.".into()); }
            values.insert(key, value);
        }
        _ => return Err("JSON Patch parent is not a container.".into()),
    }
    Ok(())
}

fn remove_pointer(root: &mut Value, path: &str) -> Result<Value, String> {
    if path.is_empty() { return Ok(std::mem::replace(root, Value::Null)); }
    let (parent, key) = parent_mut(root, path)?;
    match parent {
        Value::Array(values) => Ok(values.remove(array_index(&key, values.len(), false)?)),
        Value::Object(values) => values.remove(&key).ok_or("JSON Patch remove path does not exist.".into()),
        _ => Err("JSON Patch parent is not a container.".into()),
    }
}

pub(crate) fn apply_patch_value(mut root: Value, operations: &[Value]) -> Result<Value, String> {
    for operation in operations {
        let object = operation.as_object().ok_or("JSON Patch operation must be an object.")?;
        let op = object.get("op").and_then(Value::as_str).ok_or("JSON Patch operation is missing op.")?;
        let path = object.get("path").and_then(Value::as_str).ok_or("JSON Patch operation is missing path.")?;
        match op {
            "add" | "replace" => set_pointer(&mut root, path, object.get("value").cloned().ok_or("JSON Patch operation is missing value.")?, op == "replace")?,
            "remove" => { remove_pointer(&mut root, path)?; }
            "copy" => {
                let from = object.get("from").and_then(Value::as_str).ok_or("JSON Patch operation is missing from.")?;
                let value = read_pointer(&root, from)?.clone();
                set_pointer(&mut root, path, value, false)?;
            }
            "move" => {
                let from = object.get("from").and_then(Value::as_str).ok_or("JSON Patch operation is missing from.")?;
                let value = remove_pointer(&mut root, from)?;
                set_pointer(&mut root, path, value, false)?;
            }
            "test" => {
                let expected = object.get("value").ok_or("JSON Patch operation is missing value.")?;
                if canonical_value(read_pointer(&root, path)?) != canonical_value(expected) { return Err("JSON Patch test failed.".into()); }
            }
            _ => return Err("Unsupported JSON Patch operation.".into()),
        }
    }
    Ok(root)
}

#[wasm_bindgen]
pub fn apply_json_patch(source: &str, operations: &str) -> Result<String, JsError> {
    let root = parse_json(source).map_err(js_error)?;
    let ops = parse_json(operations).map_err(js_error)?;
    let operations = ops.as_array().ok_or_else(|| js_error("JSON Patch operations must be an array."))?;
    serde_json::to_string(&apply_patch_value(root, operations).map_err(js_error)?).map_err(js_error)
}

fn req_string(value: &Map<String, Value>, key: &str) -> Result<(), String> {
    if value.get(key).and_then(Value::as_str).is_some_and(|value| !value.is_empty()) { Ok(()) } else { Err(format!("Missing RPEngine {key}.")) }
}

fn validate_card_transfer(value: Option<&Value>) -> Result<(), String> {
    let card = value.and_then(Value::as_object).ok_or("Missing character card transfer descriptor.")?;
    if card.get("format").and_then(Value::as_str) != Some("chara_card_v2") { return Err("Only chara_card_v2 is supported.".into()); }
    let mode = card.get("mode").and_then(Value::as_str).unwrap_or_default();
    if !["snapshot", "patch", "reference"].contains(&mode) { return Err("Invalid character card transfer mode.".into()); }
    if mode == "snapshot" && !card.get("snapshot").is_some_and(Value::is_object) { return Err("A snapshot transfer requires a card object.".into()); }
    if mode != "snapshot" { req_string(card, "targetHash")?; }
    if mode == "patch" { req_string(card, "baseHash")?; if !card.get("patch").is_some_and(Value::is_array) { return Err("A patch transfer requires RFC 6902 operations.".into()); } }
    Ok(())
}

fn validate_output(value: Option<&Value>) -> Result<(), String> {
    let output = value.and_then(Value::as_object).ok_or("reply.request requires output parameters.")?;
    let modalities = output.get("modalities").and_then(Value::as_array).ok_or("reply.request output.modalities must include text and may include audio.")?;
    if modalities.is_empty() || modalities.iter().any(|value| !matches!(value.as_str(), Some("text" | "audio"))) || !modalities.iter().any(|value| value.as_str() == Some("text")) {
        return Err("reply.request output.modalities must include text and may include audio.".into());
    }
    let mut names = modalities.iter().filter_map(Value::as_str).collect::<Vec<_>>(); names.sort_unstable(); names.dedup();
    if names.len() != modalities.len() { return Err("reply.request output.modalities cannot contain duplicates.".into()); }
    let wants_audio = modalities.iter().any(|value| value.as_str() == Some("audio"));
    if wants_audio {
        let audio = output.get("audio").and_then(Value::as_object).ok_or("Audio output requires a Supertonic 3 model and voice descriptor.")?;
        if audio.get("model").and_then(Value::as_str) != Some("gemtavern-supertonic-3") || audio.get("voice").and_then(Value::as_str).unwrap_or_default().trim().is_empty() { return Err("Audio output requires a Supertonic 3 model and voice descriptor.".into()); }
        if audio.get("format").is_some_and(|value| value.as_str() != Some("pcm_s16le")) { return Err("Unsupported audio output format.".into()); }
    } else if output.contains_key("audio") { return Err("output.audio requires the audio modality.".into()); }
    if output.get("language").and_then(Value::as_str).unwrap_or_default().trim().is_empty() { return Err("reply.request output.language is required.".into()); }
    Ok(())
}

fn validate_prompt_context(envelope: &Map<String, Value>) -> Result<(), String> {
    let keys = ["interactionMode", "promptScene", "promptDirective"];
    let present = keys.iter().filter(|key| envelope.contains_key(**key)).count();
    if present == 0 { return Ok(()); }
    if present != keys.len() { return Err("Prompt context requires interactionMode, promptScene, and promptDirective together.".into()); }
    if !matches!(envelope.get("interactionMode").and_then(Value::as_str), Some("auto_event" | "direct_user")) { return Err("Unsupported interactionMode.".into()); }
    let scene = envelope.get("promptScene").and_then(Value::as_object).ok_or("promptScene must be an object.")?;
    for key in ["kind", "family", "label", "sceneLine"] { req_string(scene, key)?; }
    if !scene.get("priority").and_then(Value::as_f64).is_some_and(f64::is_finite) { return Err("promptScene.priority must be a finite number.".into()); }
    let directive = envelope.get("promptDirective").and_then(Value::as_object).ok_or("promptDirective must be an object.")?;
    if directive.get("protocolVersion").and_then(Value::as_i64).is_none_or(|value| value < 1) { return Err("promptDirective.protocolVersion must be a positive integer.".into()); }
    for key in ["sceneContext", "autoEventGuide", "directUserGuide"] { req_string(directive, key)?; }
    if directive.get("promptVersion").is_some_and(|value| value.as_str().unwrap_or_default().trim().is_empty()) { return Err("promptDirective.promptVersion must be a non-empty string when present.".into()); }
    Ok(())
}

pub(crate) fn validate_envelope_value(value: &Value) -> Result<(), String> {
    let envelope = value.as_object().ok_or("RPEngine payload must be an object.")?;
    if envelope.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) { return Err("Unsupported RPEngine protocol.".into()); }
    if envelope.get("protocolVersion").and_then(Value::as_i64) != Some(PROTOCOL_VERSION) { return Err("Unsupported RPEngine protocol version.".into()); }
    for key in ["type", "messageId", "timestamp"] { req_string(envelope, key)?; }
    match envelope.get("type").and_then(Value::as_str).unwrap_or_default() {
        "character.sync" => { req_string(envelope, "integrationId")?; req_string(envelope, "characterId")?; validate_card_transfer(envelope.get("card"))?; }
        "reply.request" => {
            for key in ["requestId", "eventId", "integrationId", "characterId"] { req_string(envelope, key)?; }
            let event = envelope.get("event").and_then(Value::as_object).ok_or("reply.request requires event.text, event.audio, or both.")?;
            let text = event.get("text");
            let audio = event.get("audio").and_then(Value::as_object);
            if text.and_then(Value::as_str).is_none_or(|value| value.trim().is_empty()) && audio.is_none() { return Err("reply.request requires event.text, event.audio, or both.".into()); }
            if text.is_some_and(|value| !value.is_string()) { return Err("event.text must be a string.".into()); }
            if let Some(audio) = audio {
                if !matches!(audio.get("format").and_then(Value::as_str), Some("pcm_s16le" | "pcm_f32le")) { return Err("Audio input must use pcm_s16le or pcm_f32le.".into()); }
                if audio.get("sampleRate").and_then(Value::as_i64) != Some(16000) || audio.get("channels").and_then(Value::as_i64) != Some(1) { return Err("Audio input must be 16 kHz mono PCM.".into()); }
                if audio.get("data").and_then(Value::as_str).unwrap_or_default().is_empty() { return Err("Audio input requires base64 data.".into()); }
                if audio.get("language").is_some_and(|value| !["en", "ar", "es", "ja", "ko", "vi", "uk", "zh"].contains(&value.as_str().unwrap_or_default())) { return Err("Unsupported Moonshine input language.".into()); }
            }
            validate_output(envelope.get("output"))?; validate_card_transfer(envelope.get("card"))?; validate_prompt_context(envelope)?;
        }
        "voice.capture.start" => { for key in ["requestId", "eventId", "integrationId", "characterId"] { req_string(envelope, key)?; } if envelope.get("returnTranscript").is_some_and(|value| !value.is_boolean()) { return Err("returnTranscript must be a boolean.".into()); } if envelope.get("silenceBehavior").is_some_and(|value| !matches!(value.as_str(), Some("error" | "restart"))) { return Err("silenceBehavior must be \"error\" or \"restart\".".into()); } validate_output(envelope.get("output"))?; validate_card_transfer(envelope.get("card"))?; validate_prompt_context(envelope)?; }
        "voice.capture.stop" | "voice.capture.cancel" | "request.cancel" => req_string(envelope, "requestId")?,
        _ => {}
    }
    Ok(())
}

#[wasm_bindgen]
pub fn decode_envelope(raw: &str) -> Result<String, JsError> {
    if raw.len() > MAX_MESSAGE_BYTES { return Err(js_error("RPEngine message exceeds 8 MiB.")); }
    let value = parse_json(raw).map_err(js_error)?;
    validate_envelope_value(&value).map_err(js_error)?;
    serde_json::to_string(&value).map_err(js_error)
}

#[wasm_bindgen]
pub fn valid_rp_engine_port(port: f64) -> bool { port.fract() == 0.0 && (1024.0..=65535.0).contains(&port) }

#[wasm_bindgen]
pub fn loopback_endpoint(port: f64) -> Result<String, JsError> {
    if !valid_rp_engine_port(port) { return Err(js_error("The RPEngine port must be between 1024 and 65535.")); }
    Ok(format!("ws://127.0.0.1:{}/rp-engine/socket", port as u32))
}

#[wasm_bindgen]
pub fn connection_port_from_fragment(fragment: &str) -> Result<f64, JsError> {
    let mut found = None;
    for part in fragment.trim_start_matches('#').split('&') {
        let mut pair = part.splitn(2, '=');
        if pair.next() == Some("port") { found = pair.next(); break; }
    }
    let Some(value) = found else { return Ok(f64::NAN); };
    let port = value.parse::<f64>().unwrap_or(f64::NAN);
    if !valid_rp_engine_port(port) { return Err(js_error("The RPEngine port must be between 1024 and 65535.")); }
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_objects() {
        assert_eq!(canonical_json(r#"{"b":2,"a":[true,null]}"#).unwrap(), r#"{"a":[true,null],"b":2}"#);
    }

    #[test]
    fn patches_arrays() {
        assert_eq!(apply_json_patch(r#"{"a":[1,2]}"#, r#"[{"op":"add","path":"/a/1","value":3}]"#).unwrap(), r#"{"a":[1,3,2]}"#);
    }

    #[test]
    fn validates_ports() {
        assert!(valid_rp_engine_port(38471.0));
        assert!(!valid_rp_engine_port(80.0));
    }
}
