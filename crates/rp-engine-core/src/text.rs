use crate::js_error;
use icu_segmenter::{options::SentenceBreakInvariantOptions, SentenceSegmenter};
use regex::{Regex, RegexBuilder};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

const MAX_RESPONSE_PROCESSING_RULES: usize = 8;
const MAX_RESPONSE_PATTERN_BYTES: usize = 1024;
const MAX_RESPONSE_CAPTURE_GROUPS: usize = 16;
const MAX_RESPONSE_MATCHES: usize = 64;
const MAX_RESPONSE_CAPTURE_BYTES: usize = 4096;

pub(crate) fn display_text_inner(source: &str) -> String {
    let mut output = String::new();
    let mut in_tag = false;
    for character in source.chars() {
        match character {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => output.push(character),
            _ => {}
        }
    }
    output
}

#[derive(Clone, Copy)]
enum ResponseOccurrence { First, Last, All }

#[derive(Clone, Copy)]
enum ResponseRemoval { Match, Capture, None }

#[derive(Clone)]
struct ResponseProcessingRule {
    id: String,
    matcher: Regex,
    capture_group: usize,
    occurrence: ResponseOccurrence,
    removal: ResponseRemoval,
    remove_from_text: bool,
    remove_from_audio: bool,
}

#[derive(Clone)]
pub(crate) struct ResponseProcessing { rules: Vec<ResponseProcessingRule> }

pub(crate) struct ProcessedResponse {
    pub(crate) text: String,
    pub(crate) audio: String,
    pub(crate) extracted: Value,
}

fn response_field(value: &Map<String, Value>, key: &str) -> Result<String, String> {
    value.get(key).and_then(Value::as_str).map(str::to_string).ok_or_else(|| format!("responseProcessing rule requires {key}."))
}

fn valid_response_rule_id(id: &str) -> bool {
    let mut characters = id.chars();
    characters.next().is_some_and(|value| value.is_ascii_lowercase())
        && id.len() <= 64
        && characters.all(|value| value.is_ascii_lowercase() || value.is_ascii_digit() || matches!(value, '_' | '.' | '-'))
}

pub(crate) fn parse_response_processing(value: Option<&Value>) -> Result<Option<ResponseProcessing>, String> {
    let Some(value) = value else { return Ok(None); };
    let processing = value.as_object().ok_or("output.responseProcessing must be an object.")?;
    if processing.get("mode").and_then(Value::as_str) != Some("buffered") { return Err("output.responseProcessing.mode must be \"buffered\".".into()); }
    let rules = processing.get("rules").and_then(Value::as_array).ok_or("output.responseProcessing.rules must be an array.")?;
    if rules.is_empty() || rules.len() > MAX_RESPONSE_PROCESSING_RULES { return Err(format!("output.responseProcessing.rules must contain between 1 and {MAX_RESPONSE_PROCESSING_RULES} rules.")); }
    let mut ids = HashSet::new();
    let mut compiled = Vec::with_capacity(rules.len());
    for value in rules {
        let rule = value.as_object().ok_or("Each responseProcessing rule must be an object.")?;
        let id = response_field(rule, "id")?;
        if !valid_response_rule_id(&id) { return Err("responseProcessing rule id must match ^[a-z][a-z0-9_.-]{0,63}$.".into()); }
        if !ids.insert(id.clone()) { return Err(format!("Duplicate responseProcessing rule id: {id}.")); }
        let matcher = rule.get("matcher").and_then(Value::as_object).ok_or("responseProcessing rule requires matcher.")?;
        if matcher.get("type").and_then(Value::as_str) != Some("regex") { return Err("responseProcessing matcher.type must be \"regex\".".into()); }
        let pattern = response_field(matcher, "pattern")?;
        if pattern.is_empty() || pattern.len() > MAX_RESPONSE_PATTERN_BYTES { return Err(format!("responseProcessing regex pattern must contain between 1 and {MAX_RESPONSE_PATTERN_BYTES} bytes.")); }
        let flags = matcher.get("flags").and_then(Value::as_str).unwrap_or_default();
        if matcher.get("flags").is_some_and(|value| !value.is_string()) || flags.chars().any(|value| !matches!(value, 'i' | 'm' | 's')) {
            return Err("responseProcessing regex flags may only contain i, m, and s.".into());
        }
        let mut unique_flags = HashSet::new();
        if flags.chars().any(|value| !unique_flags.insert(value)) { return Err("responseProcessing regex flags cannot contain duplicates.".into()); }
        let mut builder = RegexBuilder::new(&pattern);
        builder.case_insensitive(flags.contains('i')).multi_line(flags.contains('m')).dot_matches_new_line(flags.contains('s'));
        let matcher = builder.build().map_err(|error| format!("Invalid responseProcessing regex for {id}: {error}"))?;
        if matcher.captures_len().saturating_sub(1) > MAX_RESPONSE_CAPTURE_GROUPS { return Err(format!("responseProcessing regex for {id} has more than {MAX_RESPONSE_CAPTURE_GROUPS} capture groups.")); }
        let capture_group = rule.get("captureGroup").and_then(Value::as_u64).ok_or("responseProcessing rule requires a non-negative integer captureGroup.")? as usize;
        if capture_group >= matcher.captures_len() { return Err(format!("responseProcessing captureGroup {capture_group} does not exist for {id}.")); }
        let occurrence = match response_field(rule, "occurrence")?.as_str() {
            "first" => ResponseOccurrence::First, "last" => ResponseOccurrence::Last, "all" => ResponseOccurrence::All,
            _ => return Err("responseProcessing occurrence must be first, last, or all.".into()),
        };
        let removal = match response_field(rule, "remove")?.as_str() {
            "match" => ResponseRemoval::Match, "capture" => ResponseRemoval::Capture, "none" => ResponseRemoval::None,
            _ => return Err("responseProcessing remove must be match, capture, or none.".into()),
        };
        let targets = rule.get("removeFrom").and_then(Value::as_array).ok_or("responseProcessing rule requires removeFrom.")?;
        let mut remove_from_text = false;
        let mut remove_from_audio = false;
        for target in targets {
            match target.as_str() {
                Some("text") if !remove_from_text => remove_from_text = true,
                Some("audio") if !remove_from_audio => remove_from_audio = true,
                Some("text" | "audio") => return Err("responseProcessing removeFrom cannot contain duplicates.".into()),
                _ => return Err("responseProcessing removeFrom may only contain text and audio.".into()),
            }
        }
        if matches!(removal, ResponseRemoval::None) && !targets.is_empty() { return Err("responseProcessing removeFrom must be empty when remove is none.".into()); }
        compiled.push(ResponseProcessingRule { id, matcher, capture_group, occurrence, removal, remove_from_text, remove_from_audio });
    }
    Ok(Some(ResponseProcessing { rules: compiled }))
}

fn selected_matches<'a>(rule: &ResponseProcessingRule, source: &'a str) -> Vec<regex::Captures<'a>> {
    match rule.occurrence {
        ResponseOccurrence::First => rule.matcher.captures_iter(source).take(1).collect(),
        ResponseOccurrence::Last => rule.matcher.captures_iter(source).last().into_iter().collect(),
        ResponseOccurrence::All => rule.matcher.captures_iter(source).take(MAX_RESPONSE_MATCHES).collect(),
    }
}

fn remove_spans(source: &str, spans: &mut Vec<(usize, usize)>) -> String {
    if spans.is_empty() { return source.to_string(); }
    spans.sort_unstable_by_key(|span| span.0);
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
    for &(start, end) in spans.iter() {
        if let Some(last) = merged.last_mut() {
            if start <= last.1 { last.1 = last.1.max(end); continue; }
        }
        merged.push((start, end));
    }
    let mut output = String::with_capacity(source.len());
    let mut offset = 0;
    for (start, end) in merged { output.push_str(&source[offset..start]); offset = end; }
    output.push_str(&source[offset..]);
    output
}

impl ResponseProcessing {
    pub(crate) fn process(&self, source: &str) -> ProcessedResponse {
        let mut extracted = Map::new();
        let mut text_spans = Vec::new();
        let mut audio_spans = Vec::new();
        for rule in &self.rules {
            let mut values = Vec::new();
            for captures in selected_matches(rule, source) {
                let complete = captures.get(0);
                let capture = captures.get(rule.capture_group);
                if let Some(value) = capture.filter(|value| value.as_str().len() <= MAX_RESPONSE_CAPTURE_BYTES) { values.push(Value::String(value.as_str().to_string())); }
                let removal = match rule.removal { ResponseRemoval::Match => complete, ResponseRemoval::Capture => capture, ResponseRemoval::None => None };
                if let Some(removal) = removal {
                    if rule.remove_from_text { text_spans.push((removal.start(), removal.end())); }
                    if rule.remove_from_audio { audio_spans.push((removal.start(), removal.end())); }
                }
            }
            extracted.insert(rule.id.clone(), Value::Array(values));
        }
        ProcessedResponse { text: remove_spans(source, &mut text_spans), audio: remove_spans(source, &mut audio_spans), extracted: Value::Object(extracted) }
    }

    pub(crate) fn diagnostic_rules(&self, extracted: &Value) -> Value {
        let extracted = extracted.as_object();
        Value::Array(self.rules.iter().map(|rule| {
            let match_count = extracted
                .and_then(|values| values.get(&rule.id))
                .and_then(Value::as_array)
                .map_or(0, Vec::len);
            let mut removed_from = Vec::new();
            if rule.remove_from_text { removed_from.push("text"); }
            if rule.remove_from_audio { removed_from.push("audio"); }
            json!({ "id":rule.id, "matchCount":match_count, "removedFrom":removed_from })
        }).collect())
    }
}

#[wasm_bindgen]
pub fn display_text(source: &str) -> String { display_text_inner(source) }

#[wasm_bindgen]
pub fn synthesis_text(source: &str, allowed_json: &str) -> Result<String, JsError> {
    synthesis_text_inner(source, allowed_json).map_err(js_error)
}

pub(crate) fn synthesis_text_inner(source: &str, allowed_json: &str) -> Result<String, String> {
    let allowed: Vec<String> = serde_json::from_str(allowed_json).map_err(|error| error.to_string())?;
    let allowed: HashSet<String> = allowed.into_iter().map(|value| value.to_ascii_lowercase()).collect();
    let characters: Vec<char> = source.chars().collect();
    let mut output = String::new();
    let mut index = 0;
    while index < characters.len() {
        if characters[index] == '<' {
            let end = characters[index + 1..].iter().position(|value| *value == '>').map(|value| index + 1 + value);
            if let Some(end) = end {
                let tag: String = characters[index + 1..end].iter().collect::<String>().trim().to_ascii_lowercase();
                if allowed.contains(&tag) { output.push('<'); output.push_str(&tag); output.push('>'); }
                index = end + 1;
                continue;
            }
            break;
        }
        if characters[index] != '>' { output.push(characters[index]); }
        index += 1;
    }
    Ok(output)
}

#[wasm_bindgen]
pub struct DisplayTextStreamCore { pending: String }

#[wasm_bindgen]
impl DisplayTextStreamCore {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self { Self { pending: String::new() } }

    pub fn push(&mut self, chunk: &str) -> String {
        let source = format!("{}{}", self.pending, chunk);
        let open = source.rfind('<');
        let close = source.rfind('>');
        if open.is_some() && (close.is_none() || open > close) {
            let index = open.unwrap_or(0);
            self.pending = source[index..].to_string();
            return display_text_inner(&source[..index]);
        }
        self.pending.clear();
        display_text_inner(&source)
    }

    pub fn finish(&mut self) -> String {
        let value = if self.pending.starts_with('<') { String::new() } else { display_text_inner(&self.pending) };
        self.pending.clear();
        value
    }
}

impl Default for DisplayTextStreamCore { fn default() -> Self { Self::new() } }

#[derive(Debug, Serialize)]
pub(crate) struct SpeechChunk { pub(crate) sequence: u32, pub(crate) text: String }

fn speakable(source: &str) -> bool { source.chars().any(char::is_alphanumeric) }

fn sentence_blocks(source: &str, final_chunk: bool) -> Vec<(String, usize)> {
    if source.trim().is_empty() { return Vec::new(); }
    let segmenter = SentenceSegmenter::new(SentenceBreakInvariantOptions::default());
    let boundaries = segmenter.segment_str(source).collect::<Vec<_>>();
    let mut blocks = Vec::new();
    for boundary in boundaries.windows(2) {
        let start = boundary[0];
        let end = boundary[1];
        let segment = source[start..end].to_string();
        if speakable(&segment) { blocks.push((segment, end)); }
    }
    if !final_chunk { blocks.pop(); }
    blocks
}

#[wasm_bindgen]
pub struct SpeechChunkerCore { consumed_offset: usize, consumed_prefix: String, sequence: u32, minimum: usize }

#[wasm_bindgen]
impl SpeechChunkerCore {
    #[wasm_bindgen(constructor)]
    pub fn new(minimum_chunk_characters: u32) -> Self { Self { consumed_offset: 0, consumed_prefix: String::new(), sequence: 0, minimum: minimum_chunk_characters as usize } }

    pub fn update(&mut self, text: &str, final_chunk: bool) -> Result<String, JsError> {
        let chunks = self.update_inner(text, final_chunk).map_err(js_error)?;
        serde_json::to_string(&chunks).map_err(js_error)
    }

    pub fn reset(&mut self) { self.consumed_offset = 0; self.consumed_prefix.clear(); self.sequence = 0; }
}

impl SpeechChunkerCore {
    pub(crate) fn update_inner(&mut self, text: &str, final_chunk: bool) -> Result<Vec<SpeechChunk>, String> {
        if !text.starts_with(&self.consumed_prefix) { return Err("The generated text changed after an earlier sentence was already sent to speech synthesis.".into()); }
        if self.consumed_offset != self.consumed_prefix.len() || !text.is_char_boundary(self.consumed_offset) { return Err("The speech stream's consumed text position is invalid.".into()); }
        let suffix = &text[self.consumed_offset..];
        let sentences = sentence_blocks(suffix, final_chunk);
        let mut chunks = Vec::new();
        let mut packed = String::new();
        let mut packed_end = self.consumed_offset;
        for (sentence, end) in &sentences {
            packed_end = self.consumed_offset + *end;
            let trimmed = sentence.trim();
            if !speakable(trimmed) { continue; }
            if !packed.is_empty() { packed.push_str("\n\n"); }
            packed.push_str(trimmed);
            if packed.chars().count() >= self.minimum {
                chunks.push(SpeechChunk { sequence: self.sequence, text: std::mem::take(&mut packed) });
                self.sequence += 1;
            }
        }
        if final_chunk && speakable(&packed) { chunks.push(SpeechChunk { sequence: self.sequence, text: packed }); self.sequence += 1; }
        if !sentences.is_empty() { self.consumed_offset = packed_end; self.consumed_prefix = text[..self.consumed_offset].to_string(); }
        Ok(chunks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn hides_tags() { assert_eq!(display_text("Hi <laugh>there"), "Hi there"); }
    #[test] fn streams_incomplete_tags() { let mut stream = DisplayTextStreamCore::new(); assert_eq!(stream.push("Hi <la"), "Hi "); assert_eq!(stream.push("ugh>there"), "there"); }
    #[test] fn response_processing_extracts_and_removes_selected_matches() {
        let config = serde_json::json!({"mode":"buffered","rules":[{"id":"emotion","matcher":{"type":"regex","pattern":"<([a-z][a-z0-9_]{0,63})>\\s*$"},"captureGroup":1,"occurrence":"last","remove":"match","removeFrom":["text","audio"]}]});
        let processing = parse_response_processing(Some(&config)).unwrap().unwrap();
        let processed = processing.process("Keep moving.<fear_anxious>  \n");
        assert_eq!(processed.text, "Keep moving.");
        assert_eq!(processed.audio, "Keep moving.");
        assert_eq!(processed.extracted["emotion"], serde_json::json!(["fear_anxious"]));
    }
    #[test] fn response_processing_merges_overlapping_removals_and_supports_unicode() {
        let config = serde_json::json!({"mode":"buffered","rules":[
            {"id":"outer","matcher":{"type":"regex","pattern":"控制：\\[([^]]+)\\]"},"captureGroup":1,"occurrence":"all","remove":"match","removeFrom":["text"]},
            {"id":"inner","matcher":{"type":"regex","pattern":"\\[([^]]+)\\]"},"captureGroup":1,"occurrence":"all","remove":"capture","removeFrom":["text"]}
        ]});
        let processed = parse_response_processing(Some(&config)).unwrap().unwrap().process("你好。控制：[撤退]继续。控制：[躲藏]");
        assert_eq!(processed.text, "你好。继续。");
        assert_eq!(processed.extracted["outer"], serde_json::json!(["撤退", "躲藏"]));
        assert_eq!(processed.extracted["inner"], serde_json::json!(["撤退", "躲藏"]));
    }
    #[test] fn chunks_complete_sentences() { let mut chunker = SpeechChunkerCore::new(1); assert_eq!(chunker.update("Hi. Next", false).unwrap(), r#"[{"sequence":0,"text":"Hi."}]"#); }
    #[test] fn icu_keeps_decimal_periods_inside_sentences() { let blocks = sentence_blocks("The value is 3.14 today. Next sentence", true); assert_eq!(blocks.iter().map(|value| value.0.trim()).collect::<Vec<_>>(), vec!["The value is 3.14 today.", "Next sentence"]); }
    #[test] fn icu_handles_multilingual_boundaries_and_quotes() { let blocks = sentence_blocks("他说：“你好！”然后离开。下一句", true); assert_eq!(blocks.iter().map(|value| value.0.trim()).collect::<Vec<_>>(), vec!["他说：“你好！”", "然后离开。", "下一句"]); }
    #[test] fn rejects_changes_to_consumed_text() { let mut chunker = SpeechChunkerCore::new(1); chunker.update_inner("Leave now. Another", false).unwrap(); assert!(chunker.update_inner("Stay here. Another", false).unwrap_err().contains("changed")); }
}
