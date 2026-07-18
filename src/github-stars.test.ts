import { describe, expect, it } from 'vitest';
import { formatStarCount, parseStarCount } from './github-stars';

describe('GitHub star count', () => {
  it('accepts only non-negative safe integer repository counts', () => {
    expect(parseStarCount({ stargazers_count: 0 })).toBe(0);
    expect(parseStarCount({ stargazers_count: 42 })).toBe(42);
    expect(parseStarCount({ stargazers_count: -1 })).toBeUndefined();
    expect(parseStarCount({ stargazers_count: 1.5 })).toBeUndefined();
    expect(parseStarCount({ stargazers_count: '42' })).toBeUndefined();
    expect(parseStarCount(null)).toBeUndefined();
  });

  it('uses compact formatting only for larger counts', () => {
    expect(formatStarCount(999)).toBe('999');
    expect(formatStarCount(1_000)).toBe('1K');
    expect(formatStarCount(12_500)).toBe('12.5K');
  });
});
