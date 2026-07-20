# RPEngine protocol v3

Every message uses this envelope:

```json
{
  "protocol": "gemtavern.rp_engine",
  "protocolVersion": 3,
  "type": "reply.request",
  "messageId": "unique-message-id",
  "sessionId": "active-session-id",
  "timestamp": "2026-07-14T00:00:00.000Z"
}
```

The selected local transport carries these envelopes. WebSocket mode connects to a configurable loopback port (default `38471`) and must bind only to `127.0.0.1` while validating the RPEngine web origin. Filesystem mode uses the selected integration-owned mailbox described below. In both modes RPEngine sends `hello`, the integration returns `welcome` with a new `sessionId`, both sides acknowledge received envelopes, and invalid versions, duplicate message IDs, invalid sessions, and messages over 8 MiB are rejected.

## Character transfer

Cards are complete Character Card V2 JSON objects as defined by [`spec_v2.md`](../spec_v2.md). Character Card V2 is RPEngine's canonical character transport format; snapshot, patch, and reference are transfer modes around that standard document rather than a separate dynamic-card schema. See the standalone [RPEngine Character Transport Standard](character-card-v2-transport.md) for producer requirements, examples, hashing, cache lifecycle, and error recovery. `targetHash` is lowercase SHA-256 over RFC 8785 canonical JSON.

Snapshots and reconstructed patches must contain `spec: "chara_card_v2"`, `spec_version: "2.0"`, and all required V2 fields with their specified types. Use empty strings, `alternate_greetings: []`, and `extensions: {}` when a required field has no integration-specific value. Unknown fields and extension data are preserved exactly.

RPEngine validates and transports the complete V2 document. Its current stateless reply assembler consumes the card's core prompt fields (`system_prompt`, `description`, `personality`, `scenario`, `mes_example`, and `post_history_instructions`). It preserves optional fields such as `character_book`, but lorebook scanning and activation are not part of the current runtime.

- Snapshot: `{"format":"chara_card_v2","mode":"snapshot","snapshot":{...}}` (`targetHash` is optional and is computed when absent)
- Patch: `{"format":"chara_card_v2","mode":"patch","patch":[...],"baseHash":"...","targetHash":"..."}`
- Reference: `{"format":"chara_card_v2","mode":"reference","targetHash":"..."}`

The optional game-neutral filesystem mapping is specified in [`file-transport-v1.md`](file-transport-v1.md). It carries these same envelopes and does not introduce conversation storage in RPEngine.

Clones are scoped to `integrationId + characterId` within one connection session. A missing base or hash mismatch returns `request.error` with `code: "card_resync_required"`; retry the same request with a snapshot.

## Compute request

```json
{
  "type": "reply.request",
  "requestId": "stable-across-resync",
  "eventId": "game-event-id",
  "integrationId": "game-or-mod-id",
  "characterId": "stable-character-id",
  "event": { "text": "The latest event presented to the character." },
  "output": {
    "modalities": ["text", "audio"],
    "language": "en",
    "responseProcessing": {
      "mode": "buffered",
      "rules": [
        {
          "id": "emotion",
          "matcher": { "type": "regex", "pattern": "<([a-z][a-z0-9_]{0,63})>\\s*$" },
          "captureGroup": 1,
          "occurrence": "last",
          "remove": "match",
          "removeFrom": ["text", "audio"]
        }
      ]
    },
    "audio": {
      "model": "gemtavern-supertonic-3",
      "voice": "F4",
      "format": "pcm_s16le",
      "processing": { "profile": "narrowband_voice" }
    }
  },
  "player": { "displayName": "Player" },
  "card": { "format": "chara_card_v2", "mode": "reference", "targetHash": "..." }
}
```

`output.modalities` always includes `text` and optionally includes `audio`. Audio requests must carry the Supertonic 3 model and voice descriptor; voice selection is therefore owned by the calling game rather than PWA settings. `output.language` is required. `output.responseProcessing` is optional. When present, its buffered regular-expression rules run against the complete raw model response before any text or audio is delivered. Each rule captures content under its caller-defined `id` and can remove either the whole match or the capture group from text, audio, both, or neither. Captures are returned as arrays in `extractedContent` on `reply.text.completed`. RPEngine does not add output-format instructions or interpret extracted values; integrations own prompting and semantic validation. Buffered processing intentionally delays text and TTS until generation completes so filtered content cannot leak through streaming output. `player` is optional and defaults to `Player`. `event.text` becomes the newest user-role message. Requests are stateless and processed FIFO.

Response-processing rules use Rust regular-expression syntax. A rule supplies `captureGroup`, selects `first`, `last`, or `all` occurrences, and chooses `match`, `capture`, or `none` removal. Rule identifiers must match `^[a-z][a-z0-9_.-]{0,63}$`. The Core accepts at most eight rules, 1,024 bytes per pattern, sixteen capture groups, and sixty-four matches per rule. Supported flags are `i`, `m`, and `s`. Invalid configurations are rejected before Gemma is invoked; a valid rule that finds no match returns an empty array and does not fail the reply.

`output.audio.processing` is optional. Omitting it preserves the natural Supertonic output. Supported game-neutral profiles are:

- `narrowband_voice`: band-limits, compresses, and mildly saturates speech for phones, intercoms, and clean radio systems.
- `cinematic_radio`: applies a steeper communications band, presence emphasis, aggressive compression, codec coloration, quiet carrier texture, and restrained deterministic crackle/dropouts while preserving intelligibility.

Processing is applied before PCM transport, so WebSocket and filesystem integrations receive the same audio treatment when they request a profile.

## Responses

After `reply.accepted`, requests without response processing use concurrent text and audio streams. `reply.audio.start` and complete sentence segments may arrive before `reply.text.completed`. Buffered response processing suppresses text deltas and begins TTS only after the complete response has been filtered. Preserve the sequence within each stream; `reply.completed` is sent only after every requested modality has completed.

- `reply.accepted`: request accepted and card hash resolved.
- `reply.text.delta`: clean display-text chunk with a zero-based sequence; omitted for buffered response processing.
- `reply.text.completed`: complete clean display text and, when response processing was requested, an `extractedContent` object whose keys are rule IDs and whose values are capture arrays.
- `reply.audio.start`: `pcm_s16le`, sample rate, and mono channel count. Final totals are not known yet because synthesis begins while text is still being generated.
- `reply.audio.chunk`: zero-based global sequence, sentence-level `segmentSequence`, `segmentChunkSequence`, `segmentChunkCount`, and base64 PCM bytes. A game may play each complete segment immediately while later segments are generated.
- `reply.audio.completed`: final segment, chunk, byte, duration, and synthesis-time totals.
- `reply.completed`: terminal success.
- `request.cancel` / `reply.cancelled`: cancellation.
- `request.error`: structured terminal or resync error.
- `capacity.update`: queue depth, limit, and whether new requests are accepted.

Games own playback, interruption, volume, subtitles, and spatial placement. RPEngine strips expression tags from display text and retains only TTS-advertised tags in synthesis input.
