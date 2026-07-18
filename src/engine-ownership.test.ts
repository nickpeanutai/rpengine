import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineOwnership } from './engine-ownership';

class FakeLockManager {
  held = false;

  async request<T>(_name: string, _options: LockOptions, callback: (lock: Lock | null) => T | PromiseLike<T>): Promise<T> {
    if (this.held) return callback(null);
    this.held = true;
    try { return await callback({ name: 'gemtavern-rp-engine-owner-v1', mode: 'exclusive' }); }
    finally { this.held = false; }
  }
}

class FakeBroadcastChannel {
  static channels = new Set<FakeBroadcastChannel>();
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly name: string) { FakeBroadcastChannel.channels.add(this); }
  postMessage(data: unknown) {
    for (const channel of FakeBroadcastChannel.channels) if (channel !== this && channel.name === this.name) channel.onmessage?.({ data } as MessageEvent);
  }
  close() { FakeBroadcastChannel.channels.delete(this); }
}

describe('EngineOwnership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeBroadcastChannel.channels.clear();
    const locks = new FakeLockManager();
    vi.stubGlobal('navigator', { locks } as unknown as Navigator);
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      clearInterval,
      setInterval,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('allows only one owner and transfers ownership after release', async () => {
    const first = new EngineOwnership();
    const second = new EngineOwnership();

    await expect(first.acquire()).resolves.toBe(true);
    expect(first.owned).toBe(true);
    expect(second.ownerElsewhere).toBe(true);
    await expect(second.acquire()).resolves.toBe(false);

    await first.release();
    expect(first.owned).toBe(false);
    await expect(second.acquire()).resolves.toBe(true);
    expect(second.owned).toBe(true);
    await second.release();
  });

});
