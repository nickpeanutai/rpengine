import { describe, expect, it } from 'vitest';
import { DiagnosticLog } from './diagnostics';

describe('DiagnosticLog activity updates', () => {
  it('updates one progress line instead of appending repeated entries', () => {
    const log = new DiagnosticLog();
    log.upsert('model-download:model-a', 'info', 'model', 'Downloading Model A — 10%');
    log.upsert('model-download:model-a', 'info', 'model', 'Downloading Model A — 40%');

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0].message).toBe('Downloading Model A — 40%');
  });

  it('keeps detailed payloads only for errors', () => {
    const log = new DiagnosticLog();
    log.add('info', 'model', 'Downloading', { internal: 'not exported' });
    log.add('error', 'model', 'Download failed', { message: 'network interrupted' });

    expect(log.entries[0].details).toBeUndefined();
    expect(log.entries[1].details).toEqual({ message: 'network interrupted' });
  });

  it('only includes prompt snapshots when explicitly supplied', async () => {
    const log = new DiagnosticLog();
    expect(JSON.parse(await log.export().text())).not.toHaveProperty('promptSnapshots');
    expect(JSON.parse(await log.export([{ requestId: 'request-1' }]).text()).promptSnapshots).toEqual([{ requestId: 'request-1' }]);
  });
});
