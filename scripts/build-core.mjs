import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const manifest = join(root, 'crates/rp-engine-core/Cargo.toml');
const input = join(root, 'crates/rp-engine-core/target/wasm32-unknown-unknown/release/rp_engine_core.wasm');
const output = join(root, 'src/generated/rp-engine-core');
const bindgen = join(root, '.tools/bin/wasm-bindgen');
const localWasmOpt = join(root, 'node_modules/binaryen/bin/wasm-opt');
const hoistedWasmOpt = join(root, '../node_modules/binaryen/bin/wasm-opt');
const wasmOpt = existsSync(localWasmOpt) ? localWasmOpt : hoistedWasmOpt;
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (!existsSync(bindgen)) {
  console.error('Missing the pinned wasm-bindgen CLI. Run npm run core:setup once.');
  process.exit(1);
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
run('cargo', ['run', '--quiet', '--manifest-path', manifest, '--bin', 'export-contracts', '--', join(output, 'contracts.ts')]);
run('cargo', ['build', '--manifest-path', manifest, '--target', 'wasm32-unknown-unknown', '--release', '--locked']);
run(bindgen, [input, '--target', 'web', '--out-dir', output, '--out-name', 'rp_engine_core', '--no-demangle']);
if (existsSync(wasmOpt)) {
  const wasm = join(output, 'rp_engine_core_bg.wasm');
  run(wasmOpt, ['-Oz', '--enable-bulk-memory', '--enable-bulk-memory-opt', '--enable-nontrapping-float-to-int', '--enable-sign-ext', '--enable-mutable-globals', '--strip-debug', '--strip-producers', wasm, '-o', wasm]);
}
run(process.execPath, [join(root, 'scripts/verify-core-wasm.mjs')]);
