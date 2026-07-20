const $ = selector => document.querySelector(selector);
let state;
let hiddenBefore = 0;
let replySignature = '';
let activePlayback;

async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

async function refresh() {
  try { state = await api('/api/state'); render(); } catch (error) { showError(error); }
}

function render() {
  const transport = state.activeTransport === 'filesystem' ? 'filesystem' : state.activeTransport === 'websocket' ? 'WebSocket' : '';
  $('#status').textContent = state.connected ? `Connected via ${transport} · queue ${state.capacity.queueDepth}/${state.capacity.queueLimit}` : 'Disconnected';
  $('#status').className = state.connected ? 'connected' : '';
  $('#pairingDetail').textContent = state.connected ? `Connected session ${state.sessionId}` : state.fileTransportEnabled ? 'Waiting for a filesystem or WebSocket handshake.' : `Waiting on WebSocket port ${state.socketPort}.`;
  $('#openPwa').disabled = !state.clientUrl;
  $('#fileSetup').hidden = !state.fileTransportEnabled;
  $('#copyMailbox').hidden = !state.fileTransportEnabled;
  $('#mailboxDirectory').textContent = state.mailboxDirectory || '';
  $('#send').disabled = !state.connected || !state.capacity.acceptingRequests;
  $('#cancel').disabled = !state.activeRequestId;
  renderLatestReply();
  renderVoiceCapture();
  const visible = state.events.slice(hiddenBefore).reverse();
  $('#log').innerHTML = visible.map(event => `<details><summary><time>${new Date(event.timestamp).toLocaleTimeString()}</time><b>${escape(event.direction)}</b><span>${escape(event.type)}</span></summary><pre>${escape(JSON.stringify(event.details, null, 2))}</pre></details>`).join('') || '<p class="empty">No protocol messages yet.</p>';
}

function renderLatestReply() {
  const reply = state.latestReply;
  const signature = JSON.stringify(reply || null);
  if (signature === replySignature) return;
  replySignature = signature;
  $('#replyEmpty').hidden = Boolean(reply);
  $('#replyContent').hidden = !reply;
  $('#replyStatus').textContent = reply?.status || 'No request';
  $('#replyStatus').className = `reply-status ${reply?.status === 'completed' ? 'completed' : reply?.status === 'error' ? 'error' : reply ? 'active' : ''}`;
  if (!reply) return;
  $('#replyCharacter').textContent = reply.characterName || 'Character';
  $('#replyInput').textContent = reply.inputText ? `“${reply.inputText}”` : 'the submitted event';
  $('#replyText').textContent = reply.text || 'Waiting for text…';
  $('#replyError').hidden = !reply.error;
  $('#replyError').textContent = reply.error || '';
  const segments = reply.audioSegments || [];
  $('#playReply').disabled = segments.length === 0;
  $('#replyAudio').innerHTML = segments.length ? segments.map(segment => `
    <div class="audio-segment">
      <div><strong>Segment ${Number(segment.sequence) + 1}</strong><span>${escape(segment.spokenText || '')}</span></div>
      <audio controls preload="metadata" src="${escape(segment.url)}"></audio>
    </div>`).join('') : '<p class="empty-audio">Waiting for audio…</p>';
}

function renderVoiceCapture() {
  const capture = state.voiceCapture;
  const active = Boolean(capture?.requestId && state.activeRequestId === capture.requestId);
  $('#startVoice').disabled = !state.connected || !state.capacity.acceptingRequests || Boolean(state.activeRequestId);
  $('#stopVoice').disabled = !active || capture.state === 'stopping';
  $('#cancelVoice').disabled = !active;
  $('#voiceStatus').textContent = capture ? capture.state.replaceAll('_', ' ') : 'Idle';
  $('#voiceStatus').className = `voice-status ${active ? 'active' : ''} ${capture?.state === 'error' ? 'error' : ''}`;
  const peak = Math.max(Number(capture?.peak) || 0, (Number(capture?.rms) || 0) * 2.5);
  $('#voiceMeter').style.width = `${Math.round(Math.min(1, peak) * 100)}%`;
  $('#voiceTimer').textContent = `${(Number(capture?.seconds) || 0).toFixed(1)}s`;
  $('#voiceVad').textContent = capture?.autoEndEnabled ? 'FireRedVAD auto-end enabled' : 'Manual stop available';
  $('#voiceDetail').textContent = capture?.message || (active ? 'Speak into the microphone connected to the RPEngine browser tab.' : 'The RPEngine tab records the microphone; this mock game only sends protocol controls and observes capture telemetry.');
  const transcript = $('#voiceTranscript');
  transcript.hidden = capture?.transcript === undefined;
  transcript.textContent = capture?.transcript === undefined ? '' : `Moonshine transcript${capture.transcriptLanguage ? ` (${capture.transcriptLanguage})` : ''}: ${capture.transcript || '(no speech recognized)'}`;
}

function commonForm() {
  return {
    characterName: $('#characterName').value, playerName: $('#playerName').value,
    description: $('#description').value, personality: $('#personality').value, scenario: $('#scenario').value,
    transferMode: $('#transferMode').value, outputMode: $('#outputMode').value,
    language: $('#language').value, voiceId: $('#voiceId').value, processingProfile: $('#processingProfile').value,
  };
}

async function form() {
  const file = $('#eventAudio').files[0];
  return {
    ...commonForm(), eventText: $('#eventText').value,
    eventAudio: file ? await audioInput(file, $('#language').value) : undefined,
  };
}

async function audioInput(file, language) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const frames = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineAudioContext(1, frames, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const value = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(index * 2, value < 0 ? value * 32768 : value * 32767, true);
    }
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { format: 'pcm_s16le', sampleRate: 16000, channels: 1, language, data: btoa(binary) };
  } finally { await context.close(); }
}

$('#openPwa').addEventListener('click', () => { if (state?.clientUrl) window.open(state.clientUrl, '_blank', 'noopener'); });
$('#copyMailbox').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state?.mailboxDirectory || '');
    $('#copyMailbox').textContent = 'Copied';
    window.setTimeout(() => { $('#copyMailbox').textContent = 'Copy mailbox path'; }, 1200);
  } catch (error) { showError(error); }
});
$('#playReply').addEventListener('click', async () => {
  activePlayback?.pause();
  const segments = state?.latestReply?.audioSegments || [];
  $('#playReply').disabled = true;
  $('#playReply').textContent = 'Playing…';
  try {
    for (const segment of segments) {
      const audio = new Audio(segment.url);
      activePlayback = audio;
      await audio.play();
      await new Promise((resolve, reject) => { audio.addEventListener('ended', resolve, { once: true }); audio.addEventListener('error', reject, { once: true }); });
    }
  } catch (error) { showError(error); }
  finally { activePlayback = undefined; $('#playReply').disabled = segments.length === 0; $('#playReply').textContent = 'Play full reply'; }
});
$('#send').addEventListener('click', async () => { try { $('#send').disabled = true; await api('/api/request', await form()); await refresh(); } catch (error) { showError(error); } });
$('#cancel').addEventListener('click', async () => { try { await api('/api/cancel', {}); await refresh(); } catch (error) { showError(error); } });
$('#startVoice').addEventListener('click', async () => { try { $('#startVoice').disabled = true; await api('/api/voice/start', commonForm()); await refresh(); } catch (error) { showError(error); await refresh(); } });
$('#stopVoice').addEventListener('click', async () => { try { await api('/api/voice/stop', { requestId: state.voiceCapture?.requestId }); await refresh(); } catch (error) { showError(error); } });
$('#cancelVoice').addEventListener('click', async () => { try { await api('/api/voice/cancel', { requestId: state.voiceCapture?.requestId }); await refresh(); } catch (error) { showError(error); } });
$('#clear').addEventListener('click', () => { hiddenBefore = state?.events.length ?? 0; render(); });
function showError(error) { window.alert(error instanceof Error ? error.message : String(error)); }
function escape(value) { const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML; }
setInterval(refresh, 750); void refresh();
