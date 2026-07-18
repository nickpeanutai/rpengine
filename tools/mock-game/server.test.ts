import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { decode_envelope } from '../../src/core';

let server: ChildProcess | undefined;
let socket: WebSocket | undefined;
let outputDirectory: string | undefined;

afterEach(async () => {
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'test complete');
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
  if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  socket = undefined; server = undefined; outputDirectory = undefined;
});

describe('mock-game browser voice capture', () => {
  it('drives start, VAD telemetry, WAV persistence, stop, and cancel over protocol v3', async () => {
    const socketPort = await freePort();
    const controlPort = await freePort(socketPort);
    outputDirectory = await mkdtemp(join(tmpdir(), 'rpengine-mock-game-'));
    server = spawn(process.execPath, ['tools/mock-game/server.mjs'], {
      cwd: process.cwd(), env: { ...process.env, RPENGINE_PORT: String(socketPort), MOCK_GAME_CONTROL_PORT: String(controlPort), MOCK_GAME_OUTPUT_DIRECTORY: outputDirectory }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    await outputContaining(server.stdout!, `Mock game control: http://127.0.0.1:${controlPort}`);

    socket = new WebSocket(`ws://127.0.0.1:${socketPort}/rp-engine/socket`, { headers: { Origin: 'http://127.0.0.1:5173' } });
    await once(socket, 'open');
    const welcomePromise = message(socket);
    socket.send(JSON.stringify(envelope('hello', { clientVersion: 'mock-test' })));
    const welcome = await welcomePromise;
    expect(welcome).toMatchObject({ protocolVersion: 3, type: 'welcome', serverVersion: 'mock-game-1.0' });

    socket.send(JSON.stringify(envelope('capacity.update', { sessionId: welcome.sessionId, acceptingRequests: true, queueDepth: 0, queueLimit: 20 })));
    await waitForState(controlPort, value => value.capacity.acceptingRequests === true);

    const startPromise = message(socket);
    const firstStartResponse = await post(controlPort, '/api/voice/start', input());
    const firstStart = await startPromise;
    expect(firstStart).toMatchObject({ type: 'voice.capture.start', requestId: firstStartResponse.requestId, output: { modalities: ['text'], language: 'en' }, debug: { echoCapturedAudio: true, echoTranscript: true } });
    expect(() => decode_envelope(JSON.stringify(firstStart))).not.toThrow();

    socket.send(JSON.stringify(envelope('voice.capture.state', { sessionId: welcome.sessionId, requestId: firstStart.requestId, state: 'speech_started', seconds: 0.4, autoEndEnabled: true })));
    socket.send(JSON.stringify(envelope('voice.capture.level', { sessionId: welcome.sessionId, requestId: firstStart.requestId, seconds: 0.5, peak: 0.75, rms: 0.2 })));
    const active = await waitForState(controlPort, value => value.voiceCapture?.peak === 0.75);
    expect(active.voiceCapture).toMatchObject({ state: 'speech_started', seconds: 0.5, peak: 0.75, rms: 0.2, autoEndEnabled: true });

    const stopPromise = message(socket);
    await post(controlPort, '/api/voice/stop', { requestId: firstStart.requestId });
    expect(await stopPromise).toMatchObject({ type: 'voice.capture.stop', requestId: firstStart.requestId });
    const pcm = Buffer.from([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x34, 0x12]);
    socket.send(JSON.stringify(envelope('voice.capture.audio.start', { sessionId: welcome.sessionId, requestId: firstStart.requestId, format: 'pcm_s16le', sampleRate: 16000, channels: 1 })));
    socket.send(JSON.stringify(envelope('voice.capture.audio.chunk', { sessionId: welcome.sessionId, requestId: firstStart.requestId, sequence: 0, data: pcm.toString('base64') })));
    socket.send(JSON.stringify(envelope('voice.capture.audio.completed', { sessionId: welcome.sessionId, requestId: firstStart.requestId, chunkCount: 1, totalBytes: pcm.length, durationSeconds: pcm.length / 2 / 16000 })));
    const saved = await waitForState(controlPort, value => Boolean(value.voiceCapture?.recordingPath));
    expect(saved.voiceCapture.recordingPath).toBe(join(outputDirectory, `${firstStart.requestId}-microphone.wav`));
    const wav = await readFile(saved.voiceCapture.recordingPath);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.subarray(44)).toEqual(pcm);
    socket.send(JSON.stringify(envelope('voice.capture.transcript', { sessionId: welcome.sessionId, requestId: firstStart.requestId, text: 'Hello from Moonshine.', language: 'en', elapsedMs: 42 })));
    const transcribed = await waitForState(controlPort, value => Boolean(value.voiceCapture?.transcriptPath));
    expect(transcribed.voiceCapture).toMatchObject({ transcript: 'Hello from Moonshine.', transcriptLanguage: 'en', transcriptElapsedMs: 42 });
    expect(transcribed.voiceCapture.transcriptPath).toBe(join(outputDirectory, `${firstStart.requestId}-moonshine.txt`));
    expect((await readFile(transcribed.voiceCapture.transcriptPath, 'utf8'))).toBe('Hello from Moonshine.\n');
    socket.send(JSON.stringify(envelope('reply.cancelled', { sessionId: welcome.sessionId, requestId: firstStart.requestId, reason: 'test reset' })));
    const completed = await waitForState(controlPort, value => !value.activeRequestId);
    expect(completed.voiceCapture.message).toContain('Microphone WAV saved:');
    expect(completed.voiceCapture.message).toContain('Moonshine transcript saved:');

    const secondStartPromise = message(socket);
    const secondStartResponse = await post(controlPort, '/api/voice/start', input());
    const secondStart = await secondStartPromise;
    expect(secondStart.requestId).toBe(secondStartResponse.requestId);
    expect(() => decode_envelope(JSON.stringify(secondStart))).not.toThrow();
    const cancelPromise = message(socket);
    await post(controlPort, '/api/voice/cancel', { requestId: secondStart.requestId });
    expect(await cancelPromise).toMatchObject({ type: 'voice.capture.cancel', requestId: secondStart.requestId });
  });
});

function input() {
  return { characterName: 'Ari', playerName: 'Morgan', description: 'Station engineer', personality: 'Calm', scenario: 'A test', transferMode: 'snapshot', outputMode: 'text', language: 'en', voiceId: 'F4' };
}

function envelope(type: string, payload: Record<string, unknown> = {}) {
  return { protocol: 'gemtavern.rp_engine', protocolVersion: 3, type, messageId: crypto.randomUUID(), timestamp: new Date().toISOString(), ...payload };
}

async function message(ws: WebSocket) {
  const [data] = await once(ws, 'message');
  return JSON.parse(String(data)) as Record<string, any>;
}

async function post(port: number, path: string, body: unknown) {
  const value = await requestJson(port, path, 'POST', body);
  if (value.status >= 400) throw new Error(String(value.body.error ?? `HTTP ${value.status}`));
  return value.body;
}

async function requestJson(port: number, path: string, method = 'GET', body?: unknown) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  const response = await new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : undefined }, result => {
      const chunks: Buffer[] = [];
      result.on('data', chunk => chunks.push(Buffer.from(chunk)));
      result.on('end', () => resolve({ status: result.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any> }));
    });
    request.once('error', reject);
    if (encoded) request.write(encoded);
    request.end();
  });
  return response;
}

async function waitForState(port: number, predicate: (value: Record<string, any>) => boolean) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = (await requestJson(port, '/api/state')).body;
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for mock-game state.');
}

async function outputContaining(stream: NodeJS.ReadableStream, expected: string) {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    let resolved = false;
    stream.on('data', chunk => {
      output = `${output}${String(chunk)}`.slice(-4096);
      if (!resolved && output.includes(expected)) { resolved = true; resolve(); }
    });
    stream.once('error', reject);
    stream.once('end', () => { if (!resolved) reject(new Error(`Mock game exited before printing: ${expected}`)); });
  });
}

async function freePort(excluded?: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = 40000 + Math.floor(Math.random() * 15000);
    if (port === excluded) continue;
    const listener = createServer();
    try {
      await new Promise<void>((resolve, reject) => listener.listen(port, '127.0.0.1', resolve).once('error', reject));
      await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
      return port;
    } catch { listener.close(); }
  }
  throw new Error('Could not allocate a mock-game test port.');
}
