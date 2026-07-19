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
        let requested_target = transfer.get("targetHash").and_then(Value::as_str).filter(|value| !value.is_empty()).map(|value| value.to_ascii_lowercase());
        let key = format!("{integration_id}\0{character_id}");
        let cached = self.cards.get(&key).cloned();
        let card = match mode {
            "snapshot" => transfer.get("snapshot").cloned().ok_or_else(|| "card_resync_required: A snapshot transfer requires a card.".to_string())?,
            "reference" => {
                let target = requested_target.as_deref().ok_or_else(|| "card_resync_required: A reference transfer requires targetHash.".to_string())?;
                let (hash, card) = cached.ok_or_else(|| "card_resync_required: The referenced card is not cached for this session.".to_string())?;
                if hash != target { return Err("card_resync_required: The referenced card is not cached for this session.".into()); }
                return Ok(json!({ "hash": hash, "card": card, "mode": mode }));
            }
            "patch" => {
                requested_target.as_deref().ok_or_else(|| "card_resync_required: A patch transfer requires targetHash.".to_string())?;
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
        if requested_target.as_deref().is_some_and(|target| hash != target) { return Err("card_resync_required: The reconstructed character card hash did not match targetHash.".into()); }
        self.cards.insert(key, (hash.clone(), card.clone()));
        Ok(json!({ "hash": hash, "card": card, "mode": mode }))
    }
}

impl Default for CardSessionCore { fn default() -> Self { Self::new() } }

#[cfg(test)]
mod tests {
    use super::*;
    fn card() -> Value { json!({"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"Operator","description":"Remote","personality":"Guarded","scenario":"Radio","first_mes":"","mes_example":"","creator_notes":"","system_prompt":"Stay in character","post_history_instructions":"","alternate_greetings":[],"tags":[],"creator":"test","character_version":"1","extensions":{}}}) }
    #[test]
    fn snapshot_may_omit_target_hash_but_patch_and_reference_may_not() {
        let mut session=CardSessionCore::new(); let resolved=session.resolve_value("game","operator",&json!({"format":"chara_card_v2","mode":"snapshot","snapshot":card()})).unwrap();
        assert_eq!(resolved["hash"].as_str().unwrap().len(),64);
        assert!(session.resolve_value("game","operator",&json!({"format":"chara_card_v2","mode":"reference"})).unwrap_err().contains("requires targetHash"));
        assert!(session.resolve_value("game","operator",&json!({"format":"chara_card_v2","mode":"patch","baseHash":resolved["hash"],"patch":[]})).unwrap_err().contains("requires targetHash"));
    }
}
