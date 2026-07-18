import MoonshineModel, { type MoonshineModelSources } from '../moonshine-js/src/model';
import { getInstalledModelFile } from './model-store';
import { MOONSHINE_MODEL_IDS, type MoonshineLanguage } from './types';

export type OfficialMoonshineLanguage = Exclude<MoonshineLanguage, 'en'>;

export interface MoonshineModelLike {
  loadModel(): Promise<void>;
  generate(samples: Float32Array): Promise<string>;
}

export type MoonshineModelFactory = (
  modelPath: string,
  precision: string,
  sources: MoonshineModelSources,
) => MoonshineModelLike;

export type MoonshineFileReader = (modelId: string, path: string) => Promise<Uint8Array>;
export type MoonshineLoadProgress = (current: number, total: number, name: string) => void;

const defaultFactory: MoonshineModelFactory = (modelPath, precision, sources) =>
  new MoonshineModel(modelPath, precision, sources);

const defaultReader: MoonshineFileReader = async (modelId, path) =>
  new Uint8Array(await (await getInstalledModelFile(modelId, path)).arrayBuffer());

export function moonshineDirectory(language: MoonshineLanguage) {
  return `base-${language}`;
}

export class OfficialMoonshineRuntime {
  private model?: MoonshineModelLike;
  private language?: OfficialMoonshineLanguage;

  constructor(
    private readonly createModel: MoonshineModelFactory = defaultFactory,
    private readonly readFile: MoonshineFileReader = defaultReader,
  ) {}

  async load(language: OfficialMoonshineLanguage, progress: MoonshineLoadProgress = () => undefined) {
    if (this.language === language && this.model) return;
    const directory = moonshineDirectory(language);
    const modelId = MOONSHINE_MODEL_IDS[language];
    progress(1, 3, 'encoder_model.ort');
    const encoder = await this.readFile(modelId, `${directory}/encoder_model.ort`);
    progress(2, 3, 'decoder_model_merged.ort');
    const decoder = await this.readFile(modelId, `${directory}/decoder_model_merged.ort`);
    progress(3, 3, 'Official Moonshine runtime');
    const model = this.createModel(`model/${directory}`, 'quantized', {
      encoder,
      decoder,
      wasmPath: '/ort-wasm/',
    });
    await model.loadModel();
    this.model = model;
    this.language = language;
  }

  async generate(samples: Float32Array, language: OfficialMoonshineLanguage) {
    await this.load(language);
    if (!this.model) throw new Error('Official Moonshine runtime is not loaded.');
    if (samples.length === 0) throw new Error('Official Moonshine runtime received empty audio.');
    const text = await this.model.generate(samples);
    if (typeof text !== 'string') throw new Error('Official Moonshine runtime returned no transcript.');
    return text;
  }
}
