# First-party RPEngine WebAssembly core

RPEngine compiles its proprietary deterministic logic from Rust into a stripped WebAssembly module. The production JavaScript bundle contains UI rendering and adapters for browser APIs, storage, WebSockets, workers, LiteRT, and ONNX Runtime; it does not contain a JavaScript fallback for the migrated logic.

## Local setup

The toolchain is pinned by `rust-toolchain.toml`. Install it and the matching project-local `wasm-bindgen` CLI once:

```sh
npm run core:setup
```

Normal commands then rebuild the generated, ignored bindings automatically:

```sh
npm test
npm run build
```

`npm run build` also optimizes the module with Binaryen, rejects debug/name/producer/source-map sections, checks the WASM export allowlist, and audits the Vite output for source maps or migrated prompt/card logic leaking into JavaScript.

## Boundary

The Rust crate owns card validation and patching, prompt assembly, protocol validation and deduplication, request preflight/capacity policy, FIFO state, expression and sentence streaming, PCM and silence processing, capture resampling, FireRedVAD features/state, Moonshine token decoding, and settings validation.

JavaScript remains responsible for nondeterministic and browser-specific operations: DOM updates, time and UUID acquisition, WebSocket and timer execution, Fetch, OPFS/IndexedDB/localStorage, media capture, AudioWorklets, and inference runtime calls. The page and each relevant worker instantiate the same hashed WASM asset from the browser cache.

This design raises reverse-engineering cost; it does not make client-side code or embedded strings secret. Credentials and rules that must remain secret still belong on a server.
