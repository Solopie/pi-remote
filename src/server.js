import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { randomToken } from './crypto.js';
import { createGoogleAuth, googleConfig } from './auth.js';
import { WebSocketServer, WebSocket } from 'ws';

const ROOM_ID = /^[A-Za-z0-9_-]{43}$/;
const send = (ws, value) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > 2_000_000) return ws.close(1013, 'Slow connection');
  ws.send(JSON.stringify(value));
};
const equals = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b)
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createRelay({ token, roomTTL = 300000, maxRooms = 100, maxConnections = 200, maxUnauthenticated = 32, maxUnauthenticatedPerIP = 8,
  maxUpgradesPerMinute = 60, maxTrackedIPs = 1000, trustedProxies = [], google, auth: suppliedAuth } = {}) {
  if (!token || token.length < 32) throw new Error('PI_REMOTE_TOKEN must contain at least 32 characters');
  if (!Array.isArray(trustedProxies) || trustedProxies.some(ip => !isIP(ip))) throw new Error('trustedProxies must contain exact IP addresses');
  const proxies = new Set(trustedProxies);
  const auth = suppliedAuth || (google ? createGoogleAuth(google) : undefined);
  const rooms = new Map(), admissions = new Map();
  let unauthenticated = 0;
  const assets = {'/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
    '/style.css': ['style.css', 'text/css'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json']};
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const path = req.url?.split('?')[0];
    try {
      if (auth && await auth.handle(req, res, path)) return;
      if (path === '/api/auth' && req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ enabled: false, authenticated: false }));
      }
      if (path === '/api/sessions' || /^\/api\/sessions\/[A-Za-z0-9_-]{43}$/.test(path || '')) {
        const user = auth?.session(req);
        res.setHeader('Content-Type', 'application/json');
        if (!user) { res.writeHead(401); return res.end(JSON.stringify({ error: 'Sign-in required.' })); }
        if (req.method !== 'GET') { res.writeHead(405); return res.end(JSON.stringify({ error: 'Method not allowed.' })); }
        if (path === '/api/sessions') return res.end(JSON.stringify({ sessions: [...rooms.values()].filter(room => room.host).map(room => ({
          room: room.id, name: room.discovery?.name || 'Pi session', connectable: !!room.discovery })) }));
        const room = rooms.get(path.slice('/api/sessions/'.length));
        if (!room?.host || !room.discovery) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Session unavailable or not enrolled.' })); }
        return res.end(JSON.stringify({ room: room.id, key: room.discovery.key }));
      }
    } catch { res.writeHead(500); return res.end('Authentication unavailable'); }
    const asset = assets[path];
    if (req.method !== 'GET' || !asset) { res.writeHead(404); return res.end('Not found'); }
    try {
      const body = await readFile(fileURLToPath(new URL(`../public/${asset[0]}`, import.meta.url)));
      res.setHeader('Content-Type', `${asset[1]}; charset=utf-8`); res.end(body);
    } catch { res.writeHead(500); res.end('Unavailable'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    // Browsers must connect from this application's origin. Non-browser pi hosts have no Origin.
    const origin = req.headers.origin;
    let allowed = !origin;
    try { if (origin) allowed = auth ? new URL(origin).origin === auth.origin : new URL(origin).host === req.headers.host; } catch {}
    const user = auth?.session(req);
    if (auth && origin && !user) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    if (req.url !== '/ws' || !allowed || wss.clients.size >= maxConnections) return socket.destroy();
    // Only explicitly trusted TCP peers may supply a single client address.
    // The proxy MUST overwrite X-Real-IP, and the backend must stay private.
    let ip = req.socket.remoteAddress;
    if (proxies.has(ip)) {
      const clientIP = req.headers['x-real-ip'];
      if (typeof clientIP !== 'string' || !isIP(clientIP)) return socket.destroy();
      ip = clientIP;
    }
    const now = Date.now();
    let admission = admissions.get(ip);
    if (!admission) {
      if (admissions.size >= maxTrackedIPs) return socket.destroy();
      admission = { start: now, attempts: 0, pending: 0 }; admissions.set(ip, admission);
    }
    if (now - admission.start >= 60000) { admission.start = now; admission.attempts = 0; }
    if (unauthenticated >= maxUnauthenticated || admission.pending >= maxUnauthenticatedPerIP
      || ++admission.attempts > maxUpgradesPerMinute) return socket.destroy();
    unauthenticated++; admission.pending++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; unauthenticated--; admission.pending--;
    };
    socket.once('close', release);
    try {
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, release, user));
    } catch { release(); socket.destroy(); }
  });
  wss.on('connection', (ws, release, user) => {
    ws.authSession = user;
    let room, role, joined = false, windowStart = Date.now(), count = 0;
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    const deadline = setTimeout(() => ws.terminate(), 5000);
    ws.on('message', raw => {
      try {
        if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; }
        if (++count > 30) return ws.close(1008, 'Rate limit');
        const msg = JSON.parse(raw.toString());
        if (auth && (role === 'client' || (!joined && msg.role === 'client')) && !auth.valid(user)) return ws.close(4401, 'Sign-in required');
        if (!joined) {
          if (msg.type !== 'join' || typeof msg.room !== 'string' || !ROOM_ID.test(msg.room) || !['host', 'client'].includes(msg.role)) throw Error();
          role = msg.role;
          if (role === 'host') {
            if (!equals(msg.token, token)) throw Error();
            room = rooms.get(msg.room);
            if (!room) {
              if (rooms.size >= maxRooms) return ws.close(1013, 'Room capacity reached');
              room = { id: msg.room, host: null, clients: new Set(), state: null, touched: Date.now() };
              rooms.set(msg.room, room);
            }
            // An asymmetric disconnect can leave the previous host alive until
            // heartbeat cleanup. This is retryable, not an authentication error.
            if (room.host) return ws.close(1013, 'Host connection still active');
            // Keys are accepted only in authenticated-dashboard mode and only when
            // Pi explicitly opted in. Transport-only relays ignore discovery fields.
            let discovery;
            if (auth && msg.discovery !== undefined) {
              if (!msg.discovery || typeof msg.discovery.key !== 'string' || !ROOM_ID.test(msg.discovery.key) || typeof msg.discovery.name !== 'string' || msg.discovery.name.length > 256) throw Error();
              discovery = { key: msg.discovery.key, name: msg.discovery.name };
            }
            room.discovery = discovery; room.host = ws; room.touched = Date.now();
          } else {
            room = rooms.get(msg.room);
            if (!room) throw Error();
            // Stale peers may occupy slots until heartbeat cleanup. Keep the
            // pairing retryable rather than treating capacity as revocation.
            if (room.clients.size >= 4) return ws.close(1013, 'Client capacity reached');
            room.clients.add(ws);
          }
          joined = true; clearTimeout(deadline); release();
          send(ws, { type: 'joined', online: !!room.host, ...(auth && role === 'host' ? { discovery: true } : {}) });
          if (role === 'client' && room.state) send(ws, { type: 'state', payload: room.state });
          if (role === 'host') for (const client of room.clients) send(client, { type: 'presence', online: true });
          return;
        }
        if (role === 'host') room.touched = Date.now();
        if (msg.type === 'leave' && role === 'host') {
          rooms.delete(room.id);
          for (const client of room.clients) client.close(1008, 'Remote access revoked');
          return ws.close(1000);
        }
        if (!msg.payload || typeof msg.payload.iv !== 'string' || typeof msg.payload.data !== 'string') throw Error();
        if (role === 'host' && ['state', 'ack'].includes(msg.type)) {
          if (msg.type === 'state') room.state = msg.payload;
          for (const client of room.clients) send(client, { type: msg.type, payload: msg.payload });
        } else if (role === 'client' && msg.type === 'command') {
          if (!room.host) return send(ws, { type: 'presence', online: false });
          send(room.host, { type: 'command', payload: msg.payload });
        } else throw Error();
      } catch { ws.close(1008, 'Invalid request'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(deadline); release();
      if (!joined) return;
      if (role === 'host' && room.host === ws) {
        room.host = null; room.touched = Date.now();
        for (const client of room.clients) send(client, { type: 'presence', online: false });
      } else room.clients.delete(ws);
    });
  });
  const unsubscribe = auth?.onRevoke(user => {
    for (const ws of wss.clients) if (ws.authSession === user) ws.close(4401, 'Sign-in required');
  });
  const sweep = setInterval(() => {
    for (const [ip, admission] of admissions) if (!admission.pending && Date.now() - admission.start >= 60000) admissions.delete(ip);
    for (const ws of wss.clients) {
      if (auth && ws.authSession && !auth.valid(ws.authSession)) { ws.close(4401, 'Sign-in required'); continue; }
      if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); }
    }
    for (const [id, room] of rooms) if (!room.host && Date.now() - room.touched > roomTTL) {
      for (const client of room.clients) client.close(1008, 'Session expired');
      rooms.delete(id);
    }
  }, 15000);
  sweep.unref();
  return { server, rooms, close: async () => {
    clearInterval(sweep); unsubscribe?.(); auth?.close(); for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(process.argv[1]))) {
  const generated = process.env.PI_REMOTE_TOKEN === undefined;
  const token = generated ? randomToken() : process.env.PI_REMOTE_TOKEN;
  const relay = createRelay({ token, google: googleConfig(),
    trustedProxies: (process.env.PI_REMOTE_TRUSTED_PROXIES || '').split(',').map(ip => ip.trim()).filter(Boolean) });
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
  relay.server.listen(port, host, () => {
    const address = relay.server.address();
    const boundPort = address && typeof address === 'object' ? address.port : port;
    const hostname = host.includes(':') ? `[${host}]` : host;
    console.log(`pi-remote relay listening on http://${hostname}:${boundPort}`);
    if (generated) console.log(`Generated relay token — keep private:\nPI_REMOTE_TOKEN=${token}\nPaste this token into /remote setup on each Pi client.\nA new token is generated on each restart unless PI_REMOTE_TOKEN is explicitly configured.`);
  });
}
