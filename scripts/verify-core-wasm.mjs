import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const directory = join(root, 'src/generated/rp-engine-core');
const wasmPath = join(directory, 'rp_engine_core_bg.wasm');
const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);
const forbidden = ['name', 'producers', 'sourceMappingURL', 'external_debug_info'];
for (const section of forbidden) {
  if (WebAssembly.Module.customSections(module, section).length) throw new Error(`Forbidden WASM custom section: ${section}`);
}
const maps = readdirSync(directory).filter(name => name.endsWith('.map'));
if (maps.length) throw new Error(`WASM source maps must not ship: ${maps.join(', ')}`);
const exports = WebAssembly.Module.exports(module).map(value => value.name);
const allowed = /^(memory|core_abi_version|float32_to_pcm16|base64_bytes|pcm_chunk_offsets|trim_outer_silence|decode_audio_input|merge_event_text|resample_audio|analyse_audio|canonical_json|canonical_hash|validate_character_card|apply_json_patch|decode_envelope|valid_rp_engine_port|loopback_endpoint|connection_port_from_fragment|estimate_tokens|assemble_prompt|display_text|synthesis_text|valid_moonshine_language|valid_supertonic_language|valid_voice|default_moonshine_language|__wbindgen_.+|__wbg_.+|streamingresamplercore_.+|cardsessioncore_.+|coresession_.+|gemmaworkercore_.+|ttsworkercore_.+|vadworkerpolicycore_.+|displaytextstreamcore_.+|speechchunkercore_.+|vadstatecore_.+|cmvncore_.+|kaldifbankcore_.+)$/;
const unexpected = exports.filter(name => !allowed.test(name));
if (unexpected.length) throw new Error(`Unexpected first-party WASM exports: ${unexpected.join(', ')}`);
console.log(`Verified stripped first-party WASM (${bytes.byteLength} bytes, ${exports.length} low-level exports).`);
