import { display_text, DisplayTextStreamCore, synthesis_text } from './core';

export const SUPERTONIC_EXPRESSION_TAGS = ['laugh', 'breath', 'sigh'] as const;
export function synthesisText(source: string, allowedTags: readonly string[]) { return synthesis_text(source, JSON.stringify(allowedTags)); }
export function displayText(source: string) { return display_text(source); }

export class DisplayTextStream {
  private readonly core = new DisplayTextStreamCore();
  push(chunk: string) { return this.core.push(chunk); }
  finish() { return this.core.finish(); }
}
