import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import WebSocket from 'ws';
import { createRelay } from '../src/server.js';
import { randomToken, seal, open } from '../src/crypto.js';
import { publicMessage, validCommand, boundSnapshot } from '../src/protocol.js';

async function extension(t, branch = []) {
  const timers = new Map(), sockets = [], events = new Map(), notices = [], statuses = [], prompts = [], starts = [];
  let nextTimer = 0, handler, idle = true, interrupts = 0;
  const clock = {
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    count(ms) { return [...timers.values()].filter(timer => timer.ms === ms).length; },
    run(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `Expected a ${ms}ms timer`);
      timers.delete(entry[0]); entry[1].fn();
    },
  };
  class HostSocket {
    static OPEN = 1;
    readyState = 1; bufferedAmount = 0; sent = []; listeners = new Map(); terminated = false;
    constructor() { sockets.push(this); }
    on(name, fn) { this.listeners.set(name, fn); }
    emit(name, ...args) { this.listeners.get(name)?.(...args); }
    send(packet) { this.bufferedAmount += Buffer.byteLength(packet); this.sent.push(JSON.parse(packet)); }
    finish(code) { this.readyState = 3; this.emit('close', code); }
    close() { this.finish(1000); }
    terminate() { this.terminated = true; this.finish(1006); }
  }
  const ctx = { cwd: '/tmp/project', isIdle: () => idle, hasPendingMessages: () => false, abort: () => interrupts++,
    sessionManager: { getSessionId: () => 'test', getBranch: () => branch },
    ui: { setStatus: (_name, text) => statuses.push(text), notify: text => notices.push(text) } };
  const pi = { registerCommand: (_name, command) => { handler = command.handler; }, on: (name, fn) => events.set(name, fn),
    getSessionName: () => 'test', sendUserMessage: text => {
      prompts.push(text);
      // Like Pi's awaited prompt/preflight chain, preserve the invocation context
      // when a test completes this particular remote submission later.
      starts.push(AsyncResource.bind(() => { idle = false; events.get('agent_start')({}, ctx); }));
    } };
  const source = ts.transpileModule(await readFile(new URL('../extension/remote.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/^import .*;\n/gm, '').replace('export default function', 'function');
  const context = vm.createContext({ pi, WebSocket: HostSocket, AsyncLocalStorage, URL, Buffer, process: { env: { PI_REMOTE_TOKEN: randomToken() } },
    randomToken, seal, open, publicMessage, validCommand, boundSnapshot,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  vm.runInContext(`${source}\nremoteExtension(pi);`, context);
  await handler('', ctx);
  t.after(() => events.get('session_shutdown')());
  const link = new URL(notices.at(-1).split('\n').at(-1));
  const key = new URLSearchParams(link.hash.slice(1)).get('key');
  const join = ws => { ws.emit('open'); ws.emit('message', JSON.stringify({ type: 'joined' })); };
  join(sockets[0]);
  const send = (command, ws = sockets.at(-1)) => ws.emit('message', JSON.stringify({ type: 'command',
    payload: seal(key, { ...command, createdAt: Date.now() }, 'client', 'command') }));
  const acks = (ws = sockets.at(-1)) => ws.sent.filter(packet => packet.type === 'ack').map(packet => open(key, packet.payload, 'host', 'ack'));
  return { clock, sockets, events, notices, statuses, prompts, ctx, key, handler, join, send, acks,
    startSubmission(index = starts.length - 1) { starts[index](); },
    setIdle(value) { idle = value; }, get interrupts() { return interrupts; } };
}

test('extension bounds stalled outbound buffering and republishes only latest state after reconnect', async t => {
  const h = await extension(t, Array.from({ length: 40 }, () => ({ type: 'message', message: { role: 'user', content: '\0'.repeat(4000) } })));
  const first = h.sockets[0];
  h.clock.run(150);
  for (let i = 0; i < 100; i++) {
    h.events.get('message_update')({ message: { role: 'assistant', content: `latest ${i}` } });
    h.clock.run(150);
  }
  assert.ok(first.terminated);
  assert.ok(first.bufferedAmount <= 2_000_000);
  assert.ok(first.sent.filter(packet => packet.type === 'state').length < 4);
  h.clock.run(1000);
  const second = h.sockets[1]; h.join(second); h.clock.run(150);
  const state = open(h.key, second.sent.find(packet => packet.type === 'state').payload, 'host', 'state');
  assert.equal(state.messages.at(-1).text, 'latest 99');
});

test('ack lost to backpressure is recovered after reconnect without re-executing command', async t => {
  const h = await extension(t); h.clock.run(150); h.setIdle(false);
  const first = h.sockets[0]; first.bufferedAmount = 1_999_999;
  const command = { id: '12345678', action: 'interrupt' };
  h.send(command);
  assert.ok(first.terminated); assert.equal(h.interrupts, 1);
  h.clock.run(1000); h.join(h.sockets[1]); h.send(command);
  assert.equal(h.acks().at(-1).ok, true); assert.equal(h.interrupts, 1);
});

test('relay heartbeat watchdog terminates silent connections, resets on ping, and is cleaned up', async t => {
  const h = await extension(t);
  assert.equal(h.clock.count(45000), 1);
  h.sockets[0].emit('ping'); assert.equal(h.clock.count(45000), 1);
  h.clock.run(45000);
  assert.ok(h.sockets[0].terminated); assert.equal(h.clock.count(1000), 1);
  h.clock.run(1000); h.join(h.sockets[1]);
  await h.handler('off', h.ctx);
  assert.equal(h.clock.count(45000), 0); assert.equal(h.clock.count(1000), 0);
});

test('extension retries transient host conflict without changing pairing, but stops on policy rejection', async t => {
  const h = await extension(t);
  const originalLink = h.notices.at(-1);
  h.sockets[0].finish(1013); h.clock.run(1000);
  h.sockets[1].emit('open'); h.sockets[1].finish(1013); h.clock.run(2000);
  h.join(h.sockets[2]);
  await h.handler('', h.ctx);
  assert.equal(h.notices.at(-1).split('\n').at(-1), originalLink.split('\n').at(-1));
  const joins = h.sockets.flatMap(ws => ws.sent.filter(packet => packet.type === 'join'));
  assert.equal(new Set(joins.map(packet => packet.room)).size, 1);
  h.sockets[2].finish(1008);
  assert.match(h.notices.at(-1), /rejected/); assert.equal(h.clock.count(1000), 0);
});

test('duplicate authenticated host gets retryable close; authentication failures remain permanent', async t => {
  const token = randomToken(), room = randomToken(), app = createRelay({ token });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.server.address().port}/ws`;
  async function host(auth) {
    const ws = new WebSocket(url); await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'join', role: 'host', room, token: auth })); return ws;
  }
  const first = await host(token); await once(first, 'message'); const oldRoom = app.rooms.get(room);
  const bad = await host(randomToken()); assert.equal((await once(bad, 'close'))[0], 1008);
  const duplicate = await host(token); assert.equal((await once(duplicate, 'close'))[0], 1013);
  assert.equal(oldRoom.host.readyState, WebSocket.OPEN);
  const closed = once(first, 'close'); first.close(); await closed;
  // Allow server-side close processing before retrying the same room.
  const rejoined = await host(token); assert.equal(JSON.parse((await once(rejoined, 'message'))[0]).type, 'joined');
  assert.equal(app.rooms.get(room), oldRoom);
});

test('preflight interrupts are rejected, including after unknown-outcome timeout; running turns can be interrupted', async t => {
  const h = await extension(t); h.clock.run(150);
  h.send({ id: '12345678', action: 'prompt', text: 'work' }); h.clock.run(150);
  let state = open(h.key, h.sockets[0].sent.at(-1).payload, 'host', 'state');
  assert.equal(state.submitting, true);
  h.send({ id: '22345678', action: 'interrupt' });
  assert.equal(h.acks().at(-1).ok, false); assert.match(h.acks().at(-1).error, /cannot be cancelled/);
  assert.equal(h.interrupts, 0);
  h.clock.run(15000);
  h.send({ id: '32345678', action: 'interrupt' });
  assert.equal(h.acks().at(-1).ok, false); assert.equal(h.interrupts, 0);
  h.send({ id: '12345678', action: 'prompt', text: 'work' });
  assert.match(h.acks().at(-1).error, /unknown/); assert.equal(h.prompts.length, 1);
  h.send({ id: '42345678', action: 'prompt', text: 'other work' });
  assert.match(h.acks().at(-1).error, /busy/); assert.equal(h.prompts.length, 1);
  h.startSubmission(); h.clock.run(150);
  state = open(h.key, h.sockets[0].sent.at(-1).payload, 'host', 'state');
  assert.equal(state.submitting, false);
  const late = h.acks().findLast(ack => ack.id === '12345678');
  assert.equal(late.ok, true); assert.equal(late.error, undefined);
  h.send({ id: '52345678', action: 'interrupt' });
  assert.equal(h.acks().at(-1).ok, true); assert.equal(h.interrupts, 1);
  h.setIdle(true); h.events.get('agent_end')({}, h.ctx);
  h.send({ id: '62345678', action: 'interrupt' });
  assert.equal(h.acks().at(-1).ok, false);
});

test('unrelated local turns never acknowledge a pending or timed-out remote prompt', async t => {
  const h = await extension(t); h.clock.run(150);
  const command = { id: '12345678', action: 'prompt', text: 'work' };
  h.send(command);
  h.setIdle(false); h.events.get('agent_start')({}, h.ctx);
  // Matching text is not evidence of acceptance either: this is a local turn.
  h.events.get('message_start')({ message: { role: 'user', content: command.text } }, h.ctx);
  assert.equal(h.acks().length, 0);
  assert.equal(h.clock.count(15000), 1);
  h.clock.run(150);
  assert.equal(open(h.key, h.sockets[0].sent.at(-1).payload, 'host', 'state').submitting, true);

  h.clock.run(15000);
  const unknown = h.acks().at(-1);
  assert.equal(unknown.ok, false); assert.match(unknown.error, /unknown/);
  h.events.get('agent_start')({}, h.ctx);
  assert.equal(h.acks().length, 1);
  h.setIdle(true); h.events.get('agent_settled')({}, h.ctx);
  h.send(command);
  assert.deepEqual(h.acks().at(-1), unknown);
  assert.equal(h.prompts.length, 1);

  // Only the original invocation's delayed turn can confirm this command.
  h.startSubmission();
  assert.equal(h.acks().at(-1).id, command.id);
  assert.equal(h.acks().at(-1).ok, true);
  assert.equal(h.acks().at(-1).error, undefined);
  h.send(command);
  assert.equal(h.acks().at(-1).ok, true); assert.equal(h.prompts.length, 1);
});

test('late turns from a revoked pairing cannot acknowledge a new submission with the same ID', async t => {
  const h = await extension(t);
  const command = { id: '12345678', action: 'prompt', text: 'work' };
  h.send(command);
  await h.handler('off', h.ctx);
  await h.handler('on', h.ctx);
  const key = new URLSearchParams(new URL(h.notices.at(-1).split('\n').at(-1)).hash.slice(1)).get('key');
  assert.notEqual(key, h.key);
  const ws = h.sockets.at(-1); h.join(ws);
  ws.emit('message', JSON.stringify({ type: 'command', payload: seal(key, { ...command, createdAt: Date.now() }, 'client', 'command') }));
  h.startSubmission(0);
  assert.equal(ws.sent.filter(packet => packet.type === 'ack').length, 0);
  assert.equal(h.clock.count(15000), 1);
  h.setIdle(true); h.events.get('agent_settled')({}, h.ctx);
  h.startSubmission(1);
  const ack = open(key, ws.sent.find(packet => packet.type === 'ack').payload, 'host', 'ack');
  assert.equal(ack.id, command.id); assert.equal(ack.ok, true);
  assert.equal(h.clock.count(15000), 0);
});

async function browser({ importKey = (...args) => crypto.subtle.importKey(...args) } = {}) {
  const elements = new Map(), listeners = new Map(), sockets = [], timers = new Map();
  let nextTimer = 0;
  const location = { hash: '', href: 'https://relay.test/', origin: 'https://relay.test', protocol: 'https:', host: 'relay.test' };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', scrollHeight: 0, scrollTop: 0, clientHeight: 0,
      querySelectorAll: () => [], replaceChildren() {} });
    return elements.get(id);
  };
  class BrowserSocket {
    static OPEN = 1; readyState = 1; sent = [];
    constructor() { sockets.push(this); }
    send(packet) { this.sent.push(JSON.parse(packet)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const key = randomToken(), cryptoKey = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  let decryptFinished;
  const context = vm.createContext({ document: { getElementById: element, createDocumentFragment: () => ({ append() {} }), createElement: () => ({ append() {} }) },
    TextEncoder, TextDecoder, atob, btoa, WebSocket: BrowserSocket, importedKey: cryptoKey, URL, URLSearchParams,
    crypto: { getRandomValues: array => crypto.getRandomValues(array), subtle: {
      importKey, encrypt: (...args) => crypto.subtle.encrypt(...args),
      decrypt: async (...args) => { try { return await crypto.subtle.decrypt(...args); } finally { decryptFinished?.(); } },
    } }, location, history: { replaceState(_state, _title, path) {
      const url = new URL(path, location.href); location.href = url.href; location.hash = url.hash;
    } }, addEventListener: (type, fn) => listeners.set(type, fn),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {} });
  vm.runInContext(await readFile(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  vm.runInContext("cryptoKey=importedKey; credentials={room:'test'}; connect(generation); connected=true; online=true;", context);
  async function receive(type, value, encryptedType = type) {
    context.packet = { type, payload: seal(key, value, 'host', encryptedType) };
    const done = new Promise(resolve => { decryptFinished = resolve; });
    vm.runInContext('socket.onmessage({data:JSON.stringify(packet)})', context);
    await done; await new Promise(resolve => setImmediate(resolve));
  }
  return { context, element, key, receive, sockets, timers, location,
    navigate(link) { const url = new URL(link); location.href = url.href; location.hash = url.hash; return listeners.get('hashchange')(); },
    eval: expression => vm.runInContext(expression, context) };
}
const snapshot = (revision, overrides = {}) => ({ revision, busy: true, submitting: false, name: 'current', tools: [], messages: [], ...overrides });

test('browser and Node authenticate both direction and type, rejecting relabelled ACKs and legacy ciphertext', async () => {
  const h = await browser();
  await h.receive('state', snapshot(10));
  await h.receive('state', { id: '12345678', ok: true }, 'ack');
  assert.equal(h.eval('revision'), 10); assert.equal(h.eval('busy'), true);
  await h.receive('state', snapshot(1, { name: 'old snapshot', busy: false }));
  assert.equal(h.eval('revision'), 10); assert.equal(h.element('session').textContent, 'current');
  await h.receive('ack', { id: '12345678', ok: true });
  const encrypted = await h.eval("seal({id:'12345678',action:'interrupt'})");
  assert.equal(open(h.key, encrypted, 'client', 'command').action, 'interrupt');
  const ack = seal(h.key, { id: '12345678', ok: true }, 'host', 'ack');
  assert.throws(() => open(h.key, ack, 'host', 'state'));
  assert.throws(() => open(h.key, ack, 'client', 'command'));
  assert.throws(() => seal(h.key, {}, 'host')); // No unauthenticated/default type.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', Buffer.from(h.key, 'base64url'), 'AES-GCM', false, ['encrypt']);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from('pi-remote/v1/host') }, key, Buffer.from(JSON.stringify(snapshot(20))));
  const legacy = { iv: Buffer.from(iv).toString('base64url'), data: Buffer.from(data).toString('base64url') };
  assert.throws(() => open(h.key, legacy, 'host', 'state'));
  h.context.legacy = legacy;
  await assert.rejects(h.eval("open(legacy, 'state')"));
});

test('browser rejects malformed authenticated snapshots without changing revision or controls', async () => {
  const h = await browser(); await h.receive('state', snapshot(10));
  const invalid = [
    { id: '12345678', ok: true }, snapshot(NaN), snapshot(11, { busy: undefined }),
    snapshot(11, { submitting: 'yes' }), snapshot(11, { tools: [null] }),
    snapshot(11, { messages: [{ role: 'assistant', text: {} }] }),
    snapshot(11, { messages: Array(41).fill({ role: 'user', text: 'x' }) }),
  ];
  for (const state of invalid) {
    await h.receive('state', state);
    assert.equal(h.eval('revision'), 10); assert.equal(h.eval('busy'), true);
  }
  h.eval("pending.set('12345678',{action:'interrupt'})");
  await h.receive('ack', { id: '12345678', ok: 'true' });
  assert.equal(h.eval('pending.size'), 1);
  await h.receive('ack', { id: '12345678', ok: true });
  assert.equal(h.eval('pending.size'), 0);
});

test('browser disables preflight interrupts, then enables them on an authoritative running snapshot', async () => {
  const h = await browser();
  await h.receive('state', snapshot(1, { busy: false }));
  h.eval("pending.set('12345678',{action:'prompt'}); controls()");
  assert.equal(h.element('interrupt').disabled, true);
  await h.receive('state', snapshot(2, { submitting: true }));
  assert.equal(h.element('interrupt').disabled, true); assert.match(h.element('status').textContent, /Submitting/);
  await h.receive('state', snapshot(3));
  assert.equal(h.element('interrupt').disabled, false); // Prompt ACK may be lost, but the turn has started.
});

test('revocation still cleans up the connection and timers when sending leave fails', async t => {
  const h = await extension(t);
  const first = h.sockets[0]; first.send = () => { throw Error('Transport failed'); };
  await assert.doesNotReject(h.handler('off', h.ctx));
  assert.ok(first.terminated);
  assert.equal(h.clock.count(45000), 0); assert.equal(h.clock.count(1000), 0);
  first.emit('error');
  assert.equal(h.statuses.at(-1), undefined); // Stale sockets cannot re-enable the status.
});

test('same-document pairing strips the fragment and replaces the old room and key', async () => {
  const h = await browser();
  const old = h.sockets[0], room = randomToken(), key = randomToken();
  h.eval("pending.set('12345678', {action:'prompt', text:'old work'})");
  const paired = h.navigate(`${h.location.origin}/#room=${room}&key=${key}`);
  assert.equal(h.location.hash, ''); assert.equal(h.location.href, `${h.location.origin}/`);
  assert.equal(old.readyState, 3); assert.equal(h.eval('connected || online'), false);
  assert.equal(h.eval('pending.size'), 0);
  await paired;
  assert.equal(h.eval('credentials.room'), room);
  const current = h.sockets.at(-1); assert.notEqual(current, old);
  current.onopen(); assert.equal(current.sent[0].room, room);
  const encrypted = await h.eval("seal({id:'87654321', action:'interrupt'})");
  assert.equal(open(key, encrypted, 'client', 'command').id, '87654321');
  assert.throws(() => open(h.key, encrypted, 'client', 'command'));
});

test('newer pairing and disconnect invalidate in-flight key imports', async () => {
  const imports = [];
  const h = await browser({ importKey: (...args) => new Promise((resolve, reject) => imports.push({ args, resolve, reject })) });
  const link = () => `${h.location.origin}/#room=${randomToken()}&key=${randomToken()}`;
  const first = h.navigate(link()), secondLink = link(), second = h.navigate(secondLink);
  assert.equal(h.location.hash, ''); assert.equal(h.sockets[0].readyState, 3);
  imports[1].resolve(await crypto.subtle.importKey(...imports[1].args)); await second;
  const current = h.sockets.at(-1);
  imports[0].resolve(await crypto.subtle.importKey(...imports[0].args)); await first;
  assert.equal(h.eval('credentials.room'), new URLSearchParams(new URL(secondLink).hash.slice(1)).get('room'));
  assert.equal(h.sockets.at(-1), current); assert.equal(current.readyState, 1);

  const third = h.navigate(link());
  h.eval('disconnect()');
  imports[2].resolve(await crypto.subtle.importKey(...imports[2].args)); await third;
  assert.equal(h.eval('credentials'), undefined); assert.equal(h.eval('socket'), undefined);
  assert.equal(h.element('workspace').hidden, true);
});

test('failed stale imports cannot overwrite a newer pairing notice; invalid fragments are scrubbed', async () => {
  const imports = [];
  const h = await browser({ importKey: (...args) => new Promise((resolve, reject) => imports.push({ args, resolve, reject })) });
  const link = () => `${h.location.origin}/#room=${randomToken()}&key=${randomToken()}`;
  const first = h.navigate(link()), second = h.navigate(link());
  imports[1].resolve(await crypto.subtle.importKey(...imports[1].args)); await second;
  imports[0].reject(Error('Stale pairing failed')); await first;
  assert.match(h.element('notice').textContent, /Encrypted connection/);
  await h.navigate(`${h.location.origin}/#room=invalid&key=private-secret`);
  assert.equal(h.location.hash, ''); assert.equal(h.location.href, `${h.location.origin}/`);
  assert.equal(h.eval('credentials'), undefined); assert.equal(h.eval('socket'), undefined);
  assert.match(h.element('notice').textContent, /Invalid pairing link/);
});

test('browser retries temporary capacity rejection but stops on permanent revocation', async () => {
  const h = await browser(), first = h.sockets[0];
  h.eval("pending.set('12345678', {id:'12345678', action:'prompt', text:'work'})");
  first.onclose({ code: 1013 });
  assert.equal(h.eval('connected || online'), false);
  assert.equal(h.eval('pending.size'), 1); assert.equal(h.timers.size, 1);
  const [id, timer] = [...h.timers][0]; assert.equal(timer.ms, 1000);
  h.timers.delete(id); timer.fn();
  const second = h.sockets.at(-1); assert.notEqual(second, first);
  second.onopen(); assert.equal(second.sent[0].room, 'test');
  second.onclose({ code: 1008 });
  assert.equal(h.timers.size, 0); assert.match(h.element('notice').textContent, /revoked/);
});
