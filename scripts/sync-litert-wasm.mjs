import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Stage every file before replacing any live asset. Each final rename is atomic,
 * so an already-running dev server always sees either the previous complete file
 * or the new complete file, never a missing or partially copied asset.
 */
export function publishFilesAtomically(source, destination, fileNames) {
  mkdirSync(destination, { recursive: true });
  const desired = new Set(fileNames);
  const staged = [];
  try {
    for (const name of fileNames) {
      const temporary = join(destination, `.${name}.${randomUUID()}.tmp`);
      copyFileSync(join(source, name), temporary);
      staged.push({ name, temporary });
    }
    // Publish binaries first and their JS/MJS loaders last.
    staged.sort((left, right) => Number(/\.[cm]?js$/.test(left.name)) - Number(/\.[cm]?js$/.test(right.name)));
    for (const { name, temporary } of staged) renameSync(temporary, join(destination, name));
    for (const name of readdirSync(destination)) {
      if (!desired.has(name)) rmSync(join(destination, name), { force: true, recursive: true });
    }
  } finally {
    for (const { temporary } of staged) rmSync(temporary, { force: true });
  }
}

export function syncRuntimeAssets() {
  const packageJson = require.resolve('@litert-lm/core/package.json');
  const source = join(dirname(packageJson), 'wasm');
  const destination = join(root, 'public', 'wasm');
  const ortEntry = require.resolve('onnxruntime-web');
  const ortSource = dirname(ortEntry);
  const ortDestination = join(root, 'public', 'ort-wasm');

  if (!existsSync(source)) throw new Error(`LiteRT-LM WASM directory not found: ${source}`);

  // Pages limits individual static assets to 25 MiB. The Asyncify loaders stay
  // local, while their larger WASM companions are served by the Pages R2 binding.
  const omittedLiteRtFiles = new Set([
    'litertlm_wasm_asyncify_internal.wasm',
    'litertlm_wasm_compat_asyncify_internal.wasm',
  ]);
  const liteRtFiles = readdirSync(source).filter(name => !omittedLiteRtFiles.has(name));
  publishFilesAtomically(source, destination, liteRtFiles);

  const ortFiles = [
    'ort-wasm-simd-threaded.wasm',
    'ort-wasm-simd-threaded.jspi.wasm',
    'ort-wasm-simd-threaded.asyncify.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.jspi.mjs',
    'ort-wasm-simd-threaded.asyncify.mjs',
  ];
  publishFilesAtomically(ortSource, ortDestination, ortFiles);
  console.log('Synced LiteRT-LM and ONNX Runtime WASM assets atomically.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) syncRuntimeAssets();
