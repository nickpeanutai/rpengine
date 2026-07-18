export type EngineOwnerPhase = 'preparing' | 'downloading' | 'loading' | 'running';

interface OwnerMessage {
  type: 'owner-query' | 'owner-state' | 'owner-stopped';
  tabId: string;
  phase?: EngineOwnerPhase;
  timestamp: number;
}

const LOCK_NAME = 'gemtavern-rp-engine-owner-v1';
const CHANNEL_NAME = 'gemtavern-rp-engine-tabs-v1';
const OWNER_TTL_MS = 6500;
const HEARTBEAT_MS = 2000;

export class EngineOwnership extends EventTarget {
  readonly tabId = crypto.randomUUID();
  owned = false;
  phase?: EngineOwnerPhase;
  private channel?: BroadcastChannel;
  private otherOwnerId?: string;
  private otherOwnerPhase?: EngineOwnerPhase;
  private otherOwnerSeenAt = 0;
  private acquirePromise?: Promise<boolean>;
  private lockTask?: Promise<void>;
  private releaseLock?: () => void;
  private releaseRequested = false;
  private heartbeatTimer?: number;

  constructor() {
    super();
    if ('BroadcastChannel' in globalThis) {
      this.channel = new BroadcastChannel(CHANNEL_NAME);
      this.channel.onmessage = event => this.receive(event.data as OwnerMessage);
      this.post({ type: 'owner-query', tabId: this.tabId, timestamp: Date.now() });
      window.setInterval(() => this.expireStaleOwner(), HEARTBEAT_MS);
    }
    window.addEventListener('pagehide', () => { void this.release(); });
  }

  get ownerElsewhere() {
    return Boolean(this.otherOwnerId && Date.now() - this.otherOwnerSeenAt < OWNER_TTL_MS);
  }

  get ownerElsewherePhase() {
    return this.ownerElsewhere ? this.otherOwnerPhase : undefined;
  }

  async acquire() {
    if (this.owned) return true;
    if (this.acquirePromise) return this.acquirePromise;
    if (!navigator.locks) throw new Error('This browser does not support exclusive RPEngine tab ownership. Use a current Chrome or Edge release.');
    this.releaseRequested = false;

    this.acquirePromise = new Promise<boolean>((resolve, reject) => {
      let resolved = false;
      const settle = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };
      const task = navigator.locks.request<void>(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, lock => {
        if (!lock) {
          this.markOtherOwner(this.otherOwnerId ?? 'another-tab', this.otherOwnerPhase ?? 'running');
          settle(false);
          return Promise.resolve();
        }
        this.owned = true;
        this.phase = 'preparing';
        this.otherOwnerId = undefined;
        this.otherOwnerPhase = undefined;
        this.otherOwnerSeenAt = 0;
        this.startHeartbeat();
        this.changed();
        settle(true);
        const held = new Promise<void>(release => { this.releaseLock = release; });
        if (this.releaseRequested) this.releaseLock?.();
        return held.finally(() => {
          this.stopHeartbeat();
          this.owned = false;
          this.phase = undefined;
          this.releaseLock = undefined;
          this.releaseRequested = false;
          this.post({ type: 'owner-stopped', tabId: this.tabId, timestamp: Date.now() });
          this.changed();
        });
      });
      this.lockTask = task;
      void task.catch(error => {
        if (!resolved) reject(error);
      }).finally(() => {
        if (this.lockTask === task) this.lockTask = undefined;
      });
    }).finally(() => { this.acquirePromise = undefined; });
    return this.acquirePromise;
  }

  setPhase(phase: EngineOwnerPhase) {
    if (!this.owned || this.phase === phase) return;
    this.phase = phase;
    this.announce();
    this.changed();
  }

  async release() {
    this.releaseRequested = true;
    const task = this.lockTask;
    this.releaseLock?.();
    if (task) await task.catch(() => undefined);
  }

  private receive(message: OwnerMessage) {
    if (!message || message.tabId === this.tabId) return;
    if (message.type === 'owner-query' && this.owned) this.announce();
    else if (message.type === 'owner-state' && message.phase) this.markOtherOwner(message.tabId, message.phase);
    else if (message.type === 'owner-stopped' && message.tabId === this.otherOwnerId) {
      this.otherOwnerId = undefined;
      this.otherOwnerPhase = undefined;
      this.otherOwnerSeenAt = 0;
      this.changed();
    }
  }

  private markOtherOwner(tabId: string, phase: EngineOwnerPhase) {
    const changed = this.otherOwnerId !== tabId || this.otherOwnerPhase !== phase || !this.ownerElsewhere;
    this.otherOwnerId = tabId;
    this.otherOwnerPhase = phase;
    this.otherOwnerSeenAt = Date.now();
    if (changed) this.changed();
  }

  private expireStaleOwner() {
    if (!this.otherOwnerId || this.ownerElsewhere) return;
    this.otherOwnerId = undefined;
    this.otherOwnerPhase = undefined;
    this.otherOwnerSeenAt = 0;
    this.changed();
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.announce();
    this.heartbeatTimer = window.setInterval(() => this.announce(), HEARTBEAT_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== undefined) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private announce() {
    if (this.owned && this.phase) this.post({ type: 'owner-state', tabId: this.tabId, phase: this.phase, timestamp: Date.now() });
  }

  private post(message: OwnerMessage) {
    this.channel?.postMessage(message);
  }

  private changed() {
    this.dispatchEvent(new Event('change'));
  }
}
