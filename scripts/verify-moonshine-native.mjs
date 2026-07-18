import { statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const submodule = join(root, 'moonshine');
const expectedCommit = '44f8c18dab3f6ab61e2a0a13c22e80f8069d503f';
const required = [
  'core/moonshine-streaming-model.cpp',
  'core/moonshine-streaming-model.h',
  'core/transcriber.cpp',
  'core/bin-tokenizer/bin-tokenizer.cpp',
  'core/bin-tokenizer/bin-tokenizer.h',
];
const setup = 'Run: git submodule update --init --recursive moonshine';

function git(args) {
  return spawnSync('git', ['-C', submodule, ...args], { encoding: 'utf8' });
}

const head = git(['rev-parse', 'HEAD']);
if (head.status !== 0) throw new Error(`The native Moonshine submodule is not initialized. ${setup}`);
if (head.stdout.trim() !== expectedCommit) throw new Error(`Native Moonshine must be pinned to ${expectedCommit}; found ${head.stdout.trim()}.`);

const status = git(['status', '--porcelain', '--untracked-files=all']);
if (status.status !== 0) throw new Error(status.stderr.trim() || 'Could not inspect the native Moonshine submodule.');
if (status.stdout.trim()) throw new Error(`Native Moonshine must remain unmodified; found:\n${status.stdout.trim()}`);

for (const path of required) {
  try { statSync(join(submodule, path)); }
  catch { throw new Error(`Native Moonshine authoritative source is missing: ${path}. ${setup}`); }
}

console.log(`Verified native Moonshine ${expectedCommit}: clean authoritative streaming and tokenizer sources.`);
