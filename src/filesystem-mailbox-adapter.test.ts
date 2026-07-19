import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_POLL_MS, FILE_MANIFEST_SCHEMA, FILE_MANIFEST_VERSION, FileSystemMailboxAdapter, IDLE_POLL_MS, pcm16Wav, readyStems, recoverOutgoing, TEXT_DELTA_BATCH_MS, writeImmutable } from './filesystem-mailbox-adapter';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('filesystem mailbox primitives', () => {
  it('pins the manifest version and polling latency', () => {
    expect(FILE_MANIFEST_SCHEMA).toBe('gemtavern.rp_engine.file_transport');
    expect(FILE_MANIFEST_VERSION).toBe(1);
    expect(ACTIVE_POLL_MS).toBe(50);
    expect(IDLE_POLL_MS).toBe(250);
    expect(TEXT_DELTA_BATCH_MS).toBe(120);
  });

  it('writes a valid mono PCM16 WAV', () => {
    const wav = pcm16Wav(new Uint8Array([0x34, 0x12, 0xcc, 0xed]), 44100, 1);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE');
    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(44100);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(4);
    expect(Array.from(wav.subarray(44))).toEqual([0x34, 0x12, 0xcc, 0xed]);
  });

  it('orders only ready-marked immutable envelopes', () => {
    expect(readyStems(['002-b.json', '003-c.ready', '001-a.ready', '002-b.ready', 'junk'])).toEqual(['001-a', '002-b', '003-c']);
  });

  it('closes JSON before publishing the ready marker', async () => {
    const actions: string[] = []; const existing = new Set<string>();
    const directory = { async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!options?.create && !existing.has(name)) throw new DOMException('missing', 'NotFoundError');
      if (options?.create) existing.add(name);
      return { async createWritable() { return { async write(value: unknown) { actions.push(`write:${name}:${String(value)}`); }, async close() { actions.push(`close:${name}`); } }; } };
    } } as unknown as FileSystemDirectoryHandle;
    await writeImmutable(directory, '001-message', '{"ok":true}');
    expect(actions).toEqual(['write:001-message.json:{"ok":true}', 'close:001-message.json', 'write:001-message.ready:', 'close:001-message.ready']);
    await expect(writeImmutable(directory, '001-message', '{}')).rejects.toThrow('already exists');
  });

  it('recovers non-acknowledgement messages and removes orphaned acknowledgements after reload', async () => {
    const files = new Map<string, string>([
      ['001-request.json', JSON.stringify({ type: 'reply.text.delta', messageId: 'request' })],
      ['001-request.ready', ''],
      ['002-ack.json', JSON.stringify({ type: 'ack', messageId: 'orphaned-ack', acknowledgedMessageId: 'game-message' })],
      ['002-ack.ready', ''],
      ['003-unready.json', JSON.stringify({ type: 'reply.completed', messageId: 'unready' })],
    ]);
    const directory = {
      async *keys() { for (const name of files.keys()) yield name; },
      async getFileHandle(name: string) {
        if (!files.has(name)) throw new DOMException('missing', 'NotFoundError');
        const value = files.get(name)!;
        return { async getFile() { return { size: new TextEncoder().encode(value).byteLength, async text() { return value; } }; } };
      },
      async removeEntry(name: string) { files.delete(name); },
    } as unknown as FileSystemDirectoryHandle;

    expect(Array.from((await recoverOutgoing(directory)).entries())).toEqual([['request', '001-request']]);
    expect(files.has('002-ack.json')).toBe(false);
    expect(files.has('002-ack.ready')).toBe(false);
    expect(files.has('003-unready.json')).toBe(true);
  });

  it('coalesces file-mode text deltas and flushes them before completion', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const directory = memoryDirectory();
    const errors: string[] = [];
    const adapter = new FileSystemMailboxAdapter(undefined, { opened() {}, message() {}, closed() {}, error: value => errors.push(value) });
    Object.assign(adapter as unknown as Record<string, unknown>, { connected: true, outbound: directory.handle });

    expect(adapter.send('reply.text.delta', 'session', { requestId: 'request-1', sequence: 0, delta: 'Hold' })).toBe(true);
    expect(adapter.send('reply.text.delta', 'session', { requestId: 'request-1', sequence: 1, delta: ' on' })).toBe(true);
    await vi.advanceTimersByTimeAsync(TEXT_DELTA_BATCH_MS - 1);
    expect(envelopes(directory.files)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await (adapter as any).writeChain;
    expect(envelopes(directory.files)).toEqual([expect.objectContaining({ type: 'reply.text.delta', requestId: 'request-1', sequence: 0, delta: 'Hold on' })]);

    adapter.send('reply.text.delta', 'session', { requestId: 'request-1', sequence: 2, delta: ' a second.' });
    await adapter.send('reply.text.completed', 'session', { requestId: 'request-1', text: 'Hold on a second.' });
    expect(envelopes(directory.files).slice(-2)).toEqual([
      expect.objectContaining({ type: 'reply.text.delta', requestId: 'request-1', sequence: 1, delta: ' a second.' }),
      expect.objectContaining({ type: 'reply.text.completed', requestId: 'request-1', text: 'Hold on a second.' }),
    ]);
    expect(errors).toEqual([]);
    adapter.disconnect('test complete', false);
  });

  it('does not let buffered text overtake an earlier accepted message', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const directory = memoryDirectory();
    const gate = deferred<void>();
    const adapter = new FileSystemMailboxAdapter(undefined, { opened() {}, message() {}, closed() {}, error() {} });
    Object.assign(adapter as unknown as Record<string, unknown>, { connected: true, outbound: directory.handle, writeChain: gate.promise });

    const accepted = adapter.send('reply.accepted', 'session', { requestId: 'request-1' });
    adapter.send('reply.text.delta', 'session', { requestId: 'request-1', sequence: 0, delta: 'Hello' });
    gate.resolve();
    await accepted;
    expect(envelopes(directory.files)).toEqual([expect.objectContaining({ type: 'reply.accepted', requestId: 'request-1' })]);

    await vi.advanceTimersByTimeAsync(TEXT_DELTA_BATCH_MS);
    await (adapter as any).writeChain;
    expect(envelopes(directory.files).map(envelope => envelope.type)).toEqual(['reply.accepted', 'reply.text.delta']);
    adapter.disconnect('test complete', false);
  });

  it('does not prematurely flush text for capacity updates', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const directory = memoryDirectory();
    const adapter = new FileSystemMailboxAdapter(undefined, { opened() {}, message() {}, closed() {}, error() {} });
    Object.assign(adapter as unknown as Record<string, unknown>, { connected: true, outbound: directory.handle });

    adapter.send('reply.text.delta', 'session', { requestId: 'request-1', sequence: 0, delta: 'Hello' });
    await adapter.send('capacity.update', 'session', { queueDepth: 1 });
    expect(envelopes(directory.files)).toEqual([expect.objectContaining({ type: 'capacity.update' })]);

    await vi.advanceTimersByTimeAsync(TEXT_DELTA_BATCH_MS);
    await (adapter as any).writeChain;
    expect(envelopes(directory.files).map(envelope => envelope.type)).toEqual(['capacity.update', 'reply.text.delta']);
    adapter.disconnect('test complete', false);
  });

  it('drops an unflushed text batch on disconnect', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout });
    const directory = memoryDirectory();
    const adapter = new FileSystemMailboxAdapter(undefined, { opened() {}, message() {}, closed() {}, error() {} });
    Object.assign(adapter as unknown as Record<string, unknown>, { connected: true, outbound: directory.handle });
    adapter.send('reply.text.delta', 'session', { requestId: 'request-1', sequence: 0, delta: 'stale' });
    adapter.disconnect('test disconnect', false);
    await vi.advanceTimersByTimeAsync(TEXT_DELTA_BATCH_MS);
    expect(envelopes(directory.files)).toEqual([]);
  });
});

function memoryDirectory() {
  const files = new Map<string, string>();
  const handle = {
    async *keys() { for (const name of files.keys()) yield name; },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name) && !options?.create) throw new DOMException('missing', 'NotFoundError');
      if (!files.has(name)) files.set(name, '');
      return {
        async getFile() { const value = files.get(name)!; return { size: new TextEncoder().encode(value).byteLength, async text() { return value; } }; },
        async createWritable() {
          return { async write(value: unknown) { files.set(name, typeof value === 'string' ? value : String(value)); }, async close() {} };
        },
      };
    },
    async removeEntry(name: string) { files.delete(name); },
  } as unknown as FileSystemDirectoryHandle;
  return { files, handle };
}

function envelopes(files: Map<string, string>) {
  return Array.from(files.entries()).filter(([name]) => name.endsWith('.json')).sort(([left], [right]) => left.localeCompare(right)).map(([, raw]) => JSON.parse(raw));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
