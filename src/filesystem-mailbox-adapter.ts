import { MAX_MESSAGE_BYTES } from './protocol';
import { decodeBase64, envelopeJSON, type ReplyAudioSegment, type TransportAdapter, type TransportEvents } from './transport-adapter';

export const FILE_MANIFEST_SCHEMA = 'gemtavern.rp_engine.file_transport';
export const FILE_MANIFEST_VERSION = 1;
export const ACTIVE_POLL_MS = 50;
export const IDLE_POLL_MS = 250;
const STALE_MS = 24 * 60 * 60 * 1000;

interface MailboxManifest {
  schema: typeof FILE_MANIFEST_SCHEMA;
  version: 1;
  integrationId: string;
  mailboxes: { integrationToEngine: string; engineToIntegration: string };
  audio: { format: 'wav_pcm_s16le'; directory: string; slotPattern: string; slotCount: number; sampleRate: number; channels: 1 };
}

export class FileSystemMailboxAdapter implements TransportAdapter {
  readonly kind = 'filesystem' as const;
  private inbound?: FileSystemDirectoryHandle;
  private outbound?: FileSystemDirectoryHandle;
  private audio?: FileSystemDirectoryHandle;
  private manifest?: MailboxManifest;
  private timer?: number;
  private activeUntil = 0;
  private connected = false;
  private polling = false;
  private nextSlot = 0;
  private peerInstanceId = '';
  private audioExhausted = false;
  private readonly outgoing = new Map<string, string>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private root: FileSystemDirectoryHandle | undefined, private readonly events: TransportEvents) {}

  setRoot(root: FileSystemDirectoryHandle) { this.root = root; }

  async requestPermission() {
    if (!this.root) return false;
    return (await this.root.requestPermission({ mode: 'readwrite' })) === 'granted';
  }

  async hasPermission() {
    return !!this.root && (await this.root.queryPermission({ mode: 'readwrite' })) === 'granted';
  }

  async connect(_port: number) {
    this.disconnect('Superseded connection', false);
    if (!this.root) { this.events.error('Choose an integration mailbox folder in Settings.'); return; }
    if (!await this.hasPermission()) { this.events.error('Folder permission requires a button click in Settings.'); return; }
    try {
      this.manifest = await readManifest(this.root);
      this.inbound = await this.root.getDirectoryHandle(this.manifest.mailboxes.integrationToEngine);
      this.outbound = await this.root.getDirectoryHandle(this.manifest.mailboxes.engineToIntegration);
      this.audio = await this.root.getDirectoryHandle(this.manifest.audio.directory);
      this.connected = true;
      await this.cleanupStale();
      this.events.opened();
      this.schedule(0);
    } catch (error) { this.events.error(error instanceof Error ? error.message : String(error)); }
  }

  disconnect(reason: string, notify = true) {
    this.connected = false;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    if (notify) this.events.closed(1000, reason);
  }

  send(type: string, sessionId: string | undefined, payload: Record<string, unknown>) {
    return this.enqueue(() => this.sendNow(type, sessionId, payload));
  }

  private async sendNow(type: string, sessionId: string | undefined, payload: Record<string, unknown>) {
    if (!this.connected || !this.outbound) return false;
    try {
      const raw = envelopeJSON(type, sessionId, payload);
      const envelope = JSON.parse(raw) as { messageId: string };
      const stem = `${Date.now().toString().padStart(13, '0')}-${envelope.messageId}`;
      await writeImmutable(this.outbound, stem, raw);
      if (type === 'ack') window.setTimeout(() => { if (this.outbound) void removePair(this.outbound, stem); }, 2000);
      else this.outgoing.set(envelope.messageId, stem);
      this.activeUntil = performance.now() + 2000;
      return true;
    } catch (error) { this.events.error(error instanceof Error ? error.message : String(error)); return false; }
  }

  sendAudioSegment(segment: ReplyAudioSegment) {
    if (!this.manifest || !this.audio || this.audioExhausted) return false;
    if (this.nextSlot >= this.manifest.audio.slotCount) { this.audioExhausted = true; return false; }
    return this.enqueue(() => this.sendAudioNow(segment)).catch(error => { this.events.error(error instanceof Error ? error.message : String(error)); return false; });
  }

  private async sendAudioNow(segment: ReplyAudioSegment) {
    const manifest = this.manifest;
    if (!manifest || !this.audio || this.audioExhausted) return false;
    const slotIndex = this.nextSlot++;
    const relativePath = manifest.audio.slotPattern.replace('%04d', String(slotIndex).padStart(4, '0'));
    const pcm = decodeBase64(segment.pcm16Base64);
    const wav = pcm16Wav(pcm, segment.sampleRate, segment.channels);
    const file = await this.audio.getFileHandle(relativePath);
    const writable = await file.createWritable(); await writable.write(wav); await writable.close();
    await this.sendNow('reply.audio.segment', segment.sessionId, {
      requestId: segment.requestId, segmentSequence: segment.segmentSequence, spokenText: segment.spokenText,
      slotIndex, path: `${manifest.audio.directory}/${relativePath}`, format: 'wav_pcm_s16le', sampleRate: segment.sampleRate,
      channels: segment.channels, durationSeconds: segment.durationSeconds, byteLength: wav.byteLength, peerInstanceId: this.peerInstanceId,
    });
    return true;
  }

  private enqueue<T>(work: () => Promise<T>) {
    const result = this.writeChain.then(work, work);
    this.writeChain = result.then(() => undefined, () => undefined);
    return result;
  }

  private schedule(delay: number) { if (this.connected) this.timer = window.setTimeout(() => void this.poll(), delay); }

  private async poll() {
    if (!this.connected || !this.inbound || this.polling) return;
    this.polling = true;
    try {
      const listed: string[] = []; for await (const name of this.inbound.keys()) listed.push(name);
      const names = readyStems(listed);
      for (const stem of names) await this.consume(stem);
    } catch (error) { this.events.error(error instanceof Error ? error.message : String(error)); }
    finally { this.polling = false; this.schedule(performance.now() < this.activeUntil ? ACTIVE_POLL_MS : IDLE_POLL_MS); }
  }

  private async consume(stem: string) {
    if (!this.inbound) return;
    const file = await (await this.inbound.getFileHandle(`${stem}.json`)).getFile();
    if (file.size > MAX_MESSAGE_BYTES) { await removePair(this.inbound, stem); this.events.error('RPEngine message exceeds 8 MiB.'); return; }
    let raw = await file.text();
    const envelope = JSON.parse(raw) as Record<string, any>;
    if (envelope.type === 'ack' && typeof envelope.acknowledgedMessageId === 'string') await this.removeAcknowledged(envelope.acknowledgedMessageId);
    if (envelope.type === 'welcome') {
      const nextPeer = typeof envelope.peerInstanceId === 'string' ? envelope.peerInstanceId : '';
      const reportedSlot = Number(envelope.nextAudioSlot) || 0;
      if (nextPeer && nextPeer !== this.peerInstanceId) { this.peerInstanceId = nextPeer; this.nextSlot = reportedSlot; this.audioExhausted = false; }
      else if (nextPeer) this.nextSlot = Math.max(this.nextSlot, reportedSlot);
    }
    if (envelope.type === 'reply.audio.segment.consumed') await this.restoreSilence(Number(envelope.slotIndex));
    if (this.audioExhausted && (envelope.type === 'reply.request' || envelope.type === 'voice.capture.start') && envelope.output) {
      envelope.output.modalities = ['text']; delete envelope.output.audio; raw = JSON.stringify(envelope);
    }
    this.events.message(raw);
    await removePair(this.inbound, stem);
    this.activeUntil = performance.now() + 2000;
  }

  private async removeAcknowledged(messageId: string) {
    if (!this.outbound) return;
    const stem = this.outgoing.get(messageId); if (!stem) return;
    await removePair(this.outbound, stem); this.outgoing.delete(messageId);
  }

  private async restoreSilence(slotIndex: number) {
    if (!this.audio || !this.manifest || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= this.manifest.audio.slotCount) return;
    const name = this.manifest.audio.slotPattern.replace('%04d', String(slotIndex).padStart(4, '0'));
    const writable = await (await this.audio.getFileHandle(name)).createWritable(); await writable.write(pcm16Wav(new Uint8Array(2), this.manifest.audio.sampleRate, 1)); await writable.close();
  }

  private async cleanupStale() {
    for (const directory of [this.inbound, this.outbound]) {
      if (!directory) continue;
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== 'file') continue;
        const file = await (handle as FileSystemFileHandle).getFile();
        if (Date.now() - file.lastModified > STALE_MS) await directory.removeEntry(name);
      }
    }
  }
}

async function readManifest(root: FileSystemDirectoryHandle): Promise<MailboxManifest> {
  const file = await (await root.getFileHandle('manifest.json')).getFile();
  const value = JSON.parse(await file.text()) as MailboxManifest;
  if (value.schema !== FILE_MANIFEST_SCHEMA || value.version !== FILE_MANIFEST_VERSION) throw new Error('Unsupported RPEngine file-transport manifest.');
  if (!value.integrationId || !value.mailboxes?.integrationToEngine || !value.mailboxes?.engineToIntegration || !value.audio?.directory || value.audio.format !== 'wav_pcm_s16le' || value.audio.channels !== 1 || value.audio.slotCount < 1) throw new Error('Invalid RPEngine file-transport manifest.');
  return value;
}

export function readyStems(names: Iterable<string>) { return Array.from(names).filter(name => name.endsWith('.ready')).map(name => name.slice(0, -6)).sort(); }

export async function writeImmutable(directory: FileSystemDirectoryHandle, stem: string, raw: string) {
  const json = await createExclusive(directory, `${stem}.json`);
  const body = await json.createWritable(); await body.write(raw); await body.close();
  const marker = await createExclusive(directory, `${stem}.ready`);
  const ready = await marker.createWritable(); await ready.write(''); await ready.close();
}

async function createExclusive(directory: FileSystemDirectoryHandle, name: string) {
  try { await directory.getFileHandle(name); throw new Error(`Mailbox file already exists: ${name}`); }
  catch (error) { if (error instanceof Error && error.message.startsWith('Mailbox file already exists:')) throw error; if (!(error instanceof DOMException && error.name === 'NotFoundError') && (error as { name?: string })?.name !== 'NotFoundError') throw error; }
  return directory.getFileHandle(name, { create: true });
}

async function removePair(directory: FileSystemDirectoryHandle, stem: string) {
  await directory.removeEntry(`${stem}.ready`).catch(() => undefined);
  await directory.removeEntry(`${stem}.json`).catch(() => undefined);
}

export function pcm16Wav(pcm: Uint8Array, sampleRate: number, channels: 1) {
  const out = new Uint8Array(44 + pcm.byteLength); const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => { for (let index = 0; index < text.length; index += 1) out[offset + index] = text.charCodeAt(index); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, pcm.byteLength, true); out.set(pcm, 44); return out;
}
