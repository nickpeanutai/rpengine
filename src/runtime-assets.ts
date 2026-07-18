const REQUIRED_RUNTIME_ASSETS = [
  '/wasm/litertlm_wasm_internal.js',
  '/wasm/litertlm_wasm_internal.wasm',
  '/wasm/litertlm_wasm_compat_internal.js',
  '/wasm/litertlm_wasm_compat_internal.wasm',
  '/wasm/litertlm_wasm_asyncify_internal.js',
  '/wasm/litertlm_wasm_compat_asyncify_internal.js',
  '/ort-wasm/ort-wasm-simd-threaded.mjs',
  '/ort-wasm/ort-wasm-simd-threaded.wasm',
  '/ort-wasm/ort-wasm-simd-threaded.jspi.mjs',
  '/ort-wasm/ort-wasm-simd-threaded.jspi.wasm',
  '/ort-wasm/ort-wasm-simd-threaded.asyncify.mjs',
  '/ort-wasm/ort-wasm-simd-threaded.asyncify.wasm',
] as const;

interface RuntimeAssetWaitOptions {
  fetcher?: typeof fetch;
  attempts?: number;
  retryDelayMs?: number;
  delay?: (milliseconds: number) => Promise<void>;
}

export async function waitForRuntimeAssets(options: RuntimeAssetWaitOptions = {}) {
  const fetcher = options.fetcher ?? fetch;
  const attempts = options.attempts ?? 40;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let lastFailure = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const responses = await Promise.all(REQUIRED_RUNTIME_ASSETS.map(path => fetcher(path, { method: 'HEAD', cache: 'no-store' })));
      const failedIndex = responses.findIndex(response => !response.ok);
      if (failedIndex < 0) return;
      lastFailure = `${REQUIRED_RUNTIME_ASSETS[failedIndex]} returned HTTP ${responses[failedIndex].status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await delay(retryDelayMs);
  }
  throw new Error(`Local inference runtime assets are not ready after ${attempts} checks: ${lastFailure}`);
}
