import { beforeAll, describe, expect, it } from 'vitest';
import { CoreSession, core_abi_version, initializeCore } from './core';
import { dispatchCore, type CoreEffectV3 } from './core-contract';

beforeAll(() => initializeCore());

describe('generated ABI v3 contract', () => {
  it('matches the runtime ABI and returns a Rust-owned view model', () => {
    expect(core_abi_version()).toBe(3);
    const core = new CoreSession();
    const batch = dispatchCore(core, { type: 'bootstrap', appVersion: 'test', language: 'en', port: 38471 });
    expect(batch.abiVersion).toBe(3);
    expect(batch.effects.some(effect => effect.type === 'modelsRefresh')).toBe(true);
    const render = batch.effects.find(effect => effect.type === 'render');
    expect(render?.type === 'render' ? render.viewModel.settings.port : undefined).toBe(38471);
  });

  it('keeps effect handling exhaustive at compile time', () => {
    const identify = (effect: CoreEffectV3) => {
      switch (effect.type) {
        case 'transportConnect': case 'transportDisconnect': case 'transportSend': case 'scheduleTimer': case 'cancelTimer':
        case 'ownershipAcquire': case 'ownershipRelease': case 'ownershipPhase': case 'modelsRefresh':
        case 'modelDownload': case 'modelCancel': case 'modelDelete': case 'modelCleanup': case 'runtimesLoad': case 'runtimesDispose':
        case 'microphoneEnable': case 'microphoneDisable': case 'captureStart': case 'captureStop': case 'captureCancel': case 'sttInvoke':
        case 'gemmaInvoke': case 'gemmaCancel': case 'ttsInvoke': case 'replyAudioTransport': case 'diagnostic': case 'render': return effect.type;
        default: return assertNever(effect);
      }
    };
    const effect: CoreEffectV3 = { type: 'modelsRefresh' };
    expect(identify(effect)).toBe('modelsRefresh');
  });
});

function assertNever(value: never): never { throw new Error(`Unhandled effect: ${JSON.stringify(value)}`); }
