import { CoreSession } from './core';
import { APP_VERSION } from './app-version';
import { dispatchCore, dispatchCoreAudio, takeCoreReplyAudioSegment, type CoreEffectV3, type HostAudioEventV3, type HostEventV3 } from './core-contract';
import { BrowserVoiceCapture } from './browser-voice-capture';
import { DiagnosticLog } from './diagnostics';
import { EngineOwnership, type EngineOwnerPhase } from './engine-ownership';
import { ModelAdapter } from './model-adapter';
import { AppRenderer, element } from './renderer';
import { RuntimeAdapter } from './runtime-adapter';
import { connectionPortFromFragment } from './protocol';
import { loadLanguage, loadRPEnginePort, loadTransportKind, saveLanguage, saveRPEnginePort, saveTransportKind } from './settings';
import { SocketAdapter } from './socket-adapter';
import { FileSystemMailboxAdapter } from './filesystem-mailbox-adapter';
import { getTransportHandle, putTransportHandle } from './history';
import type { TransportAdapter, TransportEvents, TransportKind } from './transport-adapter';
import { GEMMA_MODEL_ID, MOONSHINE_MODEL_IDS, SUPERTONIC_MODEL_ID, type MoonshineLanguage } from './types';

type QueuedEvent = { event: HostEventV3 } | { event: HostAudioEventV3; samples: Float32Array };

export class AppHost {
  private readonly core = new CoreSession();
  private readonly diagnostics = new DiagnosticLog();
  private readonly renderer = new AppRenderer();
  private readonly ownership = new EngineOwnership();
  private readonly capture = new BrowserVoiceCapture(entry => this.diagnostics.add(entry.level, 'voice-capture', entry.message, entry.details));
  private readonly models: ModelAdapter;
  private readonly runtime: RuntimeAdapter;
  private transport: TransportAdapter;
  private transportKind: TransportKind;
  private fileTransport?: FileSystemMailboxAdapter;
  private readonly timers = new Map<string, number>();
  private readonly failedAudioRequests = new Set<string>();
  private queue: QueuedEvent[] = [];
  private draining = false;

  constructor() {
    this.models = new ModelAdapter([GEMMA_MODEL_ID, SUPERTONIC_MODEL_ID, ...Object.values(MOONSHINE_MODEL_IDS)], status => this.dispatch({ type: 'modelStatus', status }));
    this.runtime = new RuntimeAdapter(this.models, event => this.dispatch(event), (event, samples) => this.dispatchAudio(event, samples));
    this.transportKind = loadTransportKind();
    this.transport = new SocketAdapter(this.transportEvents());
  }

  async start() {
    if (this.transportKind === 'filesystem') {
      this.fileTransport = new FileSystemMailboxAdapter(await getTransportHandle('filesystem-root'), this.transportEvents());
      this.transport = this.fileTransport;
    }
    this.bind();
    this.updateTransportControls();
    this.diagnostics.addEventListener('change', () => this.renderer.renderDiagnostics(this.diagnostics));
    this.ownership.addEventListener('change', () => this.dispatch({ type: 'ownershipOther', active: this.ownership.ownerElsewhere, phase: this.ownership.ownerElsewherePhase }));
    this.renderer.renderDiagnostics(this.diagnostics);
    let port = loadRPEnginePort();
    try { port = connectionPortFromFragment() ?? port; } catch { /* Invalid fragments are ignored by the browser adapter. */ }
    if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
    this.dispatch({ type: 'bootstrap', appVersion: APP_VERSION, language: loadLanguage(), port });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(error => this.diagnostics.add('error', 'system', 'Service worker registration failed', details(error)));
  }

  private dispatch(event: HostEventV3) { this.queue.push({ event }); this.drain(); }
  private dispatchAudio(event: HostAudioEventV3, samples: Float32Array) { this.queue.push({ event, samples }); this.drain(); }
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

  private execute(effect: CoreEffectV3) {
    switch (effect.type) {
      case 'transportConnect': void this.transport.connect(effect.port); break;
      case 'transportDisconnect': this.transport.disconnect(effect.reason, false); break;
      case 'transportSend': {
        const requestId = typeof effect.payload.requestId === 'string' ? effect.payload.requestId : undefined;
        if (requestId && this.failedAudioRequests.has(requestId) && (effect.messageType === 'reply.audio.completed' || effect.messageType === 'reply.completed')) { if (effect.messageType === 'reply.completed') this.failedAudioRequests.delete(requestId); break; }
        void this.transport.send(effect.messageType, effect.sessionId, effect.payload); break;
      }
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
      case 'replyAudioTransport': {
        const segment = takeCoreReplyAudioSegment(this.core, effect.transportId); const sent = this.transport.sendAudioSegment(segment);
        if (sent === false) { this.failedAudioRequests.add(segment.requestId); void this.transport.send('request.error', segment.sessionId, { requestId: segment.requestId, code: 'audio_transport_failed', message: 'Audio delivery is unavailable for this game process; later requests are text-only.', retryable: false }); }
        break;
      }
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
    element<HTMLSelectElement>('#transportSelect').value = this.transportKind;
    element<HTMLSelectElement>('#transportSelect').addEventListener('change', event => this.changeTransport((event.target as HTMLSelectElement).value as TransportKind));
    element<HTMLButtonElement>('#chooseMailboxButton').addEventListener('click', () => void this.chooseMailbox());
    element('#modelEntries').addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-model-action]'); if (button) this.dispatch({ type: 'uiModelAction', modelId: button.dataset.modelId!, action: button.dataset.modelAction as 'download' | 'cancel' | 'delete' }); });
    element<HTMLButtonElement>('#exportLogButton').addEventListener('click', () => { const url = URL.createObjectURL(this.diagnostics.export()); const link = document.createElement('a'); link.href = url; link.download = `rpengine-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`; link.click(); URL.revokeObjectURL(url); });
  }

  private transportEvents(): TransportEvents {
    return { opened: () => this.dispatch({ type: 'transportOpened' }), message: raw => this.dispatch({ type: 'transportMessage', raw }), closed: (code, reason) => this.dispatch({ type: 'transportClosed', code, reason }), error: message => this.dispatch({ type: 'transportError', message }) };
  }

  private changeTransport(kind: TransportKind) {
    this.transport.disconnect('Transport changed', false);
    this.transportKind = kind; saveTransportKind(kind);
    if (kind === 'websocket') { this.transport = new SocketAdapter(this.transportEvents()); this.fileTransport = undefined; }
    else { this.fileTransport = new FileSystemMailboxAdapter(undefined, this.transportEvents()); this.transport = this.fileTransport; void getTransportHandle('filesystem-root').then(handle => { if (handle && this.fileTransport) this.fileTransport.setRoot(handle); }); }
    this.updateTransportControls();
  }

  private async chooseMailbox() {
    if (!('showDirectoryPicker' in window)) { this.dispatch({ type: 'transportError', message: 'This browser does not support local folder access.' }); return; }
    try {
      const root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'rpengine-file-mailbox' });
      await putTransportHandle('filesystem-root', root);
      this.fileTransport ??= new FileSystemMailboxAdapter(root, this.transportEvents()); this.fileTransport.setRoot(root);
      const granted = await this.fileTransport.requestPermission();
      element('#mailboxStatus').textContent = granted ? `Selected: ${root.name}` : 'Folder permission was not granted.';
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) this.dispatch({ type: 'transportError', message: message(error) }); }
  }

  private updateTransportControls() {
    const file = this.transportKind === 'filesystem';
    element<HTMLElement>('#fileTransportControls').hidden = !file;
    element<HTMLElement>('#webSocketControls').hidden = file;
  }
}

declare global {
  interface Window { showDirectoryPicker(options?: { mode?: 'read' | 'readwrite'; id?: string }): Promise<FileSystemDirectoryHandle>; }
  interface FileSystemHandle {
    queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  }
  interface FileSystemDirectoryHandle {
    keys(): AsyncIterableIterator<string>;
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
}

function assertNever(value: never): never { throw new Error(`Unhandled core effect: ${JSON.stringify(value)}`); }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function details(error: unknown) { return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) }; }
function isAbort(error: unknown) { return error instanceof DOMException && error.name === 'AbortError'; }
