import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

const catalogSource = await readFile(new URL('../src/model-catalog.ts', import.meta.url), 'utf8');
const compiled = transpileModule(catalogSource, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
}).outputText;
const catalogModule = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const catalog = catalogModule.MODEL_CATALOG;
const files = catalog.flatMap(model => model.files.map(file => ({ model: model.id, ...file })));

if (process.argv.includes('--smoke')) {
  const gemma = files.find(file => file.model === 'gemma-4-E2B-it-web-litertlm');
  const moonshine = files.find(file => file.path === 'small-streaming-en/frontend.ort');
  await Promise.all([gemma, moonshine].map(smoke));
  console.log('[origins] CORS/range smoke passed for Hugging Face/Xet and Moonshine v2 CDN.');
} else if (process.argv.includes('--full')) {
  for (const [index, file] of files.entries()) await audit(file, index + 1, files.length);
  console.log(`[origins] Verified ${files.length} files (${catalog.length} models) against the bundled size and SHA-256 catalog.`);
} else {
  console.error('Usage: node scripts/verify-model-origins.mjs --smoke|--full');
  process.exitCode = 2;
}

async function smoke(file) {
  if (!file) throw new Error('Smoke-test catalog entry is missing.');
  const headers = await runCurl([
    '--silent', '--show-error', '--fail', '--location', '--retry', '3',
    '--header', 'Origin: https://rpengine.gemtavern.com',
    '--header', 'Range: bytes=0-0',
    '--dump-header', '-', '--output', '/dev/null', file.url,
  ], true);
  if (!/HTTP\/(?:1\.1|2) 206/im.test(headers)) throw new Error(`${file.path} did not return HTTP 206 for a byte range.`);
  if (!/^access-control-allow-origin:\s*(?:\*|https:\/\/rpengine\.gemtavern\.com)\s*$/im.test(headers)) {
    throw new Error(`${file.path} does not allow the production web origin.`);
  }
  if (!new RegExp(`^content-range:\\s*bytes 0-0/${file.size_bytes}\\s*$`, 'im').test(headers)) {
    throw new Error(`${file.path} returned an unexpected Content-Range header.`);
  }
  console.log(`[origins] range+CORS ${file.url}`);
}

async function audit(file, index, total) {
  console.log(`[origins] ${index}/${total} ${file.model} ${file.path}`);
  const hash = createHash('sha256');
  let size = 0;
  const child = spawn('curl', ['--silent', '--show-error', '--fail', '--location', '--retry', '3', file.url], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  for await (const chunk of child.stdout) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  const code = await completed;
  if (code !== 0) throw new Error(`${file.path} download failed: ${stderr.trim() || `curl exited ${code}`}.`);
  const sha256 = hash.digest('hex');
  if (size !== file.size_bytes) throw new Error(`${file.path} size mismatch: expected ${file.size_bytes}, received ${size}.`);
  if (sha256 !== file.sha256) throw new Error(`${file.path} SHA-256 mismatch: expected ${file.sha256}, received ${sha256}.`);
}

function runCurl(args, textOutput = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `curl exited ${code}`));
        return;
      }
      const output = Buffer.concat(stdout);
      resolve(textOutput ? output.toString('utf8') : output);
    });
  });
}
