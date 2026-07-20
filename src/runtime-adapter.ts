import type { HostAudioEventV4, HostEventV4, WorkerResultV2 } from './core-contract';
import { GemmaClient } from './gemma-client';
import { ModelAdapter } from './model-adapter';
import { SttClient } from './stt-client';
import { TtsClient } from './tts-client';
import { waitForRuntimeAssets } from './runtime-assets';
import { GEMMA_MODEL_ID, MOONSHINE_MODEL_IDS, SUPERTONIC_MODEL_ID, type MoonshineLanguage } from './types';

export class RuntimeAdapter {
  private gemma?: GemmaClient;
  private stt?: SttClient;
  private tts?: TtsClient;
  constructor(
    private readonly models: ModelAdapter,
    private readonly dispatch: (event: HostEventV4) => void,
    private readonly dispatchAudio: (event: HostAudioEventV4, samples: Float32Array) => void,
  ) {}

  async load(operationId: number, language: MoonshineLanguage, defaultVoice: string) {
    await waitForRuntimeAssets();
    this.dispose(); this.create();
    const sttId = MOONSHINE_MODEL_IDS[language];
    this.models.markRuntime(GEMMA_MODEL_ID, 'loading', 0);
    this.models.markRuntime(SUPERTONIC_MODEL_ID, 'loading', 0);
    this.models.markRuntime(sttId, 'loading', 0);
    const results = await Promise.allSettled([this.gemma!.load(operationId), this.tts!.load(operationId, defaultVoice), this.stt!.load(operationId, language)]);
    const ids = [GEMMA_MODEL_ID, SUPERTONIC_MODEL_ID, sttId];
    results.forEach((result, index) => this.models.markRuntime(ids[index], result.status === 'fulfilled' ? 'ready' : 'error', result.status === 'fulfilled' ? 1 : 0, result.status === 'rejected' ? message(result.reason) : undefined));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw new Error(message(failure.reason));
    const tts = results[1].status === 'fulfilled' ? results[1].value as WorkerResultV2 & { expressionTags?: string[] } : undefined;
    return { expressionTags: tts?.expressionTags ?? [] };
  }

  async transcribe(operationId: number, samples: Float32Array, language: MoonshineLanguage) {
    const result = await this.require(this.stt, 'Moonshine').transcribe(operationId, samples, language);
    if (result.type !== 'transcribed') throw new Error('Moonshine returned an unexpected result.');
    this.dispatch({ type: 'sttCompleted', operationId, text: result.text, elapsedMs: result.elapsedMs });
  }
  async generate(operationId: number, system: string, user: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) {
    const result = await this.require(this.gemma, 'Gemma').generate(operationId, system, user, history);
    if (result.type !== 'generated') throw new Error('Gemma returned an unexpected result.');
    this.dispatch({ type: 'gemmaCompleted', operationId, response: result.response, tokenCount: result.tokenCount, elapsedMs: result.elapsedMs });
  }
  async synthesize(operationId: number, text: string, language: string, voice: string) {
    const result = await this.require(this.tts, 'Supertonic').synthesize(operationId, text, language, voice);
    if (result.type !== 'synthesized') throw new Error('Supertonic returned an unexpected result.');
    this.dispatchAudio({ type: 'ttsCompleted', operationId, sampleRate: result.sampleRate, duration: result.duration, elapsedMs: result.elapsedMs }, result.samples);
  }
  cancelGemma(operationId: number) { this.gemma?.cancel(operationId); }
  dispose() { this.gemma?.dispose(); this.stt?.dispose(); this.tts?.dispose(); this.gemma = undefined; this.stt = undefined; this.tts = undefined; }
  private create() {
    this.gemma = new GemmaClient((operationId, chunk) => this.dispatch({ type: 'gemmaDelta', operationId, chunk }));
    this.stt = new SttClient(() => undefined);
    this.tts = new TtsClient(() => undefined);
  }
  private require<T>(value: T | undefined, name: string): T { if (!value) throw new Error(`${name} runtime is not initialized.`); return value; }
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
