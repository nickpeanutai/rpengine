import { describe, expect, it } from 'vitest';
import { trimOuterSilence } from './audio-trim';

describe('Supertonic silence trimming', () => {
  const options = {
    rmsThreshold: 0.1,
    windowDuration: 0.02,
    hopDuration: 0.01,
    leadingPaddingDuration: 0.02,
    trailingPaddingDuration: 0.05,
  };

  it('trims both sides while retaining configured speech padding', () => {
    const samples = [
      ...new Array(10).fill(0),
      ...new Array(4).fill(0.5),
      ...new Array(10).fill(0),
    ];

    expect(trimOuterSilence(samples, 100, options)).toEqual([
      0, 0, 0,
      0.5, 0.5, 0.5, 0.5,
      0, 0, 0, 0, 0, 0,
    ]);
  });

  it('preserves audio when no window crosses the speech threshold', () => {
    const samples = [0, 0.01, 0, 0];
    expect(trimOuterSilence(samples, 100, options)).toEqual(samples);
  });

  it('handles speech at the buffer boundaries without over-trimming', () => {
    const samples = [0.5, 0.5, 0, 0, 0, 0.5];
    expect(trimOuterSilence(samples, 100, { ...options, trailingPaddingDuration: 0 })).toEqual(samples);
  });
});
