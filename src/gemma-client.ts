import type { WorkerRequestV2, WorkerResultV2 } from './core-contract';

export class GemmaClient {
  private readonly worker = new Worker(new URL('./gemma.worker.ts', import.meta.url));
  private pending = new Map<number, { resolve: (value: WorkerResultV2) => void; reject: (reason?: unknown) => void }>();
  constructor(
    private readonly onChunk: (operationId: number, chunk: string) => void,
    private readonly onGenerationStarted: (message: Extract<WorkerResultV2, { type: 'generationStarted' }>) => void,
  ) {
    this.worker.onmessage = event => this.receive(event.data as WorkerResultV2);
    this.worker.onerror = event => this.rejectAll(new Error(event.message));
  }
  load(operationId: number) { return this.request({ type: 'load', operationId }); }
  generate(operationId: number, system: string, user: string, history: Array<{ role: 'user' | 'assistant'; content: string }>) { return this.request({ type: 'generate', operationId, system, user, history }); }
  cancel(operationId: number) { this.pending.delete(operationId); this.worker.postMessage({ type: 'cancel', operationId } satisfies WorkerRequestV2); }
  dispose() { this.worker.terminate(); this.rejectAll(new Error('Gemma runtime stopped.')); }
  private request(payload: WorkerRequestV2) { return new Promise<WorkerResultV2>((resolve, reject) => { this.pending.set(payload.operationId, { resolve, reject }); this.worker.postMessage(payload); }); }
  private receive(message: WorkerResultV2) {
    if (message.type === 'chunk') { this.onChunk(message.operationId, message.chunk); return; }
    if (message.type === 'generationStarted') { this.onGenerationStarted(message); return; }
    const pending = this.pending.get(message.operationId); if (!pending) return;
    if (message.type === 'error') pending.reject(new Error(message.error)); else pending.resolve(message);
    this.pending.delete(message.operationId);
  }
  private rejectAll(error: Error) { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
}
