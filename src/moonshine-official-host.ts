export const MoonshineSettings = {
  BASE_ASSET_PATH: {
    MOONSHINE: 'https://download.moonshine.ai/',
    ONNX_RUNTIME: '/ort-wasm/',
  },
} as const;

export class MoonshineLog {
  static info(text: unknown) { console.info(`[MoonshineJS] ${String(text)}`); }
  static log(_text: unknown) {}
  static warn(text: unknown) { console.warn(`[MoonshineJS] ${String(text)}`); }
  static error(text: unknown) { console.error(`[MoonshineJS] ${String(text)}`); }
}
