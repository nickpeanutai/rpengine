import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDownloadedFileIntegrity, assertStorageCapacity, downloadSegment, ModelIntegrityError } from './model-store';
import type { ModelFile } from './types';

class MemoryFileHandle {
  data: Uint8Array;

  constructor(initial: Uint8Array = new Uint8Array()) {
    this.data = initial.slice();
  }

  async getFile() {
    return new Blob([this.data.slice().buffer as ArrayBuffer]);
  }

  async createWritable() {
    let position = 0;
    return {
      seek: async (next: number) => { position = next; },
      write: async (chunk: Uint8Array) => {
        const needed = position + chunk.byteLength;
        if (needed > this.data.byteLength) {
          const expanded = new Uint8Array(needed);
          expanded.set(this.data);
          this.data = expanded;
        }
        this.data.set(chunk, position);
        position += chunk.byteLength;
      },
      truncate: async (size: number) => {
        const resized = new Uint8Array(size);
        resized.set(this.data.subarray(0, size));
        this.data = resized;
        position = Math.min(position, size);
      },
      close: async () => undefined,
    };
  }
}

function modelFile(size: number, sha256 = ''): ModelFile {
  return { path: 'model.bin', size_bytes: size, sha256, url: 'https://models.example/model.bin' };
}

function bytes(value: string) {
  return new TextEncoder().encode(value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('direct model downloads', () => {
  it('streams a fresh HTTP 200 download', async () => {
    const handle = new MemoryFileHandle();
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes('abcdef'), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const downloaded = await downloadSegment(handle as unknown as FileSystemFileHandle, modelFile(6), 0, new AbortController().signal, () => undefined);

    expect(downloaded).toBe(6);
    expect(new TextDecoder().decode(handle.data)).toBe('abcdef');
    expect(fetchMock).toHaveBeenCalledWith('https://models.example/model.bin', expect.objectContaining({ headers: undefined }));
  });

  it('resumes an interrupted direct-origin download with an HTTP range request', async () => {
    const handle = new MemoryFileHandle(bytes('abc'));
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes('def'), { status: 206 }));
    vi.stubGlobal('fetch', fetchMock);

    await downloadSegment(handle as unknown as FileSystemFileHandle, modelFile(6), 3, new AbortController().signal, () => undefined);

    expect(new TextDecoder().decode(handle.data)).toBe('abcdef');
    expect(fetchMock).toHaveBeenCalledWith('https://models.example/model.bin', expect.objectContaining({ headers: { Range: 'bytes=3-' } }));
  });

  it('restarts from zero when an origin ignores the range header', async () => {
    const handle = new MemoryFileHandle(bytes('old'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes('fresh!'), { status: 200 })));

    await downloadSegment(handle as unknown as FileSystemFileHandle, modelFile(6), 3, new AbortController().signal, () => undefined);

    expect(new TextDecoder().decode(handle.data)).toBe('fresh!');
  });

  it('stops before fetching when cancelled', async () => {
    const handle = new MemoryFileHandle();
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(downloadSegment(handle as unknown as FileSystemFileHandle, modelFile(6), 0, controller.signal, () => undefined)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an artifact that does not match the catalog checksum', async () => {
    const handle = new MemoryFileHandle(bytes('wrong'));
    const file = modelFile(5, '0'.repeat(64));

    await expect(assertDownloadedFileIntegrity(handle as unknown as FileSystemFileHandle, file)).rejects.toBeInstanceOf(ModelIntegrityError);
    await expect(assertDownloadedFileIntegrity(handle as unknown as FileSystemFileHandle, file)).rejects.toThrow('upstream artifact no longer matches');
  });

  it('rejects downloads that cannot fit in persistent storage', () => {
    expect(() => assertStorageCapacity({ quota: 1_000, usage: 900 }, 100)).toThrow('Not enough persistent browser storage');
    expect(() => assertStorageCapacity({ quota: 1_000, usage: 0 }, 100)).not.toThrow();
  });
});
