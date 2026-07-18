import { defineConfig } from 'vite';
import packageJSON from './package.json';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  build: {
    sourcemap: false,
  },
  define: {
    __APP_VERSION__: JSON.stringify(packageJSON.version),
  },
  resolve: {
    alias: [
      // Supertonic is intentionally CPU/WASM-only. This also redirects the
      // upstream helper's bare ONNX Runtime import to the same singleton.
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },
  worker: {
    // LiteRT-LM and ONNX Runtime Web both bootstrap WASM via importScripts().
    format: 'iife',
  },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
});
