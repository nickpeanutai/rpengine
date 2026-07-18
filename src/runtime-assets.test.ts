import { describe, expect, it, vi } from 'vitest';
import { waitForRuntimeAssets } from './runtime-assets';

describe('runtime asset readiness', () => {
  it('waits through a cold-start asset gap before allowing runtime initialization', async () => {
    let pass = 0;
    const fetcher = vi.fn(async () => {
      pass += 1;
      return new Response(null, { status: pass <= 24 ? 404 : 200 });
    });
    const delay = vi.fn(async () => undefined);

    await expect(waitForRuntimeAssets({ fetcher, attempts: 3, delay })).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(36);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it('reports a named runtime-asset failure instead of starting model downloads', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(waitForRuntimeAssets({ fetcher, attempts: 2, delay: async () => undefined }))
      .rejects.toThrow('Local inference runtime assets are not ready after 2 checks');
  });
});
