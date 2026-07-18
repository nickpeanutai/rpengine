import { describe, expect, it } from 'vitest';
import { applyJsonPatch, canonicalHash, canonicalJson, CardSessionStore } from './card-sync';
import type { CharacterCardV2, JsonObject } from './types';

const original: CharacterCardV2 = {
  spec: 'chara_card_v2', spec_version: '2.0',
  data: {
    name: 'Ari', description: 'First', personality: '', scenario: '', first_mes: '', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: ['calm', 'loyal'], creator: '', character_version: '', extensions: {},
  },
};

describe('canonical Character Card V2 synchronization', () => {
  it('uses stable sorted canonical JSON and SHA-256', async () => {
    const fixture: JsonObject = { spec: 'chara_card_v2', data: { name: 'Ari', age: 4, tags: ['a'] } };
    const crossLanguageFixture: CharacterCardV2 = {
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name: 'Ari', description: 'Cautious engineer.', personality: 'Practical.', scenario: 'Station.',
        first_mes: '', mes_example: '', creator_notes: '', system_prompt: 'Write as {{char}}.',
        post_history_instructions: '', alternate_greetings: [], tags: ['engineer'],
        creator: 'Cross-language fixture', character_version: '1.0.0',
        extensions: { 'com.gemtavern.test/source': 'rimworld' },
      },
    };
    expect(canonicalJson(fixture)).toBe('{"data":{"age":4,"name":"Ari","tags":["a"]},"spec":"chara_card_v2"}');
    expect(await canonicalHash(original)).toMatch(/^[0-9a-f]{64}$/);
    expect(await canonicalHash(fixture)).toBe('71981de431e9b5327456a39a3eed23fb6eabb68efdd050f271c222f6f50a8b31');
    expect(await canonicalHash(crossLanguageFixture)).toBe('115fc8927f70fd0a6626081bc2cf991030929a93e44d90747634204753dc1119');
  });

  it('applies object, deletion, and array RFC 6902 operations', () => {
    const result = applyJsonPatch(original, [
      { op: 'replace', path: '/data/description', value: 'Second' },
      { op: 'remove', path: '/data/tags/0' },
      { op: 'add', path: '/data/tags/-', value: 'brave' },
    ]);
    expect(result.data).toMatchObject({ name: 'Ari', tags: ['loyal', 'brave'], description: 'Second' });
  });

  it('accepts snapshot, patch, and reference and rejects a wrong base', async () => {
    const store = new CardSessionStore();
    const hash = await canonicalHash(original);
    await store.resolve('game', 'ari', { format: 'chara_card_v2', mode: 'snapshot', snapshot: original, targetHash: hash });
    const changed = applyJsonPatch(original, [{ op: 'replace', path: '/data/description', value: 'Second' }]);
    const changedHash = await canonicalHash(changed);
    await store.resolve('game', 'ari', { format: 'chara_card_v2', mode: 'patch', patch: [{ op: 'replace', path: '/data/description', value: 'Second' }], baseHash: hash, targetHash: changedHash });
    await expect(store.resolve('game', 'ari', { format: 'chara_card_v2', mode: 'reference', targetHash: changedHash })).resolves.toMatchObject({ hash: changedHash });
    await expect(store.resolve('game', 'ari', { format: 'chara_card_v2', mode: 'patch', patch: [], baseHash: hash, targetHash: changedHash })).rejects.toMatchObject({ code: 'card_resync_required' });
    await expect(store.resolve('game', 'new', { format: 'chara_card_v2', mode: 'snapshot', snapshot: original, targetHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'card_resync_required' });
    const wrongSpec = { spec: 'other', data: { name: 'Ari' } } as unknown as CharacterCardV2;
    await expect(store.resolve('game', 'bad', { format: 'chara_card_v2', mode: 'snapshot', snapshot: wrongSpec, targetHash: hash })).rejects.toMatchObject({ code: 'invalid_character_card' });
    const incomplete = { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Ari' } } as unknown as CharacterCardV2;
    await expect(store.resolve('game', 'incomplete', { format: 'chara_card_v2', mode: 'snapshot', snapshot: incomplete, targetHash: await canonicalHash(incomplete) })).rejects.toMatchObject({ code: 'invalid_character_card' });
  });

  it('validates optional Character Card V2 character books without removing extensions', async () => {
    const withBook: CharacterCardV2 = structuredClone(original);
    (withBook.data as JsonObject).character_book = {
      name: 'Station lore', extensions: { 'mock/source': 'game' }, entries: [
        { keys: ['reactor'], content: 'The reactor is unstable.', extensions: {}, enabled: true, insertion_order: 10 },
      ],
    };
    const store = new CardSessionStore();
    const hash = await canonicalHash(withBook);
    const resolved = await store.resolve('game', 'book', { format: 'chara_card_v2', mode: 'snapshot', snapshot: withBook, targetHash: hash });
    expect(resolved.card).toEqual(withBook);
  });

  it('rejects a patch that reconstructs an invalid Character Card V2 document', async () => {
    const store = new CardSessionStore();
    const hash = await canonicalHash(original);
    await store.resolve('game', 'ari', { format: 'chara_card_v2', mode: 'snapshot', snapshot: original, targetHash: hash });

    const invalid = applyJsonPatch(original, [{ op: 'remove', path: '/data/extensions' }]);
    await expect(store.resolve('game', 'ari', {
      format: 'chara_card_v2',
      mode: 'patch',
      patch: [{ op: 'remove', path: '/data/extensions' }],
      baseHash: hash,
      targetHash: await canonicalHash(invalid),
    })).rejects.toMatchObject({ code: 'invalid_character_card' });
  });
});
