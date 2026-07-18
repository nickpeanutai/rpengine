import { assemble_prompt, estimate_tokens } from './core';
import type { InteractionMode, JsonObject, PromptDirective, PromptScene } from './types';

export interface PromptAssemblyRequest {
  card: JsonObject;
  eventText: string;
  playerDisplayName?: string;
  outputMode: 'text' | 'voice';
  language?: string;
  expressionTags?: string[];
  maxInputTokens?: number;
  interactionMode?: InteractionMode;
  promptScene?: PromptScene;
  promptDirective?: PromptDirective;
}
export interface PromptBlock { id: string; content: string; mandatory: boolean; included: boolean; estimatedTokens: number }
export class PromptBudgetError extends Error { readonly code = 'prompt_too_large'; }
export const estimateTokens = (value: string) => estimate_tokens(value);

export function assemblePrompt(request: PromptAssemblyRequest) {
  try {
    return JSON.parse(assemble_prompt(JSON.stringify(request))) as {
      system: string; user: string; history: Array<{ role: 'user' | 'assistant'; content: string }>;
      blocks: PromptBlock[]; estimatedTokens: number;
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('prompt_too_large')) throw new PromptBudgetError(message.replace(/^prompt_too_large:\s*/, ''));
    throw error;
  }
}
