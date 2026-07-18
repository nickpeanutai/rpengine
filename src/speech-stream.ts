import { SpeechChunkerCore } from './core';

export interface SpeechChunk { sequence: number; text: string }
export class IncrementalSpeechChunker {
  private readonly core: SpeechChunkerCore;
  constructor(minimumChunkCharacters = 1) { this.core = new SpeechChunkerCore(minimumChunkCharacters); }
  update(text: string, final: boolean): SpeechChunk[] { return JSON.parse(this.core.update(text, final)) as SpeechChunk[]; }
  reset() { this.core.reset(); }
}
