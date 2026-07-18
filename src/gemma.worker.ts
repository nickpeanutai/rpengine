/// <reference lib="webworker" />
import { Backend, Engine, SamplerType, loadLiteRtLm, type Conversation, type EngineSettings } from '@litert-lm/core';
import { GemmaWorkerCore, initializeCore } from './core';
import { getInstalledModelFile } from './model-store';
import type { WorkerRequestV2 } from './core-contract';

declare const self: DedicatedWorkerGlobalScope;

let engine: Engine | undefined;
let conversation: Conversation | undefined;
let runtimeLoaded = false;
let policy: GemmaWorkerCore;

self.onmessage = event => {
  const request = event.data as WorkerRequestV2;
  if (request.type === 'cancel') {
    if (policy?.cancel(BigInt(request.operationId))) conversation?.cancel();
    return;
  }
  void handle(request);
};

async function handle(request: WorkerRequestV2) {
  try {
    await initializeCore();
    policy ??= new GemmaWorkerCore();
    if (request.type === 'load') await load(request.operationId);
    else if (request.type === 'generate') await generate(request);
  } catch (error) {
    self.postMessage({ type: 'error', operationId: request.operationId, error: error instanceof Error ? error.message : String(error) });
  }
}

async function load(operationId: number) {
  const plan = JSON.parse(policy.load_plan()) as { modelId: string; path: string; maxNumTokens: number; maxTopK: number; numDecodeStepsPerSync: number };
  if (!runtimeLoaded) {
    (self as DedicatedWorkerGlobalScope & { Module?: { locateFile: (filename: string) => string } }).Module = {
      locateFile: filename => new URL(`/wasm/${filename}`, self.location.origin).href,
    };
    await loadLiteRtLm('/wasm');
    runtimeLoaded = true;
  }
  if (engine) await engine.delete();
  const model = await getInstalledModelFile(plan.modelId, plan.path);
  const settings: EngineSettings = {
    model: model.stream(), backend: Backend.GPU_ARTISAN,
    mainExecutorSettings: {
      maxNumTokens: plan.maxNumTokens, samplerBackend: Backend.GPU_ARTISAN,
      backendConfig: { num_output_candidates: 1, wait_for_weight_uploads: false, num_decode_steps_per_sync: plan.numDecodeStepsPerSync, sequence_batch_size: 0, supported_lora_ranks: [], max_top_k: plan.maxTopK, enable_decode_logits: false, enable_external_embeddings: false, use_submodel: false },
    },
  };
  engine = await Engine.create(settings);
  policy.mark_loaded();
  self.postMessage({ type: 'loaded', operationId });
}

async function generate(request: Extract<WorkerRequestV2, { type: 'generate' }>) {
  if (!engine) throw new Error('Gemma is not loaded.');
  const plan = JSON.parse(policy.generation_plan(BigInt(request.operationId))) as { maxOutputTokens: number; temperature: number; k: number };
  const started = performance.now();
  conversation = await engine.createConversation({
    sessionConfig: { maxOutputTokens: plan.maxOutputTokens, samplerParams: { type: SamplerType.TOP_K, temperature: plan.temperature, k: plan.k } },
    preface: { messages: [{ role: 'system', content: request.system }, ...request.history] },
  });
  let response = '';
  try {
    const reader = conversation.sendMessageStreaming({ role: 'user', content: request.user }).getReader();
    while (policy.accepts(BigInt(request.operationId))) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = readChunk(value); response += chunk;
      if (chunk) self.postMessage({ type: 'chunk', operationId: request.operationId, chunk });
    }
    if (!policy.accepts(BigInt(request.operationId))) return;
    const tokenCount = await conversation.getTokenCount();
    const benchmark = await conversation.getBenchmarkInfo();
    policy.finish(BigInt(request.operationId));
    self.postMessage({ type: 'generated', operationId: request.operationId, response: response.trim(), tokenCount, elapsedMs: Math.round(performance.now() - started), benchmark });
  } finally {
    await conversation.delete();
    conversation = undefined;
  }
}

function readChunk(value: unknown) {
  const content = (value as { content?: unknown })?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => typeof item === 'string' ? item : item && typeof item === 'object' && 'text' in item ? String((item as { text?: unknown }).text ?? '') : '').join('');
}
