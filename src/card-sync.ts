import { apply_json_patch, canonical_hash, canonical_json, CardSessionCore } from './core';
import type { CardTransfer, JsonObject, JsonPatchOperation, JsonValue } from './types';

export class CardSyncError extends Error {
  constructor(readonly code: 'card_resync_required' | 'invalid_character_card', message: string) { super(message); }
}
export function canonicalJson(value: JsonValue) { return canonical_json(JSON.stringify(value)); }
export async function canonicalHash(card: JsonObject) { return canonical_hash(JSON.stringify(card)); }
export function applyJsonPatch<T extends JsonValue>(source: T, operations: JsonPatchOperation[]): T {
  return JSON.parse(apply_json_patch(JSON.stringify(source), JSON.stringify(operations))) as T;
}

export class CardSessionStore {
  private readonly core = new CardSessionCore();
  clear() { this.core.clear(); }
  async resolve(integrationId: string, characterId: string, transfer: CardTransfer) {
    try {
      return JSON.parse(this.core.resolve(integrationId, characterId, JSON.stringify(transfer))) as { hash: string; card: JsonObject; mode: CardTransfer['mode'] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.includes('invalid_character_card') ? 'invalid_character_card' : 'card_resync_required';
      throw new CardSyncError(code, message.replace(/^(invalid_character_card|card_resync_required):\s*/, ''));
    }
  }
}
