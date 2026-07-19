# RPEngine file transport v1

The file transport is a game-neutral alternative to protocol-v3 WebSocket delivery. It uses the same envelopes, sessions, acknowledgements, 8 MiB limit, ordering, and message-ID deduplication. The browser stores only the selected directory handle in IndexedDB; conversation payloads remain in the game-owned mailbox.

The user must explicitly select the integration-owned mailbox directory. The selected directory must contain this manifest:

```json
{
  "schema": "gemtavern.rp_engine.file_transport",
  "version": 1,
  "integrationId": "my-game",
  "displayName": "Example integration",
  "mailboxes": {
    "integrationToEngine": "integration-to-engine",
    "engineToIntegration": "engine-to-integration"
  },
  "audio": {
    "format": "wav_pcm_s16le",
    "directory": "audio",
    "slotPattern": "slot_%04d.wav",
    "slotCount": 2048,
    "sampleRate": 44100,
    "channels": 1
  }
}
```

Each immutable envelope is written as `<timestamp>-<messageId>.json`; the matching `.ready` file is created only after the JSON writer closes. Readers ignore unmarked JSON. RPEngine polls every 50 ms during activity and 250 ms while idle, removes consumed inbound files, removes acknowledged outbound files, and deletes mailbox files older than 24 hours.

The file-mode `welcome` adds `peerInstanceId` and `nextAudioSlot`. Each completed TTS phrase becomes one mono PCM16 WAV and one `reply.audio.segment` envelope. A slot path is never reused during a `peerInstanceId`; `reply.audio.segment.consumed` restores a silent placeholder but does not make the path reusable. After all slots are used, the adapter reports `audio_slots_exhausted` and strips audio from later inbound requests until a new game process supplies a new peer identity.

Snapshot card transfers may omit `targetHash`; RPEngine validates the complete Character Card V2 and returns its computed hash. Patch and reference transfers still require `targetHash`. `voice.capture.start` returns `voice.capture.transcript` only when `returnTranscript` is `true`.
