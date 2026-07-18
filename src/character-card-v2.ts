import { validate_character_card } from './core';
import type { CharacterCardV2, JsonObject } from './types';

export class CharacterCardV2ValidationError extends Error {}

/** Thin type adapter; Character Card V2 validation is implemented in Rust/WASM. */
export function assertCharacterCardV2(card: JsonObject): asserts card is CharacterCardV2 {
  try { validate_character_card(JSON.stringify(card)); }
  catch (error) { throw new CharacterCardV2ValidationError(error instanceof Error ? error.message : String(error)); }
}
