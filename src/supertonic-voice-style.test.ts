import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The vendored Supertonic reference is intentionally plain JavaScript.
import { voiceStyleFromData } from './vendor/supertonic-helper.js';

describe('Supertonic voice style data loading', () => {
  it('constructs tensors directly without fetching a URL', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const style = voiceStyleFromData([{
        style_ttl: { dims: [1, 2, 2], data: [[[1, 2], [3, 4]]] },
        style_dp: { dims: [1, 1, 3], data: [[[5, 6, 7]]] },
      }]);

      expect(style.ttl.dims).toEqual([1, 2, 2]);
      expect(Array.from(style.ttl.data)).toEqual([1, 2, 3, 4]);
      expect(style.dp.dims).toEqual([1, 1, 3]);
      expect(Array.from(style.dp.data)).toEqual([5, 6, 7]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('rejects an empty style batch', () => {
    expect(() => voiceStyleFromData([])).toThrow('At least one voice style is required');
  });
});
