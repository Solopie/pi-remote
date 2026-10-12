const $ = id => document.getElementById(id);
let socket, cryptoKey, credentials, retryTimer, attempt = 0, generation = 0;
let online = false, connected = false, busy = true, submitting = false, revision = -1;
const pending = new Map();
const encoder = new TextEncoder(), decoder = new TextDecoder();
function bytes(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
function base64(value) {
  let str = ''; for (const byte of new Uint8Array(value)) str += String.fromCharCode(byte);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function seal(value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('pi-remote/v2/client/command') }, cryptoKey, encoder.encode(JSON.stringify(value)));
  return { iv: base64(iv), data: base64(data) };
}
async function open(envelope, type) {
  if (!['state', 'ack'].includes(type)) throw Error('Invalid encrypted packet type');
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: encoder.encode(`pi-remote/v2/host/${type}`) }, cryptoKey, bytes(envelope.data));
  return JSON.parse(decoder.decode(data));
}
function notice(text) { $('notice').textContent = text; }
function controls() {
  $('send').disabled = !connected || !online || busy || pending.size > 0;
  $('interrupt').disabled = !connected || !online || submitting
    || [...pending.values()].some(c => c.action === 'interrupt' || (c.action === 'prompt' && !busy));
  $('status').textContent = !connected ? 'Connecting to relay…' : !online ? 'Pi offline · waiting for reconnect' : submitting ? 'Submitting message · wait before interrupting' : busy ? 'Agent working' : 'Connected · ready';
}
function render(state) {
  // Validate before touching revision/UI: even authenticated data must have the
  // expected shape, otherwise malformed records could break replay protection.
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0
    || typeof state.busy !== 'boolean' || typeof state.submitting !== 'boolean'
    || typeof state.name !== 'string' || state.name.length > 256
    || !Array.isArray(state.tools) || state.tools.length > 100
    || !state.tools.every(tool => typeof tool === 'string' && tool.length <= 128)
    || !Array.isArray(state.messages) || state.messages.length > 40
    || !state.messages.every(message => message && ['user', 'assistant', 'toolResult'].includes(message.role)
      && typeof message.text === 'string' && message.text.length <= 4000
      && (message.tool === undefined || typeof message.tool === 'string'))) throw Error('Invalid snapshot');
  if (state.revision <= revision) return;
  revision = state.revision; busy = state.busy; submitting = state.submitting;
  $('session').textContent = state.name;
  $('activity').textContent = state.tools?.length ? `Running: ${state.tools.join(', ')}` : '';
  const container = $('messages');
  const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
  const scroll = container.scrollTop;
  const expanded = new Set([...container.querySelectorAll('details[open]')].map(el => el.dataset.index));
  const fragment = document.createDocumentFragment();
  for (const [index, message] of (state.messages || []).entries()) {
    const article = document.createElement('article'); article.className = `message ${message.role}`;
    const label = document.createElement('div'); label.className = 'role'; label.textContent = message.role === 'toolResult' ? (message.tool || 'Tool output') : message.role;
    const pre = document.createElement('pre'); pre.textContent = message.text;
    article.append(label);
    if (message.role === 'toolResult') {
      const details = document.createElement('details'); details.dataset.index = String(index); details.open = expanded.has(String(index));
      const summary = document.createElement('summary'); summary.textContent = 'Show output'; details.append(summary, pre); article.append(details);
    } else article.append(pre);
    fragment.append(article);
  }
  container.replaceChildren(fragment);
  container.scrollTop = nearBottom ? container.scrollHeight : scroll;
  controls();
}
async function sendCommand(command) {
  const ws = socket, gen = generation;
  const payload = await seal(command);
  if (gen === generation && ws === socket && ws?.readyState === WebSocket.OPEN && online) ws.send(JSON.stringify({ type: 'command', payload }));
}
function connect(gen) {
  if (gen !== generation || !credentials) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
  socket = ws; connected = false; controls();
  let closed = false;
  const current = () => !closed && gen === generation && socket === ws;
  ws.onopen = () => { if (current()) ws.send(JSON.stringify({ type: 'join', role: 'client', room: credentials.room })); };
  // Serialize async decrypt/render to preserve packet order.
  let queue = Promise.resolve();
  ws.onmessage = event => {
    queue = queue.then(async () => {
      if (!current()) return;
      const packet = JSON.parse(event.data);
      if (packet.type === 'joined' || packet.type === 'presence') {
        connected = true; online = packet.online; attempt = 0; controls();
        if (online) for (const command of pending.values()) {
          if (Date.now() - command.createdAt < 120000) await sendCommand(command);
          else { pending.delete(command.id); notice('A command expired; its outcome is unknown. Check the conversation before resending.'); }
        }
        controls(); return;
      }
      const value = await open(packet.payload, packet.type);
      if (!current()) return;
      if (packet.type === 'state') render(value);
      if (packet.type === 'ack') {
        if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value.id)
          || typeof value.ok !== 'boolean' || (value.error !== undefined && typeof value.error !== 'string')) throw Error('Invalid acknowledgement');
      }
      if (packet.type === 'ack' && pending.has(value.id)) {
        const command = pending.get(value.id); pending.delete(value.id);
        if (!value.ok) notice(value.error || 'Command rejected.');
        else {
          if (command.action === 'prompt') { if ($('prompt').value === command.text) $('prompt').value = ''; }
          notice(command.action === 'interrupt' ? 'Interrupt requested.' : 'Message accepted.');
        }
        controls();
      }
    }).catch(() => { if (current()) notice('Unable to verify encrypted session data. Check your pairing link.'); });
  };
  ws.onclose = event => {
    closed = true;
    if (gen !== generation || socket !== ws) return;
    connected = false; online = false; controls();
    if (event.code === 1008) { notice('Session unavailable or revoked. Run /remote in pi for a new link.'); return; }
    retryTimer = setTimeout(() => connect(gen), Math.min(1000 * 2 ** attempt++, 15000));
  };
  ws.onerror = () => {};
}
async function pair(link) {
  // Stop controlling the old session immediately. A newer pairing/disconnect
  // invalidates any key import that is still awaiting WebCrypto.
  disconnect();
  const gen = generation;
  try {
    if (!crypto.subtle) throw Error('Use HTTPS (or localhost) for secure pairing.');
    const url = new URL(link);
    if (url.origin !== location.origin) throw Error('Open the pairing link on its own relay website.');
    const params = new URLSearchParams(url.hash.slice(1));
    const room = params.get('room'), key = params.get('key');
    if (!/^[A-Za-z0-9_-]{43}$/.test(room || '') || !/^[A-Za-z0-9_-]{43}$/.test(key || '')) throw Error('Invalid pairing link.');
    const importedKey = await crypto.subtle.importKey('raw', bytes(key), 'AES-GCM', false, ['encrypt', 'decrypt']);
    if (gen !== generation) return;
    credentials = { room }; cryptoKey = importedKey;
    revision = -1; busy = true; submitting = false; attempt = 0;
    $('pair').hidden = true; $('workspace').hidden = false; $('disconnect').hidden = false;
    $('pair-link').value = ''; notice('Encrypted connection. Keep your pairing link private.'); connect(gen);
  } catch (error) { if (gen === generation) notice(error.message); }
}
function disconnect() {
  generation++; clearTimeout(retryTimer); socket?.close(); socket = undefined;
  credentials = undefined; cryptoKey = undefined; pending.clear(); online = false; connected = false; submitting = false;
  $('messages').replaceChildren(); $('workspace').hidden = true; $('pair').hidden = false; $('disconnect').hidden = true;
  $('prompt').value = ''; $('activity').textContent = ''; $('session').textContent = 'Your coding agent, anywhere.';
}
$('pair-form').onsubmit = event => { event.preventDefault(); pair($('pair-link').value); };
$('disconnect').onclick = () => { disconnect(); notice('Phone disconnected. To revoke the pairing link, run /remote off in pi.'); };
async function command(action, text) {
  if (!connected || !online || submitting || (action === 'prompt' && (busy || pending.size))) return;
  if (action === 'interrupt' && [...pending.values()].some(c => c.action === 'interrupt' || (c.action === 'prompt' && !busy))) return;
  const value = { id: crypto.randomUUID(), action, text, createdAt: Date.now() };
  pending.set(value.id, value); controls(); notice('Sending…');
  try { await sendCommand(value); } catch { pending.delete(value.id); controls(); notice('Could not send command.'); }
}
$('prompt-form').onsubmit = event => { event.preventDefault(); if ($('prompt').value.trim()) command('prompt', $('prompt').value); };
$('interrupt').onclick = () => command('interrupt');
$('prompt').onkeydown = event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('prompt-form').requestSubmit(); } };
// Same-document navigation to another pairing link does not reload this module.
// Strip secrets synchronously, before parsing/importing the new credentials.
function pairFromLocation() {
  if (!location.hash) return;
  const link = location.href;
  history.replaceState(null, '', '/');
  return pair(link);
}
addEventListener('hashchange', pairFromLocation);
pairFromLocation();

// Recover a lost acknowledgement without changing the command ID. Never silently reissue expired work.
setInterval(() => {
  for (const command of pending.values()) {
    if (Date.now() - command.createdAt >= 120000) {
      pending.delete(command.id); notice('Command acknowledgement timed out. Check the conversation before resending.');
    } else if (connected && online) sendCommand(command).catch(() => {});
  }
  controls();
}, 10000);
