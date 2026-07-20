import { analyse_audio, resample_audio } from './core';

export const CAPTURE_SAMPLE_RATE = 16000;
export const MAX_CAPTURE_SECONDS = 30;
const SILENCE_PEAK_THRESHOLD = 0.01;
const SILENCE_RMS_THRESHOLD = 0.003;
const RECORDER_TIMESLICE_MS = 250;

export interface CaptureLevel {
  requestId: string;
  seconds: number;
  peak: number;
  rms: number;
}

export interface CaptureState {
  requestId: string;
  state: 'listening' | 'speech_started' | 'speech_ended';
  seconds: number;
  autoEndEnabled: boolean;
  message?: string;
}

export interface CaptureResult {
  samples: Float32Array;
  seconds: number;
  peak: number;
  rms: number;
}

export interface CaptureCallbacks {
  onLevel: (level: CaptureLevel) => void;
  onState: (state: CaptureState) => void;
  onError: (error: Error) => void;
}

export type SilenceBehavior = 'error' | 'restart';

interface ActiveCapture {
  requestId: string;
  recorder: MediaRecorder;
  chunks: Blob[];
  chunkTimes: number[];
  startedAt: number;
  callbacks: CaptureCallbacks;
  recorderStop?: Promise<Blob>;
  resolveRecorderStop?: (blob: Blob) => void;
  rejectRecorderStop?: (error: Error) => void;
  finalize?: Promise<CaptureResult>;
  limitTimer?: number;
  heldAtLimit: boolean;
  cancelled: boolean;
  stopping: boolean;
  silenceBehavior: SilenceBehavior;
  restart?: Promise<void>;
}

export interface VoiceCaptureDiagnostic {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  details?: Record<string, unknown>;
}

export class BrowserVoiceCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private silentSink?: GainNode;
  private vadWorker?: Worker;
  private vadReady = false;
  private vadError = '';
  private active?: ActiveCapture;

  constructor(private readonly onDiagnostic: (entry: VoiceCaptureDiagnostic) => void = () => undefined) {}

  get enabled() { return Boolean(this.stream && this.context && this.worklet); }
  get recording() { return Boolean(this.active); }

  async enable() {
    if (this.enabled) {
      if (!this.vadReady) await this.loadVadSafely();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot access microphones.');
    if (typeof MediaRecorder === 'undefined') throw new Error('This browser does not support reliable microphone recording.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.context = new AudioContext();
      await this.context.audioWorklet.addModule('/microphone-worklet.js');
      this.source = this.context.createMediaStreamSource(this.stream);
      this.worklet = new AudioWorkletNode(this.context, 'gamelink-microphone-capture');
      this.silentSink = this.context.createGain();
      this.silentSink.gain.value = 0;
      this.source.connect(this.worklet).connect(this.silentSink).connect(this.context.destination);
      this.worklet.port.onmessage = event => this.receiveWorklet(event.data as Record<string, unknown>);
      for (const track of this.stream.getAudioTracks()) {
        track.addEventListener('mute', () => this.report('warn', 'Microphone track was muted.'));
        track.addEventListener('unmute', () => this.report('info', 'Microphone track resumed.'));
        track.addEventListener('ended', () => this.captureFailed(new Error('The microphone track ended. Enable microphone again.')));
      }
      await this.context.resume();
      await this.loadVadSafely();
    } catch (error) {
      this.dispose();
      throw new Error(microphoneError(error));
    }
  }

  start(requestId: string, callbacks: CaptureCallbacks, silenceBehavior: SilenceBehavior = 'error') {
    if (!this.enabled || !this.stream || !this.context) throw new Error('Enable microphone in GameLink before starting a voice message.');
    if (this.active) throw new Error('A voice capture is already active.');
    const mimeType = preferredRecorderMimeType();
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    const capture: ActiveCapture = {
      requestId,
      recorder,
      chunks: [],
      chunkTimes: [],
      startedAt: performance.now(),
      callbacks,
      heldAtLimit: false,
      cancelled: false,
      stopping: false,
      silenceBehavior,
    };
    recorder.ondataavailable = event => {
      if (event.data.size && !capture.cancelled) {
        capture.chunks.push(event.data);
        capture.chunkTimes.push(performance.now());
      }
    };
    recorder.onerror = () => this.captureFailed(new Error('The browser microphone recorder failed.'));
    recorder.onstop = () => capture.resolveRecorderStop?.(new Blob(capture.chunks, { type: recorder.mimeType || mimeType }));
    this.active = capture;
    void this.context.resume();
    recorder.start(RECORDER_TIMESLICE_MS);
    this.worklet!.port.postMessage({ type: 'start', requestId });
    if (this.vadReady) {
      this.vadWorker!.postMessage({ type: 'start', requestId, sourceRate: this.context.sampleRate });
    } else {
      callbacks.onState({ requestId, state: 'listening', seconds: 0, autoEndEnabled: false, message: this.vadError || 'VAD unavailable—use Send voice.' });
    }
    capture.limitTimer = window.setTimeout(() => this.holdAtLimit(capture), MAX_CAPTURE_SECONDS * 1000);
    this.report('info', 'Browser voice capture started.', { requestId, mimeType: recorder.mimeType || mimeType, sampleRate: this.context.sampleRate, vadEnabled: this.vadReady });
  }

  stop(requestId: string) {
    const capture = this.active;
    if (!capture || capture.requestId !== requestId) return Promise.reject(new Error('No matching voice capture is active.'));
    capture.stopping = true;
    if (!capture.finalize) capture.finalize = this.finalize(capture);
    return capture.finalize;
  }

  cancel(requestId: string) {
    const capture = this.active;
    if (!capture || capture.requestId !== requestId) return;
    capture.cancelled = true;
    capture.stopping = true;
    if (capture.limitTimer !== undefined) window.clearTimeout(capture.limitTimer);
    this.worklet?.port.postMessage({ type: 'cancel', requestId });
    this.vadWorker?.postMessage({ type: 'cancel', requestId });
    if (capture.recorder.state !== 'inactive') capture.recorder.stop();
    capture.rejectRecorderStop?.(new Error('Voice capture was cancelled.'));
    this.active = undefined;
    this.report('info', 'Browser voice capture cancelled.', { requestId });
  }

  dispose() {
    if (this.active) this.cancel(this.active.requestId);
    this.source?.disconnect();
    this.worklet?.disconnect();
    this.silentSink?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    void this.context?.close();
    this.vadWorker?.terminate();
    this.stream = undefined;
    this.context = undefined;
    this.source = undefined;
    this.worklet = undefined;
    this.silentSink = undefined;
    this.vadWorker = undefined;
    this.vadReady = false;
  }

  private async loadVadSafely() {
    try {
      this.vadWorker?.terminate();
      this.vadWorker = new Worker(new URL('./fire-red-vad.worker.ts', import.meta.url));
      this.vadWorker.onmessage = event => this.receiveVad(event.data as Record<string, unknown>);
      this.vadWorker.onerror = event => this.vadFailed(event.message || 'FireRedVAD worker failed.');
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('FireRedVAD loading timed out.')), 15000);
        const receive = (event: MessageEvent<Record<string, unknown>>) => {
          if (event.data.type !== 'loaded' && event.data.type !== 'load-error') return;
          window.clearTimeout(timeout);
          this.vadWorker?.removeEventListener('message', receive);
          if (event.data.type === 'loaded') resolve();
          else reject(new Error(String(event.data.message ?? 'FireRedVAD failed to load.')));
        };
        this.vadWorker!.addEventListener('message', receive);
        this.vadWorker!.postMessage({ type: 'load' });
      });
      this.vadReady = true;
      this.vadError = '';
      this.report('info', 'FireRedVAD loaded.', { model: 'fireredvad_stream_vad_with_cache.onnx' });
    } catch (error) {
      this.vadFailed(error instanceof Error ? error.message : String(error));
    }
  }

  private receiveWorklet(message: Record<string, unknown>) {
    const capture = this.active;
    const requestId = String(message.requestId ?? '');
    if (!capture || capture.requestId !== requestId) return;
    if (message.type === 'chunk' && message.samples instanceof ArrayBuffer) {
      if (this.vadReady) this.vadWorker?.postMessage({ type: 'chunk', requestId, samples: message.samples, endSeconds: numberValue(message.endSeconds) }, [message.samples]);
    } else if (message.type === 'level') {
      capture.callbacks.onLevel({ requestId, seconds: numberValue(message.seconds), peak: numberValue(message.peak), rms: numberValue(message.rms) });
    } else if (message.type === 'limit') {
      this.holdAtLimit(capture);
    }
  }

  private receiveVad(message: Record<string, unknown>) {
    const capture = this.active;
    if (message.type === 'loaded' || message.type === 'load-error') return;
    const requestId = String(message.requestId ?? '');
    if (!capture || capture.requestId !== requestId) return;
    if (message.type === 'state' || message.type === 'degraded') {
      capture.callbacks.onState({
        requestId,
        state: validState(message.state),
        seconds: numberValue(message.seconds),
        autoEndEnabled: message.autoEndEnabled !== false,
        message: typeof message.message === 'string' ? message.message : undefined,
      });
      if (message.type === 'degraded') this.vadReady = false;
    } else if (message.type === 'no-speech') {
      if (capture.silenceBehavior === 'restart') {
        if (!capture.restart) {
          capture.restart = this.restartSilentCapture(capture)
            .catch(error => {
              if (!capture.cancelled && !capture.stopping) this.captureFailed(error instanceof Error ? error : new Error(String(error)));
            })
            .finally(() => {
              if (this.active === capture) capture.restart = undefined;
            });
        }
      } else {
        capture.callbacks.onError(new Error('No speech was detected within 8 seconds.'));
      }
    } else if (message.type === 'diagnostic') {
      this.report('debug', `FireRedVAD p=${numberValue(message.probability).toFixed(3)}, inference=${numberValue(message.inferenceMs).toFixed(1)}ms, lag=${numberValue(message.lagSeconds).toFixed(2)}s.`);
    }
  }

  private async finalize(capture: ActiveCapture) {
    if (capture.limitTimer !== undefined) window.clearTimeout(capture.limitTimer);
    if (capture.restart) await capture.restart;
    this.worklet?.port.postMessage({ type: 'stop', requestId: capture.requestId });
    this.vadWorker?.postMessage({ type: 'cancel', requestId: capture.requestId });
    const wallSeconds = Math.min(MAX_CAPTURE_SECONDS, (performance.now() - capture.startedAt) / 1000);
    const blob = await this.stopRecorder(capture);
    if (capture.cancelled || this.active !== capture) throw new Error('Voice capture was cancelled.');
    if (!blob.size) throw new Error('No microphone audio was captured.');
    const decoded = await this.context!.decodeAudioData(await blob.arrayBuffer());
    const mono = mixToMono(decoded);
    const samples = resampleTo16k(mono, decoded.sampleRate);
    const stats = analyse(samples);
    const pcmSeconds = samples.length / CAPTURE_SAMPLE_RATE;
    const durationDelta = Math.abs(wallSeconds - pcmSeconds);
    const allowedDelta = Math.max(0.5, wallSeconds * 0.2);
    const maxGapMs = maximumGap(capture.chunkTimes);
    this.report('info', `Browser voice capture finalized: wall=${wallSeconds.toFixed(2)}s, pcm=${pcmSeconds.toFixed(2)}s, chunks=${capture.chunks.length}, maxGap=${maxGapMs.toFixed(0)}ms, peak=${stats.peak.toFixed(4)}, rms=${stats.rms.toFixed(4)}.`, { requestId: capture.requestId, mimeType: capture.recorder.mimeType });
    this.active = undefined;
    if (durationDelta > allowedDelta) throw new Error('The browser produced an incomplete recording. Please try again.');
    if (!samples.length) throw new Error('No microphone audio was captured.');
    if (stats.peak < SILENCE_PEAK_THRESHOLD && stats.rms < SILENCE_RMS_THRESHOLD) throw new Error('No audible microphone input was detected.');
    return { samples, seconds: pcmSeconds, ...stats };
  }

  private async restartSilentCapture(capture: ActiveCapture) {
    if (this.active !== capture || capture.cancelled || capture.stopping) return;
    if (capture.limitTimer !== undefined) window.clearTimeout(capture.limitTimer);
    this.worklet?.port.postMessage({ type: 'cancel', requestId: capture.requestId });
    this.vadWorker?.postMessage({ type: 'cancel', requestId: capture.requestId });
    await this.stopRecorder(capture);
    if (this.active !== capture || capture.cancelled || capture.stopping) return;

    const mimeType = preferredRecorderMimeType();
    const recorder = new MediaRecorder(this.stream!, mimeType ? { mimeType } : undefined);
    capture.recorder = recorder;
    capture.chunks = [];
    capture.chunkTimes = [];
    capture.startedAt = performance.now();
    capture.recorderStop = undefined;
    capture.resolveRecorderStop = undefined;
    capture.rejectRecorderStop = undefined;
    capture.heldAtLimit = false;
    recorder.ondataavailable = event => {
      if (event.data.size && !capture.cancelled) {
        capture.chunks.push(event.data);
        capture.chunkTimes.push(performance.now());
      }
    };
    recorder.onerror = () => this.captureFailed(new Error('The browser microphone recorder failed.'));
    recorder.onstop = () => capture.resolveRecorderStop?.(new Blob(capture.chunks, { type: recorder.mimeType || mimeType }));
    recorder.start(RECORDER_TIMESLICE_MS);
    this.worklet!.port.postMessage({ type: 'start', requestId: capture.requestId });
    this.vadWorker!.postMessage({ type: 'start', requestId: capture.requestId, sourceRate: this.context!.sampleRate });
    capture.limitTimer = window.setTimeout(() => this.holdAtLimit(capture), MAX_CAPTURE_SECONDS * 1000);
    capture.callbacks.onState({ requestId: capture.requestId, state: 'listening', seconds: 0, autoEndEnabled: true, message: 'Still listening.' });
    this.report('info', 'Silent voice capture window discarded and restarted.', { requestId: capture.requestId });
  }

  private stopRecorder(capture: ActiveCapture) {
    if (capture.recorderStop) return capture.recorderStop;
    capture.recorderStop = new Promise<Blob>((resolve, reject) => {
      capture.resolveRecorderStop = resolve;
      capture.rejectRecorderStop = reject;
      if (capture.recorder.state === 'inactive') resolve(new Blob(capture.chunks, { type: capture.recorder.mimeType }));
      else {
        capture.recorder.requestData();
        capture.recorder.stop();
      }
    });
    return capture.recorderStop;
  }

  private holdAtLimit(capture: ActiveCapture) {
    if (this.active !== capture || capture.heldAtLimit) return;
    capture.heldAtLimit = true;
    void this.stopRecorder(capture).catch(error => this.captureFailed(error instanceof Error ? error : new Error(String(error))));
    capture.callbacks.onState({ requestId: capture.requestId, state: 'listening', seconds: MAX_CAPTURE_SECONDS, autoEndEnabled: false, message: '30 second limit reached—use Send voice or Cancel.' });
  }

  private vadFailed(message: string) {
    this.vadReady = false;
    this.vadError = `VAD unavailable—use Send voice. ${message}`;
    this.report('warn', this.vadError);
    const capture = this.active;
    if (capture) capture.callbacks.onState({ requestId: capture.requestId, state: 'listening', seconds: 0, autoEndEnabled: false, message: this.vadError });
  }

  private captureFailed(error: Error) {
    const capture = this.active;
    if (!capture) return;
    capture.callbacks.onError(error);
  }

  private report(level: VoiceCaptureDiagnostic['level'], message: string, details?: Record<string, unknown>) {
    this.onDiagnostic({ level, message, details });
  }
}

export function resampleTo16k(input: Float32Array, sourceRate: number) {
  return resample_audio(input, sourceRate, CAPTURE_SAMPLE_RATE);
}

export function preferredRecorderMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  return ['audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type)) ?? '';
}

function mixToMono(buffer: AudioBuffer) {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < samples.length; index += 1) mono[index] += samples[index] / buffer.numberOfChannels;
  }
  return mono;
}

function analyse(samples: Float32Array) {
  return JSON.parse(analyse_audio(samples)) as { peak: number; rms: number };
}

function maximumGap(times: number[]) {
  let maximum = 0;
  for (let index = 1; index < times.length; index += 1) maximum = Math.max(maximum, times[index] - times[index - 1]);
  return maximum;
}

function validState(value: unknown): CaptureState['state'] {
  return value === 'speech_started' || value === 'speech_ended' ? value : 'listening';
}

function numberValue(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : 0; }

function microphoneError(error: unknown) {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone permission was denied. Enable it in your browser settings and try again.';
  if (name === 'NotFoundError') return 'No microphone device was found.';
  if (name === 'NotReadableError') return 'The microphone is busy or unavailable.';
  return error instanceof Error ? error.message : 'Could not enable the microphone.';
}
