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
let markdownEnabled = false, latestState, lastUserElement;
let authChecking = typeof fetch === 'function', authEnabled = false, authenticated = false, csrf = '', pendingPairLink;
let dashboardGeneration = 0;
function home() {
  $('login').hidden = !authEnabled || authenticated;
  $('dashboard').hidden = !authEnabled || !authenticated;
  $('logout').hidden = !authEnabled || !authenticated;
  $('disconnect-label').textContent = authEnabled ? 'Sessions' : 'Disconnect';
  $('disconnect').setAttribute('aria-label', authEnabled ? 'Back to sessions' : 'Disconnect from session');
  $('disconnect').title = authEnabled ? 'Back to sessions' : 'Disconnect from session';
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
      && typeof session.connectable === 'boolean'
      && (session.status === undefined || ['running', 'idle', 'unknown'].includes(session.status)))) throw Error();
    renderSessionList(value.sessions);
  } catch { if (gen === dashboardGeneration && authenticated) notice('Could not load sessions. Try Refresh sessions.'); }
}
function renderSessionList(sessions) {
  const make = (tag, className, text) => {
    const el = document.createElement(tag); el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const fragment = document.createDocumentFragment();
  for (const session of sessions) {
    const status = ['running', 'idle'].includes(session.status) ? session.status : 'unknown';
    const label = status === 'running' ? 'Running' : status === 'idle' ? 'Idle' : 'Status unknown';
    const button = make('button', `session-choice session-${status}`);
    button.type = 'button'; button.disabled = !session.connectable;
    const icon = make('span', 'session-icon', '>_'); icon.setAttribute('aria-hidden', 'true');
    const body = make('span', 'session-body'), top = make('span', 'session-top');
    const title = make('span', 'session-name', session.name || 'Untitled session');
    const badge = make('span', `session-badge badge-${status}`, label);
    top.append(title, badge);
    const description = !session.connectable ? 'Pairing required · open its private link'
      : status === 'running' ? 'Agent is working' : status === 'idle' ? 'Ready for your next message' : 'Activity not available yet';
    body.append(top, make('span', 'session-description', description));
    const arrow = make('span', 'session-arrow', session.connectable ? '↗' : '—');
    arrow.setAttribute('aria-hidden', 'true');
    button.append(icon, body, arrow);
    button.onclick = () => selectSession(session.room);
    fragment.append(button);
  }
  if (!sessions.length) {
    const empty = make('div', 'sessions-empty');
    const icon = make('span', 'empty-icon', '>_'); icon.setAttribute('aria-hidden', 'true');
    empty.append(icon, make('h3', '', 'No sessions yet'),
      make('p', 'muted', 'Run /remote in Pi to connect a session. It will appear here automatically.'));
    fragment.append(empty);
  }
  const running = sessions.filter(session => session.status === 'running').length;
  $('session-summary').textContent = sessions.length
    ? `${sessions.length} connected ${sessions.length === 1 ? 'session' : 'sessions'}${running ? ` · ${running} running` : ''}`
    : 'Your connected Pi sessions will appear here.';
  $('session-list').replaceChildren(fragment);
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
    else if (!authEnabled) notice('Open your private pairing link in this browser, or scan the QR code shown by /remote in Pi.');
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
  const canRename = latestState?.capabilities?.includes('rename') === true;
  $('rename-save').disabled = !connected || !online || pending.size > 0 || !canRename;
  $('session-name').disabled = !canRename;
  $('rename-help').textContent = canRename ? 'Saved to the Pi session, not just this browser.'
    : 'This session is using an older remote extension. In Pi, run /remote off, /reload, then /remote to enable renaming.';
  $('last-user').disabled = !lastUserElement;
  $('send').disabled = !connected || !online || submitting || pending.size > 0;
  $('send').textContent = busy ? 'Send steer' : 'Send';
  $('next-turn').disabled = $('send').disabled;
  $('next-turn').hidden = !busy;
  $('interrupt').disabled = !connected || !online || submitting
    || [...pending.values()].some(c => c.action === 'interrupt' || (c.action === 'prompt' && !busy));
  const failed = latestState?.messages.at(-1)?.stopReason === 'error';
  $('status').className = !connected || !online ? 'connection-status status-offline' : submitting || busy ? 'connection-status status-working' : failed ? 'connection-status status-error' : 'connection-status status-ready';
  $('status').textContent = !connected ? 'Connecting to relay…' : !online ? 'Pi offline · waiting for reconnect' : submitting ? 'Submitting message · wait before interrupting' : busy ? 'Agent working' : failed ? 'Provider error · see latest reply' : 'Connected · ready';
}
function validToolCalls(calls) {
  return Array.isArray(calls) && calls.length <= 20 && calls.every(call => call
    && typeof call.name === 'string' && call.name.length <= 128
    && typeof call.input === 'string' && call.input.length <= 4000
    && (call.id === undefined || (typeof call.id === 'string' && call.id.length <= 128)));
}
function validModel(model) {
  return model == null || (typeof model.id === 'string' && model.id.length <= 256
    && typeof model.name === 'string' && model.name.length <= 256
    && typeof model.provider === 'string' && model.provider.length <= 128);
}
function validPlanUsage(usage) {
  return usage === undefined || (usage && typeof usage.provider === 'string' && usage.provider.length <= 128
    && ['loading', 'available', 'unavailable', 'unsupported'].includes(usage.status)
    && (usage.usedPercent === null || (typeof usage.usedPercent === 'number' && Number.isFinite(usage.usedPercent) && usage.usedPercent >= 0 && usage.usedPercent <= 100))
    && (usage.status !== 'available' || typeof usage.usedPercent === 'number')
    && [usage.updatedAt, usage.resetsAt].every(time => time === null || (Number.isSafeInteger(time) && time > 0))
    && (usage.plan === null || (typeof usage.plan === 'string' && usage.plan.length <= 64)));
}
function renderSettingsInfo(state) {
  const model = state.model, usage = state.planUsage;
  $('active-model').textContent = model ? (model.name || model.id) : 'Not available';
  $('active-model-provider').textContent = model ? `${model.provider}${model.name !== model.id ? ` · ${model.id}` : ''}` : 'Update the remote extension to report the active model.';
  const available = usage?.status === 'available' && usage.provider === model?.provider;
  $('weekly-usage-bar').hidden = !available;
  if (available) {
    $('weekly-usage').textContent = `${Math.round(usage.usedPercent)}% used`;
    $('weekly-usage-bar').value = usage.usedPercent;
    const parts = [];
    if (usage.plan) parts.push(`${usage.plan} plan`);
    if (usage.resetsAt) parts.push(`Resets ${new Date(usage.resetsAt).toLocaleString()}`);
    if (usage.updatedAt) parts.push(`Checked ${new Date(usage.updatedAt).toLocaleTimeString()}`);
    $('weekly-usage-detail').textContent = parts.join(' · ') || 'Reported by your subscription provider.';
  } else {
    $('weekly-usage').textContent = usage?.status === 'loading' ? 'Checking…' : 'Not available';
    $('weekly-usage-detail').textContent = usage?.status === 'unsupported'
      ? 'This provider does not expose weekly plan usage.'
      : usage?.status === 'loading' ? 'Checking your subscription on the Pi host…'
      : 'Requires a supported subscription login (Codex or Claude). API-key usage is not a weekly plan quota.';
  }
}
function render(state, repaint = false) {
  // Validate before touching revision/UI, including the optional detail fields.
  if (!state || !Number.isSafeInteger(state.revision) || state.revision < 0
    || typeof state.busy !== 'boolean' || typeof state.submitting !== 'boolean'
    || (state.capabilities !== undefined && (!Array.isArray(state.capabilities) || state.capabilities.length > 20
      || !state.capabilities.every(value => typeof value === 'string' && value.length <= 64)))
    || !validModel(state.model) || !validPlanUsage(state.planUsage)
    || typeof state.name !== 'string' || state.name.length > 256
    || !Array.isArray(state.tools) || state.tools.length > 100
    || !state.tools.every(tool => typeof tool === 'string' && tool.length <= 128)
    || (state.activeToolCalls !== undefined && !validToolCalls(state.activeToolCalls))
    || !Array.isArray(state.messages) || state.messages.length > 40
    || !state.messages.every(message => message && ['user', 'assistant', 'toolResult'].includes(message.role)
      && typeof message.text === 'string' && message.text.length <= 4000
      && (message.stopReason === undefined || (message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)))
      && (message.errorMessage === undefined || (message.role === 'assistant' && ['error', 'aborted'].includes(message.stopReason)
        && typeof message.errorMessage === 'string' && message.errorMessage.length > 0 && message.errorMessage.length <= 4000))
      && (message.tool === undefined || (typeof message.tool === 'string' && message.tool.length <= 128))
      && (message.timestamp === undefined || (typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)))
      && (message.thinking === undefined || (message.role === 'assistant' && typeof message.thinking === 'string' && message.thinking.length <= 4000))
      && (message.toolCalls === undefined || (message.role === 'assistant' && validToolCalls(message.toolCalls))))) throw Error('Invalid snapshot');
  if (!repaint && state.revision <= revision) return;
  latestState = state;
  renderSettingsInfo(state);
  revision = state.revision; busy = state.busy; submitting = state.submitting;
  $('session').textContent = state.name;
  $('session').title = state.name;
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
  lastUserElement = undefined;
  const fragment = document.createDocumentFragment();
  for (const [index, message] of state.messages.entries()) {
    const article = document.createElement('article'); article.className = `message ${message.role}`;
    if (message.role === 'user') lastUserElement = article;
    const label = document.createElement('div'); label.className = 'role';
    label.textContent = message.role === 'toolResult' ? (message.tool || 'Tool output') : message.role;
    article.append(label);
    if (message.thinking) details(article, `message:${message.timestamp ?? index}:thinking`, 'Thinking', message.thinking, false, 'thinking');
    if (message.role === 'toolResult') details(article, `message:${message.timestamp ?? index}:output`, 'Show output', message.text);
    else if (message.text) {
      if (markdownEnabled && message.role === 'assistant') {
        const body = document.createElement('div'); body.className = 'markdown';
        renderMarkdown(body, message.text); article.append(body);
      } else {
        const pre = document.createElement('pre'); pre.textContent = message.text; article.append(pre);
      }
    }
    if (message.errorMessage) {
      const error = document.createElement('div');
      error.className = message.stopReason === 'aborted' ? 'provider-error interrupted' : 'provider-error';
      error.setAttribute('role', 'note');
      const heading = document.createElement('div'); heading.className = 'error-heading';
      heading.textContent = message.stopReason === 'aborted' ? 'Response interrupted' : 'Provider error';
      const detail = document.createElement('pre'); detail.textContent = message.errorMessage;
      error.append(heading, detail); article.append(error);
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
          if (command.action === 'rename' && $('session-name').value.trim() === command.text) closeSettings();
          if (['prompt', 'steer', 'followUp'].includes(command.action)) { if ($('prompt').value === command.text) $('prompt').value = ''; }
          notice(command.action === 'rename' ? 'Session renamed.' : command.action === 'interrupt' ? 'Interrupt requested.' : command.action === 'followUp' ? 'Next-turn message requested.' : command.action === 'steer' ? 'Steering message requested.' : 'Message accepted.');
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
    $('dashboard').hidden = true; $('login').hidden = true; $('workspace').hidden = false; $('disconnect').hidden = false; $('settings-toggle').hidden = false;
    notice('Encrypted connection. Keep your pairing link private.'); connect(gen);
  } catch (error) { if (gen === generation) notice(error.message); }
}
function disconnect() {
  closeSettings(); $('settings-toggle').hidden = true;
  generation++; clearTimeout(retryTimer); socket?.close(); socket = undefined;
  credentials = undefined; cryptoKey = undefined; pending.clear(); online = false; connected = false; submitting = false;
  $('messages').replaceChildren(); $('workspace').hidden = true; $('disconnect').hidden = true;
  $('tool-calls').replaceChildren(); $('tool-calls').hidden = true;
  latestState = undefined; lastUserElement = undefined;
  $('last-user').disabled = true;
  $('prompt').value = ''; $('activity').textContent = ''; $('session').textContent = 'Your coding agent, anywhere.'; $('session').title = ''; home();
}
$('disconnect').onclick = () => { dashboardGeneration++; disconnect(); notice('Phone disconnected. To revoke access, run /remote off in Pi.'); refreshSessions(); };
async function command(action, text) {
  if (action === 'rename' && !latestState?.capabilities?.includes('rename')) {
    notice('Update and reload the remote extension in this Pi session to enable renaming.'); return;
  }
  if (!connected || !online || (submitting && action !== 'rename') || (action !== 'interrupt' && pending.size > 0)) return;
  if (action === 'interrupt' && [...pending.values()].some(c => c.action === 'interrupt' || (c.action === 'prompt' && !busy))) return;
  const value = { id: crypto.randomUUID(), action, text, createdAt: Date.now() };
  pending.set(value.id, value); controls(); notice('Sending…');
  try { await sendCommand(value); } catch { pending.delete(value.id); controls(); notice('Could not send command.'); }
}
function closeSettings() {
  $('settings-panel').hidePopover?.();
  $('settings-panel').hidden = true;
  $('settings-toggle').setAttribute('aria-expanded', 'false');
  $('session-name').value = '';
}
$('settings-toggle').onclick = () => {
  if (!$('settings-panel').hidden) { closeSettings(); return; }
  $('session-name').value = latestState?.name || '';
  $('settings-panel').hidden = false;
  $('settings-panel').showPopover?.();
  $('settings-toggle').setAttribute('aria-expanded', 'true');
  controls();
  $('markdown-toggle').focus?.();
};
$('settings-cancel').onclick = () => { closeSettings(); $('settings-toggle').focus?.(); };
$('settings-close').onclick = $('settings-cancel').onclick;
$('settings-panel').ontoggle = event => {
  const open = event.newState === 'open';
  $('settings-panel').hidden = !open;
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  if (!open) $('session-name').value = '';
};
// Native popovers handle outside-click dismissal; retain it on older browsers.
function dismissSettingsOutside(event) {
  const panel = $('settings-panel'), toggle = $('settings-toggle');
  if (typeof panel.showPopover === 'function' || panel.hidden) return;
  if (event.target === panel || event.target === toggle || panel.contains?.(event.target) || toggle.contains?.(event.target)) return;
  closeSettings();
}
addEventListener('pointerdown', dismissSettingsOutside);

$('settings-panel').onkeydown = event => {
  if (event.key === 'Escape') { event.preventDefault(); closeSettings(); $('settings-toggle').focus?.(); }
};
$('rename-form').onsubmit = event => {
  event.preventDefault();
  const name = $('session-name').value.trim();
  if (!name || name.length > 256 || /[\x00-\x1f\x7f]/.test(name)) { notice('Enter a session name between 1 and 256 characters, without control characters.'); return; }
  command('rename', name);
};
$('last-user').onclick = () => {
  if (!lastUserElement) return;
  const chat = $('chat');
  chat.scrollTop = Math.max(0, lastUserElement.getBoundingClientRect().top - chat.getBoundingClientRect().top + chat.scrollTop - 12);
};
$('prompt-form').onsubmit = event => { event.preventDefault(); if ($('prompt').value.trim()) command(busy ? 'steer' : 'prompt', $('prompt').value); };
$('next-turn').onclick = () => { if ($('prompt').value.trim()) command('followUp', $('prompt').value); };
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

// Render an allowlisted DOM, never HTML strings. Raw HTML/images stay literal.
function renderMarkdown(parent, text) {
  const node = (tag, text) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const literal = (parent, text) => parent.append(node('span', text || ''));
  const inline = (parent, tokens) => {
    for (const token of tokens || []) {
      const tag = { strong: 'strong', em: 'em', del: 'del' }[token.type];
      if (tag) { const el = node(tag); inline(el, token.tokens); parent.append(el); }
      else if (token.type === 'codespan') parent.append(node('code', token.text));
      else if (token.type === 'br') parent.append(node('br'));
      else if (token.type === 'link') {
        let url;
        try { url = new URL(token.href); } catch {}
        if (url && ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) {
          const el = node('a'); el.href = url.href; el.rel = 'noopener noreferrer';
          inline(el, token.tokens); parent.append(el);
        } else inline(parent, token.tokens);
      } else if (token.type === 'text' && token.tokens) inline(parent, token.tokens);
      else literal(parent, ['html', 'image'].includes(token.type) ? token.raw : token.text ?? token.raw);
    }
  };
  const blocks = (parent, tokens) => {
    for (const token of tokens) {
      if (['space', 'def'].includes(token.type)) continue;
      if (token.type === 'code') {
        const pre = node('pre'); pre.append(node('code', token.text)); parent.append(pre);
      } else if (['heading', 'paragraph', 'text'].includes(token.type)) {
        const el = node(token.type === 'heading' ? `h${token.depth}` : 'p');
        if (token.tokens) inline(el, token.tokens); else literal(el, token.text);
        parent.append(el);
      } else if (token.type === 'blockquote') {
        const el = node('blockquote'); blocks(el, token.tokens); parent.append(el);
      } else if (token.type === 'list') {
        const list = node(token.ordered ? 'ol' : 'ul');
        if (token.ordered && Number.isSafeInteger(token.start)) list.start = token.start;
        for (const item of token.items) {
          const li = node('li');
          if (item.task) literal(li, item.checked ? '☑ ' : '☐ ');
          blocks(li, item.tokens); list.append(li);
        }
        parent.append(list);
      } else if (token.type === 'hr') parent.append(node('hr'));
      else if (token.type === 'table') {
        const table = node('table'), head = node('thead'), row = node('tr'), body = node('tbody');
        for (const cell of token.header) { const el = node('th'); inline(el, cell.tokens); row.append(el); }
        head.append(row); table.append(head);
        for (const cells of token.rows) {
          const row = node('tr');
          for (const cell of cells) { const el = node('td'); inline(el, cell.tokens); row.append(el); }
          body.append(row);
        }
        table.append(body); parent.append(table);
      } else literal(parent, token.raw);
    }
  };
  try { blocks(parent, marked.lexer(text, { gfm: true })); }
  catch { parent.replaceChildren(node('pre', text)); }
}
$('markdown-toggle').onclick = () => {
  markdownEnabled = !markdownEnabled;
  $('markdown-toggle').textContent = `Markdown: ${markdownEnabled ? 'On' : 'Off'}`;
  $('markdown-toggle').setAttribute('aria-pressed', String(markdownEnabled));
  if (latestState) render(latestState, true);
};
