import { default_moonshine_language, valid_moonshine_language, valid_rp_engine_port, valid_voice } from './core';
import type { TransportKind } from './transport-adapter';

export const SUPERTONIC_LANGUAGES = [
  'en', 'ko', 'es', 'pt', 'fr', 'de', 'it', 'pl', 'ru', 'nl', 'cs', 'ar', 'zh', 'ja', 'hu', 'tr',
  'fi', 'sk', 'da', 'hr', 'el', 'sv', 'nb', 'he', 'uk', 'id', 'ms', 'vi', 'th', 'ro', 'bg',
] as const;

export const VOICES = ['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'] as const;
export type Voice = typeof VOICES[number];

export const MOONSHINE_LANGUAGES = ['en', 'ar', 'es', 'ja', 'ko', 'vi', 'uk', 'zh'] as const;
export type MoonshineLanguage = typeof MOONSHINE_LANGUAGES[number];
export const LANGUAGE_NAMES: Record<MoonshineLanguage, string> = {
  en: 'English', ar: 'Arabic', es: 'Spanish', ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese', uk: 'Ukrainian', zh: 'Chinese',
};

const LANGUAGE_KEY = 'rp-engine.language';
const VOICE_KEY = 'rp-engine.voice';
const PORT_KEY = 'rp-engine.port';
const TRANSPORT_KEY = 'rp-engine.transport';
export const DEFAULT_RP_ENGINE_PORT = 38471;

function defaultLanguage(): MoonshineLanguage {
  return default_moonshine_language(navigator.language) as MoonshineLanguage;
}

export function loadLanguage(): MoonshineLanguage {
  const stored = localStorage.getItem(LANGUAGE_KEY);
  return stored && valid_moonshine_language(stored) ? stored as MoonshineLanguage : defaultLanguage();
}

export function saveLanguage(value: string) {
  if (!valid_moonshine_language(value)) throw new Error('Unsupported language.');
  localStorage.setItem(LANGUAGE_KEY, value);
}

export function loadVoice(): Voice {
  const stored = localStorage.getItem(VOICE_KEY);
  return stored && valid_voice(stored) ? stored as Voice : 'F4';
}

export function saveVoice(value: Voice) {
  localStorage.setItem(VOICE_KEY, value);
}

export function validRPEnginePort(value: number) {
  return valid_rp_engine_port(value);
}

export function loadRPEnginePort() {
  const stored = Number(localStorage.getItem(PORT_KEY));
  return validRPEnginePort(stored) ? stored : DEFAULT_RP_ENGINE_PORT;
}

export function saveRPEnginePort(value: number) {
  if (!validRPEnginePort(value)) throw new Error('Game connection port must be between 1024 and 65535.');
  localStorage.setItem(PORT_KEY, String(value));
}

export function loadTransportKind(): TransportKind { return localStorage.getItem(TRANSPORT_KEY) === 'filesystem' ? 'filesystem' : 'websocket'; }
export function saveTransportKind(value: TransportKind) { localStorage.setItem(TRANSPORT_KEY, value); }
