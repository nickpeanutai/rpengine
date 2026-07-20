import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserVoiceCapture, CAPTURE_SAMPLE_RATE, preferredRecorderMimeType, resampleTo16k } from './browser-voice-capture';

describe('browser voice capture audio preparation', () => {
  it('resamples browser microphone frames to Moonshine 16 kHz input', () => {
    const samples = resampleTo16k(new Float32Array([0, 1, 0, -1]), 8000);
    expect(samples.length).toBe(8);
    expect(samples[0]).toBe(0);
    expect(samples[2]).toBe(1);
    expect(CAPTURE_SAMPLE_RATE).toBe(16000);
  });

  it('does not require MediaRecorder when selecting a MIME type in non-browser tests', () => {
    expect(preferredRecorderMimeType()).toBe('');
  });
});

describe('browser voice capture silence policy', () => {
  class FakeMediaRecorder {
    static instances: FakeMediaRecorder[] = [];
    static isTypeSupported() { return false; }
    mimeType = 'audio/webm';
    state: RecordingState = 'inactive';
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onerror: (() => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() { FakeMediaRecorder.instances.push(this); }
    start() { this.state = 'recording'; }
    requestData() { this.ondataavailable?.({ data: new Blob(['discarded-silence']) }); }
    stop() { this.state = 'inactive'; queueMicrotask(() => this.onstop?.()); }
  }

  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    vi.stubGlobal('window', globalThis);
  });

  afterEach(() => vi.unstubAllGlobals());

  function enabledCapture() {
    const voiceCapture = new BrowserVoiceCapture();
    const postWorklet = vi.fn();
    const postVad = vi.fn();
    Object.assign(voiceCapture as unknown as Record<string, unknown>, {
      stream: {},
      context: { sampleRate: 48000, resume: vi.fn(async () => undefined) },
      worklet: { port: { postMessage: postWorklet } },
      vadWorker: { postMessage: postVad },
      vadReady: true,
    });
    return { voiceCapture, postWorklet, postVad };
  }

  it('keeps the legacy no-speech error by default', () => {
    const { voiceCapture } = enabledCapture();
    const onError = vi.fn();
    voiceCapture.start('legacy', { onLevel: vi.fn(), onState: vi.fn(), onError });
    (voiceCapture as unknown as { receiveVad(message: Record<string, unknown>): void }).receiveVad({ type: 'no-speech', requestId: 'legacy' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'No speech was detected within 8 seconds.' }));
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    voiceCapture.cancel('legacy');
  });

  it('discards and restarts a silent recorder window under the same request', async () => {
    const { voiceCapture, postWorklet, postVad } = enabledCapture();
    const onState = vi.fn();
    const onError = vi.fn();
    voiceCapture.start('restart', { onLevel: vi.fn(), onState, onError }, 'restart');
    (voiceCapture as unknown as { receiveVad(message: Record<string, unknown>): void }).receiveVad({ type: 'no-speech', requestId: 'restart' });
    await vi.waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(2));
    expect(onError).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'restart', state: 'listening', seconds: 0 }));
    expect(postWorklet).toHaveBeenLastCalledWith({ type: 'start', requestId: 'restart' });
    expect(postVad).toHaveBeenLastCalledWith({ type: 'start', requestId: 'restart', sourceRate: 48000 });
    expect((voiceCapture as unknown as { active: { chunks: Blob[] } }).active.chunks).toHaveLength(0);
    voiceCapture.cancel('restart');
  });

  it('does not create a new recorder when cancellation wins the restart race', async () => {
    const { voiceCapture } = enabledCapture();
    const onError = vi.fn();
    voiceCapture.start('race', { onLevel: vi.fn(), onState: vi.fn(), onError }, 'restart');
    (voiceCapture as unknown as { receiveVad(message: Record<string, unknown>): void }).receiveVad({ type: 'no-speech', requestId: 'race' });
    voiceCapture.cancel('race');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });
});
