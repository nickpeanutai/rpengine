import { readFile } from 'node:fs/promises';
import { initializeCore } from '../src/core';

const bytes = await readFile(new URL('../src/generated/rp-engine-core/rp_engine_core_bg.wasm', import.meta.url));
await initializeCore({ module_or_path: new WebAssembly.Module(bytes) } as never);
