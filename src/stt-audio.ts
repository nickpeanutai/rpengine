import { decode_audio_input, merge_event_text } from './core';
import type { ReplyRequestEnvelope } from './types';

export const MAX_STT_SECONDS = 30;
export function decodeAudioInput(audio: NonNullable<ReplyRequestEnvelope['event']['audio']>) { return decode_audio_input(JSON.stringify(audio)); }
export function mergeEventText(text: string | undefined, transcript: string | undefined) { return merge_event_text(text, transcript); }
