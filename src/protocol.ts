import { connection_port_from_fragment, decode_envelope, loopback_endpoint } from './core';
import { RP_ENGINE_PROTOCOL, RP_ENGINE_VERSION, type ServerEnvelope } from './types';

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/** Validation and normalization are performed by the stripped Rust core. */
export function decodeEnvelope(raw: string): ServerEnvelope {
  return JSON.parse(decode_envelope(raw)) as ServerEnvelope;
}

/** UUID and wall-clock acquisition intentionally remain a browser adapter. */
export function clientEnvelope(type: string, sessionId: string | undefined, payload: Record<string, unknown> = {}) {
  return { protocol: RP_ENGINE_PROTOCOL, protocolVersion: RP_ENGINE_VERSION, type, messageId: crypto.randomUUID(), sessionId, timestamp: new Date().toISOString(), ...payload };
}

export function connectionPortFromFragment(fragment = location.hash) {
  const value = connection_port_from_fragment(fragment);
  return Number.isNaN(value) ? undefined : value;
}

export function loopbackEndpoint(port: number) { return loopback_endpoint(port); }
