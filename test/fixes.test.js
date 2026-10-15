import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import WebSocket from 'ws';
import { createRelay } from '../src/server.js';
import { randomToken, seal, open } from '../src/crypto.js';
import { publicMessage, validCommand, boundSnapshot, toolCallDetails } from '../src/protocol.js';
import { normalizeRelayURL, readConfig, saveConfig, resolveConfig } from '../src/config.js';
import { pairingMessage } from '../src/pairing.js';
import { fetchWeeklyUsage, unavailableUsage } from '../src/usage.js';

async function extension(t, branch = [], trustRelay = false, options = {}) {
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
  const ctx = { model: options.model, cwd: '/tmp/project', isIdle: () => idle, hasPendingMessages: () => false, abort: () => interrupts++,
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
  const context = vm.createContext({ pi, WebSocket: HostSocket, AsyncLocalStorage, AbortController, URL, Buffer, join: pathJoin,
    getAgentDir: () => '/unused-pi-remote-test', process: { env: { PI_REMOTE_URL: 'http://localhost:8787', PI_REMOTE_TOKEN: randomToken(), PI_REMOTE_TRUST_RELAY: String(trustRelay) } },
    randomToken, seal, open, publicMessage, validCommand, boundSnapshot, toolCallDetails, normalizeRelayURL, readConfig, saveConfig, resolveConfig, fetchWeeklyUsage: options.usageFetcher || fetchWeeklyUsage, unavailableUsage, pairingMessage,
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

test('/remote displays a private QR and copyable link, reuses the pairing, and rotates it after revocation', async t => {
  const h = await extension(t), original = h.notices.at(-1);
  assert.match(original, /Scan with your phone's camera/); assert.match(original, /[▀▄█]/);
  assert.equal(original, pairingMessage(original.split('\n').at(-1)));
  assert.ok(!original.includes(h.sockets[0].sent.find(packet => packet.type === 'join').token));
  assert.deepEqual(h.prompts, []);
  await h.handler('on', h.ctx);
  assert.equal(h.notices.at(-1), original); assert.equal(h.sockets.length, 1);
  await h.handler('off', h.ctx);
  assert.equal(h.notices.at(-1), 'Remote access disabled.');
  await h.handler('', h.ctx);
  const next = h.notices.at(-1);
  assert.notEqual(next.split('\n').at(-1), original.split('\n').at(-1));
  assert.equal(next, pairingMessage(next.split('\n').at(-1)));
  assert.deepEqual(h.prompts, []);
});

test('Pi shares dashboard keys only with explicit trusted-relay opt-in', async t => {
  const transport = await extension(t), trusted = await extension(t, [], true);
  assert.equal(transport.sockets[0].sent[0].discovery, undefined);
  assert.equal(trusted.sockets[0].sent[0].discovery.key, trusted.key);
  assert.equal(trusted.sockets[0].sent[0].discovery.name, 'test');
});

test('thinking and tool inputs stream in encrypted snapshots and live tool details clear on completion', async t => {
  const h = await extension(t), ws = h.sockets[0]; h.clock.run(150);
  const message = { role: 'assistant', timestamp: 1, content: [] };
  h.events.get('message_start')({ message }, h.ctx);
  h.events.get('message_update')({ message: { ...message, content: [{ type: 'thinking', thinking: 'Inspecting files.' }] } });
  h.clock.run(150);
  const latest = () => open(h.key, ws.sent.filter(packet => packet.type === 'state').at(-1).payload, 'host', 'state');
  assert.equal(latest().messages.at(-1).thinking, 'Inspecting files.');
  const command = 'git diff --stat';
  const complete = { ...message, content: [{ type: 'thinking', thinking: 'Inspecting files and changes.' },
    { type: 'toolCall', name: 'bash', id: 'call-1', arguments: { command } }] };
  h.events.get('message_update')({ message: complete });
  h.events.get('tool_execution_start')({ toolCallId: 'call-1', toolName: 'bash', args: { command } });
  h.clock.run(150);
  assert.equal(latest().messages.length, 1); assert.equal(latest().messages[0].toolCalls[0].input, command);
  assert.equal(latest().activeToolCalls[0].input, command); assert.equal(latest().activeToolCalls[0].id, 'call-1');
  assert.ok(!JSON.stringify(ws.sent).includes(command)); assert.ok(!JSON.stringify(ws.sent).includes('Inspecting files'));
  h.events.get('message_end')({ message: complete });
  h.events.get('tool_execution_end')({ toolCallId: 'call-1' }); h.clock.run(150);
  assert.equal(latest().activeToolCalls.length, 0); assert.equal(latest().messages[0].toolCalls[0].input, command);
});

test('saved-session thinking and tool commands appear in the initial encrypted snapshot', async t => {
  const h = await extension(t, [{ type: 'message', message: { role: 'assistant', timestamp: 1, content: [
    { type: 'thinking', thinking: 'Reviewing the changes.' },
    { type: 'toolCall', name: 'bash', id: 'saved-call', arguments: { command: 'git diff --stat' } }
  ] } }]);
  h.clock.run(150);
  const state = open(h.key, h.sockets[0].sent.find(packet => packet.type === 'state').payload, 'host', 'state');
  assert.equal(state.messages[0].thinking, 'Reviewing the changes.');
  assert.equal(state.messages[0].toolCalls[0].input, 'git diff --stat');
});

test('live tool detail limits fit the snapshot metadata byte budget even with JSON escaping', async t => {
  const h = await extension(t); h.clock.run(150);
  for (let i = 0; i < 120; i++) h.events.get('tool_execution_start')({
    toolCallId: `${i}` + '\0'.repeat(10000), toolName: i < 20 ? 'bash' : '\0'.repeat(10000), args: { command: '\0'.repeat(10000) }
  });
  h.clock.run(150);
  const states = h.sockets[0].sent.filter(packet => packet.type === 'state');
  assert.equal(states.length, 2);
  const state = open(h.key, states.at(-1).payload, 'host', 'state');
  assert.equal(state.tools.length, 100); assert.equal(state.activeToolCalls.length, 20);
  assert.equal(state.activeToolCalls[0].input.length, 4000); assert.equal(state.activeToolCalls[0].id.length, 128);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 600000);
});

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

async function browser({ importKey = (...args) => crypto.subtle.importKey(...args), visualViewport, fetch: fetchFn } = {}) {
  const elements = new Map(), listeners = new Map(), sockets = [], timers = new Map();
  let nextTimer = 0;
  const location = { hash: '', href: 'https://relay.test/', origin: 'https://relay.test', protocol: 'https:', host: 'relay.test' };
  const createElement = tag => ({ tag, value: '', textContent: '', children: [], dataset: {}, open: false,
    scrollHeight: 0, scrollTop: 0, clientHeight: 0,
    append(...nodes) { for (const node of nodes) this.children.push(...(node.tag === 'fragment' ? node.children : [node])); },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
    setAttribute(name, value) { this[name] = value; },
    querySelectorAll(selector) {
      const result = [];
      const visit = node => { if (node.tag === 'details' && (selector === 'details' || (selector === 'details[open]' && node.open))) result.push(node); for (const child of node.children) visit(child); };
      for (const child of this.children) visit(child);
      return result;
    } });
  const element = id => { if (!elements.has(id)) elements.set(id, createElement('div')); return elements.get(id); };
  element('workspace').hidden = true;
  class BrowserSocket {
    static OPEN = 1; readyState = 1; sent = [];
    constructor() { sockets.push(this); }
    send(packet) { this.sent.push(JSON.parse(packet)); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  }
  const key = randomToken(), cryptoKey = await crypto.subtle.importKey('raw', Buffer.from(key, 'base64url'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  let decryptFinished;
  const context = vm.createContext({ document: { getElementById: element, createDocumentFragment: () => createElement('fragment'), createElement,
      documentElement: { style: { setProperty: (name, value) => { element('root-style')[name] = value; } } } }, visualViewport, fetch: fetchFn,
    TextEncoder, TextDecoder, atob, btoa, WebSocket: BrowserSocket, importedKey: cryptoKey, URL, URLSearchParams,
    crypto: { getRandomValues: array => crypto.getRandomValues(array), subtle: {
      importKey, encrypt: (...args) => crypto.subtle.encrypt(...args),
      decrypt: async (...args) => { try { return await crypto.subtle.decrypt(...args); } finally { decryptFinished?.(); } },
    } }, location, history: { replaceState(_state, _title, path) {
      const url = new URL(path, location.href); location.href = url.href; location.hash = url.hash;
    } }, addEventListener: (type, fn) => listeners.set(type, fn),
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval() {} });
  vm.runInContext(await readFile(new URL('../public/marked.js', import.meta.url), 'utf8'), context);
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
const snapshot = (revision, overrides = {}) => ({ revision, capabilities: ['rename'], busy: true, submitting: false, name: 'current', tools: [], messages: [], ...overrides });

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
    snapshot(11, { messages: [{ role: 'assistant', text: '', thinking: {} }] }),
    snapshot(11, { messages: [{ role: 'assistant', text: '', thinking: 'x'.repeat(4001) }] }),
    snapshot(11, { messages: [{ role: 'assistant', text: '', toolCalls: [{ name: 'bash', input: {} }] }] }),
    snapshot(11, { activeToolCalls: [{ name: 'bash', input: 'x'.repeat(4001) }] }),
    snapshot(11, { activeToolCalls: Array(21).fill({ name: 'bash', input: 'pwd' }) }),
    snapshot(11, { activeToolCalls: [{ name: 'bash', input: 'pwd', id: {} }] }),
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

test('phone renders thinking and actual tool inputs as text and preserves expansion across snapshots', async () => {
  const h = await browser(), input = 'printf "<img src=x onerror=alert(1)>"';
  const message = { role: 'assistant', timestamp: 1, text: 'Inspecting changes.', thinking: 'Checking the working tree.',
    toolCalls: [{ id: 'call-1', name: 'bash', input }] };
  await h.receive('state', snapshot(1, { messages: [message], tools: ['bash'], activeToolCalls: [{ id: 'call-1', name: 'bash', input }] }));
  const details = h.element('messages').querySelectorAll('details');
  assert.equal(details[0].children[0].textContent, 'Thinking'); assert.equal(details[0].open, false);
  assert.equal(details[0].children[1].textContent, message.thinking);
  assert.equal(details[1].children[1].textContent, input); assert.equal(details[1].open, true);
  assert.equal(details[1].children[1].tag, 'pre');
  assert.equal(h.element('tool-calls').querySelectorAll('details')[0].children[1].textContent, input);
  details[0].open = true; details[1].open = false;
  await h.receive('state', snapshot(2, { messages: [{ ...message, thinking: 'Checking more changes.' }], activeToolCalls: [] }));
  const updated = h.element('messages').querySelectorAll('details');
  assert.equal(updated[0].open, true); assert.equal(updated[1].open, false);
  assert.equal(updated[0].children[1].textContent, 'Checking more changes.');
  assert.equal(h.element('tool-calls').hidden, true);
  h.eval('disconnect()'); assert.equal(h.element('messages').children.length, 0); assert.equal(h.element('tool-calls').children.length, 0);
});

test('chat scroll follows new snapshots only when the reader is near the bottom', async () => {
  const h = await browser(), chat = h.element('chat');
  chat.scrollHeight = 2000; chat.clientHeight = 500; chat.scrollTop = 200;
  await h.receive('state', snapshot(1));
  assert.equal(chat.scrollTop, 200);
  chat.scrollTop = 1450;
  await h.receive('state', snapshot(2));
  assert.equal(chat.scrollTop, 2000);
});

test('connected layout height tracks the visual viewport when a mobile keyboard opens', async () => {
  const listeners = new Map(), viewport = { height: 844, addEventListener: (name, fn) => listeners.set(name, fn) };
  const h = await browser({ visualViewport: viewport });
  assert.equal(h.element('root-style')['--app-height'], '844px');
  viewport.height = 390; listeners.get('resize')();
  assert.equal(h.element('root-style')['--app-height'], '390px');
});

test('dashboard requires login, renders names as text, and selects sessions without putting keys in the URL', async () => {
  const room = randomToken(), key = randomToken(), calls = [];
  const h = await browser({ fetch: async (path, options) => {
    calls.push({ path, options });
    return { ok: true, status: 200, json: async () => path === '/api/auth'
      ? { enabled: true, authenticated: true, email: 'owner@example.com', csrf: 'csrf-token' }
      : path === '/api/sessions' ? { sessions: [{ room, name: '<img src=x onerror=alert(1)>', connectable: true }] }
      : path === '/auth/logout' ? { ok: true } : { room, key } };
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.element('dashboard').hidden, false);
  const button = h.element('session-list').children[0]; assert.equal(button.tag, 'button');
  assert.equal(button.children[1].children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(button.children[1].children[0].children[1].textContent, 'Status unknown');
  await button.onclick(); assert.equal(h.eval('credentials.room'), room);
  assert.equal(h.element('workspace').hidden, false); assert.equal(h.element('dashboard').hidden, true);
  assert.equal(h.location.hash, ''); assert.ok(!h.location.href.includes(key));
  await h.element('logout').onclick();
  assert.equal(h.element('login').hidden, false); assert.equal(h.element('workspace').hidden, true);
  assert.equal(calls.at(-1).options.headers['X-CSRF-Token'], 'csrf-token');
});

test('dashboard displays running, idle and unknown activity without changing pairing availability', async () => {
  for (const [status, label] of [['running', 'Running'], ['idle', 'Idle'], ['unknown', 'Status unknown'], [undefined, 'Status unknown']]) {
    const h = await browser({ fetch: async path => ({ ok: true, status: 200, json: async () => path === '/api/auth'
      ? { enabled: true, authenticated: true, email: 'owner@example.com', csrf: 'csrf-token' }
      : { sessions: [{ room: randomToken(), name: 'Session', connectable: true, status },
        { room: randomToken(), name: 'Private', connectable: false, status: 'unknown' }] } }) });
    await new Promise(resolve => setImmediate(resolve));
    const [session, privateSession] = h.element('session-list').children;
    assert.equal(session.children[1].children[0].children[0].textContent, 'Session');
    assert.equal(session.children[1].children[0].children[1].textContent, label);
    assert.ok(session.children[1].children[0].children[1].className.includes(`badge-${status || 'unknown'}`));
    assert.match(h.element('session-summary').textContent, /2 connected sessions/);
    assert.equal(session.disabled, false);
    assert.equal(privateSession.children[1].children[0].children[0].textContent, 'Private');
    assert.equal(privateSession.children[1].children[1].textContent, 'Pairing required · open its private link');
    assert.equal(privateSession.disabled, true);
  }
});

test('unavailable authentication status fails closed, and unauthenticated Google mode cannot pair directly', async () => {
  const failure = await browser({ fetch: async () => { throw Error('unavailable'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failure.eval('authChecking'), true); assert.equal(failure.element('workspace').hidden, true);
  const h = await browser({ fetch: async () => ({ ok: true, json: async () => ({ enabled: true, authenticated: false }) }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.element('login').hidden, false); assert.equal(h.element('workspace').hidden, true);
  const before = h.sockets.length;
  await h.navigate(`https://relay.test/#room=${randomToken()}&key=${randomToken()}`);
  assert.equal(h.sockets.length, before); assert.equal(h.location.hash, '');
});

test('a sleeping phone with an expired login returns to sign-in after a failed upgrade', async () => {
  let loggedIn = true;
  const h = await browser({ fetch: async path => ({ ok: true, status: 200, json: async () => path === '/api/auth'
    ? { enabled: true, authenticated: loggedIn, ...(loggedIn ? { email: 'owner@example.com', csrf: 'csrf' } : {}) }
    : { sessions: [] } }) });
  await new Promise(resolve => setImmediate(resolve)); loggedIn = false;
  await h.sockets.at(-1).onclose({ code: 1006 });
  assert.equal(h.element('login').hidden, false); assert.equal(h.eval('credentials'), undefined);
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


test('Markdown is opt-in, repaints existing and streamed replies, and leaves tools/users literal', async () => {
  const h = await browser();
  const messages = [{ role: 'assistant', text: '# Heading\n\n**Bold** and `code`\n\n- first\n- second\n\n```js\nconst x = 1;\n```',
    thinking: '**private thinking**', timestamp: 1 },
    { role: 'user', text: '**user**' }, { role: 'toolResult', text: '**tool**' }];
  await h.receive('state', snapshot(1, { messages }));
  const pane = () => h.element('messages').children;
  assert.equal(h.eval('markdownEnabled'), false);
  assert.equal(pane()[0].children.at(-1).tag, 'pre');
  const details = pane()[0].children.find(n => n.tag === 'details'); details.open = true;
  h.element('chat').scrollHeight = 2000; h.element('chat').clientHeight = 500; h.element('chat').scrollTop = 200;
  h.element('markdown-toggle').onclick();
  assert.equal(h.element('markdown-toggle')['aria-pressed'], 'true');
  assert.equal(h.element('markdown-toggle').textContent, 'Markdown: On');
  assert.equal(h.eval('revision'), 1);
  const rendered = pane()[0].children.at(-1);
  assert.equal(rendered.className, 'markdown');
  assert.equal(rendered.children[0].tag, 'h1');
  assert.equal(rendered.children[1].children[0].tag, 'strong');
  assert.ok(rendered.children.some(n => n.tag === 'ul'));
  assert.ok(rendered.children.some(n => n.tag === 'pre' && n.children[0].tag === 'code'));
  assert.equal(pane()[1].children.at(-1).tag, 'pre');
  assert.equal(pane()[2].children.at(-1).children[1].textContent, '**tool**');
  assert.equal(pane()[0].children.find(n => n.tag === 'details').open, true);
  assert.equal(h.element('chat').scrollTop, 200);
  await h.receive('state', snapshot(2, { messages: [{ role: 'assistant', text: '**streaming**' }] }));
  assert.equal(pane()[0].children.at(-1).children[0].children[0].tag, 'strong');
  h.element('markdown-toggle').onclick();
  assert.equal(pane()[0].children.at(-1).textContent, '**streaming**');
  assert.equal(h.element('markdown-toggle')['aria-pressed'], 'false');
  await h.receive('state', snapshot(1)); assert.equal(h.eval('revision'), 2);
});

test('Markdown does not create executable HTML, remote images or unsafe links', async () => {
  const h = await browser();
  const text = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [data](data:text/html,bad) [safe](https://example.com) ![image](https://example.com/tracker)';
  await h.receive('state', snapshot(1, { messages: [{ role: 'assistant', text }] }));
  h.element('markdown-toggle').onclick();
  const nodes = [];
  const visit = node => { nodes.push(node); for (const child of node.children) visit(child); };
  visit(h.element('messages'));
  assert.ok(!nodes.some(n => ['script', 'img', 'iframe'].includes(n.tag)));
  const links = nodes.filter(n => n.tag === 'a');
  assert.equal(links.length, 1); assert.equal(links[0].href, 'https://example.com/');
  assert.ok(nodes.some(n => n.textContent.includes('<script>')));
  assert.ok(nodes.some(n => n.textContent.includes('<img')));
});


test('home has no pairing form and private-link deployments explain direct navigation', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('id="pair"'));
  assert.ok(!html.includes('id="pair-form"'));
  assert.ok(!html.includes('id="pair-link"'));
  const h = await browser({ fetch: async () => ({ ok: true, status: 200,
    json: async () => ({ enabled: false, authenticated: false }) }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.element('notice').textContent, /Open your private pairing link/);
  const link = `https://relay.test/#room=${randomToken()}&key=${randomToken()}`;
  await h.navigate(link);
  assert.equal(h.element('workspace').hidden, false);
  assert.equal(h.location.hash, '');
});


test('session cards show a helpful empty state and correct counts', async () => {
  const h = await browser();
  h.context.sessions = [];
  h.eval('renderSessionList(sessions)');
  const empty = h.element('session-list').children[0];
  assert.equal(empty.className, 'sessions-empty');
  assert.equal(empty.children[1].textContent, 'No sessions yet');
  h.context.sessions = [{ room: randomToken(), name: 'x'.repeat(256), connectable: true, status: 'running' }];
  h.eval('renderSessionList(sessions)');
  assert.equal(h.element('session-summary').textContent, '1 connected session · 1 running');
  assert.equal(h.element('session-list').children[0].children[1].children[0].children[0].textContent.length, 256);
});


test('chat settings rename the session without touching message drafts, even while running', async () => {
  const h = await browser();
  h.element('settings-panel').hidden = true;
  await h.receive('state', snapshot(1, { name: 'Old name', submitting: true }));
  h.element('settings-toggle').onclick();
  assert.equal(h.element('settings-panel').hidden, false);
  assert.equal(h.element('session-name').value, 'Old name');
  assert.equal(h.element('rename-save').disabled, false);
  h.eval("crypto.randomUUID = () => 'rename12'; sent = []; sendCommand = async value => sent.push(value)");
  h.element('prompt').value = 'My next prompt';
  h.element('session-name').value = '  New name  ';
  h.element('rename-form').onsubmit({ preventDefault() {} });
  assert.equal(h.eval('sent.at(-1).action'), 'rename');
  assert.equal(h.eval('sent.at(-1).text'), 'New name');
  assert.equal(h.element('rename-save').disabled, true);
  await h.receive('ack', { id: 'rename12', ok: false, error: 'Rename failed' });
  assert.equal(h.element('settings-panel').hidden, false);
  assert.equal(h.element('session-name').value, '  New name  ');
  h.element('rename-form').onsubmit({ preventDefault() {} });
  await h.receive('ack', { id: 'rename12', ok: true });
  assert.equal(h.element('settings-panel').hidden, true);
  assert.equal(h.element('prompt').value, 'My next prompt');
  assert.equal(h.element('notice').textContent, 'Session renamed.');
  await h.receive('state', snapshot(2, { name: 'New name' }));
  assert.equal(h.element('session').textContent, 'New name');
  h.element('settings-toggle').onclick();
  assert.equal(h.element('session-name').value, 'New name');
  for (const name of [' ', 'x'.repeat(257), 'bad\nname']) {
    h.element('session-name').value = name;
    h.element('rename-form').onsubmit({ preventDefault() {} });
    assert.equal(h.eval('sent.length'), 2);
  }
  h.element('settings-cancel').onclick();
  assert.equal(h.element('settings-panel').hidden, true);
  h.eval('disconnect()');
  assert.equal(h.element('settings-toggle').hidden, true);
});

test('rename command validation enforces bounded, nonblank single-line names', () => {
  for (const text of ['New name', '<script>literal name</script>', 'x'.repeat(256)]) {
    assert.ok(validCommand({ id: 'rename12', action: 'rename', text }));
  }
  for (const text of [undefined, '', ' ', 'x'.repeat(257), 'bad\nname', 'bad\x00name']) {
    assert.ok(!validCommand({ id: 'rename12', action: 'rename', text }));
  }
});

test('chat navigation keeps icon buttons labelled and preserves their contents when auth changes', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<nav id="auth-controls" aria-label="Session navigation">/);
  assert.match(html, /id="settings-toggle"[^>]*aria-label="Chat settings"/);
  assert.match(html, /id="logout"[^>]*aria-label="Sign out"/);
  const h = await browser();
  const icon = { tag: 'svg' }; h.element('disconnect').children.push(icon);
  h.eval('authEnabled = true; home()');
  assert.equal(h.element('disconnect-label').textContent, 'Sessions');
  assert.equal(h.element('disconnect')['aria-label'], 'Back to sessions');
  assert.equal(h.element('disconnect').children[0], icon);
  h.eval('authEnabled = false; home()');
  assert.equal(h.element('disconnect-label').textContent, 'Disconnect');
  assert.equal(h.element('disconnect')['aria-label'], 'Disconnect from session');
  await h.receive('state', snapshot(1, { name: 'Long session name' }));
  assert.equal(h.element('session').title, 'Long session name');
});


test('older extensions cannot silently accept a rename and explain how to upgrade', async () => {
  const h = await browser();
  h.element('settings-panel').hidden = true;
  await h.receive('state', snapshot(1, { capabilities: undefined, name: 'Old extension' }));
  h.element('settings-toggle').onclick();
  assert.equal(h.element('rename-save').disabled, true);
  assert.equal(h.element('session-name').disabled, true);
  assert.match(h.element('rename-help').textContent, /older remote extension/);
  h.eval('sent = []; sendCommand = async value => sent.push(value)');
  h.element('session-name').value = 'New name';
  h.element('rename-form').onsubmit({ preventDefault() {} });
  assert.equal(h.eval('sent.length'), 0);
  await h.receive('state', snapshot(2, { capabilities: ['rename'] }));
  assert.equal(h.element('rename-save').disabled, false);
  assert.equal(h.element('session-name').disabled, false);
});

test('last-message button scrolls only the conversation to the latest user message', async () => {
  const h = await browser();
  await h.receive('state', snapshot(1));
  assert.equal(h.element('last-user').disabled, true);
  await h.receive('state', snapshot(2, { messages: [
    { role: 'user', text: 'First prompt' }, { role: 'assistant', text: 'First reply' },
    { role: 'user', text: 'Latest prompt' }, { role: 'assistant', text: 'Long reply' }
  ] }));
  const articles = h.element('messages').children;
  const chat = h.element('chat'); chat.scrollTop = 300;
  chat.getBoundingClientRect = () => ({ top: 100 });
  articles[0].getBoundingClientRect = () => ({ top: 20 });
  articles[2].getBoundingClientRect = () => ({ top: 240 });
  assert.equal(h.element('last-user').disabled, false);
  h.element('last-user').onclick();
  assert.equal(chat.scrollTop, 428);
  await h.receive('state', snapshot(3, { messages: [{ role: 'assistant', text: 'No user in retained history' }] }));
  assert.equal(h.element('last-user').disabled, true);
  h.eval('disconnect()');
  assert.equal(h.element('last-user').disabled, true);
});


test('settings pop-up contains Markdown, stays open while toggling it, and dismisses cleanly', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const settings = html.slice(html.indexOf('<section id="settings-panel"'), html.indexOf('<div class="statusbar">'));
  assert.match(settings, /popover="auto" role="dialog"/);
  assert.match(settings, /id="markdown-toggle"/);
  assert.equal(html.split('id="markdown-toggle"').length - 1, 1);
  const h = await browser();
  const panel = h.element('settings-panel'); panel.hidden = true;
  let shown = 0, hidden = 0;
  panel.showPopover = () => shown++;
  panel.hidePopover = () => hidden++;
  await h.receive('state', snapshot(1, { messages: [{ role: 'assistant', text: '**Bold**' }] }));
  h.element('settings-toggle').onclick();
  assert.equal(shown, 1);
  h.element('markdown-toggle').onclick();
  assert.equal(panel.hidden, false);
  assert.equal(h.element('markdown-toggle')['aria-pressed'], 'true');
  panel.ontoggle({ newState: 'closed' });
  assert.equal(panel.hidden, true);
  assert.equal(h.element('settings-toggle')['aria-expanded'], 'false');
  h.element('settings-toggle').onclick();
  h.element('settings-close').onclick();
  assert.equal(hidden, 1);
  assert.equal(panel.hidden, true);
  delete panel.showPopover; delete panel.hidePopover;
  h.element('settings-toggle').onclick();
  h.context.event = { target: h.element('settings-toggle') };
  h.eval('dismissSettingsOutside(event)');
  assert.equal(panel.hidden, false);
  h.context.event = { target: h.element('chat') };
  h.eval('dismissSettingsOutside(event)');
  assert.equal(panel.hidden, true);
});


test('settings display authoritative model and weekly usage with explicit unavailable states', async () => {
  const h = await browser();
  const model = { id: 'gpt-test', name: 'GPT Test', provider: 'openai-codex' };
  const planUsage = { provider: 'openai-codex', status: 'available', usedPercent: 66.4,
    resetsAt: 1800003600000, updatedAt: 1800000000000, plan: 'plus' };
  await h.receive('state', snapshot(1, { model, planUsage }));
  assert.equal(h.element('active-model').textContent, 'GPT Test');
  assert.equal(h.element('active-model-provider').textContent, 'openai-codex · gpt-test');
  assert.equal(h.element('weekly-usage').textContent, '66% used');
  assert.equal(h.element('weekly-usage-bar').value, 66.4);
  assert.equal(h.element('weekly-usage-bar').hidden, false);
  assert.match(h.element('weekly-usage-detail').textContent, /plus plan.*Resets/);
  await h.receive('state', snapshot(2, { model, planUsage: { ...planUsage, usedPercent: 0 } }));
  assert.equal(h.element('weekly-usage').textContent, '0% used');
  await h.receive('state', snapshot(3, { model: { ...model, provider: 'another' }, planUsage }));
  assert.equal(h.element('weekly-usage-bar').hidden, true);
  assert.equal(h.element('weekly-usage').textContent, 'Not available');
  for (const invalid of [{ ...planUsage, usedPercent: 101 }, { ...planUsage, usedPercent: '66' }, { ...planUsage, status: 'bad' }]) {
    await h.receive('state', snapshot(4, { model, planUsage: invalid }));
    assert.equal(h.eval('revision'), 3);
  }
  await h.receive('state', snapshot(4, { model, planUsage: { ...planUsage, status: 'loading', usedPercent: null } }));
  assert.equal(h.element('weekly-usage').textContent, 'Checking…');
  await h.receive('state', snapshot(5));
  assert.equal(h.element('active-model').textContent, 'Not available');
  assert.equal(h.element('weekly-usage-bar').hidden, true);
});

test('usage refresh follows model switches, ignores stale requests, and stops when remote is disabled', async t => {
  const pending = [], model = { id: 'first', name: 'First', provider: 'openai-codex' };
  const h = await extension(t, [], false, { model, usageFetcher: (model, _registry, options) => new Promise(resolve => pending.push({ model, options, resolve })) });
  const states = () => h.sockets[0].sent.filter(p => p.type === 'state').map(p => open(h.key, p.payload, 'host', 'state'));
  h.clock.run(150);
  assert.equal(states().at(-1).model.id, 'first');
  assert.equal(states().at(-1).planUsage.status, 'loading');
  h.ctx.model = { id: 'second', name: 'Second', provider: 'anthropic' };
  h.events.get('model_select')({}, h.ctx);
  assert.equal(pending[0].options.signal.aborted, true);
  pending[0].resolve({ ...unavailableUsage('openai-codex'), status: 'available', usedPercent: 99 });
  await new Promise(resolve => setImmediate(resolve));
  h.clock.run(150);
  assert.equal(states().at(-1).model.id, 'second');
  assert.equal(states().at(-1).planUsage.provider, 'anthropic');
  assert.equal(states().at(-1).planUsage.status, 'loading');
  pending[1].resolve({ ...unavailableUsage('anthropic'), status: 'available', usedPercent: 42, updatedAt: Date.now() });
  await new Promise(resolve => setImmediate(resolve));
  h.clock.run(150);
  assert.equal(states().at(-1).planUsage.usedPercent, 42);
  assert.equal(h.clock.count(300000), 1);
  await h.handler('off', h.ctx);
  assert.equal(h.clock.count(300000), 0);
});

const cyberRiskError = 'Codex error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.';

test('provider error-only messages survive projection, including Codex cybersecurity refusals', () => {
  const message = publicMessage({ role: 'assistant', content: [], stopReason: 'error', errorMessage: cyberRiskError, privateMetadata: 'not-forwarded' });
  assert.ok(message);
  assert.equal(message.text, '');
  assert.equal(message.stopReason, 'error');
  assert.equal(message.errorMessage, cyberRiskError);
  assert.ok(!JSON.stringify(message).includes('not-forwarded'));
  assert.equal(publicMessage({ role: 'assistant', content: [], stopReason: 'error' }).errorMessage, 'The model provider returned an error without a message.');
  assert.equal(publicMessage({ role: 'assistant', content: [], stopReason: 'aborted' }).errorMessage, 'Response interrupted.');
  assert.equal(publicMessage({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'x'.repeat(10000) }).errorMessage.length, 4000);
  for (const role of ['user', 'toolResult', 'assistant']) {
    const projected = publicMessage({ role, content: 'Visible', stopReason: role === 'assistant' ? 'stop' : 'error', errorMessage: 'hidden-error' });
    assert.equal(projected.errorMessage, undefined);
  }
});

test('extension publishes live errors without losing partial replies, and replays errors on re-enable', async t => {
  const branch = [], h = await extension(t, branch);
  const failure = { role: 'assistant', content: [{ type: 'text', text: 'Partial reply' }], timestamp: 1, stopReason: 'error', errorMessage: cyberRiskError };
  h.events.get('message_start')({ message: { ...failure, stopReason: 'stop', errorMessage: undefined } }, h.ctx);
  h.events.get('message_end')({ message: failure }, h.ctx);
  h.events.get('agent_end')({}, h.ctx);
  h.clock.run(150);
  const state = () => open(h.key, h.sockets[0].sent.filter(packet => packet.type === 'state').at(-1).payload, 'host', 'state');
  assert.equal(state().messages.length, 1);
  assert.equal(state().messages[0].text, 'Partial reply');
  assert.equal(state().messages[0].errorMessage, cyberRiskError);
  branch.push({ type: 'message', message: failure });
  await h.handler('off', h.ctx); await h.handler('', h.ctx); h.join(h.sockets.at(-1));
  h.clock.run(150);
  const ws = h.sockets.at(-1), link = new URL(h.notices.at(-1).split('\n').at(-1));
  const key = new URLSearchParams(link.hash.slice(1)).get('key');
  const replay = open(key, ws.sent.filter(packet => packet.type === 'state').at(-1).payload, 'host', 'state');
  assert.equal(replay.messages[0].errorMessage, cyberRiskError);
  assert.equal(h.prompts.length, 0);
});

test('browser renders provider failures as literal error cards, not blank replies or Markdown', async () => {
  const h = await browser();
  const errorMessage = cyberRiskError + '\n<img src=x onerror=alert(1)> **literal**';
  await h.receive('state', snapshot(1, { busy: false, messages: [{ role: 'assistant', text: '', stopReason: 'error', errorMessage }] }));
  const error = () => h.element('messages').children[0].children.at(-1);
  assert.equal(error().className, 'provider-error');
  assert.equal(error().children[0].textContent, 'Provider error');
  assert.equal(error().children[1].textContent, errorMessage);
  assert.equal(error().children[1].tag, 'pre');
  assert.equal(h.element('status').textContent, 'Provider error · see latest reply');
  h.element('markdown-toggle').onclick();
  assert.equal(error().children[1].textContent, errorMessage);
  for (const invalid of [
    { role: 'user', text: '', stopReason: 'error', errorMessage: 'invalid' },
    { role: 'assistant', text: '', stopReason: 'error', errorMessage: 'x'.repeat(4001) },
    { role: 'assistant', text: '', stopReason: 'error', errorMessage: {} }
  ]) {
    await h.receive('state', snapshot(2, { messages: [invalid] }));
    assert.equal(h.eval('revision'), 1);
  }
  await h.receive('state', snapshot(2, { busy: false, messages: [{ role: 'assistant', text: 'A later successful reply' }] }));
  assert.equal(h.element('status').textContent, 'Connected · ready');
  await h.receive('state', snapshot(3, { busy: false, messages: [{ role: 'assistant', text: '', stopReason: 'aborted', errorMessage: 'Interrupted by user' }] }));
  assert.equal(error().className, 'provider-error interrupted');
  assert.equal(error().children[0].textContent, 'Response interrupted');
});
