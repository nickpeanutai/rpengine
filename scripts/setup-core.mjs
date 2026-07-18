import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const toolRoot = join(root, '.tools');
const bindgen = join(toolRoot, 'bin', 'wasm-bindgen');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` } });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (!existsSync(join(process.env.HOME ?? '', '.cargo', 'bin', 'rustup'))) {
  console.error('Rust is required. Install rustup from https://rustup.rs, then rerun npm run core:setup.');
  process.exit(1);
}
mkdirSync(toolRoot, { recursive: true });
run('rustup', ['target', 'add', 'wasm32-unknown-unknown', '--toolchain', '1.88.0']);
if (!existsSync(bindgen)) run('cargo', ['install', 'wasm-bindgen-cli', '--version', '0.2.100', '--root', toolRoot, '--locked']);
