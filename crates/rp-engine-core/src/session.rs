use crate::{apply_patch_value, canonical_value, js_error, parse_json, validate_card_value};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

pub(crate) fn hash_value(value: &Value) -> String {
    Sha256::digest(canonical_value(value).as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

#[wasm_bindgen]
pub struct CardSessionCore { cards: HashMap<String, (String, Value)> }

#[wasm_bindgen]
impl CardSessionCore {
    #[wasm_bindgen(constructor)] pub fn new() -> Self { Self { cards: HashMap::new() } }
    pub fn clear(&mut self) { self.cards.clear(); }
    pub fn resolve(&mut self, integration_id: &str, character_id: &str, transfer_json: &str) -> Result<String, JsError> {
        let transfer = parse_json(transfer_json).map_err(js_error)?;
        let resolved = self.resolve_value(integration_id, character_id, &transfer).map_err(js_error)?;
        serde_json::to_string(&resolved).map_err(js_error)
    }

    pub(crate) fn resolve_value(&mut self, integration_id: &str, character_id: &str, transfer: &Value) -> Result<Value, String> {
        let transfer = transfer.as_object().ok_or_else(|| "card_resync_required: Invalid card transfer.".to_string())?;
        let mode = transfer.get("mode").and_then(Value::as_str).unwrap_or_default();
        let target = transfer.get("targetHash").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
        let key = format!("{integration_id}\0{character_id}");
        let cached = self.cards.get(&key).cloned();
        let card = match mode {
            "snapshot" => transfer.get("snapshot").cloned().ok_or_else(|| "card_resync_required: A snapshot transfer requires a card.".to_string())?,
            "reference" => {
                let (hash, card) = cached.ok_or_else(|| "card_resync_required: The referenced card is not cached for this session.".to_string())?;
                if hash != target { return Err("card_resync_required: The referenced card is not cached for this session.".into()); }
                return Ok(json!({ "hash": hash, "card": card, "mode": mode }));
            }
            "patch" => {
                let (hash, card) = cached.ok_or_else(|| "card_resync_required: The card patch base does not match this session.".to_string())?;
                let base = transfer.get("baseHash").and_then(Value::as_str).unwrap_or_default();
                if hash != base { return Err("card_resync_required: The card patch base does not match this session.".into()); }
                let operations = transfer.get("patch").and_then(Value::as_array).ok_or_else(|| "card_resync_required: Invalid patch.".to_string())?;
                apply_patch_value(card, operations).map_err(|error| format!("card_resync_required: {error}"))?
            }
            _ => return Err("card_resync_required: Invalid card transfer mode.".into()),
        };
        validate_card_value(&card).map_err(|error| format!("invalid_character_card: Invalid Character Card V2: {error}"))?;
        let hash = hash_value(&card);
        if hash != target { return Err("card_resync_required: The reconstructed character card hash did not match targetHash.".into()); }
        self.cards.insert(key, (hash.clone(), card.clone()));
        Ok(json!({ "hash": hash, "card": card, "mode": mode }))
    }
}

impl Default for CardSessionCore { fn default() -> Self { Self::new() } }
