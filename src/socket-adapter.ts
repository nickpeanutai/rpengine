import { clientEnvelope, loopbackEndpoint } from './protocol';

export interface SocketAdapterEvents {
  opened: () => void;
  message: (raw: string) => void;
  closed: (code: number, reason: string) => void;
  error: (message: string) => void;
}

export class SocketAdapter {
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
}
