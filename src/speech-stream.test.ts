import { describe, expect, it } from 'vitest';
import { IncrementalSpeechChunker } from './speech-stream';

describe('IncrementalSpeechChunker', () => {
  it('holds the newest sentence until another sentence begins', () => {
    const chunker = new IncrementalSpeechChunker(1);
    expect(chunker.update('Hello there.', false)).toEqual([]);
    expect(chunker.update('Hello there. How are', false)).toEqual([{ sequence: 0, text: 'Hello there.' }]);
    expect(chunker.update('Hello there. How are you?', true)).toEqual([{ sequence: 1, text: 'How are you?' }]);
  });

  it('flushes an unfinished final sentence exactly once', () => {
    const chunker = new IncrementalSpeechChunker(1);
    expect(chunker.update('Still speaking', false)).toEqual([]);
    expect(chunker.update('Still speaking', true)).toEqual([{ sequence: 0, text: 'Still speaking' }]);
    expect(chunker.update('Still speaking', true)).toEqual([]);
  });

  it('supports multilingual sentence boundaries', () => {
    const chunker = new IncrementalSpeechChunker(1);
    expect(chunker.update('你好！下一句', false)).toEqual([{ sequence: 0, text: '你好！' }]);
    expect(chunker.update('你好！下一句。', true)).toEqual([{ sequence: 1, text: '下一句。' }]);
  });

  it('uses Unicode sentence boundaries instead of splitting decimal periods', () => {
    const chunker = new IncrementalSpeechChunker(1);
    expect(chunker.update('The value is 3.14 today. Next', false)).toEqual([{ sequence: 0, text: 'The value is 3.14 today.' }]);
  });

  it('rejects revisions to text already consumed by speech synthesis', () => {
    const chunker = new IncrementalSpeechChunker(1);
    expect(chunker.update('Leave now. Another thought', false)).toEqual([{ sequence: 0, text: 'Leave now.' }]);
    expect(() => chunker.update('Stay here. Another thought', false)).toThrow(/changed after an earlier sentence/);
  });
});
