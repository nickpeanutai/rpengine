/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import { OfficialMoonshineRuntime, type OfficialMoonshineLanguage } from './moonshine-runtime';
import { MoonshineV2BatchRuntime } from './moonshine-v2-batch-runtime';
import type { MoonshineLanguage } from './types';
import type { WorkerRequestV2 } from './core-contract';

declare const self: DedicatedWorkerGlobalScope;

const officialRuntime = new OfficialMoonshineRuntime();
const englishV2Runtime = new MoonshineV2BatchRuntime();

ort.env.wasm.numThreads = Math.min(4, Math.max(1, (self.navigator.hardwareConcurrency || 2) - 2));
ort.env.wasm.wasmPaths = '/ort-wasm/';
self.onmessage = event => { void handle(event.data as WorkerRequestV2); };

async function handle(request: WorkerRequestV2) {
  try {
    if (request.type === 'load') await load(request.operationId, (request.language ?? 'en') as MoonshineLanguage, true);
    else if (request.type === 'transcribe') await transcribe(request);
  } catch (error) {
    self.postMessage({ type: 'error', operationId: request.operationId, error: error instanceof Error ? error.message : String(error) });
  }
}

async function load(operationId: number, language: MoonshineLanguage, notify: boolean) {
  try {
    const progress = (current: number, total: number, name: string) => self.postMessage({ type: 'load-progress', operationId, current, total, name });
    if (language === 'en') await englishV2Runtime.load(progress);
    else await officialRuntime.load(language as OfficialMoonshineLanguage, progress);
  } catch (error) {
    const runtimeName = language === 'en' ? 'Moonshine v2 Small' : 'Official Moonshine Base';
    throw new Error(`${runtimeName} model loading failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (notify) self.postMessage({ type: 'loaded', operationId, language, threads: ort.env.wasm.numThreads, executionProvider: 'wasm' });
}

async function transcribe(request: Extract<WorkerRequestV2, { type: 'transcribe' }>) {
  const started = performance.now();
  try {
    const language = request.language as MoonshineLanguage;
    await load(request.operationId, language, false);
    const text = language === 'en'
      ? (await englishV2Runtime.generate(request.samples)).text
      : await officialRuntime.generate(request.samples, language as OfficialMoonshineLanguage);
    self.postMessage({ type: 'transcribed', operationId: request.operationId, text, language, audioSeconds: request.samples.length / 16000, elapsedMs: Math.round(performance.now() - started) });
  } catch (error) {
    throw new Error(`Official Moonshine transcription failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
