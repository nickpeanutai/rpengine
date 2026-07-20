import type { PromptGeneration, PromptResult, PromptSnapshot } from './core-contract';

export class PromptSnapshotStore extends EventTarget {
  readonly entries: PromptSnapshot[] = [];

  start(operationId: number, snapshot: Omit<PromptSnapshot, 'operationId' | 'capturedAt' | 'status'>) {
    this.entries.push({ ...snapshot, operationId, capturedAt: new Date().toISOString(), status: 'generating' });
    if (this.entries.length > 20) this.entries.splice(0, this.entries.length - 20);
    this.changed();
  }

  setGeneration(operationId: number, generation: PromptGeneration) {
    const entry = this.find(operationId); if (!entry) return;
    entry.generation = generation; this.changed();
  }

  finish(operationId: number, status: 'completed' | 'failed' | 'cancelled', result?: PromptResult, error?: string) {
    const entry = this.find(operationId); if (!entry) return;
    entry.status = status;
    if (result) entry.result = result;
    if (error) entry.error = error;
    this.changed();
  }

  clear() { this.entries.splice(0); this.changed(); }
  latest() { return this.entries.at(-1); }
  get(operationId: number | undefined) { return operationId === undefined ? undefined : this.find(operationId); }
  exportValue() { return this.entries.map(entry => structuredClone(entry)); }

  private find(operationId: number) { return this.entries.find(entry => entry.operationId === operationId); }
  private changed() { this.dispatchEvent(new Event('change')); }
}
