interface SpeechResult { samples: Float32Array; sampleRate: number }

export class OrderedAudioPlayer extends EventTarget {
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private ready?: Promise<void>;
  private muted = false;
  private pending = new Map<string, () => void>();

  setMuted(value: boolean) {
    this.muted = value;
    if (value) this.stop();
  }

  enable(sampleRate = 24000) {
    return this.ensure(sampleRate);
  }

  async enqueue(result: SpeechResult, id: string) {
    if (this.muted) return;
    await this.ensure(result.sampleRate);
    return new Promise<void>(resolve => {
      this.pending.set(id, resolve);
      this.node?.port.postMessage({ type: 'enqueue', id, samples: result.samples }, [result.samples.buffer]);
    });
  }

  stop() {
    this.node?.port.postMessage({ type: 'clear' });
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
  }

  private ensure(sampleRate: number) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.context = new AudioContext({ sampleRate });
      await this.context.audioWorklet.addModule('/audio-worklet.js');
      this.node = new AudioWorkletNode(this.context, 'rp-engine-audio-player');
      this.node.connect(this.context.destination);
      this.node.port.onmessage = event => {
        const detail = event.data as { type?: string; id?: string };
        if (detail.type === 'ended' && detail.id) {
          this.pending.get(detail.id)?.();
          this.pending.delete(detail.id);
        }
        this.dispatchEvent(new CustomEvent('playback', { detail }));
      };
      await this.context.resume();
    })();
    return this.ready;
  }
}
