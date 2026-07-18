use crate::{js_error, parse_json};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use wasm_bindgen::prelude::*;

const MAX_STT_SECONDS: usize = 30;
const PCM_CHUNK_BYTES: usize = 32 * 1024;

#[wasm_bindgen]
pub fn float32_to_pcm16(samples: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for sample in samples {
        let sample = sample.clamp(-1.0, 1.0);
        let value = if sample < 0.0 { (sample * 32768.0) as i16 } else { (sample * 32767.0) as i16 };
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

#[wasm_bindgen]
pub fn base64_bytes(bytes: &[u8]) -> String { STANDARD.encode(bytes) }

#[wasm_bindgen]
pub fn pcm_chunk_offsets(length: u32, chunk_bytes: u32) -> Vec<u32> {
    let size = if chunk_bytes == 0 { PCM_CHUNK_BYTES as u32 } else { chunk_bytes };
    let mut offsets = Vec::new();
    let mut offset = 0;
    while offset < length { offsets.push(offset); offset = offset.saturating_add(size); }
    offsets.push(length);
    offsets
}

#[wasm_bindgen]
pub fn trim_outer_silence(samples: &[f64], sample_rate: f64, options_json: &str) -> Result<Vec<f64>, JsError> {
    if samples.is_empty() || !sample_rate.is_finite() || sample_rate <= 0.0 { return Ok(samples.to_vec()); }
    let options: Value = if options_json.is_empty() { Value::Object(Default::default()) } else { parse_json(options_json).map_err(js_error)? };
    let option = |name: &str, fallback: f64| options.get(name).and_then(Value::as_f64).unwrap_or(fallback);
    let threshold = option("rmsThreshold", 0.003);
    let window = (sample_rate * option("windowDuration", 0.02)).floor().max(1.0) as usize;
    let hop = (sample_rate * option("hopDuration", 0.01)).floor().max(1.0) as usize;
    let leading = (sample_rate * option("leadingPaddingDuration", 0.02)).floor().max(0.0) as usize;
    let trailing = (sample_rate * option("trailingPaddingDuration", 0.05)).floor().max(0.0) as usize;
    let mut first = None;
    let mut last = 0;
    for start in (0..samples.len()).step_by(hop) {
        let end = (start + window).min(samples.len());
        let rms = (samples[start..end].iter().map(|value| value.powi(2)).sum::<f64>() / (end - start) as f64).sqrt();
        if rms >= threshold { first.get_or_insert(start); last = end; }
    }
    let Some(first) = first else { return Ok(samples.to_vec()); };
    Ok(samples[first.saturating_sub(leading)..(last + trailing).min(samples.len())].to_vec())
}

pub(crate) fn trim_outer_silence_f32(samples: &[f32], sample_rate: f64) -> Vec<f32> {
    let input = samples.iter().map(|value| *value as f64).collect::<Vec<_>>();
    trim_outer_silence(&input, sample_rate, "").unwrap_or(input).into_iter().map(|value| value as f32).collect()
}

#[wasm_bindgen]
pub fn decode_audio_input(audio_json: &str) -> Result<Vec<f32>, JsError> {
    decode_audio_input_inner(audio_json).map_err(js_error)
}

pub(crate) fn decode_audio_input_inner(audio_json: &str) -> Result<Vec<f32>, String> {
    let value = parse_json(audio_json)?;
    let audio = value.as_object().ok_or_else(|| "Audio input must be an object.".to_string())?;
    if audio.get("sampleRate").and_then(Value::as_u64) != Some(16000) || audio.get("channels").and_then(Value::as_u64) != Some(1) { return Err("Moonshine requires 16 kHz mono audio.".into()); }
    let format = audio.get("format").and_then(Value::as_str).unwrap_or_default();
    let bytes = STANDARD.decode(audio.get("data").and_then(Value::as_str).unwrap_or_default()).map_err(|_| "Audio input is not valid base64.".to_string())?;
    let bytes_per_sample = if format == "pcm_s16le" { 2 } else { 4 };
    if bytes.is_empty() || bytes.len() % bytes_per_sample != 0 { return Err("Audio input has an invalid PCM byte length.".into()); }
    let mut samples = Vec::with_capacity(bytes.len() / bytes_per_sample);
    for chunk in bytes.chunks_exact(bytes_per_sample) {
        let sample = if format == "pcm_s16le" { (i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0).max(-1.0) } else { f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) };
        if !sample.is_finite() { return Err("Audio input contains a non-finite PCM sample.".into()); }
        samples.push(sample);
    }
    if samples.len() > 16000 * MAX_STT_SECONDS { return Err(format!("Audio input exceeds the {MAX_STT_SECONDS}-second limit.")); }
    Ok(samples)
}

#[wasm_bindgen]
pub fn merge_event_text(text: Option<String>, transcript: Option<String>) -> Result<String, JsError> {
    let text = text.unwrap_or_default().trim().to_string();
    let transcript = transcript.unwrap_or_default().trim().to_string();
    match (text.is_empty(), transcript.is_empty()) {
        (true, true) => Err(js_error("The request contains no usable text or speech.")),
        (true, false) => Ok(transcript),
        (false, true) => Ok(text),
        (false, false) => Ok(format!("{text}\n\nSpoken input from the player:\n{transcript}")),
    }
}

#[wasm_bindgen]
pub struct StreamingResamplerCore { source_rate: f64, target_rate: f64, input: Vec<f32>, position: f64 }

#[wasm_bindgen]
impl StreamingResamplerCore {
    #[wasm_bindgen(constructor)]
    pub fn new(source_rate: f64, target_rate: f64) -> Result<Self, JsError> {
        if source_rate <= 0.0 || target_rate <= 0.0 { return Err(js_error("Audio sample rates must be positive.")); }
        Ok(Self { source_rate, target_rate, input: Vec::new(), position: 0.0 })
    }

    pub fn push(&mut self, chunk: &[f32]) -> Vec<f32> {
        if chunk.is_empty() { return Vec::new(); }
        self.input.extend_from_slice(chunk);
        let step = self.source_rate / self.target_rate;
        let mut output = Vec::new();
        while self.position + 1.0 < self.input.len() as f64 {
            let left = self.position.floor() as usize;
            let fraction = (self.position - left as f64) as f32;
            output.push(self.input[left] + (self.input[left + 1] - self.input[left]) * fraction);
            self.position += step;
        }
        let consumed = (self.position.floor() as usize).min(self.input.len().saturating_sub(1));
        if consumed > 0 { self.input.drain(..consumed); self.position -= consumed as f64; }
        output
    }

    pub fn reset(&mut self) { self.input.clear(); self.position = 0.0; }
}

#[wasm_bindgen]
pub fn resample_audio(input: &[f32], source_rate: f64, target_rate: f64) -> Result<Vec<f32>, JsError> {
    if input.is_empty() || source_rate <= 0.0 || target_rate <= 0.0 { return Ok(Vec::new()); }
    if (source_rate - target_rate).abs() < f64::EPSILON { return Ok(input.to_vec()); }
    let step = source_rate / target_rate;
    let length = (input.len() as f64 / step).ceil() as usize;
    let mut output = Vec::with_capacity(length);
    for index in 0..length {
        let position = index as f64 * step;
        let left = (position.floor() as usize).min(input.len() - 1);
        let right = (left + 1).min(input.len() - 1);
        output.push(input[left] + (input[right] - input[left]) * (position - left as f64) as f32);
    }
    Ok(output)
}

#[wasm_bindgen]
pub fn analyse_audio(samples: &[f32]) -> String {
    let peak = samples.iter().map(|value| value.abs()).fold(0.0_f32, f32::max);
    let rms = if samples.is_empty() { 0.0 } else { (samples.iter().map(|value| (*value as f64).powi(2)).sum::<f64>() / samples.len() as f64).sqrt() };
    format!(r#"{{"peak":{peak},"rms":{rms}}}"#)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn encodes_pcm() { assert_eq!(float32_to_pcm16(&[-1.0, 0.0, 1.0]), vec![0, 128, 0, 0, 255, 127]); }
    #[test] fn trims_padding() { let mut samples = vec![0.0_f64; 20]; samples.extend(vec![0.5; 20]); samples.extend(vec![0.0; 20]); assert!(trim_outer_silence(&samples, 100.0, r#"{"windowDuration":0.1,"hopDuration":0.1,"leadingPaddingDuration":0.0,"trailingPaddingDuration":0.0}"#).unwrap().len() < samples.len()); }
    #[test] fn merges_text() { assert_eq!(merge_event_text(Some("Hi".into()), Some("there".into())).unwrap(), "Hi\n\nSpoken input from the player:\nthere"); }
}
