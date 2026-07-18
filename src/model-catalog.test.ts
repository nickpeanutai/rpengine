import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, bundledModelCatalog } from './model-catalog';

describe('bundled model catalog', () => {
  it('contains the ten web models and all 45 runtime files', () => {
    expect(MODEL_CATALOG).toHaveLength(10);
    expect(MODEL_CATALOG.flatMap(model => model.files)).toHaveLength(45);
    expect(new Set(MODEL_CATALOG.map(model => model.id)).size).toBe(10);
  });

  it('has complete safe integrity metadata and no R2 transport fields', () => {
    for (const model of MODEL_CATALOG) {
      const paths = model.files.map(file => file.path);
      expect(new Set(paths).size).toBe(paths.length);
      expect(new Set(model.required_files)).toEqual(new Set(paths));
      for (const file of model.files) {
        expect(file.path).toMatch(/^(?!\/)(?!.*(?:^|\/)\.\.?\/).+/);
        expect(file.size_bytes).toBeGreaterThan(0);
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.url).not.toContain('model-download.ai-app-dev.com');
        expect(file.url).not.toContain('/v1/models/files/');
        expect(file.url).not.toContain('signature=');
        expect('parts' in file).toBe(false);
      }
    }
  });

  it('pins Hugging Face revisions and maps Supertonic remote paths', () => {
    const gemma = MODEL_CATALOG.find(model => model.id === 'gemma-4-E2B-it-web-litertlm')!;
    expect(gemma.files[0].url).toBe(
      'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/9262660a1676eed6d0c477ab1a86344430854664/gemma-4-E2B-it-web.litertlm',
    );

    const supertonic = MODEL_CATALOG.find(model => model.id === 'gemtavern-supertonic-3')!;
    for (const file of supertonic.files) {
      expect(file.url).toContain('/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323/');
      expect(file.url).not.toContain('Supertonic3.bundle');
      expect(file.url.endsWith(file.path.replace('Supertonic3.bundle/', ''))).toBe(true);
    }
  });

  it('uses Moonshine v2 Small for English and matching Base directories for the other languages', () => {
    const moonshine = MODEL_CATALOG.filter(model => model.format === 'moonshine-stt');
    expect(moonshine).toHaveLength(8);
    expect(moonshine.flatMap(model => model.files)).toHaveLength(28);
    for (const model of moonshine) {
      for (const file of model.files) {
        const languageDirectory = file.path.split('/')[0];
        if (languageDirectory === 'small-streaming-en') expect(file.url).toContain('/model/small-streaming-en/quantized/');
        else expect(file.url).toContain(`/model/${languageDirectory}/quantized/${languageDirectory}/`);
      }
    }
    const korean = moonshine.find(model => model.id === 'gemtavern-moonshine-stt-korean-base')!;
    expect(korean.files.every(file => file.url.includes('/base-ko/quantized/base-ko/'))).toBe(true);
    const english = moonshine.find(model => model.id === 'gemtavern-moonshine-stt-english-small-streaming')!;
    expect(english.version).toBe('2026-01-27');
    expect(english.files).toHaveLength(7);
    expect(english.required_files).toContain('small-streaming-en/decoder_kv.ort');
    expect(english.required_files).not.toContain('small-streaming-en/decoder_kv_with_attention.ort');
    expect(moonshine.some(model => model.id === 'gemtavern-moonshine-stt-english-base')).toBe(false);
  });

  it('returns defensive copies to the model manager', () => {
    const first = bundledModelCatalog();
    const second = bundledModelCatalog();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0].files[0]).not.toBe(second[0].files[0]);
  });
});
