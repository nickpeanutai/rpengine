import type { WorkerRequestV2, WorkerResultV2 } from './core-contract';

export interface TtsLoadProgress { current: number; total: number; name: string }
export class TtsClient {
  private readonly worker = new Worker(new URL('./tts.worker.ts', import.meta.url));
  private pending = new Map<number, { resolve: (value: WorkerResultV2) => void; reject: (reason?: unknown) => void }>();
  constructor(private readonly onProgress: (operationId: number, progress: TtsLoadProgress) => void) { this.worker.onmessage = event => this.receive(event.data as WorkerResultV2 & { current?: number; total?: number; name?: string }); this.worker.onerror = event => this.rejectAll(new Error(event.message)); }
  load(operationId: number, voice: string) { return this.request({ type: 'load', operationId, voice }); }
  synthesize(operationId: number, text: string, language: string, voice: string) { return this.request({ type: 'synthesize', operationId, text, language, voice }); }
  dispose() { this.worker.terminate(); this.rejectAll(new Error('Supertonic runtime stopped.')); }
  private request(payload: WorkerRequestV2) { return new Promise<WorkerResultV2>((resolve, reject) => { this.pending.set(payload.operationId, { resolve, reject }); this.worker.postMessage(payload); }); }
  private receive(message: WorkerResultV2 & { current?: number; total?: number; name?: string }) {
    if ((message as { type: string }).type === 'load-progress') { this.onProgress(message.operationId, { current: message.current ?? 0, total: message.total ?? 1, name: message.name ?? '' }); return; }
    const pending = this.pending.get(message.operationId); if (!pending) return;
    if (message.type === 'error') pending.reject(new Error(message.error)); else pending.resolve(message); this.pending.delete(message.operationId);
  }
  private rejectAll(error: Error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
}
