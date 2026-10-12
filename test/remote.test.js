import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import vm from 'node:vm';
import WebSocket from 'ws';
import { createRelay } from '../src/server.js';
import { randomToken, seal, open } from '../src/crypto.js';
import { publicMessage, validCommand, boundSnapshot, MAX_SNAPSHOT_BYTES } from '../src/protocol.js';
import { normalizeRelayURL, readConfig, saveConfig, resolveConfig } from '../src/config.js';
import { pairingMessage } from '../src/pairing.js';

const token = randomToken();
async function relay(t, options = {}) {
  const app = createRelay({ token, ...options }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  return { ...app, url: `http://127.0.0.1:${app.server.address().port}`, ws: `ws://127.0.0.1:${app.server.address().port}/ws` };
}
async function peer(url, join) {
  const ws = new WebSocket(url);
  const inbox = [], waiters = [];
  ws.on('message', raw => { const value = JSON.parse(raw); const index = waiters.findIndex(w => w.type === value.type); if (index >= 0) waiters.splice(index, 1)[0].resolve(value); else inbox.push(value); });
  ws.next = (type, timeoutMs = 3000) => {
    const index = inbox.findIndex(v => v.type === type);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve: value => { clearTimeout(timeout); resolve(value); } };
      const timeout = setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); reject(Error(`Timeout: ${type}`)); }, timeoutMs);
      waiters.push(waiter);
    });
  };
  ws.json = value => ws.send(JSON.stringify(value));
  await once(ws, 'open'); ws.json(join); return ws;
}

test('authenticated directional encryption interoperates with browser WebCrypto', async () => {
  const key = randomToken(), value = { text: 'hello π' };
  const encrypted = seal(key, value, 'host', 'state');
  assert.deepEqual(open(key, encrypted, 'host', 'state'), value);
  assert.throws(() => open(key, encrypted, 'client', 'command'));
  assert.throws(() => open(randomToken(), encrypted, 'host', 'state'));
  const imported = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), 'AES-GCM', false, ['decrypt', 'encrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(encrypted.iv, 'base64url'), additionalData: Buffer.from('pi-remote/v2/host/state') }, imported, Buffer.from(encrypted.data, 'base64url'));
  assert.deepEqual(JSON.parse(Buffer.from(plain).toString()), value);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('pi-remote/v2/client/command') }, imported, Buffer.from(JSON.stringify(value)));
  assert.deepEqual(open(key, { iv: Buffer.from(iv).toString('base64url'), data: Buffer.from(data).toString('base64url') }, 'client', 'command'), value);
});

test('public transcript omits thinking, images and tool arguments, and bounds text', () => {
  assert.deepEqual(publicMessage({ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'image', data: 'secret' }, { type: 'toolCall', name: 'bash', arguments: { secret: 'key' } }, { type: 'text', text: 'Hi' }] }), { role: 'assistant', text: '[Tool: bash]\nHi', timestamp: undefined, tool: undefined });
  assert.equal(publicMessage({ role: 'assistant', content: 'x'.repeat(13000) }).text.length, 4000);
  assert.equal(publicMessage({ role: 'custom', content: 'secret' }), null);
  assert.ok(validCommand({ id: '12345678', action: 'prompt', text: 'Hi' }));
  assert.ok(!validCommand({ id: '12345678', action: 'prompt', text: ' ' }));
  assert.ok(!validCommand({ id: '12345678', action: 'exec', text: 'Hi' }));
});

test('relay routes opaque state/commands, replays snapshots, isolates rooms, and revokes', async t => {
  const app = await relay(t), room = randomToken(), key = randomToken();
  const host = await peer(app.ws, { type: 'join', role: 'host', room, token }); await host.next('joined');
  const client = await peer(app.ws, { type: 'join', role: 'client', room }); assert.equal((await client.next('joined')).online, true);
  const state = seal(key, { revision: 1, text: 'secret repo content' }, 'host', 'state');
  host.json({ type: 'state', payload: state }); assert.deepEqual((await client.next('state')).payload, state);
  assert.ok(!JSON.stringify(app.rooms.get(room)).includes('secret repo content'));
  const second = await peer(app.ws, { type: 'join', role: 'client', room }); await second.next('joined'); assert.deepEqual((await second.next('state')).payload, state);
  const payload = seal(key, { id: '12345678', action: 'interrupt' }, 'client', 'command');
  client.json({ type: 'command', payload }); assert.deepEqual((await host.next('command')).payload, payload);
  const closed = once(host, 'close'); host.close(); await closed;
  assert.equal((await client.next('presence')).online, false);
  const reconnected = await peer(app.ws, { type: 'join', role: 'host', room, token }); await reconnected.next('joined');
  assert.equal((await client.next('presence')).online, true);
  const revoked = once(client, 'close'); reconnected.json({ type: 'leave' }); assert.equal((await revoked)[0], 1008);
  assert.equal(app.rooms.has(room), false);
});

test('relay rejects wrong host token and missing rooms; serves hardened UI', async t => {
  const app = await relay(t);
  const bad = await peer(app.ws, { type: 'join', role: 'host', room: randomToken(), token: randomToken() });
  assert.equal((await once(bad, 'close'))[0], 1008);
  const missing = await peer(app.ws, { type: 'join', role: 'client', room: randomToken() });
  assert.equal((await once(missing, 'close'))[0], 1008);
  const response = await fetch(app.url);
  assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(`${app.url}/../package.json`)).status, 404);
});

test('/remote integrates with session APIs: prompts, deduplication, busy rejection, interrupt, revoke', async t => {
  const app = await relay(t);
  const filename = new URL(`../extension/.test-${randomToken()}.mjs`, import.meta.url);
  await writeFile(filename, ts.transpileModule(await readFile(new URL('../extension/remote.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
  t.after(() => unlink(filename));
  const oldURL = process.env.PI_REMOTE_URL, oldToken = process.env.PI_REMOTE_TOKEN;
  process.env.PI_REMOTE_URL = app.url; process.env.PI_REMOTE_TOKEN = token;
  t.after(() => { if (oldURL === undefined) delete process.env.PI_REMOTE_URL; else process.env.PI_REMOTE_URL = oldURL; if (oldToken === undefined) delete process.env.PI_REMOTE_TOKEN; else process.env.PI_REMOTE_TOKEN = oldToken; });
  const events = new Map(), notices = [], prompts = [], starts = []; let handler, idle = true, interrupts = 0, failSubmission = false;
  const ctx = { cwd: '/tmp/project', isIdle: () => idle, hasPendingMessages: () => false, abort: () => interrupts++,
    ui: { setStatus() {}, notify: text => notices.push(text) }, sessionManager: { getSessionId: () => 'test-session', getBranch: () => [{ type: 'message', message: { role: 'user', content: 'Existing chat' } }] } };
  const pi = { registerCommand: (_name, command) => { handler = command.handler; }, on: (name, fn) => events.set(name, fn), getSessionName: () => undefined,
    sendUserMessage: (text, options) => {
      prompts.push({ text, options });
      const start = AsyncResource.bind(() => { idle = false; events.get('agent_start')({}, ctx); });
      starts.push(start);
      if (!failSubmission) setTimeout(start, 20);
    } };
  (await import(filename.href)).default(pi);
  t.after(() => events.get('session_shutdown')());
  await handler('', ctx);
  const link = new URL(notices.at(-1).split('\n').at(-1));
  const params = new URLSearchParams(link.hash.slice(1)), room = params.get('room'), key = params.get('key');
  // Wait for outbound host registration.
  for (let i = 0; !app.rooms.get(room)?.host && i < 100; i++) await new Promise(r => setTimeout(r, 10));
  const phone = await peer(app.ws, { type: 'join', role: 'client', room }); await phone.next('joined');
  const initial = open(key, (await phone.next('state')).payload, 'host', 'state');
  assert.equal(initial.messages[0].text, 'Existing chat');
  const cmd = { id: '12345678', action: 'prompt', text: 'Do work', createdAt: Date.now() };
  phone.json({ type: 'command', payload: seal(key, cmd, 'client', 'command') }); assert.equal(open(key, (await phone.next('ack')).payload, 'host', 'ack').ok, true);
  phone.json({ type: 'command', payload: seal(key, cmd, 'client', 'command') }); await phone.next('ack'); assert.equal(prompts.length, 1);
  assert.deepEqual(prompts[0].options, { expandPromptTemplates: false });
  phone.json({ type: 'command', payload: seal(key, { ...cmd, id: '22345678' }, 'client', 'command') });
  assert.match(open(key, (await phone.next('ack')).payload, 'host', 'ack').error, /busy/);
  phone.json({ type: 'command', payload: seal(key, { ...cmd, id: '32345678', action: 'interrupt' }, 'client', 'command') }); await phone.next('ack'); assert.equal(interrupts, 1);
  idle = true; events.get('agent_end')({}, ctx);
  phone.json({ type: 'command', payload: seal(key, { ...cmd, id: '42345678', createdAt: 0 }, 'client', 'command') }); assert.match(open(key, (await phone.next('ack')).payload, 'host', 'ack').error, /expired/);
  // Simulate Pi swallowing an asynchronous preflight failure: no agent events.
  failSubmission = true;
  phone.json({ type: 'command', payload: seal(key, { ...cmd, id: '52345678', createdAt: Date.now() }, 'client', 'command') });
  const failed = open(key, (await phone.next('ack', 20000)).payload, 'host', 'ack');
  assert.equal(failed.ok, false); assert.match(failed.error, /unknown/);
  // Deduplication retains this outcome; no retry can execute the same ID again.
  phone.json({ type: 'command', payload: seal(key, { ...cmd, id: '52345678', createdAt: Date.now() }, 'client', 'command') });
  assert.deepEqual(open(key, (await phone.next('ack')).payload, 'host', 'ack'), failed);
  // Unknown submissions stay locked: a late start must not acknowledge a new ID.
  phone.json({ type: 'command', payload: seal(key, { ...cmd, id: '72345678', createdAt: Date.now() }, 'client', 'command') });
  assert.match(open(key, (await phone.next('ack')).payload, 'host', 'ack').error, /busy/);
  starts.at(-1)();
  const late = open(key, (await phone.next('ack')).payload, 'host', 'ack');
  assert.equal(late.id, '52345678'); assert.equal(late.ok, true); assert.equal(late.error, undefined);
  idle = true; events.get('agent_end')({}, ctx);
  failSubmission = false;
  phone.json({ type: 'command', payload: seal(key, { ...cmd, id: '62345678', createdAt: Date.now() }, 'client', 'command') });
  assert.equal(open(key, (await phone.next('ack')).payload, 'host', 'ack').ok, true);
  const close = once(phone, 'close'); await handler('off', ctx); assert.equal((await close)[0], 1008);
});

test('snapshot byte budget includes JSON escaping and encryption overhead', async t => {
  const app = await relay(t), room = randomToken(), key = randomToken();
  const host = await peer(app.ws, { type: 'join', role: 'host', room, token }); await host.next('joined');
  const client = await peer(app.ws, { type: 'join', role: 'client', room }); await client.next('joined');
  const original = { revision: 1, messages: Array.from({ length: 40 }, (_, i) =>
    publicMessage({ role: 'toolResult', content: '\u0000'.repeat(3990) + String(i) })) };
  const bounded = boundSnapshot(original);
  assert.equal(original.messages.length, 40);
  assert.ok(bounded.messages.length < 40);
  assert.deepEqual(bounded.messages.at(-1), original.messages.at(-1));
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= MAX_SNAPSHOT_BYTES);
  const packet = { type: 'state', payload: seal(key, bounded, 'host', 'state') };
  assert.ok(Buffer.byteLength(JSON.stringify(packet)) < 1_000_000);
  host.json(packet);
  assert.deepEqual(open(key, (await client.next('state')).payload, 'host', 'state'), JSON.parse(JSON.stringify(bounded)));
});

test('late prompt acknowledgement does not overwrite an idle snapshot', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', scrollHeight: 0, scrollTop: 0,
      clientHeight: 0, querySelectorAll: () => [], replaceChildren() {} });
    return elements.get(id);
  };
  class BrowserSocket { static OPEN = 1; send() {} }
  const context = vm.createContext({ document: { getElementById: element,
    createDocumentFragment: () => ({ append() {} }), createElement: () => ({ append() {} }) },
    TextEncoder, TextDecoder, WebSocket: BrowserSocket, location: { hash: '', protocol: 'https:', host: 'relay.test' },
    addEventListener() {}, setInterval() {}, crypto: {} });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext("open = async value => value; credentials = {room:'test'}; connect(generation); pending.set('command1', {action:'prompt',text:'work'});", context);
  const receive = async packet => {
    context.packet = packet;
    vm.runInContext('socket.onmessage({data: JSON.stringify(packet)})', context);
    await new Promise(resolve => setImmediate(resolve));
  };
  await receive({ type: 'joined', online: true });
  await receive({ type: 'state', payload: { revision: 2, busy: false, submitting: false, name: 'test', tools: [], messages: [] } });
  await receive({ type: 'ack', payload: { id: 'command1', ok: true } });
  assert.equal(element('send').disabled, false);
  assert.equal(element('status').textContent, 'Connected · ready');
});

test('unauthenticated admission quota reserves capacity and releases after join', async t => {
  const app = await relay(t, { maxUnauthenticated: 1, maxUnauthenticatedPerIP: 1 });
  const idle = new WebSocket(app.ws); idle.on('error', () => {}); await once(idle, 'open');
  const rejected = new WebSocket(app.ws); rejected.on('error', () => {});
  await new Promise(resolve => rejected.once('close', resolve));
  const joined = once(idle, 'message'); idle.send(JSON.stringify({ type: 'join', role: 'host', room: randomToken(), token }));
  assert.equal(JSON.parse((await joined)[0]).type, 'joined');
  const second = await peer(app.ws, { type: 'join', role: 'host', room: randomToken(), token });
  assert.equal((await second.next('joined')).type, 'joined');
});

test('upgrade rate limits apply even after authenticated connections close', async t => {
  const app = await relay(t, { maxUpgradesPerMinute: 1 });
  const first = await peer(app.ws, { type: 'join', role: 'host', room: randomToken(), token }); await first.next('joined');
  const closed = once(first, 'close'); first.close(); await closed;
  const rejected = new WebSocket(app.ws); rejected.on('error', () => {});
  await new Promise(resolve => rejected.once('close', resolve));
});

test('per-peer pending quota cannot be bypassed with forwarded IP headers', async t => {
  const app = await relay(t, { maxUnauthenticated: 4, maxUnauthenticatedPerIP: 1 });
  const idle = new WebSocket(app.ws); idle.on('error', () => {}); await once(idle, 'open');
  const rejected = new WebSocket(app.ws, { headers: { 'X-Forwarded-For': '192.0.2.1' } });
  rejected.on('error', () => {});
  await new Promise(resolve => rejected.once('close', resolve));
  const closed = once(idle, 'close'); idle.terminate(); await closed;
  // Give the server its close event before reconnecting.
  await new Promise(resolve => setTimeout(resolve, 20));
  const host = await peer(app.ws, { type: 'join', role: 'host', room: randomToken(), token });
  assert.equal((await host.next('joined')).type, 'joined');
});

test('trusted proxy admission isolates client quotas and rejects malformed identities', async t => {
  const app = await relay(t, { trustedProxies: ['127.0.0.1'], maxUpgradesPerMinute: 1 });
  async function proxyPeer(ip) {
    const ws = new WebSocket(app.ws, { headers: { 'X-Real-IP': ip } });
    ws.on('error', () => {});
    return ws;
  }
  const attacker = await proxyPeer('192.0.2.1'); await once(attacker, 'open');
  attacker.send('{}'); await once(attacker, 'close');
  const blocked = await proxyPeer('192.0.2.1'); await new Promise(resolve => blocked.once('close', resolve));
  const legitimate = await proxyPeer('192.0.2.2'); await once(legitimate, 'open');
  const joined = once(legitimate, 'message');
  legitimate.send(JSON.stringify({ type: 'join', role: 'host', room: randomToken(), token }));
  assert.equal(JSON.parse((await joined)[0]).type, 'joined');
  const missing = new WebSocket(app.ws); missing.on('error', () => {});
  let missingOpened = false; missing.on('open', () => { missingOpened = true; });
  await new Promise(resolve => missing.once('close', resolve)); assert.equal(missingOpened, false);
  for (const ip of ['', '192.0.2.3, 192.0.2.4', 'not-an-ip']) {
    const invalid = await proxyPeer(ip); let opened = false;
    invalid.on('open', () => { opened = true; });
    await new Promise(resolve => invalid.once('close', resolve)); assert.equal(opened, false);
  }
});

test('untrusted peers cannot bypass admission using X-Real-IP', async t => {
  const app = await relay(t, { maxUpgradesPerMinute: 1 });
  const first = new WebSocket(app.ws, { headers: { 'X-Real-IP': '192.0.2.1' } });
  await once(first, 'open'); first.send('{}'); await once(first, 'close');
  const second = new WebSocket(app.ws, { headers: { 'X-Real-IP': '192.0.2.2' } });
  second.on('error', () => {}); let opened = false;
  second.on('open', () => { opened = true; });
  await new Promise(resolve => second.once('close', resolve)); assert.equal(opened, false);
});

test('snapshot publication bounds metadata and contains timer callback failures', async () => {
  let handler, callback; const events = new Map(), statuses = [], sent = [];
  let failSend = false;
  class HostSocket {
    static OPEN = 1; readyState = 1;
    on() {} send(packet) { if (failSend) throw Error('Transport failed'); sent.push(JSON.parse(packet)); }
  }
  const ctx = { cwd: '/tmp', isIdle: () => true,
    sessionManager: { getSessionId: () => 's'.repeat(700000), getBranch: () => [] },
    ui: { notify() {}, setStatus: (_name, text) => statuses.push(text) } };
  const pi = { registerCommand: (_name, command) => { handler = command.handler; },
    on: (name, fn) => events.set(name, fn), getSessionName: () => '\u0000'.repeat(700000) };
  const source = ts.transpileModule(await readFile(new URL('../extension/remote.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/^import .*;\n/gm, '').replace('export default function', 'function');
  const context = vm.createContext({ pi, WebSocket: HostSocket, AsyncLocalStorage, AbortController, URL, Buffer, join,
    getAgentDir: () => '/unused-pi-remote-test', process: { env: { PI_REMOTE_URL: 'http://localhost:8787', PI_REMOTE_TOKEN: token } },
    randomToken, seal, open, publicMessage, validCommand, boundSnapshot, normalizeRelayURL, readConfig, saveConfig, resolveConfig, pairingMessage,
    setTimeout: fn => { callback = fn; return 1; }, clearTimeout() {} });
  vm.runInContext(`${source}\nremoteExtension(pi);`, context);
  await handler('', ctx);
  for (let i = 0; i < 120; i++) events.get('tool_execution_start')({ toolCallId: String(i), toolName: 't'.repeat(10000) });
  assert.doesNotThrow(() => callback());
  // Inspect the plaintext supplied to encryption rather than needing the generated pairing key.
  context.seal = (_key, value) => value;
  events.get('agent_start')({}, ctx); callback();
  const state = sent.at(-1).payload;
  assert.equal(state.name.length, 256); assert.equal(state.session.length, 256);
  assert.equal(state.tools.length, 100); assert.equal(state.tools[0].length, 128);
  failSend = true;
  events.get('agent_start')({}, ctx); assert.doesNotThrow(() => callback());
  assert.match(statuses.at(-1), /snapshot failed/);
});

test('browser ignores queued and decrypting messages from closed or replaced sockets', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', querySelectorAll: () => [], replaceChildren() {} });
    return elements.get(id);
  };
  class BrowserSocket { static OPEN = 1; send() {} }
  const context = vm.createContext({ document: { getElementById: element }, TextEncoder, TextDecoder,
    WebSocket: BrowserSocket, location: { hash: '', protocol: 'https:', host: 'relay.test' },
    addEventListener() {}, setInterval() {}, setTimeout() {}, crypto: {} });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext(`credentials = {room:'test'}; connect(generation);
    socket.onmessage({data: JSON.stringify({type:'joined',online:true})}); socket.onclose({code:1006});`, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('connected || online', context), false);
  vm.runInContext(`connect(generation); open = () => new Promise(resolve => { globalThis.finishDecrypt = resolve; });
    socket.onmessage({data: JSON.stringify({type:'state',payload:{}})});`, context);
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext(`socket.onclose({code:1006}); finishDecrypt({revision:99});`, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('revision', context), -1);
  vm.runInContext(`connect(generation); const old = socket;
    old.onmessage({data: JSON.stringify({type:'joined',online:true})}); connect(generation); old.onclose({code:1006});`, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(vm.runInContext('connected || online', context), false);
});

test('full client rooms are retryable and accept reconnects once a stale slot is freed', async t => {
  const app = await relay(t), room = randomToken();
  const host = await peer(app.ws, { type: 'join', role: 'host', room, token }); await host.next('joined');
  const clients = [];
  for (let i = 0; i < 4; i++) {
    const ws = await peer(app.ws, { type: 'join', role: 'client', room }); await ws.next('joined'); clients.push(ws);
  }
  const full = await peer(app.ws, { type: 'join', role: 'client', room });
  assert.equal((await once(full, 'close'))[0], 1013);
  assert.equal(app.rooms.get(room).clients.size, 4);
  const oldServerPeer = [...app.rooms.get(room).clients][0];
  const closed = once(oldServerPeer, 'close'); clients[0].close(); await closed;
  const reconnect = await peer(app.ws, { type: 'join', role: 'client', room });
  assert.equal((await reconnect.next('joined')).online, true);
  assert.equal(app.rooms.get(room).clients.size, 4);
  assert.equal(host.readyState, WebSocket.OPEN);
});

test('room capacity is retryable for authenticated hosts, without weakening authentication', async t => {
  const app = await relay(t, { maxRooms: 1 }), room = randomToken(), other = randomToken();
  const host = await peer(app.ws, { type: 'join', role: 'host', room, token }); await host.next('joined');
  const bad = await peer(app.ws, { type: 'join', role: 'host', room: other, token: randomToken() });
  assert.equal((await once(bad, 'close'))[0], 1008);
  const full = await peer(app.ws, { type: 'join', role: 'host', room: other, token });
  assert.equal((await once(full, 'close'))[0], 1013);
  assert.equal(app.rooms.size, 1); assert.equal(app.rooms.has(other), false);

  // An existing room can reconnect even while the allocation quota is full.
  const oldServerHost = app.rooms.get(room).host;
  const closed = once(oldServerHost, 'close'); host.close(); await closed;
  const existing = await peer(app.ws, { type: 'join', role: 'host', room, token }); await existing.next('joined');
  const revoked = once(existing, 'close'); existing.json({ type: 'leave' }); await revoked;
  const retry = await peer(app.ws, { type: 'join', role: 'host', room: other, token });
  assert.equal((await retry.next('joined')).online, true);
  assert.equal(app.rooms.size, 1); assert.equal(app.rooms.has(other), true);
});
