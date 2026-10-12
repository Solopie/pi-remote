import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';
import WebSocket from 'ws';
import { createRelay } from '../src/server.js';
import { randomToken, seal, open } from '../src/crypto.js';
import { publicMessage, validCommand, boundSnapshot } from '../src/protocol.js';
import { normalizeRelayURL, readConfig, saveConfig, resolveConfig } from '../src/config.js';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function extension(t, { dir, env = {}, inputs = [], confirmations = [], hasUI = true, save = saveConfig, network = false } = {}) {
  dir ||= await directory(t);
  const file = join(dir, 'pi-remote.json'), sockets = [], notices = [], dialogs = [], events = new Map(), timers = new Map(), prompts = [];
  let command, nextTimer = 0, generated = 0;
  class HostSocket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; sent = []; listeners = new Map();
    constructor(url) { this.url = url; sockets.push(this); }
    on(name, fn) { this.listeners.set(name, fn); }
    emit(name, ...args) { this.listeners.get(name)?.(...args); }
    send(packet) { this.sent.push(JSON.parse(packet)); }
    finish(code) { this.readyState = 3; this.emit('close', code); }
    close() { this.finish(1000); }
    terminate() { this.finish(1006); }
  }
  const Socket = network ? class extends WebSocket {
    constructor(...args) { super(...args); sockets.push(this); }
  } : HostSocket;
  const ctx = { hasUI, cwd: dir, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => 'setup-session', getBranch: () => [] },
    ui: { notify: (text, type) => notices.push({ text, type }), setStatus() {},
      input: async (title, placeholder, options) => { dialogs.push({ type: 'input', title, placeholder, ...options }); return inputs.shift(); },
      confirm: async (title, message, options) => { dialogs.push({ type: 'confirm', title, message, ...options }); return confirmations.shift() ?? false; } } };
  const pi = { registerCommand: (_name, value) => { command = value; }, on: (name, fn) => events.set(name, fn),
    getSessionName: () => 'setup-session', sendUserMessage: text => prompts.push(text) };
  const source = ts.transpileModule(await readFile(new URL('../extension/remote.ts', import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/^import .*;\n/gm, '').replace('export default function', 'function');
  const context = vm.createContext({ pi, WebSocket: Socket, AsyncLocalStorage, AbortController, URL, Buffer, Error, join,
    getAgentDir: () => dir, process: { env },
    randomToken: () => { generated++; return randomToken(); }, seal, open, publicMessage, validCommand, boundSnapshot,
    normalizeRelayURL, readConfig, saveConfig: save, resolveConfig,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id) });
  vm.runInContext(`${source}\nremoteExtension(pi);`, context);
  t.after(() => events.get('session_shutdown')());
  return { file, env, ctx, sockets, notices, dialogs, events, prompts,
    handler: args => command.handler(args, ctx), get generated() { return generated; },
    completions: prefix => command.getArgumentCompletions(prefix),
    runTimer(ms) {
      const [id, timer] = [...timers].find(([, timer]) => timer.ms === ms) || [];
      assert.ok(timer, `Expected a ${ms}ms timer`); timers.delete(id); timer.fn();
    } };
}

function deferred() {
  let resolve;
  const promise = new Promise(fn => { resolve = fn; });
  return { promise, resolve };
}

test('relay URL validation is shared by setup and environment settings', () => {
  assert.equal(normalizeRelayURL('https://RELAY.example:443/'), 'https://relay.example');
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(normalizeRelayURL(`http://${host}:8787/`), `http://${host}:8787`);
  }
  for (const value of ['', 'not a url', 'file:///tmp/relay', 'ws://localhost:8787', 'http://relay.example',
    'http://100.64.0.1:8787', 'https://relay.example/ws', 'https://relay.example/?token=secret',
    'https://relay.example/#key=secret', 'https://user:private-secret@relay.example']) {
    assert.throws(() => normalizeRelayURL(value), error => !error.message.includes('private-secret'));
  }
});

test('saved configuration is private, atomic, normalized, and upgrades permissive file modes', async t => {
  const dir = await directory(t), agentDir = join(dir, 'new', 'agent'), file = join(agentDir, 'pi-remote.json'), token = randomToken();
  assert.equal(await readConfig(file), undefined);
  await saveConfig(file, { url: 'https://RELAY.example/', token });
  if (process.platform !== 'win32') assert.equal((await stat(agentDir)).mode & 0o777, 0o700);
  assert.deepEqual(await readConfig(file), { url: 'https://relay.example', token });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, url: 'https://relay.example', token });
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await chmod(file, 0o644);
  const replacement = { url: 'https://new.example', token: randomToken() };
  await saveConfig(file, replacement);
  assert.deepEqual(await readConfig(file), replacement);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(agentDir), ['pi-remote.json']);
});

test('invalid or aborted saves preserve existing credentials and leave no temporary files', async t => {
  const dir = await directory(t), file = join(dir, 'pi-remote.json');
  const original = { url: 'https://old.example', token: randomToken() };
  await saveConfig(file, original);
  for (const value of [{ url: 'http://remote.example', token: randomToken() }, { url: 'https://new.example', token: 'weak' }]) {
    await assert.rejects(saveConfig(file, value));
    assert.deepEqual(await readConfig(file), original);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(saveConfig(file, { url: 'https://new.example', token: randomToken() }, controller.signal));
  assert.deepEqual(await readConfig(file), original);
  assert.deepEqual(await readdir(dir), ['pi-remote.json']);
  // A failed atomic replacement must also remove its temporary credential file.
  await assert.rejects(saveConfig(dir, { url: 'https://new.example', token: randomToken() }));
  assert.deepEqual(await readdir(dir), ['pi-remote.json']);
});

test('saving replaces a configuration symlink without overwriting its target', { skip: process.platform === 'win32' }, async t => {
  const dir = await directory(t), target = join(dir, 'unrelated-file'), file = join(dir, 'pi-remote.json');
  await writeFile(target, 'Do not overwrite'); await symlink(target, file);
  const config = { url: 'https://relay.example', token: randomToken() };
  await saveConfig(file, config);
  assert.equal(await readFile(target, 'utf8'), 'Do not overwrite');
  assert.equal((await lstat(file)).isSymbolicLink(), false);
  assert.deepEqual(await readConfig(file), config);
});

test('configuration errors never echo secret contents and explicit environment settings override saved settings', async t => {
  const dir = await directory(t), file = join(dir, 'pi-remote.json'), token = randomToken();
  await writeFile(file, `{"token":"${token}",INVALID`);
  await assert.rejects(readConfig(file), error => /Invalid remote settings/.test(error.message) && !error.message.includes(token));
  const env = { PI_REMOTE_URL: 'https://override.example/', PI_REMOTE_TOKEN: randomToken() };
  assert.deepEqual(await resolveConfig(file, env), { url: 'https://override.example', token: env.PI_REMOTE_TOKEN });
  const saved = { url: 'https://saved.example', token: randomToken() }; await saveConfig(file, saved);
  assert.deepEqual(await resolveConfig(file, {}), saved);
  assert.deepEqual(await resolveConfig(file, { PI_REMOTE_TOKEN: token }), { url: saved.url, token });
  assert.deepEqual(await resolveConfig(file, { PI_REMOTE_URL: `${saved.url}/` }), saved);
  await assert.rejects(resolveConfig(file, { PI_REMOTE_URL: env.PI_REMOTE_URL }), /Saved tokens are not sent to a different relay/);
});

test('/remote setup generates and saves a strong token without enabling access or sending a user message', async t => {
  const h = await extension(t, { inputs: ['  https://RELAY.example-tailnet.ts.net/  '] });
  await h.handler(' setup ');
  const config = await readConfig(h.file);
  assert.equal(config.url, 'https://relay.example-tailnet.ts.net');
  assert.match(config.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(config.token, 'base64url').length, 32);
  assert.equal(h.generated, 1); assert.equal(h.sockets.length, 0); assert.deepEqual(h.prompts, []);
  assert.equal(h.env.PI_REMOTE_URL, config.url); assert.equal(h.env.PI_REMOTE_TOKEN, config.token);
  assert.equal(h.dialogs.length, 1); assert.equal(h.dialogs[0].type, 'input');
  assert.match(h.notices.at(-1).text, /Start\/restart the relay/);
  assert.ok(h.notices.at(-1).text.includes(`export PI_REMOTE_TOKEN='${config.token}'`));
  assert.deepEqual(Array.from(h.completions('s'), item => item.value), ['setup']);
  await h.handler('on');
  const ws = h.sockets[0]; assert.equal(ws.url, 'wss://relay.example-tailnet.ts.net/ws'); ws.emit('open');
  assert.equal(ws.sent[0].token, config.token);
  const params = new URLSearchParams(new URL(h.notices.at(-1).text.split('\n').at(-1)).hash.slice(1));
  assert.notEqual(params.get('room'), config.token); assert.notEqual(params.get('key'), config.token);
  // Running pairings retain their authenticated token even if the process env changes.
  h.env.PI_REMOTE_TOKEN = randomToken(); ws.finish(1013); h.runTimer(1000);
  const retry = h.sockets.at(-1); retry.emit('open'); assert.equal(retry.sent[0].token, config.token);
});

test('a fresh extension automatically uses saved setup, while explicit environment settings still win', async t => {
  const dir = await directory(t), first = await extension(t, { dir, inputs: ['http://localhost:8787'] });
  await first.handler('setup'); const saved = await readConfig(first.file);
  const fresh = await extension(t, { dir }); await fresh.handler(''); fresh.sockets[0].emit('open');
  assert.equal(fresh.sockets[0].url, 'ws://localhost:8787/ws'); assert.equal(fresh.sockets[0].sent[0].token, saved.token);
  const env = { PI_REMOTE_URL: 'https://override.example', PI_REMOTE_TOKEN: randomToken() };
  const overridden = await extension(t, { dir, env }); await overridden.handler('on'); overridden.sockets[0].emit('open');
  assert.equal(overridden.sockets[0].url, 'wss://override.example/ws'); assert.equal(overridden.sockets[0].sent[0].token, env.PI_REMOTE_TOKEN);
  assert.deepEqual(await readConfig(first.file), saved);
});

test('setup retries unsafe URLs without echoing credentials or generating tokens before validation', async t => {
  const h = await extension(t, { inputs: ['http://100.64.0.1:8787', 'https://user:private-secret@relay.example',
    'https://relay.example/ws', 'https://relay.example/#key=private-secret', '', 'https://valid.example'] });
  await h.handler('setup');
  assert.equal((await readConfig(h.file)).url, 'https://valid.example');
  assert.equal(h.generated, 1); assert.equal(h.dialogs.filter(dialog => dialog.type === 'input').length, 6);
  assert.equal(h.notices.filter(notice => notice.type === 'error').length, 5);
  assert.ok(h.notices.every(notice => !notice.text.includes('private-secret')));
});

test('cancelling URL input or refusing token replacement leaves saved settings and environment unchanged', async t => {
  const dir = await directory(t), file = join(dir, 'pi-remote.json');
  const original = { url: 'https://old.example', token: randomToken() }; await saveConfig(file, original);
  for (const options of [{ inputs: [undefined] }, { inputs: ['https://new.example'], confirmations: [false] }]) {
    const env = { PI_REMOTE_URL: original.url, PI_REMOTE_TOKEN: original.token };
    const h = await extension(t, { dir, env, ...options }); await h.handler('setup');
    assert.deepEqual(await readConfig(file), original); assert.deepEqual(env, { PI_REMOTE_URL: original.url, PI_REMOTE_TOKEN: original.token });
    assert.equal(h.generated, 0); assert.equal(h.sockets.length, 0); assert.match(h.notices.at(-1).text, /cancelled/);
  }
});

test('repeated setup requires confirmation and generates a fresh token, with Enter preserving the relay URL', async t => {
  const dir = await directory(t), original = { url: 'https://relay.example', token: randomToken() };
  await saveConfig(join(dir, 'pi-remote.json'), original);
  const h = await extension(t, { dir, inputs: [''], confirmations: [true] }); await h.handler('setup');
  const replacement = await readConfig(h.file);
  assert.equal(replacement.url, original.url); assert.notEqual(replacement.token, original.token);
  assert.match(h.dialogs.find(dialog => dialog.type === 'confirm').message, /other pi hosts/);
  assert.equal(h.dialogs[0].placeholder, original.url);
  assert.ok(h.notices.every(notice => !notice.text.includes(original.token)));
});

test('setup can repair corrupt settings, but normal activation fails closed without leaking file contents', async t => {
  const h = await extension(t, { inputs: ['https://relay.example'], confirmations: [true] }), secret = randomToken();
  await writeFile(h.file, `private-secret-${secret}`);
  await h.handler('on'); assert.equal(h.sockets.length, 0);
  assert.ok(h.notices.every(notice => !notice.text.includes(secret)));
  await h.handler('setup'); assert.equal((await readConfig(h.file)).url, 'https://relay.example');
  assert.equal(h.sockets.length, 0); assert.ok(h.notices.some(notice => /confirmation/.test(notice.text)));
});

test('setup does not display an invalid credential-bearing environment URL as its default', async t => {
  const h = await extension(t, { env: { PI_REMOTE_URL: 'https://user:never-print-this@relay.example', PI_REMOTE_TOKEN: randomToken() },
    inputs: ['https://relay.example'], confirmations: [true] });
  await h.handler('setup');
  assert.ok(h.dialogs.every(dialog => !JSON.stringify(dialog).includes('never-print-this')));
  assert.ok(h.notices.every(notice => !notice.text.includes('never-print-this')));
  assert.equal((await readConfig(h.file)).url, 'https://relay.example');
});

test('setup refuses to reconfigure live access or run without an interactive UI', async t => {
  const env = { PI_REMOTE_URL: 'http://localhost:8787', PI_REMOTE_TOKEN: randomToken() };
  const h = await extension(t, { env }); await h.handler('on'); const generated = h.generated;
  await h.handler('setup'); assert.match(h.notices.at(-1).text, /\/remote off/);
  assert.equal(h.dialogs.length, 0); assert.equal(h.generated, generated); assert.equal(await readConfig(h.file), undefined);
  const noninteractive = await extension(t, { hasUI: false }); await noninteractive.handler('setup');
  assert.match(noninteractive.notices.at(-1).text, /interactive UI/);
  assert.equal(noninteractive.generated, 0); assert.equal(await readConfig(noninteractive.file), undefined);
});

test('save failures do not change active process credentials, enable access, or expose an unusable token', async t => {
  const env = { PI_REMOTE_URL: 'https://old.example', PI_REMOTE_TOKEN: randomToken() }, original = { ...env };
  const h = await extension(t, { env, inputs: ['https://new.example'], confirmations: [true], save: async () => { throw Error('Disk unavailable'); } });
  await h.handler('setup'); assert.deepEqual(env, original);
  assert.equal(h.sockets.length, 0); assert.equal(await readConfig(h.file), undefined);
  assert.match(h.notices.at(-1).text, /Disk unavailable/); assert.doesNotMatch(h.notices.at(-1).text, /export PI_REMOTE_TOKEN/);
});

test('/remote off cancels a pending wizard without allowing it to overwrite a newer setup', async t => {
  const h = await extension(t), shown = deferred(), oldInput = deferred();
  h.ctx.ui.input = (_title, _placeholder, options) => { shown.resolve(options.signal); return oldInput.promise; };
  const oldSetup = h.handler('setup'), signal = await shown.promise;
  await h.handler('on'); assert.match(h.notices.at(-1).text, /in progress/); assert.equal(h.sockets.length, 0);
  await h.handler('off'); assert.equal(signal.aborted, true);
  const newShown = deferred(), newInput = deferred();
  h.ctx.ui.input = () => { newShown.resolve(); return newInput.promise; };
  const newSetup = h.handler('setup'); await newShown.promise;
  oldInput.resolve('https://stale.example'); await oldSetup;
  await h.handler('on'); assert.match(h.notices.at(-1).text, /in progress/);
  assert.equal(await readConfig(h.file), undefined);
  newInput.resolve('https://current.example'); await newSetup;
  assert.equal((await readConfig(h.file)).url, 'https://current.example');
  assert.equal(h.generated, 1); assert.equal(h.sockets.length, 0);
});

test('session changes and shutdown cancel pending setup before credentials are generated or saved', async t => {
  for (const event of ['session_start', 'session_shutdown']) {
    const h = await extension(t), shown = deferred(), input = deferred();
    h.ctx.ui.input = (_title, _placeholder, options) => { shown.resolve(options.signal); return input.promise; };
    const pending = h.handler('setup'), signal = await shown.promise;
    h.events.get(event)({}, h.ctx); assert.equal(signal.aborted, true);
    input.resolve('https://stale.example'); await pending;
    assert.equal(h.generated, 0); assert.equal(await readConfig(h.file), undefined); assert.deepEqual(h.env, {});
  }
});

test('a generated setup token authenticates a real relay after updating its environment and restarting', async t => {
  let app = createRelay({ token: randomToken() });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const port = app.server.address().port;
  const h = await extension(t, { inputs: [`http://127.0.0.1:${port}`] });
  await h.handler('setup'); const config = await readConfig(h.file);
  assert.equal(h.sockets.length, 0);
  // This is the operator's relay-side step; setup deliberately cannot do it remotely.
  await app.close(); app = createRelay({ token: config.token });
  app.server.listen(port, '127.0.0.1'); await once(app.server, 'listening');
  const fresh = await extension(t, { dir: h.ctx.cwd, network: true }); await fresh.handler('on');
  const joined = JSON.parse((await once(fresh.sockets[0], 'message'))[0]);
  assert.equal(joined.type, 'joined'); assert.equal(app.rooms.size, 1);
  const link = new URL(fresh.notices.at(-1).text.split('\n').at(-1));
  const room = new URLSearchParams(link.hash.slice(1)).get('room');
  assert.equal(app.rooms.get(room).host.readyState, WebSocket.OPEN);
  assert.equal(fresh.prompts.length, 0);
});

test('missing credentials suggest setup and usage includes the new subcommand', async t => {
  const h = await extension(t); await h.handler('on');
  assert.equal(h.sockets.length, 0); assert.match(h.notices.at(-1).text, /Run \/remote setup/);
  await h.handler('unknown'); assert.match(h.notices.at(-1).text, /setup\|on\|off/);
});
