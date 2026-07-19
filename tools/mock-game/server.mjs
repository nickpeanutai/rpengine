import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const root = dirname(fileURLToPath(import.meta.url));
const outputDirectory = process.env.MOCK_GAME_OUTPUT_DIRECTORY ? resolve(process.env.MOCK_GAME_OUTPUT_DIRECTORY) : join(root, 'test-output');
const protocol = 'gemtavern.rp_engine';
const protocolVersion = 3;
const socketPort = Number(process.env.RPENGINE_PORT ?? 38471);
const controlPort = Number(process.env.MOCK_GAME_CONTROL_PORT ?? 38472);
const transportMode = String(process.env.MOCK_GAME_TRANSPORT ?? 'both').toLowerCase();
const mailboxDirectory = process.env.MOCK_GAME_MAILBOX_DIRECTORY ? resolve(process.env.MOCK_GAME_MAILBOX_DIRECTORY) : join(root, 'test-mailbox');
const fileTransportEnabled = transportMode === 'both' || transportMode === 'filesystem';
const websocketEnabled = transportMode === 'both' || transportMode === 'websocket';
const integrationToEngine = join(mailboxDirectory, 'integration-to-engine');
const engineToIntegration = join(mailboxDirectory, 'engine-to-integration');
const mailboxAudioDirectory = join(mailboxDirectory, 'audio');
const filePeerInstanceId = `mock-${randomUUID()}`;
const audioSlotCount = 2048;
const maxMessageBytes = 8 * 1024 * 1024;
const allowedOrigins = new Set([
  'http://127.0.0.1:5173',
  'https://rpengine.gemtavern.com',
  'https://rp-engine.gemtavern.com',
]);
if (!Number.isInteger(socketPort) || socketPort < 1024 || socketPort > 65535) throw new Error('RPENGINE_PORT must be between 1024 and 65535.');
if (!Number.isInteger(controlPort) || controlPort < 1024 || controlPort > 65535) throw new Error('MOCK_GAME_CONTROL_PORT must be between 1024 and 65535.');
if (!['both', 'filesystem', 'websocket'].includes(transportMode)) throw new Error('MOCK_GAME_TRANSPORT must be both, filesystem, or websocket.');

let sessionId;
let socket;
let activeTransport;
let fileConnected = false;
let filePollTimer;
let fileWriteChain = Promise.resolve();
let nextAudioSlot = 0;
const seenFileMessages = new Set();
const seenFileMessageOrder = [];
const fileAcknowledgedAt = new Map();
let lastCard;
let lastCardHash;
let activeRequestId;
let voiceCapture;
let latestReply;
let capacity = { acceptingRequests: false, queueDepth: 0, queueLimit: 20 };
const pending = new Map();
const audio = new Map();
const microphoneAudio = new Map();
const events = [];

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function envelope(type, payload = {}) {
  return { protocol, protocolVersion, type, messageId: randomUUID(), sessionId, timestamp: new Date().toISOString(), ...payload };
}
function log(direction, type, details) {
  events.push({ timestamp: new Date().toISOString(), direction, type, details });
  if (events.length > 500) events.splice(0, events.length - 500);
  process.stdout.write(`[${direction}] ${type}${details ? ` ${JSON.stringify(details)}` : ''}\n`);
}
async function send(type, payload = {}) {
  const message = envelope(type, payload);
  if (activeTransport === 'filesystem' && fileConnected) await writeMailboxEnvelope(message);
  else if (activeTransport === 'websocket' && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  else throw new Error('RPEngine PWA is not connected.');
  log(`game → pwa (${activeTransport})`, type, payload);
  return message;
}

function pointer(value) { return value.replaceAll('~', '~0').replaceAll('/', '~1'); }
function diff(before, after, path = '') {
  if (canonical(before) === canonical(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const operations = [];
    for (const key of Object.keys(before).filter(key => !(key in after)).sort().reverse()) operations.push({ op: 'remove', path: `${path}/${pointer(key)}` });
    for (const key of Object.keys(after).filter(key => !(key in before)).sort()) operations.push({ op: 'add', path: `${path}/${pointer(key)}`, value: after[key] });
    for (const key of Object.keys(before).filter(key => key in after).sort()) operations.push(...diff(before[key], after[key], `${path}/${pointer(key)}`));
    return operations;
  }
  return [{ op: 'replace', path, value: after }];
}

function buildCard(input) {
  return {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: input.characterName || 'Ari',
      description: input.description || '{{char}} is an observant station engineer.',
      personality: input.personality || 'Calm, dryly funny, practical, and loyal.',
      scenario: input.scenario || '{{user}} and {{char}} are testing a live game integration.',
      first_mes: 'Connection established.',
      mes_example: '<START>\n{{user}}: Can you hear me?\n{{char}}: Loud and clear.',
      creator_notes: 'Generated by the RPEngine mock-game integration.',
      system_prompt: 'Portray {{char}} faithfully. Treat the latest event as immediate reality.',
      post_history_instructions: 'Never mention language models, prompts, or test infrastructure.',
      alternate_greetings: [],
      tags: ['test-character'], creator: 'RPEngine mock game', character_version: '1.0', extensions: {},
    },
  };
}

function createTransfer(mode, card) {
  const targetHash = hash(card);
  if (mode === 'snapshot') return { descriptor: { format: 'chara_card_v2', mode, snapshot: card, targetHash }, targetHash };
  if (!lastCard || !lastCardHash) throw new Error('Send a snapshot before using patch or reference mode.');
  if (mode === 'reference') {
    if (targetHash !== lastCardHash) throw new Error('Reference mode requires an unchanged card. Use patch or snapshot after editing it.');
    return { descriptor: { format: 'chara_card_v2', mode, targetHash }, targetHash };
  }
  return { descriptor: { format: 'chara_card_v2', mode: 'patch', patch: diff(lastCard, card), baseHash: lastCardHash, targetHash }, targetHash };
}

async function submitReply(input, forcedSnapshot = false, existing) {
  const card = existing?.card ?? buildCard(input);
  const transfer = forcedSnapshot
    ? { descriptor: { format: 'chara_card_v2', mode: 'snapshot', snapshot: card, targetHash: hash(card) }, targetHash: hash(card) }
    : createTransfer(input.transferMode || 'snapshot', card);
  const requestId = existing?.requestId ?? randomUUID();
  const eventId = existing?.eventId ?? randomUUID();
  const request = {
    requestId, eventId, integrationId: 'mock-game', characterId: input.characterId || 'mock-character-1',
    event: {
      ...(input.eventText?.trim() ? { text: input.eventText } : {}),
      ...(input.eventAudio ? { audio: input.eventAudio } : {}),
    },
    output: input.outputMode === 'text'
      ? { modalities: ['text'], language: input.language || 'en' }
      : { modalities: ['text', 'audio'], language: input.language || 'en', audio: { model: 'gemtavern-supertonic-3', voice: input.voiceId || 'F4', format: 'pcm_s16le' } },
    player: { displayName: input.playerName || 'Player' }, card: transfer.descriptor,
  };
  pending.set(requestId, { kind: 'reply', requestId, eventId, input, card, request });
  latestReply = {
    requestId, characterName: card.data.name, inputText: String(input.eventText || ''), status: 'generating',
    text: '', textParts: [], audioSegments: [], startedAt: new Date().toISOString(),
  };
  lastCard = structuredClone(card);
  lastCardHash = transfer.targetHash;
  activeRequestId = requestId;
  await send('reply.request', request);
  return requestId;
}

async function submitVoiceCapture(input, forcedSnapshot = false, existing) {
  if (activeRequestId) throw new Error('Finish or cancel the active request before starting another voice capture.');
  const card = existing?.card ?? buildCard(input);
  const transfer = forcedSnapshot
    ? { descriptor: { format: 'chara_card_v2', mode: 'snapshot', snapshot: card, targetHash: hash(card) }, targetHash: hash(card) }
    : createTransfer(input.transferMode || 'snapshot', card);
  const requestId = existing?.requestId ?? randomUUID();
  const eventId = existing?.eventId ?? randomUUID();
  const request = {
    requestId, eventId, integrationId: 'mock-game', characterId: input.characterId || 'mock-character-1',
    output: input.outputMode === 'text'
      ? { modalities: ['text'], language: input.language || 'en' }
      : { modalities: ['text', 'audio'], language: input.language || 'en', audio: { model: 'gemtavern-supertonic-3', voice: input.voiceId || 'F4', format: 'pcm_s16le' } },
    player: { displayName: input.playerName || 'Player' }, card: transfer.descriptor,
    debug: { echoCapturedAudio: true, echoTranscript: true },
  };
  pending.set(requestId, { kind: 'voice', requestId, eventId, input, card, request });
  latestReply = {
    requestId, characterName: card.data.name, inputText: '(browser microphone capture)', status: 'capturing',
    text: '', textParts: [], audioSegments: [], startedAt: new Date().toISOString(),
  };
  lastCard = structuredClone(card);
  lastCardHash = transfer.targetHash;
  activeRequestId = requestId;
  voiceCapture = { requestId, state: 'requested', seconds: 0, peak: 0, rms: 0, autoEndEnabled: false, message: 'Waiting for RPEngine to start browser microphone capture.' };
  await send('voice.capture.start', request);
  return requestId;
}

async function receive(raw) {
  let message;
  try { message = JSON.parse(String(raw)); } catch { return log(`pwa → game (${activeTransport})`, 'invalid_json'); }
  if (message.protocol !== protocol || message.protocolVersion !== protocolVersion) return log(`pwa → game (${activeTransport})`, 'protocol_rejected', message);
  const isAudioChunk = typeof message.type === 'string' && message.type.endsWith('.audio.chunk');
  log(`pwa → game (${activeTransport})`, message.type, isAudioChunk ? { requestId: message.requestId, sequence: message.sequence, segmentSequence: message.segmentSequence, segmentChunkSequence: message.segmentChunkSequence, bytes: Buffer.from(message.data || '', 'base64').length } : message);
  if (message.type === 'capacity.update') capacity = { acceptingRequests: Boolean(message.acceptingRequests), queueDepth: Number(message.queueDepth), queueLimit: Number(message.queueLimit) };
  if (latestReply?.requestId === message.requestId && message.type === 'reply.text.delta') {
    latestReply.textParts[Number(message.sequence) || 0] = String(message.delta || '');
    latestReply.text = latestReply.textParts.join('');
    latestReply.status = 'streaming text';
  }
  if (latestReply?.requestId === message.requestId && message.type === 'reply.text.completed') {
    latestReply.text = String(message.text || latestReply.text);
    latestReply.status = 'generating audio';
    latestReply.textCompletedAt = new Date().toISOString();
  }
  if (message.type === 'voice.capture.level' && voiceCapture?.requestId === message.requestId) {
    voiceCapture = { ...voiceCapture, seconds: Number(message.seconds) || 0, peak: Number(message.peak) || 0, rms: Number(message.rms) || 0 };
  }
  if (message.type === 'voice.capture.state' && voiceCapture?.requestId === message.requestId) {
    voiceCapture = { ...voiceCapture, state: String(message.state || 'listening'), seconds: Number(message.seconds) || 0, autoEndEnabled: message.autoEndEnabled !== false, message: String(message.message || '') };
  }
  if (message.type === 'reply.audio.start') audio.set(message.requestId, { sampleRate: message.sampleRate, chunks: new Map() });
  if (message.type === 'reply.audio.chunk') audio.get(message.requestId)?.chunks.set(message.sequence, Buffer.from(message.data, 'base64'));
  if (message.type === 'reply.audio.completed') await saveAudio(message.requestId, message);
  if (message.type === 'reply.audio.segment') await saveFileAudioSegment(message);
  if (message.type === 'voice.capture.audio.start') microphoneAudio.set(message.requestId, { sampleRate: message.sampleRate, chunks: new Map() });
  if (message.type === 'voice.capture.audio.chunk') microphoneAudio.get(message.requestId)?.chunks.set(message.sequence, Buffer.from(message.data, 'base64'));
  if (message.type === 'voice.capture.audio.completed') await saveMicrophoneAudio(message.requestId, message);
  if (message.type === 'voice.capture.transcript') await saveMoonshineTranscript(message.requestId, message);
  if (message.type === 'request.error' && message.code === 'card_resync_required') {
    const request = pending.get(message.requestId);
    if (request?.kind === 'voice') { activeRequestId = undefined; await submitVoiceCapture(request.input, true, request); }
    else if (request) await submitReply(request.input, true, request);
  }
  if (['reply.completed', 'reply.cancelled'].includes(message.type)) {
    pending.delete(message.requestId);
    if (activeRequestId === message.requestId) activeRequestId = undefined;
    if (latestReply?.requestId === message.requestId) {
      latestReply.status = message.type === 'reply.completed' ? 'completed' : 'cancelled';
      latestReply.completedAt = new Date().toISOString();
    }
    if (voiceCapture?.requestId === message.requestId) {
      voiceCapture = {
        ...voiceCapture,
        state: message.type === 'reply.completed' ? 'completed' : 'cancelled',
        message: captureArtifactMessage(voiceCapture),
      };
    }
  }
  if (message.type === 'request.error' && voiceCapture?.requestId === message.requestId && message.code !== 'card_resync_required') {
    pending.delete(message.requestId);
    if (activeRequestId === message.requestId) activeRequestId = undefined;
    voiceCapture = { ...voiceCapture, state: 'error', message: String(message.message || 'Voice capture failed.') };
  }
  if (message.type === 'request.error' && latestReply?.requestId === message.requestId && message.code !== 'card_resync_required') {
    latestReply.status = 'error';
    latestReply.error = String(message.message || message.code || 'Request failed.');
  }
}

async function saveFileAudioSegment(message) {
  if (activeTransport !== 'filesystem') return;
  const relativePath = String(message.path || '');
  const source = resolve(mailboxDirectory, relativePath);
  const fromRoot = relative(mailboxAudioDirectory, source);
  if (!relativePath || fromRoot.startsWith('..') || fromRoot.includes(`..${sep}`) || resolve(source) === resolve(mailboxAudioDirectory)) {
    log('mock', 'audio_segment_invalid_path', { requestId: message.requestId, path: relativePath });
    return;
  }
  await mkdir(outputDirectory, { recursive: true });
  const destination = join(outputDirectory, `${message.requestId}-segment-${String(message.segmentSequence ?? 0).padStart(4, '0')}.wav`);
  await copyFile(source, destination);
  if (latestReply?.requestId === message.requestId) {
    latestReply.audioSegments.push({
      sequence: Number(message.segmentSequence) || 0,
      spokenText: String(message.spokenText || ''),
      durationSeconds: Number(message.durationSeconds) || 0,
      byteLength: Number(message.byteLength) || 0,
      url: artifactUrl(destination),
    });
    latestReply.audioSegments.sort((left, right) => left.sequence - right.sequence);
  }
  log('mock', 'audio_segment_saved', { requestId: message.requestId, segmentSequence: message.segmentSequence, path: destination, spokenText: message.spokenText });
  await send('reply.audio.segment.consumed', {
    requestId: message.requestId,
    segmentSequence: message.segmentSequence,
    slotIndex: message.slotIndex,
    peerInstanceId: filePeerInstanceId,
  });
}

async function saveAudio(requestId, completed) {
  const result = audio.get(requestId);
  if (!result) return;
  const sequences = [...result.chunks.keys()].sort((a, b) => a - b);
  if (sequences.length !== completed.chunkCount || sequences.some((value, index) => value !== index)) return log('mock', 'audio_invalid', { requestId, sequences });
  const pcm = Buffer.concat(sequences.map(sequence => result.chunks.get(sequence)));
  if (pcm.length !== completed.totalBytes) return log('mock', 'audio_invalid', { requestId, expectedBytes: completed.totalBytes, actualBytes: pcm.length });
  const wav = wavFile(pcm, result.sampleRate);
  await mkdir(outputDirectory, { recursive: true });
  const path = join(outputDirectory, `${requestId}.wav`);
  await writeFile(path, wav);
  if (latestReply?.requestId === requestId) latestReply.audioSegments = [{ sequence: 0, spokenText: latestReply.text, durationSeconds: Number(completed.durationSeconds) || 0, byteLength: wav.byteLength, url: artifactUrl(path) }];
  audio.delete(requestId);
  log('mock', 'audio_saved', { requestId, path, bytes: pcm.length, sampleRate: result.sampleRate });
}

function artifactUrl(path) { return `/artifacts/${encodeURIComponent(basename(path))}`; }

async function saveMicrophoneAudio(requestId, completed) {
  const result = microphoneAudio.get(requestId);
  if (!result) return;
  const sequences = [...result.chunks.keys()].sort((a, b) => a - b);
  if (sequences.length !== completed.chunkCount || sequences.some((value, index) => value !== index)) return log('mock', 'microphone_audio_invalid', { requestId, sequences });
  const pcm = Buffer.concat(sequences.map(sequence => result.chunks.get(sequence)));
  if (pcm.length !== completed.totalBytes) return log('mock', 'microphone_audio_invalid', { requestId, expectedBytes: completed.totalBytes, actualBytes: pcm.length });
  const wav = wavFile(pcm, result.sampleRate);
  await mkdir(outputDirectory, { recursive: true });
  const path = join(outputDirectory, `${requestId}-microphone.wav`);
  await writeFile(path, wav);
  microphoneAudio.delete(requestId);
  if (voiceCapture?.requestId === requestId) {
    voiceCapture = { ...voiceCapture, recordingPath: path };
    voiceCapture.message = captureArtifactMessage(voiceCapture);
  }
  log('mock', 'microphone_audio_saved', { requestId, path, bytes: pcm.length, sampleRate: result.sampleRate });
}

async function saveMoonshineTranscript(requestId, result) {
  const text = String(result.text ?? '');
  await mkdir(outputDirectory, { recursive: true });
  const path = join(outputDirectory, `${requestId}-moonshine.txt`);
  await writeFile(path, `${text}\n`, 'utf8');
  if (voiceCapture?.requestId === requestId) {
    voiceCapture = { ...voiceCapture, transcript: text, transcriptLanguage: String(result.language || ''), transcriptElapsedMs: Number(result.elapsedMs) || 0, transcriptPath: path };
    voiceCapture.message = captureArtifactMessage(voiceCapture);
  }
  log('mock', 'moonshine_transcript_saved', { requestId, path, text, language: result.language, elapsedMs: result.elapsedMs });
}

function captureArtifactMessage(capture) {
  const artifacts = [];
  if (capture?.recordingPath) artifacts.push(`Microphone WAV saved: ${capture.recordingPath}`);
  if (capture?.transcriptPath) artifacts.push(`Moonshine transcript saved: ${capture.transcriptPath}`);
  return artifacts.join(' · ');
}

function wavFile(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function initializeFileMailbox() {
  await Promise.all([
    mkdir(integrationToEngine, { recursive: true }),
    mkdir(engineToIntegration, { recursive: true }),
    mkdir(mailboxAudioDirectory, { recursive: true }),
  ]);
  const manifest = {
    schema: 'gemtavern.rp_engine.file_transport',
    version: 1,
    integrationId: 'mock-game',
    displayName: 'RPEngine Mock Game',
    mailboxes: { integrationToEngine: 'integration-to-engine', engineToIntegration: 'engine-to-integration' },
    audio: { format: 'wav_pcm_s16le', directory: 'audio', slotPattern: 'slot_%04d.wav', slotCount: audioSlotCount, sampleRate: 44100, channels: 1 },
  };
  await writeFile(join(mailboxDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const silence = wavFile(Buffer.alloc(2), manifest.audio.sampleRate);
  for (let start = 0; start < audioSlotCount; start += 128) {
    await Promise.all(Array.from({ length: Math.min(128, audioSlotCount - start) }, async (_, offset) => {
      const slot = String(start + offset).padStart(4, '0');
      await writeFile(join(mailboxAudioDirectory, `slot_${slot}.wav`), silence, { flag: 'wx' }).catch(error => {
        if (error?.code !== 'EEXIST') throw error;
      });
    }));
  }
}

function writeMailboxEnvelope(message) {
  const operation = fileWriteChain.then(async () => {
    const raw = JSON.stringify(message);
    if (Buffer.byteLength(raw) > maxMessageBytes) throw new Error('RPEngine message exceeds 8 MiB.');
    const stem = `${Date.now().toString().padStart(13, '0')}-${message.messageId}`;
    const jsonPath = join(integrationToEngine, `${stem}.json`);
    const readyPath = join(integrationToEngine, `${stem}.ready`);
    const json = await open(jsonPath, 'wx');
    try { await json.writeFile(raw, 'utf8'); } finally { await json.close(); }
    const ready = await open(readyPath, 'wx');
    await ready.close();
  });
  fileWriteChain = operation.catch(() => undefined);
  return operation;
}

function scheduleFilePoll(delay = 50) {
  if (!fileTransportEnabled) return;
  clearTimeout(filePollTimer);
  filePollTimer = setTimeout(() => void pollFileMailbox(), delay);
}

async function pollFileMailbox() {
  try {
    const names = await readdir(engineToIntegration);
    const stems = names.filter(name => name.endsWith('.ready')).map(name => name.slice(0, -6)).sort();
    for (const stem of stems) await consumeFileEnvelope(stem);
  } catch (error) {
    log('mock', 'file_poll_error', { message: error instanceof Error ? error.message : String(error) });
  } finally { scheduleFilePoll(fileConnected ? 50 : 250); }
}

async function consumeFileEnvelope(stem) {
  const path = join(engineToIntegration, `${stem}.json`);
  let info;
  try { info = await stat(path); } catch { return; }
  if (info.size > maxMessageBytes) {
    log('pwa → game (filesystem)', 'message_rejected', { reason: 'Message exceeds 8 MiB.', stem });
    return;
  }
  let message;
  let raw;
  try {
    raw = await readFile(path, 'utf8');
    message = JSON.parse(raw);
  } catch (error) {
    log('pwa → game (filesystem)', 'invalid_json', { stem, message: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (message.protocol !== protocol || message.protocolVersion !== protocolVersion || typeof message.messageId !== 'string') {
    log('pwa → game (filesystem)', 'protocol_rejected', message);
    return;
  }
  const duplicate = seenFileMessages.has(message.messageId);
  if (!duplicate) {
    seenFileMessages.add(message.messageId);
    seenFileMessageOrder.push(message.messageId);
    if (seenFileMessageOrder.length > 2000) {
      const expired = seenFileMessageOrder.shift();
      seenFileMessages.delete(expired);
      fileAcknowledgedAt.delete(expired);
    }
  }
  if (message.type === 'hello' && !duplicate) {
    activeTransport = 'filesystem';
    fileConnected = true;
    sessionId = `mock-${filePeerInstanceId}`;
    lastCard = undefined;
    lastCardHash = undefined;
    capacity = { acceptingRequests: false, queueDepth: 0, queueLimit: 20 };
  }
  if (!fileConnected) return;
  const acknowledgedAt = fileAcknowledgedAt.get(message.messageId) || 0;
  if (message.type !== 'ack' && (!duplicate || Date.now() - acknowledgedAt >= 1000)) {
    fileAcknowledgedAt.set(message.messageId, Date.now());
    await send('ack', { acknowledgedMessageId: message.messageId, ...(duplicate ? { duplicate: true } : {}) });
  }
  if (duplicate) return;
  if (message.type === 'hello') {
    log('pwa → game (filesystem)', 'hello', message);
    await send('welcome', { serverVersion: 'mock-game-1.0', peerInstanceId: filePeerInstanceId, nextAudioSlot });
    return;
  }
  if (message.type === 'reply.audio.segment') nextAudioSlot = Math.max(nextAudioSlot, Number(message.slotIndex) + 1 || 0);
  await receive(raw);
}

const httpServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${controlPort}`);
    if (url.pathname === '/api/state') return json(response, 200, state());
    if (url.pathname.startsWith('/artifacts/') && request.method === 'GET') {
      const name = decodeURIComponent(url.pathname.slice('/artifacts/'.length));
      if (!name || basename(name) !== name || !name.endsWith('.wav')) return json(response, 404, { error: 'Artifact not found' });
      const content = await readFile(join(outputDirectory, name));
      response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': content.byteLength, 'Cache-Control': 'no-store' });
      response.end(content); return;
    }
    if (url.pathname === '/api/request' && request.method === 'POST') {
      const input = await body(request);
      return json(response, 200, { requestId: await submitReply(input), state: state() });
    }
    if (url.pathname === '/api/cancel' && request.method === 'POST') {
      const input = await body(request); const requestId = input.requestId || activeRequestId;
      if (!requestId) throw new Error('There is no active request to cancel.');
      await send('request.cancel', { requestId }); return json(response, 200, { requestId });
    }
    if (url.pathname === '/api/voice/start' && request.method === 'POST') {
      if (!isConnected()) throw new Error('RPEngine PWA is not connected.');
      if (!capacity.acceptingRequests) throw new Error('RPEngine is not ready to accept voice capture requests. Start RPEngine and enable its microphone first.');
      const input = await body(request);
      const requestId = await submitVoiceCapture(input);
      return json(response, 200, { requestId, state: state() });
    }
    if (url.pathname === '/api/voice/stop' && request.method === 'POST') {
      const input = await body(request); const requestId = input.requestId || voiceCapture?.requestId;
      if (!requestId || activeRequestId !== requestId) throw new Error('There is no active voice capture to stop.');
      await send('voice.capture.stop', { requestId });
      voiceCapture = { ...voiceCapture, state: 'stopping', message: 'Waiting for RPEngine to finalize the recording.' };
      return json(response, 200, { requestId, state: state() });
    }
    if (url.pathname === '/api/voice/cancel' && request.method === 'POST') {
      const input = await body(request); const requestId = input.requestId || voiceCapture?.requestId;
      if (!requestId || activeRequestId !== requestId) throw new Error('There is no active voice capture to cancel.');
      await send('voice.capture.cancel', { requestId });
      return json(response, 200, { requestId, state: state() });
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'styles.css'].includes(file)) return json(response, 404, { error: 'Not found' });
    const content = await readFile(join(root, file));
    response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(content);
  } catch (error) { json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
});

const wsServer = websocketEnabled ? new WebSocketServer({ host: '127.0.0.1', port: socketPort, path: '/rp-engine/socket', maxPayload: maxMessageBytes }) : undefined;
wsServer?.on('connection', (candidate, request) => {
  if (!allowedOrigins.has(request.headers.origin || '')) { candidate.close(1008, 'Origin rejected'); return; }
  candidate.once('message', async raw => {
    let hello;
    try { hello = JSON.parse(String(raw)); } catch { candidate.close(1008, 'Invalid hello'); return; }
    if (hello.protocol !== protocol || hello.protocolVersion !== 3 || hello.type !== 'hello') { candidate.close(1008, 'Invalid hello'); return; }
    sessionId = randomUUID();
    socket?.close(3000, 'Superseded'); socket = candidate; activeTransport = 'websocket';
    await send('welcome', { serverVersion: 'mock-game-1.0' });
    candidate.on('message', receive);
    candidate.on('close', () => { if (socket === candidate) { socket = undefined; if (activeTransport === 'websocket') { activeTransport = undefined; sessionId = undefined; lastCard = undefined; lastCardHash = undefined; } } });
  });
});

function isConnected() {
  return activeTransport === 'filesystem' ? fileConnected : activeTransport === 'websocket' && socket?.readyState === WebSocket.OPEN;
}
function state() {
  return {
    connected: isConnected(), activeTransport, transportMode, sessionId, capacity, activeRequestId, voiceCapture,
    clientUrl: `http://127.0.0.1:5173/#port=${socketPort}`, socketPort,
    fileTransportEnabled, mailboxDirectory: fileTransportEnabled ? mailboxDirectory : undefined,
    filePeerInstanceId: fileTransportEnabled ? filePeerInstanceId : undefined,
    nextAudioSlot, lastCardHash, latestReply, events: events.slice(-100),
  };
}
async function body(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); }

if (fileTransportEnabled) {
  await initializeFileMailbox();
  scheduleFilePoll(0);
}

httpServer.listen(controlPort, '127.0.0.1', () => {
  process.stdout.write(`Mock game control: http://127.0.0.1:${controlPort}\n`);
  if (websocketEnabled) process.stdout.write(`RPEngine socket: ws://127.0.0.1:${socketPort}/rp-engine/socket\n`);
  if (fileTransportEnabled) process.stdout.write(`RPEngine filesystem mailbox: ${mailboxDirectory}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  clearTimeout(filePollTimer);
  wsServer?.close();
  httpServer.close(() => process.exit(0));
});
