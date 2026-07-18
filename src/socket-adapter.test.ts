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
});
