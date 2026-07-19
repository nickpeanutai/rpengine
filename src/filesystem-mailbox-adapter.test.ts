import { describe, expect, it } from 'vitest';
import { ACTIVE_POLL_MS, FILE_MANIFEST_SCHEMA, FILE_MANIFEST_VERSION, IDLE_POLL_MS, pcm16Wav, readyStems, recoverOutgoing, writeImmutable } from './filesystem-mailbox-adapter';

describe('filesystem mailbox primitives', () => {
  it('pins the manifest version and polling latency', () => {
    expect(FILE_MANIFEST_SCHEMA).toBe('gemtavern.rp_engine.file_transport');
    expect(FILE_MANIFEST_VERSION).toBe(1);
    expect(ACTIVE_POLL_MS).toBe(50);
    expect(IDLE_POLL_MS).toBe(250);
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
});
