import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

describe('FireRedVAD worker cold start', () => {
  it('initializes WASM before constructing any WASM-backed VAD object', async () => {
    vi.resetModules();
    const coldBindings = await import('./generated/rp-engine-core/rp_engine_core.js');
    expect(() => new coldBindings.KaldiFbankCore()).toThrow(/kaldifbankcore_new|undefined/);

    const { createVadCoreObjects } = await import('./fire-red-vad-runtime');
    const bytes = await readFile(new URL('./generated/rp-engine-core/rp_engine_core_bg.wasm', import.meta.url));
    const objects = await createVadCoreObjects({ module_or_path: new WebAssembly.Module(bytes) } as never);

    expect(objects.fbank).toBeDefined();
    expect(JSON.parse(objects.policy.start('cold-start'))).toMatchObject({ state: 'listening', autoEndEnabled: true });
  });
});
