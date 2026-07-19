import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTransportKind, saveTransportKind } from './settings';

afterEach(() => vi.unstubAllGlobals());

describe('transport preference compatibility', () => {
  it('defaults existing users to WebSocket when no preference exists', () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    expect(loadTransportKind()).toBe('websocket');
    saveTransportKind('filesystem'); expect(loadTransportKind()).toBe('filesystem');
    saveTransportKind('websocket'); expect(loadTransportKind()).toBe('websocket');
  });
});
