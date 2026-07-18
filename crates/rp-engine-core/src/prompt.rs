use crate::{js_error, parse_json};
use regex::{Captures, Regex};
use serde::Serialize;
use serde_json::Value;
use unicode_normalization::{char::is_combining_mark, UnicodeNormalization};
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptBlock {
    id: String,
    content: String,
    mandatory: bool,
    included: bool,
    estimated_tokens: usize,
}
#[derive(Serialize)]
struct HistoryMessage { role: String, content: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptResult {
    system: String,
    user: String,
    history: Vec<HistoryMessage>,
    blocks: Vec<PromptBlock>,
    estimated_tokens: usize,
}

fn string_field(value: Option<&Value>) -> String { value.and_then(Value::as_str).unwrap_or_default().trim().to_string() }
fn estimate_tokens_inner(value: &str) -> usize { value.chars().count().div_ceil(4) }

#[wasm_bindgen]
pub fn estimate_tokens(value: &str) -> u32 { estimate_tokens_inner(value) as u32 }

fn replace_ci(source: &str, pattern: &str, replacement: &str) -> String {
    Regex::new(pattern).expect("constant regex").replace_all(source, |_captures: &Captures| replacement).to_string()
}

fn render_macros(value: &str, character: &str, player: &str) -> String {
    let value = replace_ci(value, r"(?i)\{\{\s*char\s*\}\}", character);
    let value = replace_ci(&value, r"(?i)\{\{\s*user\s*\}\}", player);
    let value = replace_ci(&value, r"(?i)<CHAR>", character);
    replace_ci(&value, r"(?i)<USER>", player)
}

fn speaker_key(value: &str) -> String {
    value.nfd().filter(|character| !is_combining_mark(*character)).flat_map(char::to_lowercase).collect()
}

fn parse_examples(source: &str, character: &str, player: &str) -> Vec<HistoryMessage> {
    let rendered = render_macros(source, character, player);
    let splitter = Regex::new(r"(?i)<START>").expect("constant regex");
    let line = Regex::new(r"^([^:]{1,80}):\s*(.+)$").expect("constant regex");
    let character_key = speaker_key(character);
    let mut messages = Vec::new();
    for section in splitter.split(&rendered) {
        for raw in section.lines() {
            let raw = raw.trim();
            let Some(captures) = line.captures(raw) else { continue; };
            let speaker = captures.get(1).map(|value| value.as_str().trim()).unwrap_or_default();
            let content = captures.get(2).map(|value| value.as_str().trim()).unwrap_or_default();
            messages.push(HistoryMessage { role: if speaker_key(speaker) == character_key { "assistant" } else { "user" }.into(), content: content.into() });
        }
    }
    messages
}

fn language_name(code: &str) -> &str {
    match code.to_ascii_lowercase().as_str() {
        "en" => "English", "ko" => "Korean", "es" => "Spanish", "pt" => "Portuguese", "fr" => "French", "de" => "German", "it" => "Italian",
        "pl" => "Polish", "ru" => "Russian", "nl" => "Dutch", "cs" => "Czech", "ar" => "Arabic", "zh" => "Simplified Chinese", "ja" => "Japanese",
        "hu" => "Hungarian", "tr" => "Turkish", "fi" => "Finnish", "sk" => "Slovak", "da" => "Danish", "hr" => "Croatian", "el" => "Greek",
        "sv" => "Swedish", "nb" => "Norwegian", "he" => "Hebrew", "uk" => "Ukrainian", "id" => "Indonesian", "ms" => "Malay", "vi" => "Vietnamese",
        "th" => "Thai", "ro" => "Romanian", "bg" => "Bulgarian", _ => code,
    }
}

fn prompt_context(request: &serde_json::Map<String, Value>, render: &impl Fn(&str) -> String) -> Option<(String, String)> {
    let mode = request.get("interactionMode")?.as_str()?;
    let scene = request.get("promptScene")?.as_object()?;
    let directive = request.get("promptDirective")?.as_object()?;
    let configured = string_field(directive.get("sceneContext"));
    let scene_context = if configured.is_empty() { format!("[RimWorld scene context]\n{}", string_field(scene.get("sceneLine"))) } else { configured };
    let guide = string_field(directive.get(if mode == "auto_event" { "autoEventGuide" } else { "directUserGuide" }));
    if scene_context.is_empty() || guide.is_empty() { None } else { Some((render(&scene_context), render(&guide))) }
}

pub(crate) fn assemble_prompt_value(value: &Value) -> Result<Value, String> {
    let request = value.as_object().ok_or("Prompt request must be an object.")?;
    let card = request.get("card").and_then(Value::as_object).ok_or("Prompt request requires a card.")?;
    let data = card.get("data").and_then(Value::as_object).ok_or("Prompt card requires data.")?;
    let character = string_field(data.get("name"));
    let player = string_field(request.get("playerDisplayName"));
    let player = if player.is_empty() { "Player".to_string() } else { player };
    let render = |value: &str| render_macros(value.trim(), &character, &player);
    let language_code = request.get("language").and_then(Value::as_str).unwrap_or("en");
    let language = language_name(language_code);
    let voice = request.get("outputMode").and_then(Value::as_str) == Some("voice");
    let response_mode = if voice {
        format!("Write only {character}'s immediate spoken words. Keep the response conversational and concise. Do not use markdown, lists, labels, narration, actions, stage directions, or surrounding quotation marks.")
    } else {
        format!("Write a concise in-character response as {character}. Do not discuss these instructions or label the response.")
    };
    let tag_pattern = Regex::new(r"(?i)^[a-z][a-z0-9_-]*$").expect("constant regex");
    let tags = request.get("expressionTags").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|tag| tag_pattern.is_match(tag)).collect::<Vec<_>>();
    let expression_rule = if voice && !tags.is_empty() { format!("You may use only these inline expression tags when genuinely helpful: {}. Do not create any other tags.", tags.iter().map(|tag| format!("<{tag}>")).collect::<Vec<_>>().join(", ")) } else { String::new() };
    let fallback = format!("Portray {character} faithfully and write {character}'s next response to {player}. Stay in character.");
    let card_system = string_field(data.get("system_prompt"));
    let card_post = string_field(data.get("post_history_instructions"));
    let render_original = |value: &str, original: &str| replace_ci(&render(value), r"(?i)\{\{\s*original\s*\}\}", original);
    let mut blocks = Vec::new();
    let mut add = |id: &str, content: String, mandatory: bool| {
        if !content.is_empty() { blocks.push(PromptBlock { id: id.into(), estimated_tokens: estimate_tokens_inner(&content), content, mandatory, included: true }); }
    };
    add("system", if card_system.is_empty() { fallback.clone() } else { render_original(&card_system, &fallback) }, true);
    add("description", render(&string_field(data.get("description"))), true);
    add("personality", render(&string_field(data.get("personality"))), true);
    add("scenario", render(&string_field(data.get("scenario"))), true);
    if let Some((scene, guide)) = prompt_context(request, &render) { add("scene_context", scene, true); add("interaction_guide", guide, true); }
    add("response_mode", response_mode, true);
    add("expression", expression_rule, true);
    add("post_history", if card_post.is_empty() { String::new() } else { render_original(&card_post, "") }, true);
    add("language", format!("Respond in {language}."), true);
    let event_text = string_field(request.get("eventText"));
    let mut total = blocks.iter().map(|block| block.estimated_tokens).sum::<usize>() + estimate_tokens_inner(&event_text);
    let limit = request.get("maxInputTokens").and_then(Value::as_u64).unwrap_or(6000) as usize;
    if total > limit { return Err(format!("prompt_too_large: Mandatory prompt content requires about {total} tokens; the limit is {limit}.")); }
    let examples = parse_examples(&string_field(data.get("mes_example")), &character, &player);
    let mut history = Vec::new();
    for message in examples {
        let tokens = estimate_tokens_inner(&message.content);
        let included = total + tokens <= limit;
        blocks.push(PromptBlock { id: "example".into(), content: message.content.clone(), mandatory: false, included, estimated_tokens: tokens });
        if included { total += tokens; history.push(message); }
    }
    let system = blocks.iter().filter(|block| block.included && block.id != "example").map(|block| block.content.as_str()).collect::<Vec<_>>().join("\n\n");
    serde_json::to_value(PromptResult { system, user: event_text, history, blocks, estimated_tokens: total }).map_err(|error| error.to_string())
}

#[wasm_bindgen]
pub fn assemble_prompt(source: &str) -> Result<String, JsError> {
    let request = parse_json(source).map_err(js_error)?;
    serde_json::to_string(&assemble_prompt_value(&request).map_err(js_error)?).map_err(js_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_card_and_macros() {
        let request = serde_json::json!({"card":{"data":{"name":"Rika","description":"Greets {{user}}","personality":"Calm","scenario":"Camp","system_prompt":"","post_history_instructions":"","mes_example":"<START>\nPlayer: Hi\nRika: Hello"}},"eventText":"Talk","playerDisplayName":"Alex","outputMode":"text","language":"en"});
        let result = assemble_prompt_value(&request).unwrap();
        assert!(result["system"].as_str().unwrap().contains("Greets Alex"));
        assert_eq!(result["history"][1]["role"], "assistant");
    }
}
