use crate::{
    assemble_prompt_value, base64_bytes, decode_audio_input_inner, display_text_inner, float32_to_pcm16,
    js_error, parse_json, synthesis_text_inner, validate_envelope_value,
    CardSessionCore, DisplayTextStreamCore, SpeechChunkerCore,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use wasm_bindgen::prelude::*;

const ABI_VERSION: u32 = 2;
const QUEUE_LIMIT: usize = 20;
const GEMMA_ID: &str = "gemma-4-E2B-it-web-litertlm";
const TTS_ID: &str = "gemtavern-supertonic-3";
const LEGACY_ENGLISH_STT_ID: &str = "gemtavern-moonshine-stt-english-base";
const PCM_CHUNK_BYTES: usize = 32 * 1024;

fn stt_id(language: &str) -> &'static str {
    match language {
        "ar" => "gemtavern-moonshine-stt-arabic-base",
        "es" => "gemtavern-moonshine-stt-spanish-base",
        "ja" => "gemtavern-moonshine-stt-japanese-base",
        "ko" => "gemtavern-moonshine-stt-korean-base",
        "vi" => "gemtavern-moonshine-stt-vietnamese-base",
        "uk" => "gemtavern-moonshine-stt-ukrainian-base",
        "zh" => "gemtavern-moonshine-stt-chinese-base",
        _ => "gemtavern-moonshine-stt-english-small-streaming",
    }
}

fn language_name(language: &str) -> &'static str {
    match language {
        "ar" => "Arabic", "es" => "Spanish", "ja" => "Japanese", "ko" => "Korean",
        "vi" => "Vietnamese", "uk" => "Ukrainian", "zh" => "Chinese", _ => "English",
    }
}

fn supported_stt_language(language: &str) -> bool { matches!(language, "en" | "ar" | "es" | "ja" | "ko" | "vi" | "uk" | "zh") }
fn supported_tts_language(language: &str) -> bool { matches!(language, "en" | "ko" | "es" | "pt" | "fr" | "de" | "it" | "pl" | "ru" | "nl" | "cs" | "ar" | "zh" | "ja" | "hu" | "tr" | "fi" | "sk" | "da" | "hr" | "el" | "sv" | "nb" | "he" | "uk" | "id" | "ms" | "vi" | "th" | "ro" | "bg") }
fn supported_voice(voice: &str) -> bool { voice.len() == 2 && matches!(voice.as_bytes()[0], b'F' | b'M') && matches!(voice.as_bytes()[1], b'1'..=b'5') }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelState {
    id: String,
    name: String,
    phase: String,
    progress: f64,
    downloaded_bytes: u64,
    total_bytes: u64,
    is_resuming: bool,
    bytes_per_second: Option<f64>,
    eta_seconds: Option<f64>,
    error: Option<String>,
    runtime_phase: Option<String>,
    runtime_progress: Option<f64>,
    runtime_error: Option<String>,
}

impl ModelState {
    fn from_value(value: &Value) -> Option<Self> {
        Some(Self {
            id: value.get("id")?.as_str()?.to_string(),
            name: value.get("name").and_then(Value::as_str).unwrap_or_else(|| value.get("id").and_then(Value::as_str).unwrap_or_default()).to_string(),
            phase: value.get("phase").and_then(Value::as_str).unwrap_or("missing").to_string(),
            progress: value.get("progress").and_then(Value::as_f64).unwrap_or(0.0),
            downloaded_bytes: value.get("downloadedBytes").and_then(Value::as_u64).unwrap_or(0),
            total_bytes: value.get("totalBytes").and_then(Value::as_u64).unwrap_or(0),
            is_resuming: value.get("isResuming").and_then(Value::as_bool).unwrap_or(false),
            bytes_per_second: value.get("bytesPerSecond").and_then(Value::as_f64),
            eta_seconds: value.get("etaSeconds").and_then(Value::as_f64),
            error: value.get("error").and_then(Value::as_str).map(str::to_string),
            runtime_phase: value.get("runtimePhase").and_then(Value::as_str).map(str::to_string),
            runtime_progress: value.get("runtimeProgress").and_then(Value::as_f64),
            runtime_error: value.get("runtimeError").and_then(Value::as_str).map(str::to_string),
        })
    }
    fn installed(&self) -> bool { matches!(self.phase.as_str(), "installed" | "ready" | "loading") }
    fn busy(&self) -> bool { matches!(self.phase.as_str(), "checking" | "downloading" | "verifying" | "loading") }
}

#[derive(Clone)]
struct QueuedReply { envelope: Value, card: Value }

struct SpeechState {
    language: String,
    voice: String,
    expression_tags: Vec<String>,
    chunker: SpeechChunkerCore,
    pending: VecDeque<(u32, String)>,
    inflight: Option<(u64, u32)>,
    started: bool,
    audio_sequence: u32,
    segment_count: u32,
    total_chunks: u32,
    total_bytes: usize,
    duration_seconds: f64,
    elapsed_ms: f64,
}

struct ActiveReply {
    request_id: String,
    source_message_id: String,
    envelope: Value,
    card: Value,
    raw: String,
    clean: String,
    delta_sequence: u32,
    display: DisplayTextStreamCore,
    transcript: Option<String>,
    stt_operation: Option<u64>,
    gemma_operation: Option<u64>,
    gemma_done: bool,
    text_completed: bool,
    speech: Option<SpeechState>,
}

#[derive(Clone, Copy)]
enum CapturePhase { Capturing, Stopping, Transcribing }

struct CaptureRequest { envelope: Value, card: Value, phase: CapturePhase, operation: Option<u64> }

enum SttTarget { Reply(String), Capture(String) }

struct ReplyAudioTransportJob {
    samples: Vec<f32>,
    request_id: String,
    session_id: Option<String>,
    sample_rate: u32,
    segment_sequence: u32,
    first_audio_sequence: u32,
    send_start: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum CoreEffectV2 {
    SocketConnect { port: u16, attempt: u32 },
    SocketDisconnect { reason: String },
    SocketSend { message_type: String, payload: Value, session_id: Option<String> },
    ScheduleTimer { timer_id: String, delay_ms: u32 },
    CancelTimer { timer_id: String },
    OwnershipAcquire,
    OwnershipRelease,
    OwnershipPhase { phase: String },
    ModelsRefresh,
    ModelDownload { model_id: String },
    ModelCancel { model_id: String },
    ModelDelete { model_id: String },
    ModelCleanup { model_id: String },
    RuntimesLoad { operation_id: u64, language: String, default_voice: String },
    RuntimesDispose,
    MicrophoneEnable,
    MicrophoneDisable,
    CaptureStart { request_id: String },
    CaptureStop { request_id: String },
    CaptureCancel { request_id: String },
    SttInvoke { operation_id: u64, buffer_id: u32, language: String },
    GemmaInvoke { operation_id: u64, system: String, user: String, history: Value },
    GemmaCancel { operation_id: u64 },
    TtsInvoke { operation_id: u64, text: String, language: String, voice: String, segment_sequence: u32 },
    ReplyAudioTransport { transport_id: u32 },
    Diagnostic { level: String, category: String, message: String, details: Option<Value>, key: Option<String> },
    Render { view_model: Value },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EffectBatchV2 { abi_version: u32, effects: Vec<CoreEffectV2> }

#[wasm_bindgen]
pub struct CoreSession {
    cards: CardSessionCore,
    seen: HashSet<String>,
    seen_order: VecDeque<String>,
    accepted: HashSet<String>,
    queue: VecDeque<QueuedReply>,
    active: Option<ActiveReply>,
    capture: Option<CaptureRequest>,
    stt_targets: HashMap<u64, SttTarget>,
    buffers: HashMap<u32, Vec<f32>>,
    reply_audio_transports: HashMap<u32, ReplyAudioTransportJob>,
    next_buffer: u32,
    next_operation: u64,
    selected_language: String,
    app_version: String,
    port: u16,
    models: HashMap<String, ModelState>,
    service_phase: String,
    service_started: bool,
    runtimes_ready: bool,
    runtime_operation: Option<u64>,
    expression_tags: Vec<String>,
    ownership_owned: bool,
    owner_elsewhere: bool,
    owner_elsewhere_phase: Option<String>,
    release_after_action: bool,
    pending_downloads: VecDeque<String>,
    active_download: Option<String>,
    manual_model_action: Option<(String, String)>,
    microphone_enabled: bool,
    microphone_pending: bool,
    microphone_error: String,
    connection_state: String,
    session_id: Option<String>,
    reconnect_attempt: u32,
    socket_attempt: u32,
}

#[wasm_bindgen]
impl CoreSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            cards: CardSessionCore::new(), seen: HashSet::new(), seen_order: VecDeque::new(), accepted: HashSet::new(),
            queue: VecDeque::new(), active: None, capture: None, stt_targets: HashMap::new(), buffers: HashMap::new(), reply_audio_transports: HashMap::new(), next_buffer: 1, next_operation: 1,
            selected_language: "en".into(), app_version: "unknown".into(), port: 38471, models: HashMap::new(), service_phase: "checking".into(), service_started: false,
            runtimes_ready: false, runtime_operation: None, expression_tags: Vec::new(), ownership_owned: false, owner_elsewhere: false,
            owner_elsewhere_phase: None, release_after_action: false, pending_downloads: VecDeque::new(), active_download: None, manual_model_action: None,
            microphone_enabled: false, microphone_pending: false, microphone_error: String::new(), connection_state: "idle".into(), session_id: None,
            reconnect_attempt: 0, socket_attempt: 0,
        }
    }

    pub fn dispatch(&mut self, event_json: &str) -> Result<String, JsError> {
        let event = parse_json(event_json).map_err(js_error)?;
        let mut effects = Vec::new();
        self.handle_event(&event, &mut effects).map_err(js_error)?;
        effects.push(CoreEffectV2::Render { view_model: self.view_model_value() });
        self.serialize(effects)
    }

    pub fn dispatch_audio(&mut self, event_json: &str, samples: Vec<f32>) -> Result<String, JsError> {
        let event = parse_json(event_json).map_err(js_error)?;
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default();
        let mut effects = Vec::new();
        match event_type {
            "captureCompleted" => self.capture_completed(&event, &samples, &mut effects),
            "ttsCompleted" => self.tts_completed(&event, samples, &mut effects),
            _ => return Err(js_error(format!("Unsupported HostAudioEventV2 type: {event_type}"))),
        }
        effects.push(CoreEffectV2::Render { view_model: self.view_model_value() });
        self.serialize(effects)
    }

    pub fn take_f32_buffer(&mut self, buffer_id: u32) -> Result<Vec<f32>, JsError> {
        self.buffers.remove(&buffer_id).ok_or_else(|| js_error(format!("Unknown or consumed audio buffer: {buffer_id}")))
    }

    pub fn take_reply_audio_transport(&mut self, transport_id: u32) -> Result<String, JsError> {
        let job = self.reply_audio_transports.remove(&transport_id).ok_or_else(|| js_error(format!("Unknown or consumed reply audio transport: {transport_id}")))?;
        let pcm = float32_to_pcm16(&job.samples);
        let chunks = pcm.chunks(PCM_CHUNK_BYTES).collect::<Vec<_>>();
        let mut effects = Vec::with_capacity(chunks.len() + usize::from(job.send_start));
        if job.send_start {
            effects.push(CoreEffectV2::SocketSend {
                message_type: "reply.audio.start".into(),
                payload: json!({ "requestId":job.request_id, "format":"pcm_s16le", "sampleRate":job.sample_rate, "channels":1 }),
                session_id: job.session_id.clone(),
            });
        }
        for (segment_chunk_sequence, chunk) in chunks.iter().enumerate() {
            effects.push(CoreEffectV2::SocketSend {
                message_type: "reply.audio.chunk".into(),
                payload: json!({
                    "requestId":job.request_id,
                    "sequence":job.first_audio_sequence + segment_chunk_sequence as u32,
                    "segmentSequence":job.segment_sequence,
                    "segmentChunkSequence":segment_chunk_sequence,
                    "segmentChunkCount":chunks.len(),
                    "data":base64_bytes(chunk)
                }),
                session_id: job.session_id.clone(),
            });
        }
        self.serialize(effects)
    }

    pub fn view_model(&self) -> String { self.view_model_value().to_string() }
}

impl CoreSession {
    fn serialize(&self, effects: Vec<CoreEffectV2>) -> Result<String, JsError> {
        serde_json::to_string(&EffectBatchV2 { abi_version: ABI_VERSION, effects }).map_err(js_error)
    }

    fn handle_event(&mut self, event: &Value, effects: &mut Vec<CoreEffectV2>) -> Result<(), String> {
        let object = event.as_object().ok_or("HostEventV2 must be an object.")?;
        let event_type = object.get("type").and_then(Value::as_str).unwrap_or_default();
        match event_type {
            "bootstrap" => {
                if let Some(version) = object.get("appVersion").and_then(Value::as_str).filter(|value| !value.is_empty()) { self.app_version = version.into(); }
                if let Some(language) = object.get("language").and_then(Value::as_str).filter(|value| supported_stt_language(value)) { self.selected_language = language.into(); }
                if let Some(port) = object.get("port").and_then(Value::as_u64).filter(|value| (1024..=65535).contains(value)) { self.port = port as u16; }
                effects.push(CoreEffectV2::ModelsRefresh);
            }
            "uiPrimary" => self.primary(effects),
            "uiToggleMicrophone" => self.toggle_microphone(effects),
            "uiLanguage" => self.change_language(object.get("language").and_then(Value::as_str).unwrap_or_default(), effects),
            "uiPort" => self.change_port(object.get("port").and_then(Value::as_u64).unwrap_or(0), effects),
            "uiModelAction" => self.model_action(object, effects),
            "pageHide" => self.stop_service(effects, true),
            "ownershipAcquired" => self.ownership_acquired(effects),
            "ownershipDenied" => { self.service_phase = "idle".into(); self.owner_elsewhere = true; self.diagnostic(effects, "warn", "system", "RPEngine is already active in another tab.", None); }
            "ownershipReleased" => { self.ownership_owned = false; }
            "ownershipOther" => {
                self.owner_elsewhere = object.get("active").and_then(Value::as_bool).unwrap_or(false);
                self.owner_elsewhere_phase = object.get("phase").and_then(Value::as_str).map(str::to_string);
            }
            "modelsSnapshot" => self.models_snapshot(object, effects),
            "modelStatus" => self.model_status(object, effects),
            "modelFailed" => self.model_failed(object, effects),
            "modelCleanupCompleted" => self.model_cleanup_completed(object, effects),
            "modelCleanupFailed" => self.model_cleanup_failed(object, effects),
            "runtimeLoaded" => self.runtime_loaded(object, effects),
            "runtimeFailed" => self.runtime_failed(object, effects),
            "runtimeProgress" => self.runtime_progress(object),
            "microphoneEnabled" => { self.microphone_pending = false; self.microphone_enabled = true; self.microphone_error.clear(); self.diagnostic(effects, "info", "microphone", "Browser microphone enabled.", None); }
            "microphoneDisabled" => { self.microphone_pending = false; self.microphone_enabled = false; self.microphone_error.clear(); self.diagnostic(effects, "info", "microphone", "Browser microphone disabled.", None); }
            "microphoneFailed" => { self.microphone_pending = false; self.microphone_enabled = false; self.microphone_error = string(object, "message"); self.diagnostic(effects, "error", "microphone", &self.microphone_error.clone(), None); }
            "socketOpened" => self.socket_opened(effects),
            "socketMessage" => self.socket_message(object.get("raw").and_then(Value::as_str).unwrap_or_default(), effects),
            "socketClosed" => self.socket_closed(object, effects),
            "socketError" => { self.connection_state = "error".into(); self.diagnostic(effects, "error", "connection", &string(object, "message"), None); }
            "timerFired" => self.timer_fired(object.get("timerId").and_then(Value::as_str).unwrap_or_default(), effects),
            "captureLevel" => self.capture_level(object, effects),
            "captureState" => self.capture_state(object, effects),
            "captureFailed" => self.capture_failed(object, effects),
            "sttCompleted" => self.stt_completed(object, effects),
            "sttFailed" => self.operation_failed(object, "Moonshine", effects),
            "gemmaDelta" => self.gemma_delta(object, effects),
            "gemmaCompleted" => self.gemma_completed(object, effects),
            "gemmaFailed" => self.operation_failed(object, "Gemma", effects),
            "ttsFailed" => self.operation_failed(object, "Supertonic", effects),
            _ => return Err(format!("Unsupported HostEventV2 type: {event_type}")),
        }
        Ok(())
    }

    fn toggle_microphone(&mut self, effects: &mut Vec<CoreEffectV2>) {
        if self.microphone_pending || self.capture.is_some() { return; }
        self.microphone_pending = true;
        effects.push(if self.microphone_enabled { CoreEffectV2::MicrophoneDisable } else { CoreEffectV2::MicrophoneEnable });
    }

    fn next_operation(&mut self) -> u64 { let value = self.next_operation; self.next_operation += 1; value }
    fn store_buffer(&mut self, samples: &[f32]) -> u32 { let id = self.next_buffer; self.next_buffer += 1; self.buffers.insert(id, samples.to_vec()); id }
    fn store_reply_audio_transport(&mut self, job: ReplyAudioTransportJob) -> u32 { let id = self.next_buffer; self.next_buffer += 1; self.reply_audio_transports.insert(id, job); id }
    fn required_model_ids(&self) -> [String; 3] { [GEMMA_ID.into(), TTS_ID.into(), stt_id(&self.selected_language).into()] }
    fn model_ready(&self, id: &str) -> bool { self.models.get(id).is_some_and(ModelState::installed) }
    fn ready(&self) -> bool { self.service_started && self.runtimes_ready }
    fn queue_depth(&self) -> usize { self.queue.len() + usize::from(self.active.is_some()) + usize::from(self.capture.is_some()) }

    fn primary(&mut self, effects: &mut Vec<CoreEffectV2>) {
        if self.service_started || matches!(self.service_phase.as_str(), "loading" | "running") { self.stop_service(effects, false); return; }
        let downloading = self.required_model_ids().iter().any(|id| self.models.get(id).is_some_and(|status| matches!(status.phase.as_str(), "downloading" | "verifying")));
        if downloading {
            for id in self.required_model_ids() { effects.push(CoreEffectV2::ModelCancel { model_id: id }); }
            self.service_phase = "idle".into();
            return;
        }
        if self.owner_elsewhere && !self.ownership_owned { return; }
        self.service_phase = "acquiring".into();
        effects.push(CoreEffectV2::OwnershipAcquire);
    }

    fn ownership_acquired(&mut self, effects: &mut Vec<CoreEffectV2>) {
        self.ownership_owned = true;
        self.owner_elsewhere = false;
        if let Some((action, id)) = self.manual_model_action.take() {
            self.release_after_action = true;
            self.service_phase = if action == "download" { "downloading" } else { "preparing" }.into();
            effects.push(CoreEffectV2::OwnershipPhase { phase: self.service_phase.clone() });
            if action == "download" { self.active_download = Some(id.clone()); effects.push(CoreEffectV2::ModelDownload { model_id: id }); }
            else { effects.push(CoreEffectV2::ModelDelete { model_id: id }); }
            return;
        }
        self.release_after_action = false;
        let missing = self.required_model_ids().into_iter().filter(|id| !self.model_ready(id)).collect::<Vec<_>>();
        if missing.is_empty() { self.begin_runtime_load(effects); }
        else {
            self.service_phase = "downloading".into();
            effects.push(CoreEffectV2::OwnershipPhase { phase: "downloading".into() });
            self.pending_downloads = missing.into();
            self.start_next_download(effects);
        }
    }

    fn start_next_download(&mut self, effects: &mut Vec<CoreEffectV2>) {
        if self.active_download.is_some() { return; }
        if let Some(model_id) = self.pending_downloads.pop_front() {
            self.active_download = Some(model_id.clone());
            effects.push(CoreEffectV2::ModelDownload { model_id });
        } else if self.release_after_action { self.release_after_action = false; self.service_phase = "idle".into(); effects.push(CoreEffectV2::OwnershipRelease); }
        else if self.service_phase == "downloading" { self.begin_runtime_load(effects); }
    }

    fn begin_runtime_load(&mut self, effects: &mut Vec<CoreEffectV2>) {
        let operation_id = self.next_operation();
        self.runtime_operation = Some(operation_id);
        self.service_phase = "loading".into();
        effects.push(CoreEffectV2::OwnershipPhase { phase: "loading".into() });
        effects.push(CoreEffectV2::RuntimesLoad { operation_id, language: self.selected_language.clone(), default_voice: "F4".into() });
    }

    fn runtime_loaded(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        if object.get("operationId").and_then(Value::as_u64) != self.runtime_operation { return; }
        self.runtime_operation = None;
        self.runtimes_ready = true;
        self.service_started = true;
        self.service_phase = "running".into();
        self.expression_tags = object.get("expressionTags").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
        effects.push(CoreEffectV2::OwnershipPhase { phase: "running".into() });
        if self.selected_language == "en" {
            effects.push(CoreEffectV2::ModelCleanup { model_id: LEGACY_ENGLISH_STT_ID.into() });
        }
        self.connect(effects);
        self.diagnostic(effects, "info", "system", "System initialized", None);
    }

    fn runtime_failed(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        if object.get("operationId").and_then(Value::as_u64) != self.runtime_operation { return; }
        self.runtime_operation = None;
        self.runtimes_ready = false;
        self.service_started = false;
        self.service_phase = "error".into();
        self.diagnostic(effects, "error", "system", "Model initialization failed", object.get("details").cloned());
        effects.push(CoreEffectV2::RuntimesDispose);
        effects.push(CoreEffectV2::OwnershipRelease);
    }

    fn runtime_progress(&mut self, object: &Map<String, Value>) {
        if let Some(status) = object.get("status").and_then(ModelState::from_value) { self.models.insert(status.id.clone(), status); }
    }

    fn model_cleanup_completed(&self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        if object.get("modelId").and_then(Value::as_str) != Some(LEGACY_ENGLISH_STT_ID) { return; }
        if object.get("removed").and_then(Value::as_bool).unwrap_or(false) {
            self.diagnostic(effects, "info", "model", "Removed the legacy Moonshine English Base model.", None);
        }
    }

    fn model_cleanup_failed(&self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        if object.get("modelId").and_then(Value::as_str) != Some(LEGACY_ENGLISH_STT_ID) { return; }
        self.diagnostic(effects, "warn", "model", "Could not remove the legacy Moonshine English Base model; cleanup will be retried after the next successful English start.", object.get("message").cloned());
    }

    fn stop_service(&mut self, effects: &mut Vec<CoreEffectV2>, page_hide: bool) {
        self.cancel_all(effects, "service_stopped");
        self.service_started = false;
        self.runtimes_ready = false;
        self.runtime_operation = None;
        self.service_phase = "idle".into();
        self.connection_state = "disconnected".into();
        self.session_id = None;
        effects.push(CoreEffectV2::CancelTimer { timer_id: "welcome".into() });
        effects.push(CoreEffectV2::CancelTimer { timer_id: "reconnect".into() });
        effects.push(CoreEffectV2::SocketDisconnect { reason: if page_hide { "Page closed" } else { "Service stopped" }.into() });
        effects.push(CoreEffectV2::RuntimesDispose);
        if self.ownership_owned { effects.push(CoreEffectV2::OwnershipRelease); }
    }

    fn change_language(&mut self, language: &str, effects: &mut Vec<CoreEffectV2>) {
        if self.service_started || self.service_phase == "loading" || !supported_stt_language(language) { return; }
        if self.selected_language != language { self.selected_language = language.into(); self.runtimes_ready = false; effects.push(CoreEffectV2::RuntimesDispose); }
    }

    fn change_port(&mut self, port: u64, effects: &mut Vec<CoreEffectV2>) {
        if !(1024..=65535).contains(&port) { self.diagnostic(effects, "warn", "settings", "Enter a port between 1024 and 65535.", None); return; }
        if self.port == port as u16 { return; }
        self.port = port as u16;
        if self.service_started { effects.push(CoreEffectV2::SocketDisconnect { reason: "Port changed".into() }); self.connect(effects); }
    }

    fn model_action(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        let id = string(object, "modelId");
        let action = string(object, "action");
        if action == "cancel" { effects.push(CoreEffectV2::ModelCancel { model_id: id }); return; }
        if self.owner_elsewhere && !self.ownership_owned { return; }
        self.pending_downloads.clear();
        self.active_download = None;
        self.service_phase = if action == "download" { "downloading" } else { "preparing" }.into();
        self.release_after_action = true;
        if !self.ownership_owned { self.manual_model_action = Some((action, id)); effects.push(CoreEffectV2::OwnershipAcquire); }
        else if action == "download" { self.active_download = Some(id.clone()); effects.push(CoreEffectV2::ModelDownload { model_id: id }); }
        else { effects.push(CoreEffectV2::ModelDelete { model_id: id }); }
    }

    fn models_snapshot(&mut self, object: &Map<String, Value>, _effects: &mut Vec<CoreEffectV2>) {
        self.models.clear();
        for value in object.get("models").and_then(Value::as_array).into_iter().flatten() {
            if let Some(status) = ModelState::from_value(value) { self.models.insert(status.id.clone(), status); }
        }
        if self.service_phase == "checking" { self.service_phase = "idle".into(); }
    }

    fn model_status(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        let Some(status) = object.get("status").and_then(ModelState::from_value) else { return; };
        let id = status.id.clone();
        let finished = status.installed() && self.active_download.as_deref() == Some(&id);
        let deleted = status.phase == "missing" && self.release_after_action;
        if self.active_download.as_deref() == Some(&id) { self.model_download_activity(&status, effects); }
        self.models.insert(id.clone(), status);
        if finished { self.active_download = None; self.start_next_download(effects); }
        else if self.active_download.as_deref() == Some(&id) && matches!(self.models.get(&id).map(|value| value.phase.as_str()), Some("paused" | "error" | "missing")) {
            self.active_download = None; self.pending_downloads.clear(); self.service_phase = "idle".into(); if self.ownership_owned { effects.push(CoreEffectV2::OwnershipRelease); }
        }
        else if deleted { self.release_after_action = false; self.service_phase = "idle".into(); effects.push(CoreEffectV2::OwnershipRelease); }
    }

    fn model_download_activity(&self, status: &ModelState, effects: &mut Vec<CoreEffectV2>) {
        let name = display_model_name(&status.id, &status.name);
        let progress = format!("{}% · {} / {}", (status.progress * 100.0).round() as u64, format_bytes(status.downloaded_bytes), format_bytes(status.total_bytes));
        let activity = match status.phase.as_str() {
            "downloading" | "verifying" => {
                let action = if status.phase == "verifying" { "Verifying" } else if status.is_resuming { "Resuming" } else { "Downloading" };
                let speed = status.bytes_per_second.filter(|value| *value > 0.0).map(|value| format!(" · {}/s", format_bytes(value as u64))).unwrap_or_default();
                let eta = status.eta_seconds.map(|value| format!(" · {} left", format_duration(value))).unwrap_or_default();
                Some(("info", format!("{action} {name} — {progress}{speed}{eta}")))
            }
            "installed" | "ready" => Some(("info", format!("Installed {name} · {}", format_bytes(status.total_bytes)))),
            "paused" => Some(("warn", format!("Download paused: {name} — {progress}"))),
            _ => None,
        };
        if let Some((level, message)) = activity {
            effects.push(CoreEffectV2::Diagnostic { level: level.into(), category: "model".into(), message, details: None, key: Some(format!("model-download:{}", status.id)) });
        }
    }

    fn model_failed(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        let id = string(object, "modelId");
        self.active_download = None;
        self.pending_downloads.clear();
        self.service_phase = "error".into();
        self.diagnostic(effects, "error", "model", &string(object, "message"), Some(json!({ "modelId": id })));
        if self.ownership_owned { effects.push(CoreEffectV2::OwnershipRelease); }
    }

    fn connect(&mut self, effects: &mut Vec<CoreEffectV2>) {
        if !self.service_started { return; }
        self.socket_attempt += 1;
        self.connection_state = "connecting".into();
        effects.push(CoreEffectV2::SocketConnect { port: self.port, attempt: self.socket_attempt });
    }

    fn socket_opened(&mut self, effects: &mut Vec<CoreEffectV2>) {
        if !self.service_started { return; }
        self.connection_state = "handshaking".into();
        self.send(effects, "hello", json!({ "clientVersion": self.app_version }));
        effects.push(CoreEffectV2::ScheduleTimer { timer_id: "welcome".into(), delay_ms: 5000 });
    }

    fn socket_message(&mut self, raw: &str, effects: &mut Vec<CoreEffectV2>) {
        let envelope = match parse_json(raw).and_then(|value| { validate_envelope_value(&value)?; Ok(value) }) {
            Ok(value) => value,
            Err(message) => { self.diagnostic(effects, "error", "protocol", "Rejected game payload", Some(json!({ "message": message }))); self.send(effects, "request.error", json!({ "code":"invalid_payload", "message":message })); return; }
        };
        let message_id = envelope.get("messageId").and_then(Value::as_str).unwrap_or_default().to_string();
        let duplicate = self.seen.contains(&message_id);
        self.send(effects, "ack", if duplicate { json!({ "acknowledgedMessageId":message_id, "duplicate":true }) } else { json!({ "acknowledgedMessageId":message_id }) });
        if duplicate { return; }
        self.seen.insert(message_id.clone()); self.seen_order.push_back(message_id);
        while self.seen_order.len() > 2000 { if let Some(old) = self.seen_order.pop_front() { self.seen.remove(&old); } }
        match envelope.get("type").and_then(Value::as_str).unwrap_or_default() {
            "welcome" => {
                self.session_id = envelope.get("sessionId").and_then(Value::as_str).map(str::to_string);
                self.connection_state = "connected".into(); self.reconnect_attempt = 0; self.cards.clear();
                effects.push(CoreEffectV2::CancelTimer { timer_id: "welcome".into() }); self.publish_capacity(effects);
            }
            "character.sync" => self.character_sync(&envelope, effects),
            "reply.request" => self.accept_reply(envelope, effects),
            "voice.capture.start" => self.accept_capture(envelope, effects),
            "voice.capture.stop" => self.stop_capture(envelope.get("requestId").and_then(Value::as_str).unwrap_or_default(), effects),
            "voice.capture.cancel" => self.cancel_request(envelope.get("requestId").and_then(Value::as_str).unwrap_or_default(), "requested_by_game", effects),
            "request.cancel" => self.cancel_request(envelope.get("requestId").and_then(Value::as_str).unwrap_or_default(), "requested_by_game", effects),
            _ => {}
        }
    }

    fn socket_closed(&mut self, _object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        self.connection_state = "disconnected".into(); self.session_id = None; self.cards.clear();
        effects.push(CoreEffectV2::CancelTimer { timer_id: "welcome".into() });
        self.cancel_all(effects, "connection_lost");
        if self.service_started {
            let delay = (1000_u32.saturating_mul(2_u32.saturating_pow(self.reconnect_attempt))).min(15000);
            self.reconnect_attempt = self.reconnect_attempt.saturating_add(1);
            effects.push(CoreEffectV2::ScheduleTimer { timer_id: "reconnect".into(), delay_ms: delay });
        }
    }

    fn timer_fired(&mut self, timer: &str, effects: &mut Vec<CoreEffectV2>) {
        if timer == "reconnect" { self.connect(effects); }
        else if timer == "welcome" && self.connection_state == "handshaking" {
            self.connection_state = "error".into();
            self.diagnostic(effects, "error", "connection", "The game did not complete the local handshake. Retrying…", None);
            effects.push(CoreEffectV2::SocketDisconnect { reason: "Welcome timeout".into() });
            let delay = (1000_u32.saturating_mul(2_u32.saturating_pow(self.reconnect_attempt))).min(15000);
            self.reconnect_attempt = self.reconnect_attempt.saturating_add(1);
            effects.push(CoreEffectV2::ScheduleTimer { timer_id: "reconnect".into(), delay_ms: delay });
        }
    }

    fn character_sync(&mut self, envelope: &Value, effects: &mut Vec<CoreEffectV2>) {
        let integration = envelope.get("integrationId").and_then(Value::as_str).unwrap_or_default();
        let character = envelope.get("characterId").and_then(Value::as_str).unwrap_or_default();
        let Some(transfer) = envelope.get("card") else { return; };
        match self.cards.resolve_value(integration, character, transfer) {
            Ok(resolved) => self.send(effects, "character.synced", json!({ "sourceMessageId": envelope.get("messageId"), "integrationId":integration, "characterId":character, "targetHash":resolved.get("hash") })),
            Err(error) => self.request_error(None, envelope.get("messageId").and_then(Value::as_str).unwrap_or_default(), &error, effects),
        }
    }

    fn resolve_card(&mut self, envelope: &Value) -> Result<Value, String> {
        let resolved = self.cards.resolve_value(
            envelope.get("integrationId").and_then(Value::as_str).unwrap_or_default(),
            envelope.get("characterId").and_then(Value::as_str).unwrap_or_default(),
            envelope.get("card").ok_or("card_resync_required: Request is missing a character card transfer.")?,
        )?;
        Ok(resolved)
    }

    fn accept_reply(&mut self, envelope: Value, effects: &mut Vec<CoreEffectV2>) {
        let request_id = envelope.get("requestId").and_then(Value::as_str).unwrap_or_default().to_string();
        let source = envelope.get("messageId").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Err((code, message)) = self.preflight(&request_id, false) { self.request_error_code(Some(&request_id), &source, code, message, effects); return; }
        match self.resolve_card(&envelope) {
            Ok(resolved) => {
                self.accepted.insert(request_id.clone());
                self.send(effects, "reply.accepted", json!({ "requestId":request_id, "eventId":envelope.get("eventId"), "resolvedCardHash":resolved.get("hash"), "queueDepth":self.queue_depth()+1 }));
                self.queue.push_back(QueuedReply { envelope, card: resolved.get("card").cloned().unwrap_or(Value::Null) });
                self.publish_capacity(effects); self.start_next_reply(effects);
            }
            Err(error) => self.request_error(Some(&request_id), &source, &error, effects),
        }
    }

    fn accept_capture(&mut self, envelope: Value, effects: &mut Vec<CoreEffectV2>) {
        let request_id = envelope.get("requestId").and_then(Value::as_str).unwrap_or_default().to_string();
        let source = envelope.get("messageId").and_then(Value::as_str).unwrap_or_default().to_string();
        if let Err((code, message)) = self.preflight(&request_id, true) { self.request_error_code(Some(&request_id), &source, code, message, effects); return; }
        match self.resolve_card(&envelope) {
            Ok(resolved) => {
                self.accepted.insert(request_id.clone());
                self.capture = Some(CaptureRequest { envelope: envelope.clone(), card: resolved.get("card").cloned().unwrap_or(Value::Null), phase: CapturePhase::Capturing, operation: None });
                self.send(effects, "reply.accepted", json!({ "requestId":request_id, "eventId":envelope.get("eventId"), "resolvedCardHash":resolved.get("hash"), "queueDepth":self.queue_depth() }));
                effects.push(CoreEffectV2::CaptureStart { request_id }); self.publish_capacity(effects);
            }
            Err(error) => self.request_error(Some(&request_id), &source, &error, effects),
        }
    }

    fn preflight(&self, request_id: &str, voice: bool) -> Result<(), (&'static str, String)> {
        if self.accepted.contains(request_id) { return Err(("duplicate_request", "This requestId is already active.".into())); }
        if !self.ready() { return Err(("service_not_started", "Start RPEngine first.".into())); }
        if self.queue_depth() >= QUEUE_LIMIT { return Err(("capacity_exceeded", "The local request queue is full.".into())); }
        if voice && !self.microphone_enabled { return Err(("microphone_not_enabled", if self.microphone_error.is_empty() { "Click Enable microphone before RimCall voice chat.".into() } else { self.microphone_error.clone() })); }
        if voice && self.capture.is_some() { return Err(("voice_capture_active", "Another voice capture is already active.".into())); }
        Ok(())
    }

    fn start_next_reply(&mut self, effects: &mut Vec<CoreEffectV2>) {
        if self.active.is_some() { return; }
        let Some(queued) = self.queue.pop_front() else { self.publish_capacity(effects); return; };
        let envelope = queued.envelope;
        let request_id = envelope.get("requestId").and_then(Value::as_str).unwrap_or_default().to_string();
        let source_message_id = envelope.get("messageId").and_then(Value::as_str).unwrap_or_default().to_string();
        let language = envelope.pointer("/output/language").and_then(Value::as_str).unwrap_or("en").to_string();
        let voice = envelope.pointer("/output/audio/voice").and_then(Value::as_str).unwrap_or("F4").to_string();
        let wants_audio = envelope.pointer("/output/modalities").and_then(Value::as_array).is_some_and(|values| values.iter().any(|value| value.as_str() == Some("audio")));
        if !supported_tts_language(&language) { self.request_error_code(Some(&request_id), &source_message_id, "unsupported_language", format!("Unsupported language: {language}"), effects); self.start_next_reply(effects); return; }
        if !supported_voice(&voice) { self.request_error_code(Some(&request_id), &source_message_id, "unsupported_voice", format!("Unsupported voice: {voice}"), effects); self.start_next_reply(effects); return; }
        let speech = wants_audio.then(|| SpeechState { language, voice, expression_tags: self.expression_tags.clone(), chunker: SpeechChunkerCore::new(1), pending: VecDeque::new(), inflight: None, started: false, audio_sequence: 0, segment_count: 0, total_chunks: 0, total_bytes: 0, duration_seconds: 0.0, elapsed_ms: 0.0 });
        self.active = Some(ActiveReply { request_id: request_id.clone(), source_message_id, envelope, card: queued.card, raw: String::new(), clean: String::new(), delta_sequence: 0, display: DisplayTextStreamCore::new(), transcript: None, stt_operation: None, gemma_operation: None, gemma_done: false, text_completed: false, speech });
        let audio = self.active.as_ref().and_then(|active| active.envelope.pointer("/event/audio")).cloned();
        if let Some(audio) = audio {
            let language = audio.get("language").and_then(Value::as_str).unwrap_or(&self.selected_language).to_string();
            if !self.model_ready(stt_id(&language)) { self.fail_active("stt_model_not_installed", format!("Moonshine {} is not installed.", language_name(&language)), effects); return; }
            match decode_audio_input_inner(&audio.to_string()) {
                Ok(samples) => { let buffer = self.store_buffer(&samples); let operation = self.next_operation(); self.stt_targets.insert(operation, SttTarget::Reply(request_id)); if let Some(active) = self.active.as_mut() { active.stt_operation = Some(operation); } effects.push(CoreEffectV2::SttInvoke { operation_id: operation, buffer_id: buffer, language }); }
                Err(error) => self.fail_active("request_failed", error, effects),
            }
        } else { self.begin_gemma(None, effects); }
        self.publish_capacity(effects);
    }

    fn begin_gemma(&mut self, transcript: Option<String>, effects: &mut Vec<CoreEffectV2>) {
        let Some(mut active) = self.active.take() else { return; };
        active.transcript = transcript.clone();
        let text = active.envelope.pointer("/event/text").and_then(Value::as_str).unwrap_or_default().trim();
        let transcript = transcript.unwrap_or_default();
        let event_text = match (text.is_empty(), transcript.trim().is_empty()) {
            (true, true) => { self.active = Some(active); self.fail_active("request_failed", "The request contains no usable text or speech.".into(), effects); return; }
            (true, false) => transcript.trim().to_string(),
            (false, true) => text.to_string(),
            (false, false) => format!("{text}\n\nSpoken input from the player:\n{}", transcript.trim()),
        };
        let wants_audio = active.speech.is_some();
        let request = json!({
            "card":active.card, "eventText":event_text,
            "playerDisplayName":active.envelope.pointer("/player/displayName"),
            "outputMode":if wants_audio { "voice" } else { "text" },
            "language":active.envelope.pointer("/output/language").and_then(Value::as_str).unwrap_or("en"),
            "expressionTags":active.speech.as_ref().map(|speech| speech.expression_tags.clone()).unwrap_or_default(),
            "interactionMode":active.envelope.get("interactionMode"), "promptScene":active.envelope.get("promptScene"), "promptDirective":active.envelope.get("promptDirective")
        });
        match assemble_prompt_value(&request) {
            Ok(prompt) => {
                let operation = self.next_operation(); active.gemma_operation = Some(operation);
                effects.push(CoreEffectV2::GemmaInvoke { operation_id: operation, system: prompt.get("system").and_then(Value::as_str).unwrap_or_default().into(), user: prompt.get("user").and_then(Value::as_str).unwrap_or_default().into(), history: prompt.get("history").cloned().unwrap_or_else(|| json!([])) });
                self.diagnostic(effects, "info", "gemma", "Text generation started", None);
                self.active = Some(active);
            }
            Err(error) => { self.active = Some(active); let code = if error.starts_with("prompt_too_large:") { "prompt_too_large" } else { "request_failed" }; self.fail_active(code, error.trim_start_matches("prompt_too_large: ").into(), effects); }
        }
    }

    fn stt_completed(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        let operation = object.get("operationId").and_then(Value::as_u64).unwrap_or(0);
        let Some(target) = self.stt_targets.remove(&operation) else { return; };
        let text = string(object, "text").trim().to_string();
        match target {
            SttTarget::Reply(request_id) => { if self.active.as_ref().is_some_and(|active| active.request_id == request_id && active.stt_operation == Some(operation)) { self.begin_gemma(Some(text), effects); } }
            SttTarget::Capture(request_id) => {
                let Some(capture) = self.capture.take().filter(|capture| capture.envelope.get("requestId").and_then(Value::as_str) == Some(&request_id) && capture.operation == Some(operation)) else { return; };
                let echo_to_mock = capture.envelope.get("integrationId").and_then(Value::as_str) == Some("mock-game")
                    && capture.envelope.pointer("/debug/echoTranscript").and_then(Value::as_bool) == Some(true);
                if echo_to_mock {
                    self.send(effects, "voice.capture.transcript", json!({ "requestId":request_id, "text":text, "language":self.selected_language, "elapsedMs":object.get("elapsedMs").and_then(Value::as_f64).unwrap_or(0.0) }));
                }
                if text.is_empty() { self.accepted.remove(&request_id); self.request_error_code(Some(&request_id), capture.envelope.get("messageId").and_then(Value::as_str).unwrap_or_default(), "empty_speech", "No speech was recognized from this recording.".into(), effects); }
                else {
                    let mut envelope = capture.envelope; if let Some(map) = envelope.as_object_mut() { map.insert("type".into(), Value::String("reply.request".into())); map.insert("event".into(), json!({ "text":text })); }
                    self.queue.push_back(QueuedReply { envelope, card: capture.card }); self.start_next_reply(effects);
                }
            }
        }
        self.publish_capacity(effects);
    }

    fn gemma_delta(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        let operation = object.get("operationId").and_then(Value::as_u64).unwrap_or(0);
        let chunk = string(object, "chunk");
        let Some(mut active) = self.active.take() else { return; };
        if active.gemma_operation != Some(operation) { self.active = Some(active); return; }
        active.raw.push_str(&chunk);
        let clean = active.display.push(&chunk);
        if !clean.is_empty() { self.send(effects, "reply.text.delta", json!({ "requestId":active.request_id, "sequence":active.delta_sequence, "delta":clean })); active.delta_sequence += 1; active.clean.push_str(&clean); }
        if let Some(speech) = active.speech.as_mut() { if let Err(error) = enqueue_chunks(speech, &active.raw, false) { self.active = Some(active); self.fail_active("request_failed", error, effects); return; } }
        self.active = Some(active); self.start_tts_if_needed(effects);
    }

    fn gemma_completed(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        let operation = object.get("operationId").and_then(Value::as_u64).unwrap_or(0);
        let Some(mut active) = self.active.take() else { return; };
        if active.gemma_operation != Some(operation) { self.active = Some(active); return; }
        let tail = active.display.finish();
        if !tail.is_empty() { self.send(effects, "reply.text.delta", json!({ "requestId":active.request_id, "sequence":active.delta_sequence, "delta":tail })); active.delta_sequence += 1; active.clean.push_str(&tail); }
        let generated = object.get("response").and_then(Value::as_str).filter(|value| !value.is_empty()).unwrap_or(&active.raw).to_string();
        if let Some(speech) = active.speech.as_mut() { if let Err(error) = enqueue_chunks(speech, &generated, true) { self.active = Some(active); self.fail_active("request_failed", error, effects); return; } }
        let final_text = display_text_inner(&generated).trim().to_string();
        if !final_text.is_empty() { active.clean = final_text; }
        active.gemma_done = true; active.text_completed = true;
        self.send(effects, "reply.text.completed", json!({ "requestId":active.request_id, "text":active.clean, "tokenCount":object.get("tokenCount").and_then(Value::as_u64).unwrap_or(0), "elapsedMs":object.get("elapsedMs").and_then(Value::as_f64).unwrap_or(0.0) }));
        self.active = Some(active); self.start_tts_if_needed(effects); self.complete_if_ready(effects);
    }

    fn start_tts_if_needed(&mut self, effects: &mut Vec<CoreEffectV2>) {
        let Some(mut active) = self.active.take() else { return; };
        let Some(speech) = active.speech.as_mut() else { self.active = Some(active); return; };
        if speech.inflight.is_none() {
            if let Some((sequence, text)) = speech.pending.pop_front() {
                let allowed = serde_json::to_string(&speech.expression_tags).unwrap_or_else(|_| "[]".into());
                let tagged = synthesis_text_inner(&text, &allowed).unwrap_or(text).trim().to_string();
                if !tagged.is_empty() {
                    let operation = self.next_operation(); speech.inflight = Some((operation, sequence));
                    effects.push(CoreEffectV2::TtsInvoke { operation_id: operation, text: tagged, language: speech.language.clone(), voice: speech.voice.clone(), segment_sequence: sequence });
                }
            }
        }
        self.active = Some(active);
    }

    fn tts_completed(&mut self, event: &Value, samples: Vec<f32>, effects: &mut Vec<CoreEffectV2>) {
        let operation = event.get("operationId").and_then(Value::as_u64).unwrap_or(0);
        let sample_rate = event.get("sampleRate").and_then(Value::as_u64).unwrap_or(0);
        let duration = event.get("duration").and_then(Value::as_f64).unwrap_or(0.0);
        let elapsed = event.get("elapsedMs").and_then(Value::as_f64).unwrap_or(0.0);
        let Some(mut active) = self.active.take() else { return; };
        let Some(speech) = active.speech.as_mut() else { self.active = Some(active); return; };
        let Some((expected, segment_sequence)) = speech.inflight else { self.active = Some(active); return; };
        if expected != operation { self.active = Some(active); return; }
        if sample_rate != 44100 { self.active = Some(active); self.fail_active("unsupported_sample_rate", format!("Supertonic returned {sample_rate} Hz; voice output requires 44100 Hz."), effects); return; }
        let total_bytes = samples.len().saturating_mul(2);
        let chunk_count = total_bytes.div_ceil(PCM_CHUNK_BYTES) as u32;
        let send_start = !speech.started;
        let first_audio_sequence = speech.audio_sequence;
        speech.started = true;
        speech.audio_sequence += chunk_count;
        speech.segment_count += 1;
        speech.total_chunks += chunk_count;
        speech.total_bytes += total_bytes;
        speech.duration_seconds += duration;
        speech.elapsed_ms += elapsed;
        speech.inflight = None;
        let transport_id = self.store_reply_audio_transport(ReplyAudioTransportJob {
            samples,
            request_id: active.request_id.clone(),
            session_id: self.session_id.clone(),
            sample_rate: sample_rate as u32,
            segment_sequence,
            first_audio_sequence,
            send_start,
        });
        self.active = Some(active);

        // Start the next sentence in the TTS worker before main-thread PCM conversion and
        // Base64/WebSocket transport for this sentence. The following transport effect is
        // consume-once and still executes the proprietary conversion inside Rust/WASM.
        self.start_tts_if_needed(effects);
        effects.push(CoreEffectV2::ReplyAudioTransport { transport_id });
        self.complete_if_ready(effects);
    }

    fn complete_if_ready(&mut self, effects: &mut Vec<CoreEffectV2>) {
        let ready = self.active.as_ref().is_some_and(|active| active.gemma_done && active.speech.as_ref().is_none_or(|speech| speech.inflight.is_none() && speech.pending.is_empty()));
        if !ready { return; }
        let active = self.active.take().unwrap();
        if let Some(speech) = active.speech {
            if !speech.started { self.send(effects, "reply.audio.start", json!({ "requestId":active.request_id, "format":"pcm_s16le", "sampleRate":44100, "channels":1 })); }
            self.send(effects, "reply.audio.completed", json!({ "requestId":active.request_id, "chunkCount":speech.total_chunks, "totalBytes":speech.total_bytes, "durationSeconds":speech.duration_seconds, "elapsedMs":speech.elapsed_ms, "segmentCount":speech.segment_count }));
        }
        let modalities = active.envelope.pointer("/output/modalities").cloned().unwrap_or_else(|| json!(["text"]));
        self.send(effects, "reply.completed", json!({ "requestId":active.request_id, "modalities":modalities }));
        self.accepted.remove(&active.request_id); self.publish_capacity(effects); self.start_next_reply(effects);
    }

    fn stop_capture(&mut self, request_id: &str, effects: &mut Vec<CoreEffectV2>) {
        if let Some(capture) = self.capture.as_mut().filter(|capture| capture.envelope.get("requestId").and_then(Value::as_str) == Some(request_id) && matches!(capture.phase, CapturePhase::Capturing)) {
            capture.phase = CapturePhase::Stopping; effects.push(CoreEffectV2::CaptureStop { request_id: request_id.into() });
        }
    }

    fn capture_completed(&mut self, event: &Value, samples: &[f32], effects: &mut Vec<CoreEffectV2>) {
        let request_id = event.get("requestId").and_then(Value::as_str).unwrap_or_default().to_string();
        let valid = self.capture.as_ref().is_some_and(|capture| capture.envelope.get("requestId").and_then(Value::as_str) == Some(&request_id));
        if !valid { return; }
        let echo_to_mock = self.capture.as_ref().is_some_and(|capture| {
            capture.envelope.get("integrationId").and_then(Value::as_str) == Some("mock-game")
                && capture.envelope.pointer("/debug/echoCapturedAudio").and_then(Value::as_bool) == Some(true)
        });
        if echo_to_mock {
            let pcm = float32_to_pcm16(samples);
            let chunks = pcm.chunks(PCM_CHUNK_BYTES).collect::<Vec<_>>();
            self.send(effects, "voice.capture.audio.start", json!({ "requestId":request_id, "format":"pcm_s16le", "sampleRate":16000, "channels":1 }));
            for (sequence, chunk) in chunks.iter().enumerate() {
                self.send(effects, "voice.capture.audio.chunk", json!({ "requestId":request_id, "sequence":sequence, "data":base64_bytes(chunk) }));
            }
            self.send(effects, "voice.capture.audio.completed", json!({ "requestId":request_id, "chunkCount":chunks.len(), "totalBytes":pcm.len(), "durationSeconds":samples.len() as f64 / 16000.0 }));
        }
        let operation = self.next_operation(); let buffer_id = self.store_buffer(samples);
        if let Some(capture) = self.capture.as_mut() { capture.phase = CapturePhase::Transcribing; capture.operation = Some(operation); }
        self.stt_targets.insert(operation, SttTarget::Capture(request_id));
        effects.push(CoreEffectV2::SttInvoke { operation_id: operation, buffer_id, language: self.selected_language.clone() });
    }

    fn capture_level(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        if self.capture.is_some() { self.send(effects, "voice.capture.level", json!({ "requestId":object.get("requestId"), "seconds":object.get("seconds"), "peak":object.get("peak"), "rms":object.get("rms") })); }
    }

    fn capture_state(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        if self.capture.is_none() { return; }
        self.send(effects, "voice.capture.state", json!({ "requestId":object.get("requestId"), "state":object.get("state"), "seconds":object.get("seconds"), "autoEndEnabled":object.get("autoEndEnabled"), "message":object.get("message") }));
        if object.get("state").and_then(Value::as_str) == Some("speech_ended") { self.stop_capture(object.get("requestId").and_then(Value::as_str).unwrap_or_default(), effects); }
    }

    fn capture_failed(&mut self, object: &Map<String, Value>, effects: &mut Vec<CoreEffectV2>) {
        let request_id = string(object, "requestId");
        let source = self.capture.as_ref().and_then(|capture| capture.envelope.get("messageId")).and_then(Value::as_str).unwrap_or_default().to_string();
        self.capture = None; self.accepted.remove(&request_id); self.request_error_code(Some(&request_id), &source, "request_failed", string(object, "message"), effects); self.publish_capacity(effects);
    }

    fn operation_failed(&mut self, object: &Map<String, Value>, runtime: &str, effects: &mut Vec<CoreEffectV2>) {
        let operation = object.get("operationId").and_then(Value::as_u64).unwrap_or(0);
        if let Some(target) = self.stt_targets.remove(&operation) {
            match target {
                SttTarget::Capture(id) => { let source = self.capture.as_ref().and_then(|capture| capture.envelope.get("messageId")).and_then(Value::as_str).unwrap_or_default().to_string(); self.capture = None; self.accepted.remove(&id); self.request_error_code(Some(&id), &source, "request_failed", string(object, "message"), effects); }
                SttTarget::Reply(id) => if self.active.as_ref().is_some_and(|active| active.request_id == id) { self.fail_active("request_failed", string(object, "message"), effects); },
            }
            return;
        }
        let matches_active = self.active.as_ref().is_some_and(|active| active.gemma_operation == Some(operation) || active.speech.as_ref().and_then(|speech| speech.inflight).is_some_and(|value| value.0 == operation));
        if matches_active { self.fail_active("request_failed", format!("{runtime}: {}", string(object, "message")), effects); }
    }

    fn cancel_request(&mut self, request_id: &str, reason: &str, effects: &mut Vec<CoreEffectV2>) {
        if self.capture.as_ref().is_some_and(|capture| capture.envelope.get("requestId").and_then(Value::as_str) == Some(request_id)) {
            self.capture = None; self.accepted.remove(request_id); effects.push(CoreEffectV2::CaptureCancel { request_id: request_id.into() }); self.send(effects, "reply.cancelled", json!({ "requestId":request_id, "reason":reason })); self.publish_capacity(effects); return;
        }
        if let Some(position) = self.queue.iter().position(|queued| queued.envelope.get("requestId").and_then(Value::as_str) == Some(request_id)) {
            self.queue.remove(position); self.accepted.remove(request_id); self.send(effects, "reply.cancelled", json!({ "requestId":request_id, "reason":reason })); self.publish_capacity(effects); return;
        }
        if self.active.as_ref().is_some_and(|active| active.request_id == request_id) {
            if let Some(operation) = self.active.as_ref().and_then(|active| active.gemma_operation) { effects.push(CoreEffectV2::GemmaCancel { operation_id: operation }); }
            self.stt_targets.retain(|_, target| !matches!(target, SttTarget::Reply(id) if id == request_id));
            self.active = None; self.accepted.remove(request_id); self.send(effects, "reply.cancelled", json!({ "requestId":request_id, "reason":reason })); self.publish_capacity(effects); self.start_next_reply(effects); return;
        }
        self.send(effects, "reply.cancelled", json!({ "requestId":request_id, "reason":"not_active" }));
    }

    fn cancel_all(&mut self, effects: &mut Vec<CoreEffectV2>, reason: &str) {
        let ids = self.queue.iter().filter_map(|queued| queued.envelope.get("requestId").and_then(Value::as_str).map(str::to_string)).chain(self.active.as_ref().map(|active| active.request_id.clone())).chain(self.capture.as_ref().and_then(|capture| capture.envelope.get("requestId").and_then(Value::as_str).map(str::to_string))).collect::<Vec<_>>();
        if let Some(operation) = self.active.as_ref().and_then(|active| active.gemma_operation) { effects.push(CoreEffectV2::GemmaCancel { operation_id: operation }); }
        if let Some(id) = self.capture.as_ref().and_then(|capture| capture.envelope.get("requestId")).and_then(Value::as_str) { effects.push(CoreEffectV2::CaptureCancel { request_id: id.into() }); }
        self.queue.clear(); self.active = None; self.capture = None; self.accepted.clear(); self.stt_targets.clear(); self.buffers.clear();
        for id in ids { self.send(effects, "reply.cancelled", json!({ "requestId":id, "reason":reason })); }
    }

    fn fail_active(&mut self, code: &str, message: String, effects: &mut Vec<CoreEffectV2>) {
        let Some(active) = self.active.take() else { return; };
        self.accepted.remove(&active.request_id);
        self.request_error_code(Some(&active.request_id), &active.source_message_id, code, message, effects);
        self.publish_capacity(effects); self.start_next_reply(effects);
    }

    fn request_error(&mut self, request_id: Option<&str>, source: &str, error: &str, effects: &mut Vec<CoreEffectV2>) {
        let code = error.split_once(':').map(|value| value.0).filter(|value| matches!(*value, "card_resync_required" | "invalid_character_card" | "prompt_too_large")).unwrap_or("request_failed");
        let message = error.split_once(':').map(|value| value.1.trim()).unwrap_or(error).to_string();
        self.request_error_code(request_id, source, code, message, effects);
    }

    fn request_error_code(&mut self, request_id: Option<&str>, source: &str, code: &str, message: String, effects: &mut Vec<CoreEffectV2>) {
        self.diagnostic(effects, "error", "request", &message, Some(json!({ "requestId":request_id, "sourceMessageId":source, "code":code })));
        self.send(effects, "request.error", json!({ "requestId":request_id, "sourceMessageId":source, "code":code, "message":message, "retryable":matches!(code, "card_resync_required" | "capacity_exceeded") }));
    }

    fn publish_capacity(&self, effects: &mut Vec<CoreEffectV2>) {
        effects.push(CoreEffectV2::SocketSend { message_type: "capacity.update".into(), payload: json!({ "queueDepth":self.queue_depth(), "queueLimit":QUEUE_LIMIT, "acceptingRequests":self.ready() && self.queue_depth() < QUEUE_LIMIT }), session_id: self.session_id.clone() });
    }

    fn send(&self, effects: &mut Vec<CoreEffectV2>, message_type: &str, payload: Value) {
        effects.push(CoreEffectV2::SocketSend { message_type: message_type.into(), payload, session_id: self.session_id.clone() });
    }

    fn diagnostic(&self, effects: &mut Vec<CoreEffectV2>, level: &str, category: &str, message: &str, details: Option<Value>) {
        effects.push(CoreEffectV2::Diagnostic { level: level.into(), category: category.into(), message: message.into(), details, key: None });
    }

    fn view_model_value(&self) -> Value {
        let ids = self.required_model_ids();
        let statuses = ids.iter().map(|id| self.models.get(id)).collect::<Vec<_>>();
        let checking = statuses.iter().any(|status| status.is_none_or(|status| status.phase == "checking"));
        let downloading = statuses.iter().any(|status| status.is_some_and(|status| matches!(status.phase.as_str(), "downloading" | "verifying")));
        let missing = statuses.iter().any(|status| status.is_none_or(|status| !status.installed()));
        let blocked = self.owner_elsewhere && !self.ownership_owned;
        let (primary_label, primary_detail, primary_disabled, primary_progress, indeterminate): (String, String, bool, Option<f64>, bool) = if blocked {
            ("RPEngine is active in another tab".into(), owner_phase_label(self.owner_elsewhere_phase.as_deref()).into(), true, None, false)
        } else if self.service_started {
            ("Stop RPEngine".into(), if self.connection_state == "connected" { "Local models ready · game connected" } else { "Local models ready · waiting for game" }.into(), false, None, false)
        } else if self.service_phase == "loading" {
            ("Initializing RPEngine".into(), "Opening local model files".into(), true, Some(runtime_progress(&statuses)), false)
        } else if downloading {
            let bytes: u64 = statuses.iter().flatten().map(|status| status.downloaded_bytes).sum(); let total: u64 = statuses.iter().flatten().map(|status| status.total_bytes).sum();
            ("Pause model download".into(), format!("{}% · {} / {}", percent(bytes, total), format_bytes(bytes), format_bytes(total)), false, Some(if total > 0 { bytes as f64 / total as f64 } else { 0.0 }), false)
        } else if missing {
            let resumable = statuses.iter().flatten().any(|status| status.downloaded_bytes > 0);
            let pending = matches!(self.service_phase.as_str(), "acquiring" | "preparing");
            (if pending { if resumable { "Preparing to resume" } else { "Preparing model download" } } else if resumable { "Resume model downloads" } else { "Download models" }.into(), if pending { "Securing this browser tab" } else if resumable { "Continue verified downloads on this device" } else { "Install the local AI models on this device" }.into(), pending, None, pending)
        } else if self.service_phase == "acquiring" {
            ("Securing RPEngine".into(), "Securing this browser tab".into(), true, None, true)
        } else { ("Start RPEngine".into(), "Models installed · ready for local initialization".into(), false, None, false) };
        let model_entries = [(ids[0].clone(), "Language model".to_string()), (ids[1].clone(), "Speech output".to_string()), (ids[2].clone(), format!("Speech input · {}", language_name(&self.selected_language)))]
            .into_iter().map(|(id, role)| self.model_view(&id, role, blocked)).collect::<Vec<_>>();
        json!({
            "connection":{"state":self.connection_state,"label":if self.connection_state == "connected" { "Connected" } else { "Not Connected" },"connected":self.connection_state == "connected"},
            "primary":{"label":primary_label,"detail":primary_detail,"disabled":primary_disabled || checking,"progress":primary_progress,"indeterminate":indeterminate || checking},
            "ownerNotice":{"visible":blocked,"text":"RPEngine is already active in another tab. Use that tab to stop or manage RPEngine."},
            "microphone":{"enabled":self.microphone_enabled,"label":if self.microphone_pending { if self.microphone_enabled { "Disabling microphone…" } else { "Enabling microphone…" } } else if self.microphone_enabled { "Disable microphone" } else { "Enable microphone" },"disabled":self.microphone_pending || self.capture.is_some()},
            "settings":{"language":self.selected_language,"port":self.port,"languageDisabled":self.service_started || matches!(self.service_phase.as_str(), "loading" | "acquiring") || self.owner_elsewhere,"portDisabled":blocked,
                "languages":[{"value":"ar","label":"Arabic"},{"value":"zh","label":"Chinese"},{"value":"en","label":"English"},{"value":"ja","label":"Japanese"},{"value":"ko","label":"Korean"},{"value":"es","label":"Spanish"},{"value":"uk","label":"Ukrainian"},{"value":"vi","label":"Vietnamese"}]},
            "models":model_entries,
            "service":{"phase":self.service_phase,"ready":self.ready()},
            "capacity":{"queueDepth":self.queue_depth(),"queueLimit":QUEUE_LIMIT,"acceptingRequests":self.ready() && self.queue_depth() < QUEUE_LIMIT}
        })
    }

    fn model_view(&self, id: &str, role: String, blocked: bool) -> Value {
        let status = self.models.get(id);
        let installed = status.is_some_and(ModelState::installed); let busy = status.is_some_and(ModelState::busy); let resumable = status.is_some_and(|value| value.downloaded_bytes > 0) && !installed;
        let progress = status.map(|value| value.progress).unwrap_or(0.0);
        let status_text = if status.is_none_or(|value| value.phase == "checking") { "Checking installation".into() }
            else if installed { "Installed".into() } else if status.is_some_and(|value| matches!(value.phase.as_str(), "downloading" | "verifying")) { format!("Installing {}%", (progress * 100.0).round()) }
            else if status.is_some_and(|value| value.phase == "paused") { format!("Ready to resume {}%", (progress * 100.0).round()) }
            else if status.is_some_and(|value| value.phase == "error") { if resumable { format!("Interrupted at {}%", (progress * 100.0).round()) } else { "Installation error".into() } } else { "Not installed".into() };
        let transfer = status.filter(|_| busy || resumable).map(|value| format!("{} / {}{}{}", format_bytes(value.downloaded_bytes), format_bytes(value.total_bytes), value.bytes_per_second.map(|speed| format!(" · {}/s", format_bytes(speed as u64))).unwrap_or_default(), value.eta_seconds.map(|eta| format!(" · {} left", format_duration(eta))).unwrap_or_default())).unwrap_or_else(|| status.filter(|value| value.total_bytes > 0).map(|value| format_bytes(value.total_bytes)).unwrap_or_default());
        let action = if installed { "delete" } else if busy { "cancel" } else { "download" };
        json!({ "id":id,"role":role,"name":display_model_name(id,status.map(|value| value.name.as_str()).unwrap_or(id)),"status":status_text,"transfer":transfer,"progress":progress,"showProgress":resumable || status.is_some_and(|value| matches!(value.phase.as_str(),"downloading"|"verifying"|"paused")),"action":action,"actionLabel":if installed { "Delete" } else if busy { "Cancel" } else if resumable { "Resume" } else { "Download" },"disabled":status.is_some_and(|value| matches!(value.phase.as_str(),"checking"|"loading")) || blocked || matches!(self.service_phase.as_str(),"acquiring"|"preparing") })
    }
}

impl Default for CoreSession { fn default() -> Self { Self::new() } }

fn string(object: &Map<String, Value>, key: &str) -> String { object.get(key).and_then(Value::as_str).unwrap_or_default().to_string() }
fn enqueue_chunks(speech: &mut SpeechState, text: &str, final_chunk: bool) -> Result<(), String> { for chunk in speech.chunker.update_inner(text, final_chunk)? { speech.pending.push_back((chunk.sequence, chunk.text)); } Ok(()) }
fn percent(bytes: u64, total: u64) -> u64 { if total == 0 { 0 } else { ((bytes as f64 / total as f64) * 100.0).round() as u64 } }
fn format_bytes(value: u64) -> String { if value >= 1024_u64.pow(3) { format!("{:.1} GB", value as f64 / 1024_f64.powi(3)) } else if value >= 1024_u64.pow(2) { format!("{:.1} MB", value as f64 / 1024_f64.powi(2)) } else { format!("{:.1} KB", value as f64 / 1024.0) } }
fn format_duration(value: f64) -> String { let seconds = value.max(0.0).round() as u64; if seconds < 60 { format!("{seconds}s") } else { format!("{}m {}s", seconds / 60, seconds % 60) } }
fn runtime_progress(statuses: &[Option<&ModelState>]) -> f64 { let values = statuses.iter().flatten().filter(|value| value.runtime_phase.as_deref() == Some("loading")).collect::<Vec<_>>(); if values.is_empty() { 0.0 } else { values.iter().map(|value| value.runtime_progress.unwrap_or(0.0)).sum::<f64>() / values.len() as f64 } }
fn owner_phase_label(phase: Option<&str>) -> &'static str { match phase { Some("downloading") => "The other tab is installing local models", Some("loading") => "The other tab is initializing local models", Some("preparing") => "The other tab is preparing RPEngine", _ => "Use the active tab to stop or manage RPEngine" } }
fn display_model_name(id: &str, name: &str) -> String { if id == TTS_ID || id.contains("moonshine") { name.trim_start_matches("GemTavern ").to_string() } else { name.to_string() } }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::hash_value;

    fn dispatch(core: &mut CoreSession, event: Value) -> Value { serde_json::from_str(&core.dispatch(&event.to_string()).unwrap()).unwrap() }
    fn effects(batch: &Value) -> &[Value] { batch["effects"].as_array().unwrap() }
    fn effect<'a>(batch: &'a Value, kind: &str) -> &'a Value { effects(batch).iter().find(|value| value["type"] == kind).unwrap_or_else(|| panic!("missing {kind}: {batch}")) }
    fn take_audio_transport(core: &mut CoreSession, batch: &Value) -> Value {
        let transport_id = effect(batch, "replyAudioTransport")["transportId"].as_u64().unwrap() as u32;
        serde_json::from_str(&core.take_reply_audio_transport(transport_id).unwrap()).unwrap()
    }
    fn ready_core() -> CoreSession {
        let mut core = CoreSession::new(); core.service_started = true; core.runtimes_ready = true; core.service_phase = "running".into(); core.connection_state = "connected".into(); core.session_id = Some("session".into()); core.microphone_enabled = true;
        for id in [GEMMA_ID, TTS_ID, stt_id("en")] { core.models.insert(id.into(), ModelState { id:id.into(), name:id.into(), phase:"installed".into(), progress:1.0, downloaded_bytes:1, total_bytes:1, is_resuming:false, bytes_per_second:None, eta_seconds:None, error:None, runtime_phase:Some("ready".into()), runtime_progress:Some(1.0), runtime_error:None }); }
        core
    }
    fn card() -> Value { json!({"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Rika","description":"Calm colonist","personality":"Kind","scenario":"A colony","first_mes":"Hello","mes_example":"","creator_notes":"","system_prompt":"","post_history_instructions":"","alternate_greetings":[],"tags":[],"creator":"test","character_version":"1","extensions":{}}}) }
    fn transfer() -> Value { let card = card(); json!({"format":"chara_card_v2","mode":"snapshot","targetHash":hash_value(&card),"snapshot":card}) }
    fn envelope(kind: &str, id: &str) -> Value { json!({"protocol":"gemtavern.rp_engine","protocolVersion":3,"type":kind,"messageId":format!("m-{id}"),"sessionId":"session","timestamp":"2026-07-15T00:00:00.000Z"}) }
    fn reply(id: &str, audio_input: bool, audio_output: bool) -> Value {
        let mut value = envelope("reply.request", id);
        let map = value.as_object_mut().unwrap();
        let output = if audio_output { json!({"modalities":["text","audio"],"language":"en","audio":{"model":TTS_ID,"voice":"F4","format":"pcm_s16le"}}) } else { json!({"modalities":["text"],"language":"en"}) };
        map.extend(json!({"requestId":id,"eventId":format!("e-{id}"),"integrationId":"test","characterId":"rika","event":if audio_input { json!({"audio":{"format":"pcm_s16le","sampleRate":16000,"channels":1,"language":"en","data":"AAAAAA=="}}) } else { json!({"text":"Hello"}) },"output":output,"card":transfer()}).as_object().unwrap().clone());
        value
    }
    fn socket(core: &mut CoreSession, envelope: Value) -> Value { dispatch(core, json!({"type":"socketMessage","raw":envelope.to_string()})) }

    #[test]
    fn abi_v2_bootstraps_with_model_refresh_and_view() {
        let mut core = CoreSession::new(); let batch = dispatch(&mut core, json!({"type":"bootstrap","language":"ko","port":38471}));
        assert_eq!(batch["abiVersion"], 2); assert!(batch["effects"].as_array().unwrap().iter().any(|effect| effect["type"] == "modelsRefresh")); assert_eq!(core.view_model_value()["settings"]["language"], "ko");
    }

    #[test]
    fn microphone_button_enables_and_disables_the_browser_capture_adapter() {
        let mut core = CoreSession::new();
        let enabling = dispatch(&mut core, json!({"type":"uiToggleMicrophone"}));
        assert_eq!(effect(&enabling, "microphoneEnable")["type"], "microphoneEnable");
        assert_eq!(effect(&enabling, "render")["viewModel"]["microphone"]["label"], "Enabling microphone…");
        assert_eq!(effect(&enabling, "render")["viewModel"]["microphone"]["disabled"], true);
        let duplicate = dispatch(&mut core, json!({"type":"uiToggleMicrophone"}));
        assert!(!effects(&duplicate).iter().any(|value| value["type"] == "microphoneEnable"));

        let enabled = dispatch(&mut core, json!({"type":"microphoneEnabled"}));
        assert_eq!(effect(&enabled, "render")["viewModel"]["microphone"]["label"], "Disable microphone");
        assert_eq!(effect(&enabled, "render")["viewModel"]["microphone"]["enabled"], true);

        let disabling = dispatch(&mut core, json!({"type":"uiToggleMicrophone"}));
        assert_eq!(effect(&disabling, "microphoneDisable")["type"], "microphoneDisable");
        assert_eq!(effect(&disabling, "render")["viewModel"]["microphone"]["label"], "Disabling microphone…");
        let disabled = dispatch(&mut core, json!({"type":"microphoneDisabled"}));
        assert_eq!(effect(&disabled, "render")["viewModel"]["microphone"]["label"], "Enable microphone");
        assert_eq!(effect(&disabled, "render")["viewModel"]["microphone"]["enabled"], false);
    }

    #[test]
    fn reconnect_backoff_is_owned_by_core() {
        let mut core = CoreSession::new(); core.service_started = true;
        let first = dispatch(&mut core, json!({"type":"socketClosed"})); let second = dispatch(&mut core, json!({"type":"socketClosed"}));
        assert!(first.to_string().contains("1000")); assert!(second.to_string().contains("2000"));
    }

    #[test]
    fn hello_preserves_the_host_app_version() {
        let mut core = CoreSession::new();
        dispatch(&mut core, json!({"type":"bootstrap","appVersion":"1.3.0-test","language":"en","port":38471}));
        core.service_started = true;
        let opened = dispatch(&mut core, json!({"type":"socketOpened"}));
        assert_eq!(effect(&opened, "socketSend")["payload"]["clientVersion"], "1.3.0-test");
    }

    #[test]
    fn audio_buffers_are_consume_once() {
        let mut core = CoreSession::new(); let id = core.store_buffer(&[0.25, -0.25]); assert_eq!(core.buffers.remove(&id).unwrap(), vec![0.25, -0.25]); assert!(!core.buffers.contains_key(&id));
    }

    #[test]
    fn fake_host_runs_text_request_to_completion() {
        let mut core = ready_core();
        let accepted = socket(&mut core, reply("text", false, false));
        assert_eq!(effect(&accepted, "socketSend")["messageType"], "ack");
        let operation = effect(&accepted, "gemmaInvoke")["operationId"].as_u64().unwrap();
        let delta = dispatch(&mut core, json!({"type":"gemmaDelta","operationId":operation,"chunk":"Hello there."}));
        assert!(effects(&delta).iter().any(|value| value["messageType"] == "reply.text.delta"));
        let completed = dispatch(&mut core, json!({"type":"gemmaCompleted","operationId":operation,"response":"Hello there.","tokenCount":3,"elapsedMs":25}));
        assert!(effects(&completed).iter().any(|value| value["messageType"] == "reply.text.completed"));
        assert!(effects(&completed).iter().any(|value| value["messageType"] == "reply.completed"));
        assert!(core.active.is_none());
    }

    #[test]
    fn fake_host_runs_audio_input_then_streaming_tts() {
        let mut core = ready_core();
        let accepted = socket(&mut core, reply("audio", true, true));
        let stt = effect(&accepted, "sttInvoke"); let stt_operation = stt["operationId"].as_u64().unwrap(); let buffer_id = stt["bufferId"].as_u64().unwrap() as u32;
        assert!(!core.buffers.remove(&buffer_id).unwrap().is_empty());
        let prompt = dispatch(&mut core, json!({"type":"sttCompleted","operationId":stt_operation,"text":"Spoken hello","elapsedMs":10}));
        let gemma_operation = effect(&prompt, "gemmaInvoke")["operationId"].as_u64().unwrap();
        dispatch(&mut core, json!({"type":"gemmaDelta","operationId":gemma_operation,"chunk":"Hi."}));
        let generation_done = dispatch(&mut core, json!({"type":"gemmaCompleted","operationId":gemma_operation,"response":"Hi.","tokenCount":1,"elapsedMs":20}));
        let tts_operation = effect(&generation_done, "ttsInvoke")["operationId"].as_u64().unwrap();
        let audio = serde_json::from_str::<Value>(&core.dispatch_audio(&json!({"type":"ttsCompleted","operationId":tts_operation,"sampleRate":44100,"duration":0.1,"elapsedMs":5}).to_string(), vec![0.1; 4410]).unwrap()).unwrap();
        let transport = take_audio_transport(&mut core, &audio);
        for message in ["reply.audio.start", "reply.audio.chunk"] { assert!(effects(&transport).iter().any(|value| value["messageType"] == message), "missing {message}: {transport}"); }
        for message in ["reply.audio.completed", "reply.completed"] { assert!(effects(&audio).iter().any(|value| value["messageType"] == message), "missing {message}: {audio}"); }
    }

    #[test]
    fn revised_generated_prefix_fails_an_audio_reply() {
        let mut core = ready_core();
        let accepted = socket(&mut core, reply("divergence", false, true));
        let operation = effect(&accepted, "gemmaInvoke")["operationId"].as_u64().unwrap();
        let streaming = dispatch(&mut core, json!({"type":"gemmaDelta","operationId":operation,"chunk":"Leave now. Another thought"}));
        assert!(effects(&streaming).iter().any(|value| value["type"] == "ttsInvoke"));
        let completed = dispatch(&mut core, json!({"type":"gemmaCompleted","operationId":operation,"response":"Stay here. Another thought","tokenCount":5,"elapsedMs":20}));
        let error = effects(&completed).iter().find(|value| value["messageType"] == "request.error").expect("request error");
        assert_eq!(error["payload"]["code"], "request_failed");
        assert!(error["payload"]["message"].as_str().unwrap().contains("changed after an earlier sentence"));
        assert!(core.active.is_none());
    }

    #[test]
    fn next_tts_sentence_starts_before_previous_audio_transport() {
        let mut core = ready_core();
        let accepted = socket(&mut core, reply("overlap", false, true));
        let gemma_operation = effect(&accepted, "gemmaInvoke")["operationId"].as_u64().unwrap();

        let streaming = dispatch(&mut core, json!({"type":"gemmaDelta","operationId":gemma_operation,"chunk":"First sentence. Second sentence"}));
        let first_tts_operation = effect(&streaming, "ttsInvoke")["operationId"].as_u64().unwrap();
        let generation_done = dispatch(&mut core, json!({"type":"gemmaCompleted","operationId":gemma_operation,"response":"First sentence. Second sentence.","tokenCount":6,"elapsedMs":20}));
        assert!(!effects(&generation_done).iter().any(|value| value["type"] == "ttsInvoke"), "the first sentence must remain the only in-flight TTS operation");

        let first_audio = serde_json::from_str::<Value>(&core.dispatch_audio(&json!({"type":"ttsCompleted","operationId":first_tts_operation,"sampleRate":44100,"duration":0.1,"elapsedMs":5}).to_string(), vec![0.1; 4410]).unwrap()).unwrap();
        let next_tts_index = effects(&first_audio).iter().position(|value| value["type"] == "ttsInvoke").expect("second sentence TTS effect");
        let transport_index = effects(&first_audio).iter().position(|value| value["type"] == "replyAudioTransport").expect("first sentence transport effect");
        assert!(next_tts_index < transport_index, "sentence N+1 must start before sentence N transport: {first_audio}");
        assert!(!effects(&first_audio).iter().any(|value| value["messageType"] == "reply.audio.chunk"), "PCM transport must remain deferred: {first_audio}");

        let first_transport = take_audio_transport(&mut core, &first_audio);
        assert_eq!(effect(&first_transport, "socketSend")["messageType"], "reply.audio.start");
        let first_chunk = effects(&first_transport).iter().find(|value| value["messageType"] == "reply.audio.chunk").unwrap();
        assert_eq!(first_chunk["payload"]["sequence"], 0);
        assert_eq!(first_chunk["payload"]["segmentSequence"], 0);

        let second_tts_operation = effect(&first_audio, "ttsInvoke")["operationId"].as_u64().unwrap();
        let second_audio = serde_json::from_str::<Value>(&core.dispatch_audio(&json!({"type":"ttsCompleted","operationId":second_tts_operation,"sampleRate":44100,"duration":0.1,"elapsedMs":5}).to_string(), vec![0.1; 4410]).unwrap()).unwrap();
        let final_transport_index = effects(&second_audio).iter().position(|value| value["type"] == "replyAudioTransport").unwrap();
        let completed_index = effects(&second_audio).iter().position(|value| value["messageType"] == "reply.audio.completed").unwrap();
        assert!(final_transport_index < completed_index, "the final audio transport must execute before completion: {second_audio}");
        let second_transport = take_audio_transport(&mut core, &second_audio);
        let second_chunk = effects(&second_transport).iter().find(|value| value["messageType"] == "reply.audio.chunk").unwrap();
        assert_eq!(second_chunk["payload"]["sequence"], 1);
        assert_eq!(second_chunk["payload"]["segmentSequence"], 1);
    }

    #[test]
    fn cancellation_removes_queued_and_rejects_stale_completion() {
        let mut core = ready_core();
        let first = socket(&mut core, reply("one", false, false)); let operation = effect(&first, "gemmaInvoke")["operationId"].as_u64().unwrap();
        socket(&mut core, reply("two", false, false));
        let mut cancel_two = envelope("request.cancel", "cancel-two"); cancel_two.as_object_mut().unwrap().insert("requestId".into(), json!("two"));
        let cancelled = socket(&mut core, cancel_two); assert!(effects(&cancelled).iter().any(|value| value["messageType"] == "reply.cancelled"));
        let mut cancel_one = envelope("request.cancel", "cancel-one"); cancel_one.as_object_mut().unwrap().insert("requestId".into(), json!("one")); socket(&mut core, cancel_one);
        let stale = dispatch(&mut core, json!({"type":"gemmaCompleted","operationId":operation,"response":"stale","tokenCount":1,"elapsedMs":1}));
        assert!(!effects(&stale).iter().any(|value| value["messageType"] == "reply.completed"));
    }

    #[test]
    fn voice_capture_flows_through_typed_audio_and_stt() {
        let mut core = ready_core();
        let mut start = envelope("voice.capture.start", "voice"); start.as_object_mut().unwrap().extend(json!({"requestId":"voice","eventId":"e-voice","integrationId":"mock-game","characterId":"rika","output":{"modalities":["text"],"language":"en"},"card":transfer(),"debug":{"echoCapturedAudio":true,"echoTranscript":true}}).as_object().unwrap().clone());
        let accepted = socket(&mut core, start); assert_eq!(effect(&accepted, "captureStart")["requestId"], "voice");
        let mut stop = envelope("voice.capture.stop", "stop"); stop.as_object_mut().unwrap().insert("requestId".into(), json!("voice")); let stopping = socket(&mut core, stop); assert_eq!(effect(&stopping, "captureStop")["requestId"], "voice");
        let captured = serde_json::from_str::<Value>(&core.dispatch_audio(&json!({"type":"captureCompleted","requestId":"voice"}).to_string(), vec![0.2; 1600]).unwrap()).unwrap();
        for message in ["voice.capture.audio.start", "voice.capture.audio.chunk", "voice.capture.audio.completed"] { assert!(effects(&captured).iter().any(|value| value["messageType"] == message), "missing {message}: {captured}"); }
        assert_eq!(effects(&captured).iter().find(|value| value["messageType"] == "voice.capture.audio.completed").unwrap()["payload"]["totalBytes"], 3200);
        let operation = effect(&captured, "sttInvoke")["operationId"].as_u64().unwrap();
        let transcribed = dispatch(&mut core, json!({"type":"sttCompleted","operationId":operation,"text":"Hello","elapsedMs":10}));
        let transcript = effects(&transcribed).iter().find(|value| value["messageType"] == "voice.capture.transcript").unwrap();
        assert_eq!(transcript["payload"]["text"], "Hello");
        assert_eq!(transcript["payload"]["language"], "en");
        assert!(effects(&transcribed).iter().any(|value| value["type"] == "gemmaInvoke"));
    }

    #[test]
    fn captured_artifacts_are_not_echoed_without_the_mock_opt_in() {
        let mut core = ready_core();
        let mut start = envelope("voice.capture.start", "private-voice"); start.as_object_mut().unwrap().extend(json!({"requestId":"private-voice","eventId":"e-private-voice","integrationId":"rimworld","characterId":"rika","output":{"modalities":["text"],"language":"en"},"card":transfer(),"debug":{"echoCapturedAudio":true,"echoTranscript":true}}).as_object().unwrap().clone());
        socket(&mut core, start);
        let captured = serde_json::from_str::<Value>(&core.dispatch_audio(&json!({"type":"captureCompleted","requestId":"private-voice"}).to_string(), vec![0.2; 1600]).unwrap()).unwrap();
        assert!(!effects(&captured).iter().any(|value| value["messageType"].as_str().is_some_and(|kind| kind.starts_with("voice.capture.audio."))));
        let operation = effect(&captured, "sttInvoke")["operationId"].as_u64().unwrap();
        let transcribed = dispatch(&mut core, json!({"type":"sttCompleted","operationId":operation,"text":"Private words","elapsedMs":10}));
        assert!(!effects(&transcribed).iter().any(|value| value["messageType"] == "voice.capture.transcript"));
    }

    #[test]
    fn service_start_and_partial_runtime_failure_are_effect_driven() {
        let mut core = CoreSession::new();
        let statuses = [GEMMA_ID, TTS_ID, stt_id("en")].into_iter().map(|id| json!({"id":id,"name":id,"phase":"installed","progress":1,"downloadedBytes":1,"totalBytes":1})).collect::<Vec<_>>();
        dispatch(&mut core, json!({"type":"modelsSnapshot","models":statuses.clone()}));
        let acquire = dispatch(&mut core, json!({"type":"uiPrimary"})); assert!(effects(&acquire).iter().any(|value| value["type"] == "ownershipAcquire"));
        let loading = dispatch(&mut core, json!({"type":"ownershipAcquired"})); let operation = effect(&loading, "runtimesLoad")["operationId"].as_u64().unwrap();
        for status in statuses {
            let mut status = status;
            status.as_object_mut().unwrap().extend(json!({"runtimePhase":"error","runtimeProgress":0.0,"runtimeError":"asset unavailable"}).as_object().unwrap().clone());
            dispatch(&mut core, json!({"type":"modelStatus","status":status}));
        }
        let failed = dispatch(&mut core, json!({"type":"runtimeFailed","operationId":operation,"message":"TTS failed"}));
        assert!(effects(&failed).iter().any(|value| value["type"] == "runtimesDispose")); assert!(effects(&failed).iter().any(|value| value["type"] == "ownershipRelease")); assert!(!core.service_started);
        dispatch(&mut core, json!({"type":"ownershipReleased"}));
        let retry = dispatch(&mut core, json!({"type":"uiPrimary"}));
        assert!(effects(&retry).iter().any(|value| value["type"] == "ownershipAcquire"));
        let reloading = dispatch(&mut core, json!({"type":"ownershipAcquired"}));
        assert!(effects(&reloading).iter().any(|value| value["type"] == "runtimesLoad"));
        assert!(!effects(&reloading).iter().any(|value| value["type"] == "modelDownload"));
    }

    #[test]
    fn successful_english_v2_load_requests_nonfatal_legacy_cleanup() {
        let mut core = CoreSession::new();
        core.runtime_operation = Some(7);
        core.selected_language = "en".into();
        let loaded = dispatch(&mut core, json!({"type":"runtimeLoaded","operationId":7,"expressionTags":[]}));
        assert_eq!(effect(&loaded, "modelCleanup")["modelId"], LEGACY_ENGLISH_STT_ID);

        let failed_cleanup = dispatch(&mut core, json!({"type":"modelCleanupFailed","modelId":LEGACY_ENGLISH_STT_ID,"message":"OPFS busy"}));
        let diagnostic = effect(&failed_cleanup, "diagnostic");
        assert_eq!(diagnostic["level"], "warn");
        assert!(core.service_started);
        assert!(!effects(&failed_cleanup).iter().any(|value| value["type"] == "runtimesDispose"));
    }

    #[test]
    fn failed_or_non_english_runtime_load_never_removes_legacy_english_base() {
        let mut failed_core = CoreSession::new(); failed_core.runtime_operation = Some(1);
        let failed = dispatch(&mut failed_core, json!({"type":"runtimeFailed","operationId":1,"message":"frontend failed"}));
        assert!(!effects(&failed).iter().any(|value| value["type"] == "modelCleanup"));

        let mut other_language = CoreSession::new(); other_language.runtime_operation = Some(2); other_language.selected_language = "ko".into();
        let loaded = dispatch(&mut other_language, json!({"type":"runtimeLoaded","operationId":2,"expressionTags":[]}));
        assert!(!effects(&loaded).iter().any(|value| value["type"] == "modelCleanup"));
    }

    #[test]
    fn model_download_progress_is_emitted_as_a_keyed_activity_log_entry() {
        let mut core = CoreSession::new();
        core.active_download = Some(GEMMA_ID.into());
        let progress = dispatch(&mut core, json!({"type":"modelStatus","status":{"id":GEMMA_ID,"name":"Gemma 4 E2B","phase":"downloading","progress":0.25,"downloadedBytes":262144,"totalBytes":1048576,"isResuming":false,"bytesPerSecond":131072,"etaSeconds":6}}));
        let diagnostic = effect(&progress, "diagnostic");
        assert_eq!(diagnostic["key"], format!("model-download:{GEMMA_ID}"));
        assert_eq!(diagnostic["category"], "model");
        assert_eq!(diagnostic["message"], "Downloading Gemma 4 E2B — 25% · 256.0 KB / 1.0 MB · 128.0 KB/s · 6s left");

        let installed = dispatch(&mut core, json!({"type":"modelStatus","status":{"id":GEMMA_ID,"name":"Gemma 4 E2B","phase":"installed","progress":1.0,"downloadedBytes":1048576,"totalBytes":1048576}}));
        assert_eq!(effect(&installed, "diagnostic")["message"], "Installed Gemma 4 E2B · 1.0 MB");
    }
}
