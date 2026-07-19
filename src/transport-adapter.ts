import { MAX_MESSAGE_BYTES, clientEnvelope } from './protocol';

export type TransportKind = 'websocket' | 'filesystem';

export interface TransportEvents {
  opened: () => void;
  message: (raw: string) => void;
  closed: (code: number, reason: string) => void;
  error: (message: string) => void;
}

export interface ReplyAudioSegment {
  requestId: string;
  sessionId?: string;
  sampleRate: number;
  channels: 1;
  segmentSequence: number;
  spokenText: string;
  durationSeconds: number;
  firstAudioSequence: number;
  sendStart: boolean;
  pcm16Base64: string;
  byteLength: number;
}

export interface TransportAdapter {
  readonly kind: TransportKind;
  connect(port: number): void | Promise<void>;
  disconnect(reason: string, notify?: boolean): void;
  send(type: string, sessionId: string | undefined, payload: Record<string, unknown>): boolean | Promise<boolean>;
  sendAudioSegment(segment: ReplyAudioSegment): boolean | Promise<boolean>;
}

export function envelopeJSON(type: string, sessionId: string | undefined, payload: Record<string, unknown>) {
  const raw = JSON.stringify(clientEnvelope(type, sessionId, payload));
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) throw new Error('RPEngine message exceeds 8 MiB.');
  return raw;
}

export function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
