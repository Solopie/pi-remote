import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomToken } from './crypto.js';
import { normalizeRelayURL } from './config.js';

const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function cookies(req) {
  const result = new Map();
  for (const item of (req.headers.cookie || '').split(';')) {
    const index = item.indexOf('=');
    if (index > 0) result.set(item.slice(0, index).trim(), item.slice(index + 1).trim());
  }
  return result;
}
export function googleConfig(env = process.env) {
  const values = [env.PI_REMOTE_GOOGLE_CLIENT_ID, env.PI_REMOTE_GOOGLE_CLIENT_SECRET, env.PI_REMOTE_ALLOWED_EMAIL, env.PI_REMOTE_PUBLIC_URL];
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => !value?.trim())) throw Error('Google login requires PI_REMOTE_GOOGLE_CLIENT_ID, PI_REMOTE_GOOGLE_CLIENT_SECRET, PI_REMOTE_ALLOWED_EMAIL, and PI_REMOTE_PUBLIC_URL.');
  return { clientId: values[0], clientSecret: values[1], allowedEmail: values[2], origin: values[3] };
}

// Injectable transport/verifier/clock make tests independent of Google and model APIs.
export async function verifyGoogleToken(token, clientId, keys = jwks) {
  return (await jwtVerify(token, keys, { audience: clientId, issuer: ['https://accounts.google.com', 'accounts.google.com'],
    algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email', 'email_verified'] })).payload;
}
export function createGoogleAuth(config, { fetchToken = fetch, verifyToken = token => verifyGoogleToken(token, config.clientId),
  now = Date.now, sessionTTL = 8 * 60 * 60 * 1000 } = {}) {
  const origin = normalizeRelayURL(config.origin), secure = origin.startsWith('https:');
  if (!config.clientId?.trim() || !config.clientSecret?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.allowedEmail || '')) throw Error('Invalid Google login configuration.');
  const allowedEmail = config.allowedEmail.toLowerCase();
  const redirectURI = `${origin}/auth/google/callback`;
  const sessionCookie = secure ? '__Host-pi-remote-session' : 'pi-remote-session';
  const flowCookie = secure ? '__Host-pi-remote-flow' : 'pi-remote-flow';
  const flows = new Map(), sessions = new Map(), listeners = new Set();
  let exchanges = 0;
  const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const redirect = (res, url) => { res.writeHead(303, { Location: url }); res.end(); };
  const prune = () => {
    for (const [id, flow] of flows) if (flow.expires <= now()) flows.delete(id);
    for (const [id, session] of sessions) if (session.expires <= now()) { sessions.delete(id); for (const listener of listeners) listener(session); }
  };
  const session = req => { prune(); return sessions.get(cookies(req).get(sessionCookie)); };
  return { origin, redirectURI, session, onRevoke: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    valid: value => { prune(); return !!value && sessions.get(value.id) === value; },
    close: () => { flows.clear(); sessions.clear(); listeners.clear(); },
    async handle(req, res, path) {
      if (path === '/api/auth' && req.method === 'GET') {
        const user = session(req);
        json(res, 200, { enabled: true, authenticated: !!user, ...(user ? { email: user.email, csrf: user.csrf } : {}) }); return true;
      }
      if (path === '/auth/google/start' && req.method === 'GET') {
        prune();
        if (flows.size >= 128) { json(res, 429, { error: 'Too many login attempts. Try again later.' }); return true; }
        const state = randomToken(), binding = randomToken(), verifier = randomToken(), nonce = randomToken();
        flows.set(state, { binding, verifier, nonce, expires: now() + 300000 });
        res.setHeader('Set-Cookie', cookie(flowCookie, binding, 300));
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectURI, response_type: 'code', scope: 'openid email',
          state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
        redirect(res, url.href); return true;
      }
      if (path === '/auth/google/callback' && req.method === 'GET') {
        const url = new URL(req.url, origin), state = url.searchParams.get('state');
        prune(); const flow = flows.get(state);
        // A cross-browser request must not consume another browser's login transaction.
        if (!flow || !equal(cookies(req).get(flowCookie), flow.binding)) { json(res, 400, { error: 'Invalid or expired login. Start again.' }); return true; }
        flows.delete(state); res.setHeader('Set-Cookie', cookie(flowCookie, '', 0));
        if (exchanges >= 32) { json(res, 429, { error: 'Too many login attempts. Try again later.' }); return true; }
        exchanges++;
        try {
          const code = url.searchParams.get('code');
          if (!code || code.length > 4096 || url.searchParams.has('error')) throw Error();
          const response = await fetchToken('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(10000),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: config.clientId,
              client_secret: config.clientSecret, redirect_uri: redirectURI, grant_type: 'authorization_code', code_verifier: flow.verifier }) });
          if (!response.ok) throw Error();
          const tokens = await response.json();
          if (typeof tokens.id_token !== 'string' || tokens.id_token.length > 32000) throw Error();
          const claims = await verifyToken(tokens.id_token);
          if (!equal(claims.nonce, flow.nonce) || claims.email_verified !== true || typeof claims.email !== 'string'
            || claims.email.toLowerCase() !== allowedEmail || typeof claims.sub !== 'string' || !claims.sub) throw Error();
          prune(); if (sessions.size >= 128) throw Error();
          const id = randomToken(), previous = session(req);
          if (previous) { sessions.delete(previous.id); for (const listener of listeners) listener(previous); }
          sessions.set(id, { id, email: allowedEmail, subject: claims.sub, csrf: randomToken(), expires: now() + sessionTTL });
          res.setHeader('Set-Cookie', [cookie(flowCookie, '', 0), cookie(sessionCookie, id, Math.ceil(sessionTTL / 1000))]);
          redirect(res, '/');
        } catch { json(res, 403, { error: 'Sign-in denied. Use the allowed Google account, or start login again.' }); }
        finally { exchanges--; }
        return true;
      }
      if (path === '/auth/logout') {
        const user = session(req);
        if (req.method !== 'POST' || req.headers.origin !== origin || !user || !equal(req.headers['x-csrf-token'], user.csrf)) {
          json(res, 403, { error: 'Invalid logout request.' }); return true;
        }
        sessions.delete(user.id); for (const listener of listeners) listener(user);
        res.setHeader('Set-Cookie', cookie(sessionCookie, '', 0)); json(res, 200, { ok: true }); return true;
      }
      return false;
    }
  };
}
