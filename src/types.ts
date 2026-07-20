export const RP_ENGINE_PROTOCOL = 'gemtavern.rp_engine';
export const RP_ENGINE_VERSION = 3;
export const GEMMA_MODEL_ID = 'gemma-4-E2B-it-web-litertlm';
export const SUPERTONIC_MODEL_ID = 'gemtavern-supertonic-3';
export const MOONSHINE_ENGLISH_V2_MODEL_ID = 'gemtavern-moonshine-stt-english-small-streaming';
export const LEGACY_MOONSHINE_ENGLISH_BASE_MODEL_ID = 'gemtavern-moonshine-stt-english-base';
export const MOONSHINE_MODEL_IDS = {
  en: MOONSHINE_ENGLISH_V2_MODEL_ID,
  ar: 'gemtavern-moonshine-stt-arabic-base',
  es: 'gemtavern-moonshine-stt-spanish-base',
  ja: 'gemtavern-moonshine-stt-japanese-base',
  ko: 'gemtavern-moonshine-stt-korean-base',
  vi: 'gemtavern-moonshine-stt-vietnamese-base',
  uk: 'gemtavern-moonshine-stt-ukrainian-base',
  zh: 'gemtavern-moonshine-stt-chinese-base',
} as const;
export type MoonshineLanguage = keyof typeof MOONSHINE_MODEL_IDS;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type CharacterCardV2Data = JsonObject & {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  character_version: string;
  extensions: JsonObject;
  character_book?: JsonObject;
};

export type CharacterCardV2 = JsonObject & {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: CharacterCardV2Data;
};

export type JsonPatchOperation =
  | { op: 'add' | 'replace' | 'test'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'move' | 'copy'; from: string; path: string };

export type CardTransfer =
  | { format: 'chara_card_v2'; mode: 'snapshot'; snapshot: CharacterCardV2; targetHash?: string }
  | { format: 'chara_card_v2'; mode: 'patch'; patch: JsonPatchOperation[]; baseHash: string; targetHash: string }
  | { format: 'chara_card_v2'; mode: 'reference'; targetHash: string };

export interface EnvelopeBase {
  protocol: typeof RP_ENGINE_PROTOCOL;
  protocolVersion: typeof RP_ENGINE_VERSION;
  type: string;
  messageId: string;
  sessionId?: string;
  timestamp: string;
}

export interface WelcomeEnvelope extends EnvelopeBase {
  type: 'welcome';
  sessionId: string;
  serverVersion: string;
}

export interface CharacterSyncEnvelope extends EnvelopeBase {
  type: 'character.sync';
  integrationId: string;
  characterId: string;
  card: CardTransfer;
}

export interface ReplyRequestEnvelope extends EnvelopeBase {
  type: 'reply.request';
  requestId: string;
  eventId: string;
  integrationId: string;
  characterId: string;
  event: {
    text?: string;
    audio?: {
      format: 'pcm_s16le' | 'pcm_f32le';
      sampleRate: 16000;
      channels: 1;
      data: string;
      language?: MoonshineLanguage;
    };
  };
  output: {
    modalities: Array<'text' | 'audio'>;
    language: string;
    audio?: {
      model: typeof SUPERTONIC_MODEL_ID;
      voice: string;
      format?: 'pcm_s16le';
      processing?: { profile: 'narrowband_voice' | 'cinematic_radio' };
    };
  };
  player?: { displayName?: string };
  card: CardTransfer;
  interactionMode?: InteractionMode;
  promptScene?: PromptScene;
  promptDirective?: PromptDirective;
}

export type InteractionMode = 'auto_event' | 'direct_user';

export interface PromptScene {
  kind: string;
  family: string;
  priority: number;
  label: string;
  sceneLine: string;
}

export interface PromptDirective {
  protocolVersion: number;
  sceneContext: string;
  autoEventGuide: string;
  directUserGuide: string;
  promptVersion?: string;
}

export interface VoiceCaptureStartEnvelope extends EnvelopeBase {
  type: 'voice.capture.start';
  requestId: string;
  eventId: string;
  integrationId: string;
  characterId: string;
  output: ReplyRequestEnvelope['output'];
  player?: { displayName?: string };
  card: CardTransfer;
  interactionMode?: InteractionMode;
  promptScene?: PromptScene;
  promptDirective?: PromptDirective;
  returnTranscript?: boolean;
  silenceBehavior?: 'error' | 'restart';
}

export interface VoiceCaptureStopEnvelope extends EnvelopeBase {
  type: 'voice.capture.stop';
  requestId: string;
}

export interface VoiceCaptureCancelEnvelope extends EnvelopeBase {
  type: 'voice.capture.cancel';
  requestId: string;
}

export interface RequestCancelEnvelope extends EnvelopeBase {
  type: 'request.cancel';
  requestId: string;
}

export type ServerEnvelope = WelcomeEnvelope | CharacterSyncEnvelope | ReplyRequestEnvelope | VoiceCaptureStartEnvelope | VoiceCaptureStopEnvelope | VoiceCaptureCancelEnvelope | RequestCancelEnvelope | EnvelopeBase;

export interface ModelFile {
  path: string;
  size_bytes: number;
  sha256: string;
  url: string;
}

export interface ModelManifest {
  id: string;
  name: string;
  version: string;
  format: string;
  directory_name: string;
  required_files: string[];
  files: ModelFile[];
}

export interface InstalledModel {
  id: string;
  version: string;
  installedAt: string;
  files: ModelFile[];
}

export type ModelPhase = 'missing' | 'paused' | 'checking' | 'downloading' | 'verifying' | 'installed' | 'loading' | 'ready' | 'error';

export interface ModelStatus {
  id: string;
  name: string;
  phase: ModelPhase;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  message: string;
  isResuming?: boolean;
  bytesPerSecond?: number;
  etaSeconds?: number;
  error?: string;
}
