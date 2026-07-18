import { describe, expect, it } from 'vitest';
import { float32ToPcm16, pcmChunks } from './audio-wire';
import { displayText, DisplayTextStream, synthesisText } from './expression';

describe('voice wire output', () => {
  it('keeps supported tags for synthesis and removes all tags from display', () => {
    expect(synthesisText('<laugh>Hello <angry>there', ['laugh'])).toBe('<laugh>Hello there');
    expect(displayText('<laugh>Hello <angry>there')).toBe('Hello there');
    const stream = new DisplayTextStream();
    expect(stream.push('Hi <lau')).toBe('Hi ');
    expect(stream.push('gh>friend')).toBe('friend');
  });

  it('converts and chunks little-endian mono PCM16 in order', () => {
    const bytes = float32ToPcm16(new Float32Array([-1, 0, 1]));
    expect([...bytes]).toEqual([0, 128, 0, 0, 255, 127]);
    expect(pcmChunks(bytes, 2).map(chunk => [...chunk])).toEqual([[0, 128], [0, 0], [255, 127]]);
  });
});
