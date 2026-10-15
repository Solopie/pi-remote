import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createGoogleAuth, googleConfig, verifyGoogleToken } from '../src/auth.js';
import { createRelay } from '../src/server.js';
import { randomToken, seal, open } from '../src/crypto.js';

const config = { clientId: 'test-client', clientSecret: 'private-oauth-secret', allowedEmail: 'owner@example.com', origin: 'https://relay.example' };
async function fixture(t, options = {}, authConfig = config) {
  let nonce, exchange, claims = {};
  const auth = createGoogleAuth(authConfig, { fetchToken: async (_url, request) => {
    exchange = new URLSearchParams(request.body); return { ok: true, json: async () => ({ id_token: 'signed-test-token' }) };
  }, verifyToken: async () => ({ sub: 'owner-subject', email: config.allowedEmail, email_verified: true, nonce, ...claims }), ...options });
  const token = randomToken(), relay = createRelay({ token, auth });
  relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening');
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${relay.server.address().port}`;
  const request = (path, cookie = '', init = {}) => fetch(base + path, { redirect: 'manual', ...init, headers: { Cookie: cookie, ...init.headers } });
  async function begin() {
    const response = await request('/auth/google/start'); assert.equal(response.status, 303);
    const url = new URL(response.headers.get('location')); nonce = url.searchParams.get('nonce');
    return { url, state: url.searchParams.get('state'), cookie: response.headers.getSetCookie()[0].split(';')[0] };
  }
  async function callback(flow, cookie = flow.cookie) { return request(`/auth/google/callback?state=${flow.state}&code=test-code`, cookie); }
  async function login() {
    const flow = await begin(), response = await callback(flow); assert.equal(response.status, 303);
    const cookie = response.headers.getSetCookie().find(item => item.startsWith('__Host-pi-remote-session=')).split(';')[0];
    return { cookie, flow, response, me: await (await request('/api/auth', cookie)).json() };
  }
  async function socket(role, room, cookie = '', extra = {}) {
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { Cookie: cookie } });
    await once(ws, 'open'); const message = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'join', role, room, ...(role === 'host' ? { token } : {}), ...extra }));
    return { ws, message };
  }
  return { auth, token, relay, request, begin, callback, login, socket, get exchange() { return exchange; }, setClaims(value) { claims = value; } };
}

test('Google configuration is optional, but partial or unsafe configuration fails closed without exposing secrets', () => {
  assert.equal(googleConfig({}), undefined);
  assert.throws(() => googleConfig({ PI_REMOTE_GOOGLE_CLIENT_SECRET: 'private-oauth-secret' }), error => !error.message.includes('private-oauth-secret'));
  assert.throws(() => createGoogleAuth({ ...config, origin: 'http://remote.example' }));
  assert.throws(() => createGoogleAuth({ ...config, allowedEmail: 'owner@example.com,other@example.com' }));
});

test('production JWT verification enforces signature, issuer, audience, expiration, required claims, and RS256', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test';
  const keys = createLocalJWKSet({ keys: [jwk] });
  const signed = overrides => new SignJWT({ email: config.allowedEmail, email_verified: true, nonce: 'nonce', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://accounts.google.com').setAudience(config.clientId)
    .setSubject('owner').setIssuedAt().setExpirationTime('1h').sign(privateKey);
  assert.equal((await verifyGoogleToken(await signed({}), config.clientId, keys)).email, config.allowedEmail);
  await assert.rejects(verifyGoogleToken(await signed({}), 'wrong-audience', keys));
  const badIssuer = await new SignJWT({ email: config.allowedEmail, email_verified: true, nonce: 'nonce' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://evil.example').setAudience(config.clientId)
    .setSubject('owner').setIssuedAt().setExpirationTime('1h').sign(privateKey);
  await assert.rejects(verifyGoogleToken(badIssuer, config.clientId, keys));
  const expired = await new SignJWT({ email: config.allowedEmail, email_verified: true, nonce: 'nonce' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://accounts.google.com').setAudience(config.clientId)
    .setSubject('owner').setIssuedAt().setExpirationTime('1 second ago').sign(privateKey);
  await assert.rejects(verifyGoogleToken(expired, config.clientId, keys));
  await assert.rejects(verifyGoogleToken(await signed({ nonce: undefined }), config.clientId, keys));
  const missingExpiration = await new SignJWT({ email: config.allowedEmail, email_verified: true, nonce: 'nonce' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://accounts.google.com').setAudience(config.clientId)
    .setSubject('owner').setIssuedAt().sign(privateKey);
  await assert.rejects(verifyGoogleToken(missingExpiration, config.clientId, keys));
  const hmac = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('a'.repeat(32)));
  await assert.rejects(verifyGoogleToken(hmac, config.clientId, keys));
  const { publicKey: other } = await generateKeyPair('RS256'); const wrongKey = await exportJWK(other); wrongKey.kid = 'test';
  await assert.rejects(verifyGoogleToken(await signed({}), config.clientId, createLocalJWKSet({ keys: [wrongKey] })));
});

test('login uses PKCE, state, nonce, cookie binding, one-use transactions, secure cookies, and no OAuth secrets in redirects', async t => {
  const h = await fixture(t), flow = await h.begin();
  assert.equal(flow.url.origin, 'https://accounts.google.com');
  assert.equal(flow.url.searchParams.get('redirect_uri'), config.origin + '/auth/google/callback');
  assert.equal(flow.url.searchParams.get('scope'), 'openid email');
  assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(flow.url.searchParams.has('client_secret'), false);
  assert.equal((await h.callback(flow, '')).status, 400);
  const response = await h.callback(flow); assert.equal(response.status, 303);
  assert.equal(h.exchange.get('client_secret'), config.clientSecret); assert.ok(h.exchange.get('code_verifier'));
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax') && cookie.includes('Secure')));
  assert.ok(!cookies.join('').includes('signed-test-token'));
  assert.equal((await h.callback(flow)).status, 400);
});

test('only the verified configured Google email and matching nonce may authenticate', async t => {
  const h = await fixture(t);
  for (const claims of [{ email: 'other@example.com' }, { email_verified: false }, { email_verified: 'true' }, { nonce: 'wrong' }, { sub: '' }]) {
    h.setClaims(claims); const flow = await h.begin(), response = await h.callback(flow);
    assert.equal(response.status, 403); assert.ok(!(await response.text()).includes(config.clientSecret));
    assert.equal((await h.request('/api/sessions')).status, 401);
  }
  h.setClaims({ email: config.allowedEmail.toUpperCase() }); assert.equal((await h.login()).me.authenticated, true);
});

test('login transactions expire and expire authenticated sessions deny HTTP and WebSocket commands', async t => {
  let now = Date.now(); const h = await fixture(t, { now: () => now, sessionTTL: 1000 });
  const flow = await h.begin(); now += 300001; assert.equal((await h.callback(flow)).status, 400);
  const user = await h.login(), room = randomToken(), key = randomToken();
  const host = await h.socket('host', room, '', { discovery: { name: 'Private session', key } }); await host.message;
  const client = await h.socket('client', room, user.cookie); await client.message;
  const closed = once(client.ws, 'close'); now += 1001;
  client.ws.send(JSON.stringify({ type: 'command', payload: seal(key, { action: 'interrupt' }, 'client', 'command') }));
  assert.equal((await closed)[0], 4401);
  assert.equal((await h.request('/api/sessions', user.cookie)).status, 401);
});

test('authenticated dashboard lists connected sessions, releases only opted-in keys, and revokes on logout and remote off', async t => {
  const h = await fixture(t), user = await h.login(), room = randomToken(), key = randomToken();
  const host = await h.socket('host', room, '', { discovery: { name: '<script>private title</script>', key } }); await host.message;
  const legacyRoom = randomToken(), legacy = await h.socket('host', legacyRoom); await legacy.message;
  assert.equal((await h.request('/api/sessions')).status, 401);
  assert.equal((await h.request(`/api/sessions/${room}`)).status, 401);
  const list = await (await h.request('/api/sessions', user.cookie)).json();
  assert.equal(list.sessions.length, 2); assert.equal(list.sessions[0].connectable, true); assert.equal(list.sessions[1].connectable, false);
  assert.ok(!JSON.stringify(list).includes(key)); assert.ok(!JSON.stringify(list).includes(h.token));
  assert.deepEqual(await (await h.request(`/api/sessions/${room}`, user.cookie)).json(), { room, key });
  assert.equal((await h.request(`/api/sessions/${legacyRoom}`, user.cookie)).status, 404);
  const client = await h.socket('client', room, user.cookie); await client.message;
  const received = once(host.ws, 'message'); client.ws.send(JSON.stringify({ type: 'command', payload: seal(key, { action: 'interrupt' }, 'client', 'command') }));
  assert.equal(open(key, JSON.parse((await received)[0]).payload, 'client', 'command').action, 'interrupt');
  assert.equal((await h.request('/auth/logout', user.cookie)).status, 403);
  assert.equal((await h.request('/auth/logout', user.cookie, { method: 'POST', headers: { Origin: config.origin, 'X-CSRF-Token': 'wrong' } })).status, 403);
  const closed = once(client.ws, 'close');
  assert.equal((await h.request('/auth/logout', user.cookie, { method: 'POST', headers: { Origin: config.origin, 'X-CSRF-Token': user.me.csrf } })).status, 200);
  assert.equal((await closed)[0], 4401); assert.equal((await h.request('/api/sessions', user.cookie)).status, 401);
  const next = await h.login(); host.ws.send(JSON.stringify({ type: 'leave' })); await once(host.ws, 'close');
  assert.equal((await h.request(`/api/sessions/${room}`, next.cookie)).status, 404);
});

test('unauthenticated sockets cannot bypass Google using a known room, and browser upgrades require cookies and exact origin', async t => {
  const h = await fixture(t), room = randomToken(); const host = await h.socket('host', room); await host.message;
  const ws = new WebSocket(`ws://127.0.0.1:${h.relay.server.address().port}/ws`); await once(ws, 'open');
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'join', role: 'client', room })); assert.equal((await closed)[0], 4401);
  for (const headers of [{ Origin: config.origin }, { Origin: 'https://evil.example' }]) {
    const browser = new WebSocket(`ws://127.0.0.1:${h.relay.server.address().port}/ws`, { headers });
    browser.on('error', () => {}); await new Promise(resolve => browser.once('close', resolve));
  }
});

test('dashboard activity follows trusted encrypted snapshots and resets on reconnect', async t => {
  const h = await fixture(t), user = await h.login(), room = randomToken(), key = randomToken();
  const host = await h.socket('host', room, '', { discovery: { name: 'Working session', key } }); await host.message;
  const privateRoom = randomToken(), privateKey = randomToken();
  const privateHost = await h.socket('host', privateRoom); await privateHost.message;
  const client = await h.socket('client', room, user.cookie); await client.message;
  const list = async () => (await (await h.request('/api/sessions', user.cookie)).json()).sessions;
  assert.equal((await list()).find(s => s.room === room).status, 'unknown');
  let revision = 0;
  const update = async (state, expected, encryptionKey = key, type = 'state') => {
    const received = once(client.ws, 'message');
    host.ws.send(JSON.stringify({ type: 'state', payload: seal(encryptionKey, { revision: ++revision, ...state }, 'host', type) }));
    await received;
    const sessions = await list();
    assert.equal(sessions.find(s => s.room === room).status, expected);
    assert.ok(!JSON.stringify(sessions).includes(key));
  };
  await update({ busy: false, submitting: false }, 'idle');
  await update({ busy: true, submitting: false, name: 'Renamed chat' }, 'running');
  assert.equal((await list()).find(s => s.room === room).name, 'Renamed chat');
  await update({ busy: false, submitting: true }, 'running');
  await update({ busy: false, submitting: false }, 'idle');
  await update({ busy: 'false', submitting: false }, 'unknown');
  await update({ busy: false, submitting: false }, 'unknown', randomToken());
  await update({ busy: false, submitting: false }, 'unknown', key, 'ack');
  // A non-enrolled session stays opaque even when its snapshot resembles status.
  const privateClient = await h.socket('client', privateRoom, user.cookie); await privateClient.message;
  const received = once(privateClient.ws, 'message');
  privateHost.ws.send(JSON.stringify({ type: 'state', payload: seal(privateKey, { busy: true, submitting: false }, 'host', 'state') }));
  await received;
  assert.equal((await list()).find(s => s.room === privateRoom).status, 'unknown');
  await update({ busy: true, submitting: false }, 'running');
  const offline = once(client.ws, 'message'); host.ws.close(); await offline;
  assert.equal((await list()).some(s => s.room === room), false);
  const reconnected = await h.socket('host', room, '', { discovery: { name: 'Working session', key } }); await reconnected.message;
  assert.equal((await list()).find(s => s.room === room).status, 'unknown');
});


test('preview uses the shared callback with isolated state and cookies', async t => {
  const previewConfig = { ...config, origin: 'https://relay.example:18789',
    redirectURI: 'https://relay.example/auth/google/callback', authNamespace: 'preview' };
  const h = await fixture(t, {}, previewConfig), flow = await h.begin();
  assert.equal(flow.url.searchParams.get('redirect_uri'), previewConfig.redirectURI);
  assert.match(flow.state, /^pi_remote_preview_[A-Za-z0-9_-]{43}$/);
  assert.match(flow.cookie, /^__Host-preview-pi-remote-flow=/);
  assert.equal((await h.callback(flow, flow.cookie.replace('preview-pi-remote', 'pi-remote'))).status, 400);
  const response = await h.callback(flow);
  assert.equal(response.status, 303);
  assert.equal(h.exchange.get('redirect_uri'), previewConfig.redirectURI);
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.every(cookie => cookie.startsWith('__Host-preview-pi-remote-')));
  const cookie = cookies.find(cookie => cookie.startsWith('__Host-preview-pi-remote-session=')).split(';')[0];
  assert.equal((await (await h.request('/api/auth', cookie)).json()).authenticated, true);
  const legacy = await (await h.request('/api/auth', cookie.replace('preview-pi-remote', 'pi-remote'))).json();
  assert.equal(legacy.authenticated, false);
});

test('shared callbacks reject foreign hosts, unsafe paths and invalid cookie namespaces', () => {
  for (const redirectURI of ['https://evil.example/auth/google/callback', 'https://relay.example/other',
    'https://relay.example/auth/google/callback?next=evil', 'http://relay.example/auth/google/callback']) {
    assert.throws(() => createGoogleAuth({ ...config, redirectURI }));
  }
  assert.throws(() => createGoogleAuth({ ...config, authNamespace: '../invalid' }));
});
