import { describe, expect, it } from 'vitest';
import { decodeAudioInput, mergeEventText } from './stt-audio';

describe('STT audio input', () => {
  it('decodes little-endian PCM16', () => {
    const data = btoa(String.fromCharCode(0, 128, 0, 0, 255, 127));
    const result = decodeAudioInput({ format: 'pcm_s16le', sampleRate: 16000, channels: 1, data });
    expect([...result]).toEqual([-1, 0, 32767 / 32768]);
  });

  it('merges typed context and speech without changing text-only events', () => {
    expect(mergeEventText('Door opens.', undefined)).toBe('Door opens.');
    expect(mergeEventText(undefined, 'Hello')).toBe('Hello');
    expect(mergeEventText('Door opens.', 'Hello')).toContain('Spoken input from the player:\nHello');
  });
});
