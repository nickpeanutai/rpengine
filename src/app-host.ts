import { CoreSession } from './core';
import { APP_VERSION } from './app-version';
import { dispatchCore, dispatchCoreAudio, takeCoreReplyAudioTransport, type CoreEffectV2, type HostAudioEventV2, type HostEventV2 } from './core-contract';
import { BrowserVoiceCapture } from './browser-voice-capture';
import { DiagnosticLog } from './diagnostics';
import { EngineOwnership, type EngineOwnerPhase } from './engine-ownership';
import { ModelAdapter } from './model-adapter';
import { AppRenderer, element } from './renderer';
import { RuntimeAdapter } from './runtime-adapter';
import { connectionPortFromFragment } from './protocol';
import { loadLanguage, loadRPEnginePort, saveLanguage, saveRPEnginePort } from './settings';
import { SocketAdapter } from './socket-adapter';
import { GEMMA_MODEL_ID, MOONSHINE_MODEL_IDS, SUPERTONIC_MODEL_ID, type MoonshineLanguage } from './types';

type QueuedEvent = { event: HostEventV2 } | { event: HostAudioEventV2; samples: Float32Array };

export class AppHost {
  private readonly core = new CoreSession();
  private readonly diagnostics = new DiagnosticLog();
  private readonly renderer = new AppRenderer();
  private readonly ownership = new EngineOwnership();
  private readonly capture = new BrowserVoiceCapture(entry => this.diagnostics.add(entry.level, 'voice-capture', entry.message, entry.details));
  private readonly models: ModelAdapter;
  private readonly runtime: RuntimeAdapter;
  private readonly socket: SocketAdapter;
  private readonly timers = new Map<string, number>();
  private queue: QueuedEvent[] = [];
  private draining = false;

  constructor() {
    this.models = new ModelAdapter([GEMMA_MODEL_ID, SUPERTONIC_MODEL_ID, ...Object.values(MOONSHINE_MODEL_IDS)], status => this.dispatch({ type: 'modelStatus', status }));
    this.runtime = new RuntimeAdapter(this.models, event => this.dispatch(event), (event, samples) => this.dispatchAudio(event, samples));
    this.socket = new SocketAdapter({ opened: () => this.dispatch({ type: 'socketOpened' }), message: raw => this.dispatch({ type: 'socketMessage', raw }), closed: (code, reason) => this.dispatch({ type: 'socketClosed', code, reason }), error: message => this.dispatch({ type: 'socketError', message }) });
  }

  start() {
    this.bind();
    this.diagnostics.addEventListener('change', () => this.renderer.renderDiagnostics(this.diagnostics));
    this.ownership.addEventListener('change', () => this.dispatch({ type: 'ownershipOther', active: this.ownership.ownerElsewhere, phase: this.ownership.ownerElsewherePhase }));
    this.renderer.renderDiagnostics(this.diagnostics);
    let port = loadRPEnginePort();
    try { port = connectionPortFromFragment() ?? port; } catch { /* Invalid fragments are ignored by the browser adapter. */ }
    if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
    this.dispatch({ type: 'bootstrap', appVersion: APP_VERSION, language: loadLanguage(), port });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(error => this.diagnostics.add('error', 'system', 'Service worker registration failed', details(error)));
  }

  private dispatch(event: HostEventV2) { this.queue.push({ event }); this.drain(); }
  private dispatchAudio(event: HostAudioEventV2, samples: Float32Array) { this.queue.push({ event, samples }); this.drain(); }
  private drain() {
    if (this.draining) return; this.draining = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        const batch = 'samples' in next ? dispatchCoreAudio(this.core, next.event, next.samples) : dispatchCore(this.core, next.event);
        for (const effect of batch.effects) this.execute(effect);
      }
    } finally { this.draining = false; }
  }

  private execute(effect: CoreEffectV2) {
    switch (effect.type) {
      case 'socketConnect': this.socket.connect(effect.port); break;
      case 'socketDisconnect': this.socket.disconnect(effect.reason, false); break;
      case 'socketSend': this.socket.send(effect.messageType, effect.sessionId, effect.payload); break;
      case 'scheduleTimer': this.schedule(effect.timerId, effect.delayMs); break;
      case 'cancelTimer': this.cancelTimer(effect.timerId); break;
      case 'ownershipAcquire': void this.ownership.acquire().then(acquired => this.dispatch({ type: acquired ? 'ownershipAcquired' : 'ownershipDenied' })).catch(() => this.dispatch({ type: 'ownershipDenied' })); break;
      case 'ownershipRelease': void this.ownership.release().then(() => this.dispatch({ type: 'ownershipReleased' })); break;
      case 'ownershipPhase': this.ownership.setPhase(effect.phase as EngineOwnerPhase); break;
      case 'modelsRefresh': void this.models.refresh().then(models => this.dispatch({ type: 'modelsSnapshot', models })).catch(error => {
        this.diagnostics.add('error', 'model', 'Could not inspect local models', details(error));
        this.dispatch({ type: 'modelsSnapshot', models: this.models.failRefresh(message(error)) });
      }); break;
      case 'modelDownload': void this.models.download(effect.modelId).catch(error => { if (!isAbort(error)) this.dispatch({ type: 'modelFailed', modelId: effect.modelId, message: message(error) }); }); break;
      case 'modelCancel': this.models.cancel(effect.modelId); break;
      case 'modelDelete': void this.models.delete(effect.modelId).catch(error => this.dispatch({ type: 'modelFailed', modelId: effect.modelId, message: message(error) })); break;
      case 'modelCleanup': void this.models.cleanup(effect.modelId).then(removed => this.dispatch({ type: 'modelCleanupCompleted', modelId: effect.modelId, removed })).catch(error => this.dispatch({ type: 'modelCleanupFailed', modelId: effect.modelId, message: message(error) })); break;
      case 'runtimesLoad': void this.runtime.load(effect.operationId, effect.language as MoonshineLanguage, effect.defaultVoice).then(result => this.dispatch({ type: 'runtimeLoaded', operationId: effect.operationId, expressionTags: result.expressionTags })).catch(error => this.dispatch({ type: 'runtimeFailed', operationId: effect.operationId, message: message(error), details: details(error) })); break;
      case 'runtimesDispose': this.runtime.dispose(); break;
      case 'microphoneEnable': void this.capture.enable().then(() => this.dispatch({ type: 'microphoneEnabled' })).catch(error => this.dispatch({ type: 'microphoneFailed', message: message(error) })); break;
      case 'microphoneDisable': this.capture.dispose(); this.dispatch({ type: 'microphoneDisabled' }); break;
      case 'captureStart': this.startCapture(effect.requestId); break;
      case 'captureStop': void this.capture.stop(effect.requestId).then(result => this.dispatchAudio({ type: 'captureCompleted', requestId: effect.requestId }, result.samples)).catch(error => this.dispatch({ type: 'captureFailed', requestId: effect.requestId, message: message(error) })); break;
      case 'captureCancel': this.capture.cancel(effect.requestId); break;
      case 'sttInvoke': {
        const samples = this.core.take_f32_buffer(effect.bufferId);
        void this.runtime.transcribe(effect.operationId, samples, effect.language as MoonshineLanguage).catch(error => this.dispatch({ type: 'sttFailed', operationId: effect.operationId, message: message(error) }));
        break;
      }
      case 'gemmaInvoke': void this.runtime.generate(effect.operationId, effect.system, effect.user, effect.history).catch(error => this.dispatch({ type: 'gemmaFailed', operationId: effect.operationId, message: message(error) })); break;
      case 'gemmaCancel': this.runtime.cancelGemma(effect.operationId); break;
      case 'ttsInvoke': void this.runtime.synthesize(effect.operationId, effect.text, effect.language, effect.voice).catch(error => this.dispatch({ type: 'ttsFailed', operationId: effect.operationId, message: message(error) })); break;
      case 'replyAudioTransport': for (const transportEffect of takeCoreReplyAudioTransport(this.core, effect.transportId).effects) this.execute(transportEffect); break;
      case 'diagnostic': effect.key ? this.diagnostics.upsert(effect.key, effect.level, effect.category, effect.message, effect.details) : this.diagnostics.add(effect.level, effect.category, effect.message, effect.details); break;
      case 'render': this.renderer.render(effect.viewModel); saveLanguage(effect.viewModel.settings.language as MoonshineLanguage); saveRPEnginePort(effect.viewModel.settings.port); break;
      default: assertNever(effect);
    }
  }

  private startCapture(requestId: string) {
    try {
      this.capture.start(requestId, {
        onLevel: level => this.dispatch({ type: 'captureLevel', ...level }),
        onState: state => this.dispatch({ type: 'captureState', ...state }),
        onError: error => this.dispatch({ type: 'captureFailed', requestId, message: error.message }),
      });
    } catch (error) { this.dispatch({ type: 'captureFailed', requestId, message: message(error) }); }
  }

  private schedule(id: string, delay: number) { this.cancelTimer(id); this.timers.set(id, window.setTimeout(() => { this.timers.delete(id); this.dispatch({ type: 'timerFired', timerId: id }); }, delay)); }
  private cancelTimer(id: string) { const timer = this.timers.get(id); if (timer !== undefined) window.clearTimeout(timer); this.timers.delete(id); }

  private bind() {
    window.addEventListener('pagehide', () => this.dispatch({ type: 'pageHide' }));
    element<HTMLButtonElement>('#primaryButton').addEventListener('click', () => this.dispatch({ type: 'uiPrimary' }));
    element<HTMLButtonElement>('#microphoneButton').addEventListener('click', () => this.dispatch({ type: 'uiToggleMicrophone' }));
    element<HTMLButtonElement>('#settingsButton').addEventListener('click', () => element<HTMLDialogElement>('#settingsDialog').showModal());
    element<HTMLButtonElement>('#apiDocsButton').addEventListener('click', () => element<HTMLDialogElement>('#apiDocsDialog').showModal());
    element<HTMLSelectElement>('#languageSelect').addEventListener('change', event => this.dispatch({ type: 'uiLanguage', language: (event.target as HTMLSelectElement).value }));
    element<HTMLInputElement>('#rpEnginePortInput').addEventListener('change', event => this.dispatch({ type: 'uiPort', port: Number((event.target as HTMLInputElement).value) }));
    element('#modelEntries').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-model-action]'); if (button) this.dispatch({ type: 'uiModelAction', modelId: button.dataset.modelId!, action: button.dataset.modelAction as 'download' | 'cancel' | 'delete' }); });
    element<HTMLButtonElement>('#exportLogButton').addEventListener('click', () => { const url = URL.createObjectURL(this.diagnostics.export()); const link = document.createElement('a'); link.href = url; link.download = `rpengine-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`; link.click(); URL.revokeObjectURL(url); });
  }
}

function assertNever(value: never): never { throw new Error(`Unhandled core effect: ${JSON.stringify(value)}`); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function details(error: unknown) { return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }; }
function isAbort(error: unknown) { return error instanceof DOMException && error.name === 'AbortError'; }
