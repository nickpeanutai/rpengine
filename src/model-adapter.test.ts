import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelManifest } from './types';

const modelStore = vi.hoisted(() => ({
  deleteModel: vi.fn(),
  fetchModelManifest: vi.fn(),
  installModel: vi.fn(),
  installedModel: vi.fn(),
  resumableModelBytes: vi.fn(),
}));

vi.mock('./model-store', () => modelStore);

import { ModelAdapter } from './model-adapter';

const manifest: ModelManifest = {
  id: 'model',
  name: 'Test model',
  version: 'v1',
  format: 'test',
  directory_name: 'TestModel',
  required_files: ['model.bin'],
  files: [{ path: 'model.bin', size_bytes: 100, sha256: '0'.repeat(64), url: 'https://example.com/model.bin' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  modelStore.fetchModelManifest.mockResolvedValue([manifest]);
  modelStore.installedModel.mockResolvedValue({ id: manifest.id, version: manifest.version, installedAt: '', files: manifest.files });
  modelStore.resumableModelBytes.mockResolvedValue(100);
});

describe('model installation and runtime state', () => {
  it('keeps an installed model installed when runtime initialization fails', async () => {
    const adapter = new ModelAdapter([manifest.id], () => undefined);
    await adapter.refresh();

    adapter.markRuntime(manifest.id, 'loading', 0.4);
    adapter.markRuntime(manifest.id, 'error', 0.4, 'runtime loader failed');

    expect(adapter.snapshot(manifest.id)).toMatchObject({
      phase: 'installed',
      progress: 1,
      downloadedBytes: 100,
      runtimePhase: 'error',
      runtimeProgress: 0.4,
      runtimeError: 'runtime loader failed',
    });
  });

  it('cleans a legacy model without changing visible catalog status', async () => {
    const adapter = new ModelAdapter([manifest.id], () => undefined);
    await adapter.refresh();

    await expect(adapter.cleanup('legacy-model')).resolves.toBe(true);

    expect(modelStore.deleteModel).toHaveBeenCalledWith('legacy-model');
    expect(adapter.snapshot(manifest.id)?.phase).toBe('installed');
  });
});
