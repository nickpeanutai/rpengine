import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const submodule = join(root, 'moonshine-js');
const patch = join(root, 'patches/MoonshineJS/rp-engine-web.patch');
const expectedCommit = '59c9c83669e464d3e3f00d85c850d4327bef9009';
const setup = 'Run: git submodule update --init --recursive moonshine-js && git -C moonshine-js apply ../patches/MoonshineJS/rp-engine-web.patch';

function git(args, options = {}) {
  return spawnSync('git', ['-C', submodule, ...args], { encoding: 'utf8', ...options });
}

const head = git(['rev-parse', 'HEAD']);
if (head.status !== 0) throw new Error(`The Moonshine JS submodule is not initialized. ${setup}`);
if (head.stdout.trim() !== expectedCommit) {
  throw new Error(`Moonshine JS must be pinned to ${expectedCommit}; found ${head.stdout.trim()}.`);
}

const reverse = git(['apply', '--reverse', '--check', patch]);
if (reverse.status !== 0) throw new Error(`The RPEngine Moonshine JS patch is not applied cleanly. ${setup}`);

const changed = git(['diff', '--name-only']);
if (changed.status !== 0) throw new Error(changed.stderr.trim() || 'Could not inspect the Moonshine JS submodule.');
const changedFiles = changed.stdout.trim().split(/\r?\n/).filter(Boolean);
if (changedFiles.length !== 1 || changedFiles[0] !== 'src/model.ts') {
  throw new Error(`Unexpected Moonshine JS submodule changes: ${changedFiles.join(', ') || '(none)'}.`);
}

const upstream = git(['show', 'HEAD:src/model.ts']);
if (upstream.status !== 0) throw new Error(upstream.stderr.trim() || 'Could not read upstream MoonshineModel.');
const current = readFileSync(join(submodule, 'src/model.ts'), 'utf8');
const marker = '    public async generate(audio: Float32Array): Promise<string> {';
const upstreamGenerate = upstream.stdout.slice(upstream.stdout.indexOf(marker));
const currentGenerate = current.slice(current.indexOf(marker));
if (!upstreamGenerate || upstreamGenerate !== currentGenerate) {
  throw new Error('The patched MoonshineModel.generate() implementation differs from pinned upstream.');
}

console.log(`Verified Moonshine JS ${expectedCommit}: parent patch applied; generate() matches upstream.`);
