import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishFilesAtomically } from './sync-litert-wasm.mjs';

const temporaryDirectories = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rp-engine-runtime-assets-'));
  temporaryDirectories.push(root);
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  mkdirSync(source);
  mkdirSync(destination);
  return { source, destination };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('atomic runtime asset publishing', () => {
  it('keeps the previous complete asset set when staging fails', () => {
    const { source, destination } = fixture();
    writeFileSync(join(source, 'runtime.js'), 'new loader');
    writeFileSync(join(destination, 'runtime.js'), 'old loader');
    writeFileSync(join(destination, 'runtime.wasm'), 'old wasm');

    expect(() => publishFilesAtomically(source, destination, ['runtime.js', 'runtime.wasm'])).toThrow();

    expect(readFileSync(join(destination, 'runtime.js'), 'utf8')).toBe('old loader');
    expect(readFileSync(join(destination, 'runtime.wasm'), 'utf8')).toBe('old wasm');
  });

  it('replaces complete files and removes stale assets only after staging succeeds', () => {
    const { source, destination } = fixture();
    writeFileSync(join(source, 'runtime.js'), 'new loader');
    writeFileSync(join(source, 'runtime.wasm'), 'new wasm');
    writeFileSync(join(destination, 'runtime.js'), 'old loader');
    writeFileSync(join(destination, 'runtime.wasm'), 'old wasm');
    writeFileSync(join(destination, 'stale.wasm'), 'stale');

    publishFilesAtomically(source, destination, ['runtime.js', 'runtime.wasm']);

    expect(readFileSync(join(destination, 'runtime.js'), 'utf8')).toBe('new loader');
    expect(readFileSync(join(destination, 'runtime.wasm'), 'utf8')).toBe('new wasm');
    expect(() => readFileSync(join(destination, 'stale.wasm'))).toThrow();
  });
});
