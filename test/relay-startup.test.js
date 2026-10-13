import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { randomToken } from '../src/crypto.js';

function launch(t, token) {
  const env = { ...process.env, HOST: '127.0.0.1', PORT: '0', PI_REMOTE_TRUSTED_PROXIES: '' };
  if (token === undefined) delete env.PI_REMOTE_TOKEN; else env.PI_REMOTE_TOKEN = token;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  return { child, closed, get output() { return output; }, get errors() { return errors; } };
}

async function ready(run, configured) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const address = run.output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    const token = configured ?? run.output.match(/PI_REMOTE_TOKEN=([A-Za-z0-9_-]{43})\n/)?.[1];
    if (address && token) return { address, token };
    assert.equal(run.child.exitCode, null, 'Relay exited before becoming ready');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Relay did not start within five seconds');
}

async function host(t, address, token) {
  const ws = new WebSocket(address.replace('http:', 'ws:') + '/ws');
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const response = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'join', role: 'host', room: randomToken(), token }));
  return JSON.parse((await response)[0]);
}

test('relay CLI generates a strong token, requires it for Pi hosts, and never serves it over HTTP', async t => {
  const run = launch(t), { address, token } = await ready(run);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.equal(run.output.split(`PI_REMOTE_TOKEN=${token}`).length - 1, 1);
  assert.match(run.output, /keep private/);
  assert.equal((await host(t, address, token)).type, 'joined');
  const bad = new WebSocket(address.replace('http:', 'ws:') + '/ws');
  t.after(() => bad.terminate()); await once(bad, 'open');
  const rejection = once(bad, 'close');
  bad.send(JSON.stringify({ type: 'join', role: 'host', room: randomToken(), token: randomToken() }));
  assert.equal((await rejection)[0], 1008);
  const page = await fetch(address);
  assert.equal(page.status, 200); assert.ok(!(await page.text()).includes(token));
  assert.equal((await fetch(`${address}/pi-remote.json`)).status, 404);
});

test('automatic relay tokens rotate between startups; explicit relay tokens are reused without being logged', async t => {
  const first = await ready(launch(t)), second = await ready(launch(t));
  assert.notEqual(first.token, second.token);
  const run = launch(t, first.token), { address, token } = await ready(run, first.token);
  assert.equal(token, first.token); assert.ok(!run.output.includes(first.token));
  assert.ok(!run.output.includes('Generated relay token'));
  assert.equal((await host(t, address, first.token)).type, 'joined');
});

test('explicitly invalid relay tokens fail closed instead of silently generating replacements', async t => {
  for (const token of ['', 'too-short']) {
    const run = launch(t, token), [code] = await run.closed;
    assert.notEqual(code, 0); assert.match(run.errors, /PI_REMOTE_TOKEN must contain at least 32 characters/);
    assert.ok(!run.output.includes('Generated relay token'));
    assert.ok(!run.output.includes('listening on'));
  }
});
