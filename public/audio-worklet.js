class RPEngineAudioPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.port.onmessage = event => {
      if (event.data.type === 'clear') {
        this.queue = [];
        this.current = null;
        this.offset = 0;
      } else if (event.data.type === 'enqueue') {
        this.queue.push({ id: event.data.id, samples: event.data.samples });
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);
    let write = 0;
    while (write < output.length) {
      if (!this.current) {
        this.current = this.queue.shift() || null;
        this.offset = 0;
        if (!this.current) break;
        this.port.postMessage({ type: 'started', id: this.current.id });
      }
      const count = Math.min(output.length - write, this.current.samples.length - this.offset);
      output.set(this.current.samples.subarray(this.offset, this.offset + count), write);
      write += count;
      this.offset += count;
      if (this.offset >= this.current.samples.length) {
        this.port.postMessage({ type: 'ended', id: this.current.id });
        this.current = null;
      }
    }
    return true;
  }
}

registerProcessor('rp-engine-audio-player', RPEngineAudioPlayer);
