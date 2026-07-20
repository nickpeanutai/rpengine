import { describe, expect, it } from 'vitest';
import { connectionPortFromFragment, decodeEnvelope, loopbackEndpoint } from './protocol';

const base = {
  protocol: 'gemtavern.rp_engine', protocolVersion: 3, type: 'reply.request', messageId: 'm1', timestamp: '2026-07-14T00:00:00.000Z',
  requestId: 'r1', eventId: 'e1', integrationId: 'test-game', characterId: 'c1', event: { text: 'The door opens.' },
  output: { modalities: ['text', 'audio'], language: 'en', audio: { model: 'gemtavern-supertonic-3', voice: 'F4', format: 'pcm_s16le' } }, card: { format: 'chara_card_v2', mode: 'reference', targetHash: 'abc' },
};

const promptContext = {
  interactionMode: 'auto_event',
  promptScene: { kind: 'combat', family: 'combat', priority: 10, label: 'Under fire', sceneLine: 'Ari is under fire outside the colony walls.' },
  promptDirective: {
    protocolVersion: 2,
    sceneContext: '[RimWorld scene context]\nAri is under fire outside the colony walls.',
    autoEventGuide: '[RimWorld event reply guide]\nReact to the immediate danger.',
    directUserGuide: '[RimWorld direct user message]\nAnswer the user first.',
    promptVersion: 'rimworld-mod-full-prompts-2026-07-02',
  },
};

describe('RPEngine protocol v3', () => {
  it('decodes a valid game-neutral reply request', () => expect(decodeEnvelope(JSON.stringify(base)).type).toBe('reply.request'));
  it('accepts a text-only multimodal request', () => {
    const request = { ...base, output: { modalities: ['text'], language: 'en' } };
    expect(decodeEnvelope(JSON.stringify(request)).type).toBe('reply.request');
  });
  it('accepts buffered regex response processing and rejects invalid rules', () => {
    const responseProcessing = { mode: 'buffered', rules: [{ id: 'emotion', matcher: { type: 'regex', pattern: '<([a-z_]+)>\\s*$' }, captureGroup: 1, occurrence: 'last', remove: 'match', removeFrom: ['text', 'audio'] }] };
    expect(decodeEnvelope(JSON.stringify({ ...base, output: { ...base.output, responseProcessing } })).type).toBe('reply.request');
    expect(() => decodeEnvelope(JSON.stringify({ ...base, output: { ...base.output, responseProcessing: { ...responseProcessing, mode: 'streaming' } } }))).toThrow(/mode/);
    expect(() => decodeEnvelope(JSON.stringify({ ...base, output: { ...base.output, responseProcessing: { mode: 'buffered', rules: [{ ...responseProcessing.rules[0], matcher: { type: 'regex', pattern: '(' } }] } } }))).toThrow(/Invalid responseProcessing regex/);
  });
  it('accepts audio input with or without accompanying text', () => {
    const audio = { format: 'pcm_s16le', sampleRate: 16000, channels: 1, language: 'en', data: 'AAAA' };
    expect(decodeEnvelope(JSON.stringify({ ...base, event: { audio } })).type).toBe('reply.request');
    expect(decodeEnvelope(JSON.stringify({ ...base, event: { text: 'Visual context', audio } })).type).toBe('reply.request');
  });
  it('accepts browser-managed voice capture controls with character context', () => {
    const start = { ...base, ...promptContext, protocol: 'gemtavern.rp_engine', type: 'voice.capture.start' };
    delete (start as { event?: unknown }).event;
    expect(decodeEnvelope(JSON.stringify(start)).type).toBe('voice.capture.start');
    expect(decodeEnvelope(JSON.stringify({ protocol: 'gemtavern.rp_engine', protocolVersion: 3, type: 'voice.capture.stop', messageId: 'm2', timestamp: '2026-07-14T00:00:00.000Z', requestId: 'r1' })).type).toBe('voice.capture.stop');
  });
  it('accepts optional game-neutral audio profiles for reply and capture requests', () => {
    for (const profile of ['narrowband_voice', 'cinematic_radio']) {
      const output = { ...base.output, audio: { ...base.output.audio, processing: { profile } } };
      expect(decodeEnvelope(JSON.stringify({ ...base, output })).type).toBe('reply.request');
      const start = { ...base, type: 'voice.capture.start', output };
      delete (start as { event?: unknown }).event;
      expect(decodeEnvelope(JSON.stringify(start)).type).toBe('voice.capture.start');
    }
  });
  it('rejects malformed and unknown audio processing profiles', () => {
    const audio = { ...base.output.audio, processing: 'narrowband_voice' };
    expect(() => decodeEnvelope(JSON.stringify({ ...base, output: { ...base.output, audio } }))).toThrow(/must be an object/);
    const unknown = { ...base.output.audio, processing: { profile: 'radio' } };
    expect(() => decodeEnvelope(JSON.stringify({ ...base, output: { ...base.output, audio: unknown } }))).toThrow(/processing profile/);
  });
  it('accepts only supported voice silence behaviors', () => {
    const start = { ...base, ...promptContext, protocol: 'gemtavern.rp_engine', type: 'voice.capture.start', silenceBehavior: 'restart' };
    delete (start as { event?: unknown }).event;
    expect((decodeEnvelope(JSON.stringify(start)) as { silenceBehavior?: string }).silenceBehavior).toBe('restart');
    expect(() => decodeEnvelope(JSON.stringify({ ...start, silenceBehavior: 'ignore' }))).toThrow(/silenceBehavior/);
  });
  it('accepts complete prompt context and rejects incomplete or invalid bundles', () => {
    expect(decodeEnvelope(JSON.stringify({ ...base, ...promptContext })).type).toBe('reply.request');
    expect(() => decodeEnvelope(JSON.stringify({ ...base, interactionMode: 'auto_event' }))).toThrow(/together/);
    expect(() => decodeEnvelope(JSON.stringify({ ...base, ...promptContext, interactionMode: 'voice' }))).toThrow(/interactionMode/);
    expect(() => decodeEnvelope(JSON.stringify({ ...base, ...promptContext, promptScene: { ...promptContext.promptScene, sceneLine: '' } }))).toThrow(/sceneLine/);
  });
  it('rejects malformed audio input', () => {
    expect(() => decodeEnvelope(JSON.stringify({ ...base, event: { audio: { format: 'wav', sampleRate: 16000, channels: 1, data: 'AAAA' } } }))).toThrow(/pcm_s16le/);
    expect(() => decodeEnvelope(JSON.stringify({ ...base, event: { audio: { format: 'pcm_s16le', sampleRate: 44100, channels: 1, data: 'AAAA' } } }))).toThrow(/16 kHz mono/);
  });
  it('rejects v2 and malformed output modes', () => {
    expect(() => decodeEnvelope(JSON.stringify({ ...base, protocolVersion: 2 }))).toThrow(/version/);
    expect(() => decodeEnvelope(JSON.stringify({ ...base, output: { modalities: ['audio'] } }))).toThrow(/must include text/);
    expect(() => decodeEnvelope(JSON.stringify({ ...base, output: { modalities: ['text', 'audio'], language: 'en' } }))).toThrow(/Supertonic 3/);
  });
  it('accepts configurable loopback ports without pairing credentials', () => {
    expect(connectionPortFromFragment('#port=39000')).toBe(39000);
    expect(connectionPortFromFragment('')).toBeUndefined();
    expect(loopbackEndpoint(39000)).toBe('ws://127.0.0.1:39000/rp-engine/socket');
    expect(() => connectionPortFromFragment('#port=80')).toThrow(/between 1024 and 65535/);
  });
});
