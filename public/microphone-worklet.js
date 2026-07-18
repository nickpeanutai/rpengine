const CHUNK_SAMPLES = 4096;
const LEVEL_INTERVAL_SECONDS = 0.1;
const MAX_CAPTURE_SECONDS = 30;

class GameLinkMicrophoneProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.requestId = '';
    this.active = false;
    this.heldAtLimit = false;
    this.capturedSamples = 0;
    this.levelSamples = 0;
    this.levelPeak = 0;
    this.levelSquares = 0;
    this.chunk = new Float32Array(CHUNK_SAMPLES);
    this.chunkLength = 0;
    this.port.onmessage = event => this.command(event.data || {});
  }

  process(inputs) {
    if (!this.active) return true;
    const channels = inputs[0] || [];
    const frames = channels[0] ? channels[0].length : 0;
    const maximum = Math.floor(sampleRate * MAX_CAPTURE_SECONDS);
    for (let frame = 0; frame < frames && this.capturedSamples < maximum; frame += 1) {
      let total = 0;
      for (const channel of channels) total += channel[frame] || 0;
      const value = channels.length ? total / channels.length : 0;
      this.append(value);
      this.capturedSamples += 1;
      this.levelSamples += 1;
      this.levelPeak = Math.max(this.levelPeak, Math.abs(value));
      this.levelSquares += value * value;
      if (this.levelSamples >= sampleRate * LEVEL_INTERVAL_SECONDS) this.reportLevel();
    }
    if (this.capturedSamples >= maximum) {
      this.active = false;
      this.heldAtLimit = true;
      this.flush();
      this.reportLevel();
      this.port.postMessage({ type: 'limit', requestId: this.requestId, seconds: this.capturedSamples / sampleRate });
    }
    return true;
  }

  command(message) {
    const type = String(message.type || '');
    const requestId = String(message.requestId || '');
    if (!requestId) return;
    if (type === 'start') {
      this.requestId = requestId;
      this.active = true;
      this.heldAtLimit = false;
      this.capturedSamples = 0;
      this.levelSamples = 0;
      this.levelPeak = 0;
      this.levelSquares = 0;
      this.chunkLength = 0;
    } else if (type === 'stop' && requestId === this.requestId) {
      this.active = false;
      this.flush();
      this.reportLevel();
      this.port.postMessage({ type: 'stopped', requestId, seconds: this.capturedSamples / sampleRate, atLimit: this.heldAtLimit });
      this.requestId = '';
      this.heldAtLimit = false;
    } else if (type === 'cancel' && requestId === this.requestId) {
      this.active = false;
      this.requestId = '';
      this.heldAtLimit = false;
      this.capturedSamples = 0;
      this.levelSamples = 0;
      this.levelPeak = 0;
      this.levelSquares = 0;
      this.chunkLength = 0;
    }
  }

  append(value) {
    this.chunk[this.chunkLength++] = value;
    if (this.chunkLength === this.chunk.length) this.flush();
  }

  flush() {
    if (!this.chunkLength || !this.requestId) return;
    const samples = this.chunk.slice(0, this.chunkLength);
    this.port.postMessage({ type: 'chunk', requestId: this.requestId, samples: samples.buffer, endSeconds: this.capturedSamples / sampleRate }, [samples.buffer]);
    this.chunk = new Float32Array(CHUNK_SAMPLES);
    this.chunkLength = 0;
  }

  reportLevel() {
    if (!this.requestId || !this.levelSamples) return;
    this.port.postMessage({ type: 'level', requestId: this.requestId, seconds: this.capturedSamples / sampleRate, peak: this.levelPeak, rms: Math.sqrt(this.levelSquares / this.levelSamples) });
    this.levelSamples = 0;
    this.levelPeak = 0;
    this.levelSquares = 0;
  }
}

registerProcessor('gamelink-microphone-capture', GameLinkMicrophoneProcessor);
