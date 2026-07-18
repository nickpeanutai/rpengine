import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'dist');
const files = [];
const visit = directory => {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) visit(path); else files.push(path);
  }
};
visit(dist);
const maps = files.filter(path => path.endsWith('.map'));
if (maps.length) throw new Error(`Production source maps are forbidden: ${maps.join(', ')}`);
const scripts = files.filter(path => path.endsWith('.js')).map(path => readFileSync(path, 'utf8')).join('\n');
const leakedLogic = [
  "Portray ",
  "Mandatory prompt content requires about",
  "The card patch base does not match this session",
  "You may use only these inline expression tags",
  "JSON Patch array index is out of range",
  "Mandatory prompt content requires about",
  "This requestId is already active",
  "The local request queue is full",
  "FireRedVAD fell ",
  "maxOutputTokens:256",
].filter(fragment => scripts.includes(fragment));
if (leakedLogic.length) throw new Error(`Proprietary logic leaked into production JavaScript: ${leakedLogic.join(', ')}`);
const retiredModelTransport = [
  'model-download.ai-app-dev.com',
  '/v1/models/download-token',
  '/v1/models/files/',
].filter(fragment => scripts.includes(fragment));
if (retiredModelTransport.length) throw new Error(`Retired R2 model transport leaked into production JavaScript: ${retiredModelTransport.join(', ')}`);
const retiredMoonshineRuntime = [
  'MoonshineWorkerCore',
  'MoonshineTokenizerCore',
  'BinTokenizer',
  'decoder_step',
  'accept_logits',
].filter(fragment => scripts.includes(fragment));
if (retiredMoonshineRuntime.length) throw new Error(`Retired custom Moonshine runtime leaked into production JavaScript: ${retiredMoonshineRuntime.join(', ')}`);
const requiredMoonshineV2 = [
  'small-streaming-en',
  'frontend.ort',
  'cross_kv.ort',
  'decoder_kv.ort',
].filter(fragment => !scripts.includes(fragment));
if (requiredMoonshineV2.length) throw new Error(`Moonshine v2 adapter is missing from the production bundle: ${requiredMoonshineV2.join(', ')}`);
const core = files.find(path => /rp_engine_core_bg-[\w-]+\.wasm$/.test(path));
if (!core) throw new Error('The stripped first-party WASM asset is missing from the production bundle.');
const ttsWorkerSource = readFileSync(join(root, 'src/tts.worker.ts'), 'utf8');
if (/createObjectURL|loadVoiceStyle/.test(ttsWorkerSource)) {
  throw new Error('The TTS worker must load parsed voice-style data without blob URLs or URL-based fetches.');
}
const sttWorkerSource = readFileSync(join(root, 'src/stt.worker.ts'), 'utf8');
if (!/language === 'en'\) await englishV2Runtime\.load/.test(sttWorkerSource) || !/language === 'en'[\s\S]*englishV2Runtime\.generate/.test(sttWorkerSource)) {
  throw new Error('The STT worker must route English load and transcription through Moonshine v2.');
}
if (/officialRuntime\.(?:load|generate)\(language(?:,|\))/.test(sttWorkerSource)) {
  throw new Error('The STT worker may not route English through the legacy two-session runtime.');
}
const v2Source = readFileSync(join(root, 'src/moonshine-v2-batch-runtime.ts'), 'utf8');
for (const stage of ['frontend', 'encoder', 'adapter', 'crossKv', 'decoderKv']) {
  if (!v2Source.includes(stage)) throw new Error(`Moonshine v2 adapter is missing the ${stage} session.`);
}
for (const retired of ['src/queue.ts', 'src/model-manager.ts', 'src/rp-engine-client.ts']) {
  try { statSync(join(root, retired)); throw new Error(`Retired TypeScript state-machine module still exists: ${retired}`); }
  catch (error) { if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error; }
}
for (const retired of ['src/bin-tokenizer.ts', 'src/bin-tokenizer.test.ts', 'crates/rp-engine-core/src/token.rs']) {
  try { statSync(join(root, retired)); throw new Error(`Retired custom Moonshine implementation still exists: ${retired}`); }
  catch (error) { if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error; }
}
const mainSource = readFileSync(join(root, 'src/main.ts'), 'utf8');
if (mainSource.split(/\r?\n/).length > 30 || /activeRequest|cancelled|generationQueue|activeSpeech|runtimesReady|serviceStarted/.test(mainSource)) {
  throw new Error('main.ts must remain bootstrap-only; application lifecycle state belongs to Rust/WASM.');
}
if (/HostEventV1|EffectBatchV1|core_abi_version\(\)!==1/.test(scripts.replaceAll(' ', ''))) {
  throw new Error('ABI v1 state-machine contracts leaked into the production bundle.');
}
console.log(`Production audit passed: ${scripts.length} JavaScript characters; first-party core is ${statSync(core).size} bytes.`);
