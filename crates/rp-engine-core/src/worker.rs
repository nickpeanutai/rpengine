use crate::{js_error, synthesis_text_inner, trim_outer_silence_f32, VadStateCore};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

fn voice_valid(voice: &str) -> bool { voice.len() == 2 && matches!(voice.as_bytes()[0], b'F' | b'M') && matches!(voice.as_bytes()[1], b'1'..=b'5') }

#[wasm_bindgen]
pub struct GemmaWorkerCore { loaded: bool, active_operation: Option<u64> }

#[wasm_bindgen]
impl GemmaWorkerCore {
    #[wasm_bindgen(constructor)] pub fn new() -> Self { Self { loaded: false, active_operation: None } }
    pub fn load_plan(&self) -> String { json!({"modelId":"gemma-4-E2B-it-web-litertlm","path":"gemma-4-E2B-it-web.litertlm","backend":"GPU_ARTISAN","maxNumTokens":8192,"maxTopK":40,"numDecodeStepsPerSync":1}).to_string() }
    pub fn mark_loaded(&mut self) { self.loaded = true; }
    pub fn generation_plan(&mut self, operation_id: u64) -> Result<String, JsError> {
        if !self.loaded { return Err(js_error("Gemma is not loaded.")); }
        if self.active_operation.is_some() { return Err(js_error("Gemma already has an active generation.")); }
        self.active_operation = Some(operation_id);
        Ok(json!({"maxOutputTokens":256,"sampler":"topK","temperature":0.8,"k":40}).to_string())
    }
    pub fn accepts(&self, operation_id: u64) -> bool { self.active_operation == Some(operation_id) }
    pub fn finish(&mut self, operation_id: u64) -> bool { if self.accepts(operation_id) { self.active_operation = None; true } else { false } }
    pub fn cancel(&mut self, operation_id: u64) -> bool { self.finish(operation_id) }
}
impl Default for GemmaWorkerCore { fn default() -> Self { Self::new() } }

#[wasm_bindgen]
pub struct TtsWorkerCore { loaded: bool, voices: Vec<String> }

#[wasm_bindgen]
impl TtsWorkerCore {
    #[wasm_bindgen(constructor)] pub fn new() -> Self { Self { loaded: false, voices: Vec::new() } }
    pub fn load_plan(&self, voice: &str) -> Result<String, JsError> {
        if !voice_valid(voice) { return Err(js_error(format!("Unsupported voice: {voice}"))); }
        Ok(json!({"config":"Supertonic3.bundle/onnx/tts.json","unicodeIndexer":"Supertonic3.bundle/onnx/unicode_indexer.json","models":["duration_predictor.onnx","text_encoder.onnx","vector_estimator.onnx","vocoder.onnx"],"voicePath":format!("Supertonic3.bundle/voice_styles/{voice}.json"),"threadsPolicy":"hardwareMinusTwoCappedAtFour"}).to_string())
    }
    pub fn mark_loaded(&mut self, voice: &str) { self.loaded = true; if !self.voices.iter().any(|value| value == voice) { self.voices.push(voice.into()); } }
    pub fn synthesis_plan(&mut self, text: &str, language: &str, voice: &str, allowed_tags_json: &str) -> Result<String, JsError> {
        if !self.loaded { return Err(js_error("Supertonic 3 is not loaded.")); }
        if !voice_valid(voice) { return Err(js_error(format!("Unsupported voice: {voice}"))); }
        let text = synthesis_text_inner(text, allowed_tags_json).map_err(js_error)?.trim().to_string();
        if text.is_empty() { return Err(js_error("Cannot synthesize an empty response.")); }
        Ok(json!({"text":text,"language":language,"voice":voice,"steps":5,"speed":1.05,"voiceCached":self.voices.iter().any(|value| value==voice)}).to_string())
    }
    pub fn mark_voice_loaded(&mut self, voice: &str) { if !self.voices.iter().any(|value| value == voice) { self.voices.push(voice.into()); } }
    pub fn process_audio(&self, samples: &[f32], sample_rate: f64) -> Result<Vec<f32>, JsError> {
        if (sample_rate - 44100.0).abs() > f64::EPSILON { return Err(js_error(format!("Supertonic returned {sample_rate} Hz; voice output requires 44100 Hz."))); }
        Ok(trim_outer_silence_f32(samples, sample_rate))
    }
}
impl Default for TtsWorkerCore { fn default() -> Self { Self::new() } }

#[wasm_bindgen]
pub struct VadWorkerPolicyCore {
    request_id: String, state: VadStateCore, processed_frames: u32, latest_capture_seconds: f64,
    observed_capture_seconds: f64, disabled: bool, speech_detected: bool, last_diagnostic_seconds: f64,
}

#[wasm_bindgen]
impl VadWorkerPolicyCore {
    #[wasm_bindgen(constructor)] pub fn new() -> Self { Self { request_id: String::new(), state: VadStateCore::default(), processed_frames: 0, latest_capture_seconds: 0.0, observed_capture_seconds: 0.0, disabled: false, speech_detected: false, last_diagnostic_seconds: 0.0 } }
    pub fn start(&mut self, request_id: &str) -> Result<String, JsError> { if request_id.is_empty() { return Err(js_error("FireRedVAD received an invalid capture start.")); } self.reset(); self.request_id = request_id.into(); Ok(json!({"state":"listening","seconds":0,"autoEndEnabled":true}).to_string()) }
    pub fn observe_capture(&mut self, end_seconds: f64) { if end_seconds.is_finite() { self.observed_capture_seconds = self.observed_capture_seconds.max(end_seconds); self.latest_capture_seconds = self.latest_capture_seconds.max(end_seconds); } }
    pub fn accept_probabilities(&mut self, probabilities: &[f32], inference_ms: f64) -> Result<String, JsError> {
        if self.request_id.is_empty() || self.disabled { return Ok("[]".into()); }
        let mut events = Vec::<Value>::new();
        for probability in probabilities {
            self.processed_frames += 1; let seconds = self.processed_frames as f64 / 100.0;
            let update = self.state.process(*probability as f64, seconds, 0.01);
            if !update.is_empty() {
                let value: Value = serde_json::from_str(&update).map_err(js_error)?;
                if value.get("state").and_then(Value::as_str) == Some("speech_started") { self.speech_detected = true; }
                if value.get("state").and_then(Value::as_str) == Some("listening") { self.speech_detected = false; }
                events.push(json!({"type":"state","update":value,"probability":probability,"inferenceMs":inference_ms}));
                if events.last().and_then(|value| value.pointer("/update/state")).and_then(Value::as_str) == Some("speech_ended") { break; }
            }
            if !self.speech_detected && seconds >= 8.0 { self.disabled = true; events.push(json!({"type":"noSpeech","seconds":seconds})); break; }
        }
        let lag = (self.observed_capture_seconds - self.processed_frames as f64 / 100.0).max(0.0);
        if self.latest_capture_seconds - self.last_diagnostic_seconds >= 1.0 { self.last_diagnostic_seconds = self.latest_capture_seconds; events.push(json!({"type":"diagnostic","probability":probabilities.last().copied().unwrap_or(0.0),"inferenceMs":inference_ms,"lagSeconds":lag})); }
        if lag > 1.5 { self.disabled = true; events.push(json!({"type":"degraded","seconds":self.latest_capture_seconds,"message":format!("FireRedVAD fell {lag:.2}s behind capture.")})); }
        serde_json::to_string(&events).map_err(js_error)
    }
    pub fn disabled(&self) -> bool { self.disabled }
    pub fn reset(&mut self) { self.request_id.clear(); self.state = VadStateCore::default(); self.processed_frames = 0; self.latest_capture_seconds = 0.0; self.observed_capture_seconds = 0.0; self.disabled = false; self.speech_detected = false; self.last_diagnostic_seconds = 0.0; }
}
impl Default for VadWorkerPolicyCore { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn gemma_policy_is_pinned() { let mut core = GemmaWorkerCore::new(); core.mark_loaded(); let plan: Value = serde_json::from_str(&core.generation_plan(7).unwrap()).unwrap(); assert_eq!(plan["maxOutputTokens"], 256); assert_eq!(plan["temperature"], 0.8); }
    #[test] fn tts_trims_and_pins_inference() { let mut core = TtsWorkerCore::new(); core.mark_loaded("F4"); let plan: Value = serde_json::from_str(&core.synthesis_plan("Hello", "en", "F4", "[]").unwrap()).unwrap(); assert_eq!(plan["steps"], 5); let mut samples = vec![0.0; 4410]; samples.extend(vec![0.5; 4410]); samples.extend(vec![0.0; 4410]); assert!(core.process_audio(&samples, 44100.0).unwrap().len() < samples.len()); }
    #[test] fn vad_policy_degrades_on_lag() { let mut core = VadWorkerPolicyCore::new(); core.start("r").unwrap(); core.observe_capture(3.0); assert!(core.accept_probabilities(&[0.0], 1.0).unwrap().contains("degraded")); }
}
