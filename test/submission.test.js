import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent';
import { getModel } from '@earendil-works/pi-ai/compat';
import { randomToken, seal, open } from '../src/crypto.js';
import { publicMessage, validCommand, boundSnapshot } from '../src/protocol.js';
import { normalizeRelayURL, readConfig, saveConfig, resolveConfig } from '../src/config.js';
import { pairingMessage } from '../src/pairing.js';

test('Pi 1.1.0 supports interactive setup and preserves submission identity through delayed, transformed preflight', { timeout: 10000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-submission-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sockets = [], notices = [];
  class HostSocket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = []; listeners = new Map();
    constructor() { sockets.push(this); }
    on(name, fn) { this.listeners.set(name, fn); }
    emit(name, ...args) { this.listeners.get(name)?.(...args); }
    send(packet) { this.sent.push(JSON.parse(packet)); }
    close() { this.readyState = 3; this.emit('close', 1000); }
    terminate() { this.close(); }
  }
  const source = ts.transpileModule(await readFile(new URL('../extension/remote.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/^import .*;\n/gm, '').replace('export default function', 'function');
  const context = vm.createContext({ WebSocket: HostSocket, AsyncLocalStorage, AbortController, URL, Buffer, join, setTimeout, clearTimeout,
    getAgentDir: () => dir, process: { env: {} },
    randomToken, seal, open, publicMessage, validCommand, boundSnapshot, normalizeRelayURL, readConfig, saveConfig, resolveConfig, pairingMessage });
  const remote = vm.runInContext(`${source}\nremoteExtension;`, context);
  let release, entered, settled, remoteReleased = false, remoteInputs = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const preflightEntered = new Promise(resolve => { entered = resolve; });
  const remoteSettled = new Promise(resolve => { settled = resolve; });
  const preflight = pi => {
    pi.on('input', async event => {
      if (event.source !== 'extension') return { action: 'continue' };
      remoteInputs++; entered(); await gate;
      remoteReleased = true;
      return { action: 'transform', text: `${event.text} (transformed)` };
    });
    pi.on('agent_settled', () => { if (remoteReleased) settled(); });
  };
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, cacheWarmingMode: 'off' });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.hasConfiguredAuth = () => true;
  const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [remote, preflight] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime, resourceLoader,
    sessionManager: SessionManager.inMemory(dir), model: getModel('anthropic', 'claude-sonnet-4-5'), tools: [] });
  // Exercise the real submission wrapper, preflight, extension runner and agent
  // loop, but never call a model or execute a tool.
  session.agent.streamFunction = () => { throw Error('Synthetic stream: no model request'); };
  t.after(async () => {
    release();
    if (remoteInputs) await remoteSettled;
    await session.prompt('/remote off');
    session.dispose();
  });
  await session.bindExtensions({ uiContext: { setStatus() {}, notify: text => notices.push(text),
    input: async () => 'http://localhost:8787', confirm: async () => true } });
  await session.prompt('/remote setup');
  assert.equal(sockets.length, 0);
  const config = await readConfig(join(dir, 'pi-remote.json'));
  assert.match(config.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(notices.at(-1).includes(`export PI_REMOTE_TOKEN='${config.token}'`));
  assert.equal(session.sessionManager.getBranch().filter(entry => entry.type === 'message').length, 0);
  await session.prompt('/remote');
  const pairing = notices.at(-1);
  assert.match(pairing, /[▀▄█]/); assert.ok(!pairing.includes(config.token));
  assert.equal(session.sessionManager.getBranch().filter(entry => entry.type === 'message').length, 0);
  await session.prompt('/remote'); assert.equal(notices.at(-1), pairing);
  const key = new URLSearchParams(new URL(pairing.split('\n').at(-1)).hash.slice(1)).get('key');
  const ws = sockets[0]; ws.emit('open'); ws.emit('message', JSON.stringify({ type: 'joined' }));
  const command = { id: '12345678', action: 'prompt', text: 'work', createdAt: Date.now() };
  const send = () => ws.emit('message', JSON.stringify({ type: 'command', payload: seal(key, command, 'client', 'command') }));
  const acks = () => ws.sent.filter(packet => packet.type === 'ack').map(packet => open(key, packet.payload, 'host', 'ack'));
  send(); await preflightEntered;
  assert.equal(acks().length, 0);
  // Identical local text is unrelated to the pending remote API invocation.
  await session.prompt(command.text);
  assert.equal(acks().length, 0);
  send(); assert.equal(remoteInputs, 1); assert.equal(acks().length, 0);
  release(); await remoteSettled;
  assert.equal(acks().length, 1); assert.equal(acks()[0].id, command.id); assert.equal(acks()[0].ok, true);
  const users = session.sessionManager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'user');
  assert.deepEqual(users.map(entry => publicMessage(entry.message).text), ['work', 'work (transformed)']);
  send(); assert.equal(remoteInputs, 1); assert.equal(acks().at(-1).ok, true);
});
