import { clientEnvelope, loopbackEndpoint } from './protocol';
import { decodeBase64, type ReplyAudioSegment, type TransportAdapter, type TransportEvents } from './transport-adapter';

export type SocketAdapterEvents = TransportEvents;

export class SocketAdapter implements TransportAdapter {
  readonly kind = 'websocket' as const;
  private socket?: WebSocket;
  private token = 0;
  constructor(private readonly events: SocketAdapterEvents) {}
  connect(port: number) {
    this.disconnect('Superseded connection', false);
    const token = ++this.token;
    const socket = new WebSocket(loopbackEndpoint(port)); this.socket = socket;
    socket.onopen = () => { if (token === this.token) this.events.opened(); else socket.close(3000, 'Superseded connection'); };
    socket.onmessage = event => { if (token === this.token) this.events.message(String(event.data)); };
    socket.onerror = () => { if (token === this.token) this.events.error('Could not connect to the local game integration.'); };
    socket.onclose = event => { if (token === this.token) { this.socket = undefined; this.events.closed(event.code, event.reason); } };
  }
  disconnect(reason: string, notify = true) { const socket = this.socket; this.socket = undefined; this.token += 1; if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, reason); if (notify) this.events.closed(1000, reason); }
  send(type: string, sessionId: string | undefined, payload: Record<string, unknown>) { if (this.socket?.readyState !== WebSocket.OPEN) return false; this.socket.send(JSON.stringify(clientEnvelope(type, sessionId, payload))); return true; }
  sendAudioSegment(segment: ReplyAudioSegment) {
    if (segment.sendStart) this.send('reply.audio.start', segment.sessionId, { requestId: segment.requestId, format: 'pcm_s16le', sampleRate: segment.sampleRate, channels: 1 });
    const pcm = decodeBase64(segment.pcm16Base64);
    const chunkSize = 32 * 1024;
    const chunkCount = Math.ceil(pcm.byteLength / chunkSize);
    for (let index = 0; index < chunkCount; index += 1) {
      const data = pcm.subarray(index * chunkSize, Math.min(pcm.byteLength, (index + 1) * chunkSize));
      let binary = ''; for (const byte of data) binary += String.fromCharCode(byte);
      this.send('reply.audio.chunk', segment.sessionId, { requestId: segment.requestId, sequence: segment.firstAudioSequence + index, segmentSequence: segment.segmentSequence, segmentChunkSequence: index, segmentChunkCount: chunkCount, data: btoa(binary) });
    }
    return true;
  }
}
