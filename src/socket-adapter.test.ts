import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocketAdapter } from './socket-adapter';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2;
  readyState = FakeSocket.CONNECTING;
  onopen?: () => void; onmessage?: (event: { data: unknown }) => void; onerror?: () => void; onclose?: (event: { code: number; reason: string }) => void;
  sent: string[] = [];
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(value: string) { this.sent.push(value); }
  close(_code?: number, _reason?: string) { this.readyState = FakeSocket.CLOSING; }
}

afterEach(() => { vi.unstubAllGlobals(); FakeSocket.instances = []; });

describe('mechanical socket adapter', () => {
  it('reports browser events and sends protocol envelopes without retry policy', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const events = { opened: vi.fn(), message: vi.fn(), closed: vi.fn(), error: vi.fn() };
    const adapter = new SocketAdapter(events);
    adapter.connect(38471);
    const socket = FakeSocket.instances[0];
    expect(socket.url).toBe('ws://127.0.0.1:38471/rp-engine/socket');
    socket.readyState = FakeSocket.OPEN; socket.onopen?.(); socket.onmessage?.({ data: 'payload' });
    expect(events.opened).toHaveBeenCalledOnce(); expect(events.message).toHaveBeenCalledWith('payload');
    expect(adapter.send('ack', 'session', { ok: true })).toBe(true);
    expect(JSON.parse(socket.sent[0])).toMatchObject({ protocolVersion: 3, type: 'ack', sessionId: 'session', ok: true });
  });

  it('preserves RimCall-compatible sentence PCM framing and sequence fields', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const adapter = new SocketAdapter({ opened: vi.fn(), message: vi.fn(), closed: vi.fn(), error: vi.fn() });
    adapter.connect(38471);
    const socket = FakeSocket.instances[0]; socket.readyState = FakeSocket.OPEN;
    const pcm = new Uint8Array(32 * 1024 + 2); pcm[0] = 1; pcm[pcm.length - 1] = 2;
    expect(adapter.sendAudioSegment({ requestId: 'request', sessionId: 'session', sampleRate: 44100, channels: 1, segmentSequence: 4, spokenText: 'Hello.', durationSeconds: 0.5, firstAudioSequence: 9, sendStart: true, pcm16Base64: Buffer.from(pcm).toString('base64'), byteLength: pcm.length })).toBe(true);
    const messages = socket.sent.map(raw => JSON.parse(raw));
    expect(messages.map(message => message.type)).toEqual(['reply.audio.start', 'reply.audio.chunk', 'reply.audio.chunk']);
    expect(messages[0]).toMatchObject({ protocolVersion: 3, sessionId: 'session', requestId: 'request', format: 'pcm_s16le', sampleRate: 44100, channels: 1 });
    expect(messages[1]).toMatchObject({ sequence: 9, segmentSequence: 4, segmentChunkSequence: 0, segmentChunkCount: 2 });
    expect(messages[2]).toMatchObject({ sequence: 10, segmentSequence: 4, segmentChunkSequence: 1, segmentChunkCount: 2 });
    expect(Buffer.from(messages[1].data + messages[2].data, 'base64')).not.toHaveLength(0);
    expect(Buffer.concat(messages.slice(1).map(message => Buffer.from(message.data, 'base64')))).toEqual(Buffer.from(pcm));
  });
});
