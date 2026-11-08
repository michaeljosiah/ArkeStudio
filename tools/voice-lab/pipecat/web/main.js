import { PipecatClient } from '@pipecat-ai/client-js';
import { SmallWebRTCTransport } from '@pipecat-ai/small-webrtc-transport';
import './style.css';

const $ = (id) => document.getElementById(id);
let client, session, events, assistant, muted = false, previewUrl;
const log = [];
const audio = new Audio();
audio.autoplay = true;
audio.playsInline = true;
let output = new MediaStream();
audio.srcObject = output;
document.body.append(audio);

function error(value) { $('error').hidden = !value; $('error').textContent = value || ''; }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw Error(data.detail || `Request failed (${response.status})`); }
  return response;
}
function message(role, text = '') {
  $('transcript').querySelector('.empty')?.remove();
  const row = document.createElement('div'); row.className = `message ${role}`;
  const who = document.createElement('small'); who.textContent = role === 'user' ? 'YOU' : role === 'assistant' ? 'ARKE' : 'TEST';
  const words = document.createElement('span'); words.textContent = text;
  row.append(who, words); $('transcript').append(row); $('transcript').scrollTop = $('transcript').scrollHeight;
  return words;
}
function activity(active) {
  for (const id of ['text', 'send', 'mute', 'disconnect', 'background']) $(id).disabled = !active;
  for (const id of ['model', 'voice', 'delay', 'connect']) $(id).disabled = active;
}
function handle(event) {
  log.push(event);
  switch (event.type) {
    case 'transcript': assistant = null; message('user', event.text); $('status').textContent = 'Thinking…'; break;
    case 'assistant-delta': if (!assistant) assistant = message('assistant'); assistant.textContent += event.text; $('transcript').scrollTop = $('transcript').scrollHeight; break;
    case 'assistant-end': assistant = null; break;
    case 'first-token': $('token-ms').innerHTML = `${event.ms}<small> ms</small>`; break;
    case 'bot-speaking': $('status').textContent = event.active ? 'Speaking — you can interrupt' : 'Listening'; if (event.active && event.latencyMs != null) $('voice-ms').innerHTML = `${event.latencyMs}<small> ms</small>`; break;
    case 'user-speaking': $('status').textContent = event.active ? 'Listening to you…' : 'Thinking…'; break;
    case 'interrupted': $('status').textContent = 'Interrupted — listening'; assistant = null; break;
    case 'background-start': $('jobs').textContent = `Working · ${event.task}`; message('system', 'Background agent started. Keep talking.'); break;
    case 'background-tool-start': $('jobs').textContent = `Searching sample reference notes · ${event.query} (${event.delaySeconds}s minimum tool hold)`; message('system', `Background tool · search_reference_library · ${event.query}`); break;
    case 'background-tool-result': message('system', `Reference search returned · ${event.sources.join(', ') || 'no matching notes'}`); break;
    case 'background-complete': $('jobs').textContent = `Done · ${event.text}`; break;
    case 'background-failed': $('jobs').textContent = 'Background task failed. The conversation can continue.'; break;
    case 'tool': message('system', `Tool called · ${event.name}`); break;
    case 'error': error(event.message); $('status').textContent = 'Turn failed — ready to try again'; break;
    case 'disconnected': $('status').textContent = 'Disconnected'; break;
  }
}
async function disconnect() {
  const id = session; session = null;
  events?.close(); events = null;
  await client?.disconnect().catch(() => {}); client = null;
  if (id) await api(`/api/session/${id}`, 'DELETE').catch(() => {});
  output.getTracks().forEach(track => output.removeTrack(track));
  activity(false); $('status').textContent = 'Conversation ended'; $('mute').textContent = 'Mute microphone'; muted = false;
}
$('connect').onclick = async () => {
  error(); $('connect').disabled = true; $('status').textContent = 'Connecting…';
  try {
    session = (await (await api('/api/session', 'POST', { model: $('model').value, voice: $('voice').value, delay: Number($('delay').value) })).json()).id;
    events = new EventSource(`/api/events/${session}`); events.onmessage = (event) => handle(JSON.parse(event.data));
    client = new PipecatClient({ transport: new SmallWebRTCTransport(), enableMic: true, enableCam: false,
      callbacks: {
        onTrackStarted(track, participant) { if (track.kind === 'audio' && !participant?.local) { output.addTrack(track); audio.play().catch(() => error('Press Start again to allow audio playback.')); } },
        onBotReady() { $('status').textContent = 'Listening — say hello'; },
        onError(e) { error(e.message || 'The voice connection failed'); },
      },
    });
    await client.connect({ webrtcRequestParams: { endpoint: `${location.origin}/api/offer/${session}` } });
    activity(true); $('status').textContent = 'Listening — say hello';
  } catch (e) { await disconnect(); error(e.message); }
};
$('disconnect').onclick = disconnect;
$('mute').onclick = () => { muted = !muted; client.enableMic(!muted); $('mute').textContent = muted ? 'Unmute microphone' : 'Mute microphone'; $('status').textContent = muted ? 'Microphone muted' : 'Listening'; };
$('text-form').onsubmit = async (event) => { event.preventDefault(); const text = $('text').value.trim(); if (!text || !session) return; try { await api(`/api/text/${session}`, 'POST', { text }); $('text').value = ''; } catch (e) { error(e.message); } };
$('background').onclick = async () => { try { await api(`/api/text/${session}`, 'POST', { text: 'In the background, search the sample reference library for Skyharbour’s storm mooring code and what arriving ships must do during a red storm. Delegate that lookup, then let us keep talking.' }); } catch (e) { error(e.message); } };
$('audition').onclick = async () => { $('audition').disabled = true; error(); try { const response = await api('/api/audition', 'POST', { voice: $('voice').value }); if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(await response.blob()); const preview = new Audio(previewUrl); await preview.play(); } catch (e) { error(e.message); } finally { $('audition').disabled = false; } };
$('export').onclick = () => { const link = document.createElement('a'); const url = URL.createObjectURL(new Blob([JSON.stringify({ engine: 'pipecat', model: $('model').value, voice: $('voice').value, events: log }, null, 2)], { type: 'application/json' })); link.href = url; link.download = `arke-pipecat-${new Date().toISOString().replaceAll(':', '-')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
window.addEventListener('pagehide', () => { client?.disconnect(); if (session) fetch(`/api/session/${session}`, { method: 'DELETE', keepalive: true }); });
try {
  const config = await (await api('/api/config')).json();
  for (const [id, values, selected] of [['model', config.models, config.defaultModel], ['voice', config.voices, config.defaultVoice]]) {
    for (const value of values) { const option = document.createElement('option'); option.value = option.textContent = value; $(id).append(option); }
    if (values.includes(selected)) $(id).value = selected;
  }
  $('stack').textContent = `Pipecat ${config.pipecat} · OpenCode ${config.opencode} · ${config.recognizer} · ${config.kokoro}. espeak runs as a separate executable. WebRTC stays on this machine; no STUN service is configured.`;
} catch (e) { error(e.message); $('connect').disabled = true; }
