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

The local adapter is the loopback WebSocket host. The port is configurable and defaults to `38471`; both sides must use the same value. The compute client sends `hello` and the adapter returns `welcome` with a new `sessionId`. Both sides acknowledge received envelopes and reject wrong versions, duplicate message IDs, invalid sessions, and messages over 8 MiB. The adapter must bind only to `127.0.0.1` and validate the RPEngine web origin.

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

`output.modalities` always includes `text` and optionally includes `audio`. Audio requests must carry the Supertonic 3 model and voice descriptor; voice selection is therefore owned by the calling game rather than PWA settings. `output.language` is required. `player` is optional and defaults to `Player`. `event.text` becomes the newest user-role message. Requests are stateless and processed FIFO.

`output.audio.processing` is optional. Omitting it preserves the natural Supertonic output. The game-neutral `narrowband_voice` profile band-limits, compresses, and mildly saturates speech for integrations such as phones, intercoms, and radios. Processing is applied before PCM transport, so WebSocket and filesystem integrations receive the same audio treatment when they request the profile.

## Responses

After `reply.accepted`, text and audio are concurrent streams. `reply.audio.start` and complete sentence segments may arrive before `reply.text.completed`. Preserve the sequence within each stream; `reply.completed` is sent only after every requested modality has completed.

- `reply.accepted`: request accepted and card hash resolved.
- `reply.text.delta`: clean display-text chunk with a zero-based sequence.
- `reply.text.completed`: complete clean display text.
- `reply.audio.start`: `pcm_s16le`, sample rate, and mono channel count. Final totals are not known yet because synthesis begins while text is still being generated.
- `reply.audio.chunk`: zero-based global sequence, sentence-level `segmentSequence`, `segmentChunkSequence`, `segmentChunkCount`, and base64 PCM bytes. A game may play each complete segment immediately while later segments are generated.
- `reply.audio.completed`: final segment, chunk, byte, duration, and synthesis-time totals.
- `reply.completed`: terminal success.
- `request.cancel` / `reply.cancelled`: cancellation.
- `request.error`: structured terminal or resync error.
- `capacity.update`: queue depth, limit, and whether new requests are accepted.

Games own playback, interruption, volume, subtitles, and spatial placement. RPEngine strips expression tags from display text and retains only TTS-advertised tags in synthesis input.
