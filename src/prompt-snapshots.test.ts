import { describe, expect, it } from 'vitest';
import { PromptSnapshotStore } from './prompt-snapshots';

const snapshot = (requestId: string) => ({
  requestId, integrationId: 'zomboidcall', characterId: 'survivor', received: {}, assembled: {},
});

describe('PromptSnapshotStore', () => {
  it('keeps the latest twenty snapshots and updates them by operation', () => {
    const store = new PromptSnapshotStore();
    for (let operationId = 1; operationId <= 21; operationId++) store.start(operationId, snapshot(`request-${operationId}`));
    expect(store.entries).toHaveLength(20);
    expect(store.entries[0].requestId).toBe('request-2');
    store.setGeneration(21, { model: 'gemma', maxOutputTokens: 256, sampler: 'top_k', temperature: 0.8, topK: 40 });
    store.finish(21, 'completed', { rawResponse: 'Raw', displayText: 'Clean', tokenCount: 1, elapsedMs: 2 });
    expect(store.latest()).toMatchObject({ status: 'completed', generation: { topK: 40 }, result: { rawResponse: 'Raw' } });
  });

  it('records failures and clears all private snapshots', () => {
    const store = new PromptSnapshotStore();
    store.start(1, snapshot('request-1'));
    store.finish(1, 'failed', undefined, 'generation failed');
    expect(store.latest()).toMatchObject({ status: 'failed', error: 'generation failed' });
    store.clear();
    expect(store.entries).toEqual([]);
  });
});
