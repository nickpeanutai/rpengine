import type { ModelFile, ModelManifest } from './types';

const GEMMA_REPOSITORY = 'litert-community/gemma-4-E2B-it-litert-lm';
const GEMMA_REVISION = '9262660a1676eed6d0c477ab1a86344430854664';
const SUPERTONIC_REPOSITORY = 'Supertone/supertonic-3';
const SUPERTONIC_REVISION = '3cadd1ee6394adea1bd021217a0e650ede09a323';

type FileDefinition = readonly [path: string, sizeBytes: number, sha256: string];

function huggingFaceURL(repository: string, revision: string, path: string) {
  return `https://huggingface.co/${repository}/resolve/${revision}/${path}`;
}

function file(definition: FileDefinition, url: string): ModelFile {
  const [path, size_bytes, sha256] = definition;
  return { path, size_bytes, sha256, url };
}

const gemmaFiles = [
  file(
    ['gemma-4-E2B-it-web.litertlm', 2_008_432_640, '3a08e8d94e23b814ae5414469c370c503813949acb8ceaa17e4ebf8a35af35b5'],
    huggingFaceURL(GEMMA_REPOSITORY, GEMMA_REVISION, 'gemma-4-E2B-it-web.litertlm'),
  ),
];

const supertonicDefinitions: FileDefinition[] = [
  ['Supertonic3.bundle/onnx/duration_predictor.onnx', 3_700_147, 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db'],
  ['Supertonic3.bundle/onnx/text_encoder.onnx', 36_416_150, 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff'],
  ['Supertonic3.bundle/onnx/tts.json', 8_253, '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09'],
  ['Supertonic3.bundle/onnx/unicode_indexer.json', 277_676, '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f'],
  ['Supertonic3.bundle/onnx/vector_estimator.onnx', 256_534_781, '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c'],
  ['Supertonic3.bundle/onnx/vocoder.onnx', 101_424_195, '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba'],
  ['Supertonic3.bundle/voice_styles/F1.json', 292_046, 'bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2'],
  ['Supertonic3.bundle/voice_styles/F2.json', 292_423, '7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6'],
  ['Supertonic3.bundle/voice_styles/F3.json', 290_794, '12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab'],
  ['Supertonic3.bundle/voice_styles/F4.json', 291_808, 'c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b'],
  ['Supertonic3.bundle/voice_styles/F5.json', 291_479, '45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d'],
  ['Supertonic3.bundle/voice_styles/M1.json', 291_748, 'e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b'],
  ['Supertonic3.bundle/voice_styles/M2.json', 292_055, 'b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50'],
  ['Supertonic3.bundle/voice_styles/M3.json', 290_198, 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b'],
  ['Supertonic3.bundle/voice_styles/M4.json', 291_522, 'ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303'],
  ['Supertonic3.bundle/voice_styles/M5.json', 291_469, 'dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2'],
];

const supertonicFiles = supertonicDefinitions.map(definition => {
  const remotePath = definition[0].replace(/^Supertonic3\.bundle\//, '');
  return file(definition, huggingFaceURL(SUPERTONIC_REPOSITORY, SUPERTONIC_REVISION, remotePath));
});

const supertonicRequiredFiles = [
  'Supertonic3.bundle/onnx/tts.json',
  'Supertonic3.bundle/onnx/unicode_indexer.json',
  'Supertonic3.bundle/onnx/duration_predictor.onnx',
  'Supertonic3.bundle/onnx/text_encoder.onnx',
  'Supertonic3.bundle/onnx/vector_estimator.onnx',
  'Supertonic3.bundle/onnx/vocoder.onnx',
  ...['M1', 'M2', 'M3', 'M4', 'M5', 'F1', 'F2', 'F3', 'F4', 'F5'].map(voice => `Supertonic3.bundle/voice_styles/${voice}.json`),
];

interface MoonshineDefinition {
  id: string;
  name: string;
  directoryName: string;
  languageDirectory: string;
  version?: string;
  originBaseUrl?: string;
  files: readonly FileDefinition[];
}

const moonshineDefinitions: readonly MoonshineDefinition[] = [
  {
    id: 'gemtavern-moonshine-stt-english-small-streaming', name: 'GemTavern Moonshine English Small Streaming STT', directoryName: 'MoonshineSTTEnglishSmallStreaming', languageDirectory: 'small-streaming-en', version: '2026-01-27',
    originBaseUrl: 'https://download.moonshine.ai/model/small-streaming-en/quantized/',
    files: [
      ['small-streaming-en/frontend.ort', 30_984_200, 'e086451043c1c8652a9614e4a4a81d5807221b611584a3cf31f73779d5900003'],
      ['small-streaming-en/encoder.ort', 43_853_224, '3b21d02eff6aa5651524ada4271d37c1d7bba4eb3d256415074f2cfdbaeb526a'],
      ['small-streaming-en/adapter.ort', 2_867_424, 'd8493e0ac76a198b309a8be6f74b3101e235f773ffe5d6b378278cd7e4177992'],
      ['small-streaming-en/cross_kv.ort', 5_298_736, '6e57d1361717e00d73336a0c3beafedae784b1e537905ad253dee33db4007466'],
      ['small-streaming-en/decoder_kv.ort', 81_435_904, 'd5adfcfaa6e582144791f1568bd0f683852c7bfbb8c79acad97499da05e4ffcf'],
      ['small-streaming-en/streaming_config.json', 512, '26f02b6afb22d60871a5efd85c3d38e569cc0ddb6c5eb6e93d3260152ae8a47a'],
      ['small-streaming-en/tokenizer.bin', 249_974, '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d'],
    ],
  },
  {
    id: 'gemtavern-moonshine-stt-arabic-base', name: 'GemTavern Moonshine Arabic Base STT', directoryName: 'MoonshineSTTArabicBase', languageDirectory: 'base-ar',
    files: [
      ['base-ar/decoder_model_merged.ort', 109_424_552, '8f272cb50818e28ad86bbffc21e1450a4d57155e95f099ca6a236f38f4d9eafb'],
      ['base-ar/encoder_model.ort', 31_326_824, '68e50ebe0317ce909f098044a5dda2a76e6b86dc882829a317771fbafc5826ae'],
      ['base-ar/tokenizer.bin', 249_974, '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d'],
    ],
  },
  {
    id: 'gemtavern-moonshine-stt-spanish-base', name: 'GemTavern Moonshine Spanish Base STT', directoryName: 'MoonshineSTTSpanishBase', languageDirectory: 'base-es',
    files: [
      ['base-es/decoder_model_merged.ort', 43_612_200, '8e6513ad66a3a71ca86824746a09051eeb60468940eaf8201ce758e8919e2b5d'],
      ['base-es/encoder_model.ort', 20_964_320, '331aafa2fc7f7e55ba28376eef08eaf919ae105bb719cd64ba6875505dca72b3'],
      ['base-es/tokenizer.bin', 241_639, '04670d78994d030185c3dd843c60591788fed0a56cc6750747bd326825f13ca9'],
    ],
  },
  {
    id: 'gemtavern-moonshine-stt-japanese-base', name: 'GemTavern Moonshine Japanese Base STT', directoryName: 'MoonshineSTTJapaneseBase', languageDirectory: 'base-ja',
    files: [
      ['base-ja/decoder_model_merged.ort', 109_424_424, '35a522052d2d8695d0dd2870666f088d633111e08cfbed0418f61c4122b4ba25'],
      ['base-ja/encoder_model.ort', 31_326_816, '3230cafb84d5f08800e60de6f932aad7c69c649a37fa6997fe04fe25f808b56b'],
      ['base-ja/tokenizer.bin', 249_974, '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d'],
    ],
  },
  {
    id: 'gemtavern-moonshine-stt-korean-base', name: 'GemTavern Moonshine Korean Base STT', directoryName: 'MoonshineSTTKoreanBase', languageDirectory: 'base-ko',
    files: [
      ['base-ko/decoder_model_merged.ort', 109_424_456, 'd628a7408fbce8dfc93a3febfb3ec2232f25b3d17da205669f0cfcabc5211c42'],
      ['base-ko/encoder_model.ort', 31_326_816, '89b94408b1ed02c6f4bc89bdce0478a8c40d53fe0e567418d27f2c82dfae8c05'],
      ['base-ko/tokenizer.bin', 249_974, '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d'],
    ],
  },
  {
    id: 'gemtavern-moonshine-stt-vietnamese-base', name: 'GemTavern Moonshine Vietnamese Base STT', directoryName: 'MoonshineSTTVietnameseBase', languageDirectory: 'base-vi',
    files: [
      ['base-vi/decoder_model_merged.ort', 109_424_520, '0a4f007e9d585348d94124d8de47f7aefbc3e2d3fa44152646af7b94c639770d'],
      ['base-vi/encoder_model.ort', 31_326_816, '5a63cf0e248ef463776fbad50784813b4185eb73136f1fb062c5722e667130dc'],
      ['base-vi/tokenizer.bin', 249_974, '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d'],
    ],
  },
  {
    id: 'gemtavern-moonshine-stt-ukrainian-base', name: 'GemTavern Moonshine Ukrainian Base STT', directoryName: 'MoonshineSTTUkrainianBase', languageDirectory: 'base-uk',
    files: [
      ['base-uk/decoder_model_merged.ort', 109_424_424, '2c0c1ebc20ba75a21ff5315fd039e53d2fc9ba77a9ca9ad3bc4c7c1c1de93cbc'],
      ['base-uk/encoder_model.ort', 31_326_816, 'ea37ff7a2c308b566def1fd6e6860e23db4968590f192d5cc0fbc494666e30f9'],
      ['base-uk/tokenizer.bin', 249_974, '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d'],
    ],
  },
  {
    id: 'gemtavern-moonshine-stt-chinese-base', name: 'GemTavern Moonshine Chinese Base STT', directoryName: 'MoonshineSTTChineseBase', languageDirectory: 'base-zh',
    files: [
      ['base-zh/decoder_model_merged.ort', 109_424_520, 'bf79fce626e123739ec37eceb2b2a010a93d720da266dd5d8ef9a47ef9a7dc36'],
      ['base-zh/encoder_model.ort', 31_326_816, 'c725a24b58595905921ea2a47e2bcf0f18c78f4d171d96136f2dcbc8c77a58a6'],
      ['base-zh/tokenizer.bin', 249_974, '6884b35fd6377d4c4d32336a0bc152f36b64d1e45b6503683cdc238250a8472d'],
    ],
  },
];

function moonshineManifest(definition: MoonshineDefinition): ModelManifest {
  const files = definition.files.map(source => {
    const filename = source[0].split('/').at(-1)!;
    const url = definition.originBaseUrl
      ? `${definition.originBaseUrl}${filename}`
      : `https://download.moonshine.ai/model/${definition.languageDirectory}/quantized/${definition.languageDirectory}/${filename}`;
    return file(source, url);
  });
  return {
    id: definition.id,
    name: definition.name,
    version: definition.version ?? '2026-06-26',
    format: 'moonshine-stt',
    directory_name: definition.directoryName,
    required_files: files.map(entry => entry.path),
    files,
  };
}

export const MODEL_CATALOG: readonly ModelManifest[] = [
  {
    id: 'gemma-4-E2B-it-web-litertlm',
    name: 'Gemma 4 E2B IT Web',
    version: '2026-07-14',
    format: 'litertlm-web',
    directory_name: 'gemma-4-E2B-it-web-litertlm',
    required_files: gemmaFiles.map(entry => entry.path),
    files: gemmaFiles,
  },
  {
    id: 'gemtavern-supertonic-3',
    name: 'GemTavern Supertonic 3',
    version: '2026-06-06',
    format: 'supertonic-3',
    directory_name: 'Supertonic3',
    required_files: supertonicRequiredFiles,
    files: supertonicFiles,
  },
  ...moonshineDefinitions.map(moonshineManifest),
];

export function bundledModelCatalog(): ModelManifest[] {
  return MODEL_CATALOG.map(manifest => ({
    ...manifest,
    required_files: [...manifest.required_files],
    files: manifest.files.map(entry => ({ ...entry })),
  }));
}
