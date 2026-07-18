use crate::js_error;
use icu_segmenter::{options::SentenceBreakInvariantOptions, SentenceSegmenter};
use serde::Serialize;
use std::collections::HashSet;
use wasm_bindgen::prelude::*;

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
    #[test] fn chunks_complete_sentences() { let mut chunker = SpeechChunkerCore::new(1); assert_eq!(chunker.update("Hi. Next", false).unwrap(), r#"[{"sequence":0,"text":"Hi."}]"#); }
    #[test] fn icu_keeps_decimal_periods_inside_sentences() { let blocks = sentence_blocks("The value is 3.14 today. Next sentence", true); assert_eq!(blocks.iter().map(|value| value.0.trim()).collect::<Vec<_>>(), vec!["The value is 3.14 today.", "Next sentence"]); }
    #[test] fn icu_handles_multilingual_boundaries_and_quotes() { let blocks = sentence_blocks("他说：“你好！”然后离开。下一句", true); assert_eq!(blocks.iter().map(|value| value.0.trim()).collect::<Vec<_>>(), vec!["他说：“你好！”", "然后离开。", "下一句"]); }
    #[test] fn rejects_changes_to_consumed_text() { let mut chunker = SpeechChunkerCore::new(1); chunker.update_inner("Leave now. Another", false).unwrap(); assert!(chunker.update_inner("Stay here. Another", false).unwrap_err().contains("changed")); }
}
