const $ = id => document.getElementById(id);
// Mobile keyboards can shrink the visual viewport without changing 100dvh.
if (typeof visualViewport !== 'undefined' && visualViewport) {
  const fitViewport = () => document.documentElement.style.setProperty('--app-height', `${visualViewport.height}px`);
  visualViewport.addEventListener('resize', fitViewport);
  fitViewport();
}
let socket, cryptoKey, credentials, retryTimer, attempt = 0, generation = 0;
let online = false, connected = false, busy = true, submitting = false, revision = -1;
const pending = new Map();
let authChecking = typeof fetch === 'function', authEnabled = false, authenticated = false, csrf = '', pendingPairLink;
let dashboardGeneration = 0;
function home() {
  $('login').hidden = !authEnabled || authenticated;
  $('dashboard').hidden = !authEnabled || !authenticated;
  $('pair').hidden = authEnabled && !authenticated;
  $('logout').hidden = !authEnabled || !authenticated;
  $('disconnect').textContent = authEnabled ? 'Sessions' : 'Disconnect';
}
async function refreshSessions() {
  if (!authEnabled || !authenticated || !$('workspace').hidden) return;
  const gen = ++dashboardGeneration;
  try {
    const response = await fetch('/api/sessions', { cache: 'no-store' });
    if (gen !== dashboardGeneration) return;
    if (response.status === 401) return signedOut();
    if (!response.ok) throw Error();
    const value = await response.json();
    if (gen !== dashboardGeneration || !authenticated || !$('workspace').hidden) return;
    if (!Array.isArray(value.sessions) || value.sessions.length > 100 || !value.sessions.every(session => session
      && typeof session.room === 'string' && /^[A-Za-z0-9_-]{43}$/.test(session.room) && typeof session.name === 'string' && session.name.length <= 256
      && typeof session.connectable === 'boolean')) throw Error();
    const fragment = document.createDocumentFragment();
    for (const session of value.sessions) {
      const button = document.createElement('button'); button.className = 'session-choice';
      button.textContent = session.name + (session.connectable ? '' : ' · pairing required'); button.disabled = !session.connectable;
      button.onclick = () => selectSession(session.room); fragment.append(button);
    }
    if (!value.sessions.length) { const text = document.createElement('p'); text.textContent = 'No connected sessions. Enable /remote in Pi.'; fragment.append(text); }
    $('session-list').replaceChildren(fragment);
  } catch { if (gen === dashboardGeneration && authenticated) notice('Could not load sessions. Try Refresh sessions.'); }
}
async function selectSession(room) {
  const gen = ++dashboardGeneration;
  try {
    const response = await fetch(`/api/sessions/${room}`, { cache: 'no-store' });
    if (gen !== dashboardGeneration) return;
    if (response.status === 401) return signedOut();
    if (!response.ok) throw Error();
    const value = await response.json();
    if (gen !== dashboardGeneration || !authenticated) return;
    if (value.room !== room || typeof value.key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.key)) throw Error();
    // Keep dashboard-issued keys out of the address bar and browser history.
    await pair(`${location.origin}/#room=${room}&key=${value.key}`);
  } catch { if (gen === dashboardGeneration) notice('Session unavailable. Refresh the session list.'); }
}
function signedOut() {
  authenticated = false; csrf = ''; dashboardGeneration++; pendingPairLink = undefined;
  disconnect(); $('session-list').replaceChildren(); $('account').textContent = ''; home(); notice('Sign in to access your sessions.');
}
async function initializeAuth() {
  // Fail closed if authentication status cannot be checked.
  $('pair').hidden = true;
  try {
    const response = await fetch('/api/auth', { cache: 'no-store' });
    if (response.status === 404) { notice('Restart the relay with the updated server before using this client.'); return; }
    if (!response.ok) throw Error();
    const value = await response.json();
    if (typeof value.enabled !== 'boolean' || typeof value.authenticated !== 'boolean'
      || (value.authenticated && (typeof value.email !== 'string' || typeof value.csrf !== 'string'))) throw Error();
    authEnabled = value.enabled; authenticated = value.authenticated; csrf = value.csrf || ''; authChecking = false;
    home(); if (authenticated) $('account').textContent = `Signed in as ${value.email}`;
    if (pendingPairLink && (!authEnabled || authenticated)) { const link = pendingPairLink; pendingPairLink = undefined; await pair(link); }
    else if (authEnabled && !authenticated && pendingPairLink) notice('Sign in first, then reopen the pairing link if this session is not enrolled.');
    else await refreshSessions();
  } catch { notice('Could not check sign-in status. Refresh this page to try again.'); }
}
$('refresh-sessions').onclick = refreshSessions;
$('logout').onclick = async () => {
  dashboardGeneration++;
  try {
    const response = await fetch('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
    if (!response.ok) throw Error();
    signedOut();
  } catch { notice('Sign-out failed. Try again; your login may still be active.'); }
};
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
function validToolCalls(calls) {
  return Array.isArray(calls) && calls.length <= 20 && calls.every(call => call
    && typeof call.name === 'string' && call.name.length <= 128
    && typeof call.input === 'string' && call.input.length <= 4000
    && (call.id === undefined || (typeof call.id === 'string' && call.id.length <= 128)));
}
function render(state) {
  // Validate before touching revision/UI, including the optional detail fields.
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0
    || typeof state.busy !== 'boolean' || typeof state.submitting !== 'boolean'
    || typeof state.name !== 'string' || state.name.length > 256
    || !Array.isArray(state.tools) || state.tools.length > 100
    || !state.tools.every(tool => typeof tool === 'string' && tool.length <= 128)
    || (state.activeToolCalls !== undefined && !validToolCalls(state.activeToolCalls))
    || !Array.isArray(state.messages) || state.messages.length > 40
    || !state.messages.every(message => message && ['user', 'assistant', 'toolResult'].includes(message.role)
      && typeof message.text === 'string' && message.text.length <= 4000
      && (message.tool === undefined || (typeof message.tool === 'string' && message.tool.length <= 128))
      && (message.timestamp === undefined || (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)))
      && (message.thinking === undefined || (message.role === 'assistant' && typeof message.thinking === 'string' && message.thinking.length <= 4000))
      && (message.toolCalls === undefined || (message.role === 'assistant' && validToolCalls(message.toolCalls))))) throw Error('Invalid snapshot');
  if (state.revision <= revision) return;
  revision = state.revision; busy = state.busy; submitting = state.submitting;
  $('session').textContent = state.name;
  $('activity').textContent = state.tools.length ? `Running: ${state.tools.join(', ')}` : '';
  const container = $('messages'), active = $('tool-calls'), chat = $('chat');
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  const scroll = chat.scrollTop;
  const expanded = new Map([...container.querySelectorAll('details'), ...active.querySelectorAll('details')]
    .map(el => [el.dataset.index, el.open]));
  const details = (parent, key, title, text, open = false, kind = 'tool-input') => {
    const element = document.createElement('details'); element.className = kind; element.dataset.index = key;
    element.open = expanded.get(key) ?? open;
    const summary = document.createElement('summary'); summary.textContent = title;
    const pre = document.createElement('pre'); pre.textContent = text;
    element.append(summary, pre); parent.append(element);
  };
  const fragment = document.createDocumentFragment();
  for (const [index, message] of state.messages.entries()) {
    const article = document.createElement('article'); article.className = `message ${message.role}`;
    const label = document.createElement('div'); label.className = 'role';
    label.textContent = message.role === 'toolResult' ? (message.tool || 'Tool output') : message.role;
    article.append(label);
    if (message.thinking) details(article, `message:${message.timestamp ?? index}:thinking`, 'Thinking', message.thinking, false, 'thinking');
    if (message.role === 'toolResult') details(article, `message:${message.timestamp ?? index}:output`, 'Show output', message.text);
    else if (message.text) {
      const pre = document.createElement('pre'); pre.textContent = message.text; article.append(pre);
    }
    for (const [callIndex, call] of (message.toolCalls || []).entries()) {
      details(article, `message:${message.timestamp ?? index}:call:${call.id ?? callIndex}`, `${call.name} · input`, call.input, true);
    }
    fragment.append(article);
  }
  container.replaceChildren(fragment);
  const running = document.createDocumentFragment();
  for (const [index, call] of (state.activeToolCalls || []).entries()) {
    const article = document.createElement('article'); article.className = 'message running-tool';
    details(article, `active:${call.id ?? index}`, `Running: ${call.name}`, call.input, true); running.append(article);
  }
  active.replaceChildren(running); active.hidden = !state.activeToolCalls?.length;
  chat.scrollTop = nearBottom ? chat.scrollHeight : scroll;
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
  ws.onclose = async event => {
    closed = true;
    if (gen !== generation || socket !== ws) return;
    connected = false; online = false; controls();
    if (event.code === 4401) { signedOut(); return; }
    if (event.code === 1008) { notice('Session unavailable or revoked. Choose another session or run /remote in Pi.'); return; }
    if (authEnabled) {
      // A sleeping phone may miss the server's expiry close; an HTTP 401 on
      // the next upgrade appears to browsers only as a generic socket failure.
      try {
        const response = await fetch('/api/auth', { cache: 'no-store' });
        const value = response.ok ? await response.json() : undefined;
        if (gen !== generation || socket !== ws) return;
        if (value?.enabled === true && value.authenticated === false) { signedOut(); return; }
      } catch { /* Offline: retain credentials and retry instead of logging out. */ }
      if (gen !== generation || socket !== ws) return;
    }
    retryTimer = setTimeout(() => connect(gen), Math.min(1000 * 2 ** attempt++, 15000));
  };
  ws.onerror = () => {};
}
async function pair(link) {
  if (authChecking || (authEnabled && !authenticated)) { pendingPairLink = link; return; }
  dashboardGeneration++;
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
    $('pair').hidden = true; $('dashboard').hidden = true; $('login').hidden = true; $('workspace').hidden = false; $('disconnect').hidden = false;
    $('pair-link').value = ''; notice('Encrypted connection. Keep your pairing link private.'); connect(gen);
  } catch (error) { if (gen === generation) notice(error.message); }
}
function disconnect() {
  generation++; clearTimeout(retryTimer); socket?.close(); socket = undefined;
  credentials = undefined; cryptoKey = undefined; pending.clear(); online = false; connected = false; submitting = false;
  $('messages').replaceChildren(); $('workspace').hidden = true; $('pair').hidden = false; $('disconnect').hidden = true;
  $('tool-calls').replaceChildren(); $('tool-calls').hidden = true;
  $('prompt').value = ''; $('activity').textContent = ''; $('session').textContent = 'Your coding agent, anywhere.'; home();
}
$('pair-form').onsubmit = event => { event.preventDefault(); pair($('pair-link').value); };
$('disconnect').onclick = () => { dashboardGeneration++; disconnect(); notice('Phone disconnected. To revoke access, run /remote off in Pi.'); refreshSessions(); };
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
if (typeof fetch === 'function') initializeAuth();

// Recover a lost acknowledgement without changing the command ID. Never silently reissue expired work.
setInterval(() => {
  for (const command of pending.values()) {
    if (Date.now() - command.createdAt >= 120000) {
      pending.delete(command.id); notice('Command acknowledgement timed out. Check the conversation before resending.');
    } else if (connected && online) sendCommand(command).catch(() => {});
  }
  controls();
}, 10000);

setInterval(refreshSessions, 10000);
