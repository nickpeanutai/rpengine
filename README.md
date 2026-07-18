# GemTavern RPEngine PWA

An installable, game-neutral local character-response compute provider. A game integration hosts an authenticated loopback WebSocket endpoint and this PWA connects outbound. The integration supplies Character Card V2 data and event text; RPEngine owns prompt assembly, Gemma inference, Supertonic synthesis, and response streaming.

The wire contract is `gemtavern.rp_engine` protocol v3. See [docs/protocol-v3.md](docs/protocol-v3.md).

## Runtime

- Gemma 4 E2B Web through `@litert-lm/core@0.14.0` and WebGPU (`GPU_ARTISAN`).
- Supertonic 3 through `onnxruntime-web@1.27.0`, multithreaded WASM, and CPU only.
- Models download directly from commit-pinned Hugging Face repositories or the Moonshine CDN, with resumable ranges, SHA-256 verification, and persistent OPFS storage.
- Character card clones exist only for the authenticated connection session. Requests do not retain dialogue history.
- An exclusive browser Web Lock permits only one active RPEngine tab per origin and browser profile. Passive tabs do not create or load inference workers.
- Reply requests use multimodal output parameters: text is always streamed, and callers can add Supertonic 3 audio with a per-request language and voice.
- Diagnostics remain in memory for the page session and can be exported explicitly.
- V1 supports current desktop Chrome and Edge and requires WebGPU plus cross-origin isolation.

The UI deliberately exposes one lifecycle control: it downloads missing models, starts local compute, or stops it according to the current state. Voice configuration belongs to the calling game through the protocol rather than to browser settings.

## Development

```bash
git clone --recurse-submodules https://github.com/nickpeanutai/rpengine.git
cd rpengine
git -C moonshine-js apply ../patches/MoonshineJS/rp-engine-web.patch
npm ci
npm run core:setup
npm test
npm run dev
```

Development requires Node.js 22.12 or newer and the pinned Rust toolchain in
`rust-toolchain.toml`. The one-time `core:setup` command installs the pinned
project-local `wasm-bindgen` CLI; it does not modify the global Rust toolchain.

`npm run dev` builds and serves production-style classic worker bundles on `127.0.0.1:5173`. Keeping this origin stable preserves downloaded OPFS models. `npm run dev:ui` provides Vite HMR for UI-only work, but inference workers require the production-style bundled preview.

For a local integration test, keep this server running and open RPEngine from the game adapter.

To test without launching a game, stop RimWorld and run `npm run mock-game`, then open `http://127.0.0.1:38472`. The mock adapter hosts the real loopback protocol endpoint, supports snapshot/patch/reference requests, text and voice output, cancellation, resync, and saves returned PCM audio as WAV files under `tools/mock-game/test-output`. Browser microphone tests also save the finalized 16 kHz recording as `<requestId>-microphone.wav` and Moonshine's recognized text as `<requestId>-moonshine.txt` in that directory.

Production must serve the isolation headers in `public/_headers`. The service worker caches the app shell only; model data never enters the service-worker cache.

`LiteRT-LM` is pinned to upstream v0.14.0. `src/vendor/supertonic-helper.js` is the MIT-licensed upstream browser helper used at build time; the `supertonic` submodule pins the upstream development reference.

## License

First-party source code is licensed under
[AGPL-3.0-only](LICENSE). Third-party components remain under their respective
licenses as described in [NOTICE](NOTICE).

The RPEngine and GemTavern names, logos, icons, and brand artwork are not
licensed under the AGPL. Forks must follow [TRADEMARKS.md](TRADEMARKS.md) and
replace reserved branding before presenting a modified deployment as their own
product.
