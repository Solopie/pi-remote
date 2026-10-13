import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { randomToken } from '../src/crypto.js';

async function launch(t, contents, overrides = {}) {
  // Run the real package start script in an isolated checkout, never the user's
  // repository .env. Only first-party source and installed dependencies are used.
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-npm-start-'));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { start: pkg.scripts.start } }));
  await cp(new URL('../src', import.meta.url), join(dir, 'src'), { recursive: true });
  await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'node_modules'), 'dir');
  if (contents !== undefined) await writeFile(join(dir, '.env'), contents, { mode: 0o600 });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('PI_REMOTE_')) delete env[key];
  Object.assign(env, { HOST: '127.0.0.1', PORT: '0', ...overrides });
  const child = spawn('npm', ['start', '--silent'], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
    await closed; await rm(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const address = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (address) return { address, get output() { return output; } };
    assert.equal(child.exitCode, null, `npm start exited: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('npm start did not become ready');
}
async function joined(t, address, token) {
  const ws = new WebSocket(address.replace('http:', 'ws:') + '/ws'); t.after(() => ws.terminate());
  await once(ws, 'open'); const response = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'join', role: 'host', room: randomToken(), token }));
  assert.equal(JSON.parse((await response)[0]).type, 'joined');
}

test('npm start automatically loads a private .env including relay token and Google settings', async t => {
  const token = randomToken();
  const run = await launch(t, `PI_REMOTE_TOKEN=${token}\nPI_REMOTE_GOOGLE_CLIENT_ID=synthetic-client\nPI_REMOTE_GOOGLE_CLIENT_SECRET=synthetic-secret\nPI_REMOTE_ALLOWED_EMAIL=owner@example.com\nPI_REMOTE_PUBLIC_URL=https://relay.example\n`);
  await joined(t, run.address, token);
  assert.deepEqual(await (await fetch(run.address + '/api/auth')).json(), { enabled: true, authenticated: false });
  assert.ok(!run.output.includes(token)); assert.ok(!run.output.includes('synthetic-secret'));
});

test('npm start works without .env and generates a relay token', async t => {
  const run = await launch(t);
  const token = run.output.match(/PI_REMOTE_TOKEN=([A-Za-z0-9_-]{43})\n/)?.[1];
  assert.ok(token); await joined(t, run.address, token);
});

test('npm start preserves explicit environment precedence over .env', async t => {
  const fileToken = randomToken(), environmentToken = randomToken();
  const run = await launch(t, `PI_REMOTE_TOKEN=${fileToken}\n`, { PI_REMOTE_TOKEN: environmentToken });
  await joined(t, run.address, environmentToken); assert.ok(!run.output.includes(fileToken));
});
