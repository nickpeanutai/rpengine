import { describe, expect, it } from 'vitest';
import { CAPTURE_SAMPLE_RATE, preferredRecorderMimeType, resampleTo16k } from './browser-voice-capture';

describe('browser voice capture audio preparation', () => {
  it('resamples browser microphone frames to Moonshine 16 kHz input', () => {
    const samples = resampleTo16k(new Float32Array([0, 1, 0, -1]), 8000);
    expect(samples.length).toBe(8);
    expect(samples[0]).toBe(0);
    expect(samples[2]).toBe(1);
    expect(CAPTURE_SAMPLE_RATE).toBe(16000);
  });

  it('does not require MediaRecorder when selecting a MIME type in non-browser tests', () => {
    expect(preferredRecorderMimeType()).toBe('');
  });
});
