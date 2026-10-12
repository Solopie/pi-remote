import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomToken } from './crypto.js';

/** @typedef {{url: string, token: string}} RemoteConfig */

/** @param {string} base */
export function normalizeRelayURL(base) {
  let url;
  try { url = new URL(base); }
  catch { throw new Error('Use a valid root HTTP(S) relay URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a root HTTP(S) URL without credentials, a path, query, or fragment.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Use HTTPS for a remote relay. HTTP is allowed only on localhost.');
  }
  return url.origin;
}

/** @param {unknown} value @returns {RemoteConfig} */
function validatedConfig(value) {
  if (!value || typeof value !== 'object' || !('url' in value) || !('token' in value)
    || typeof value.url !== 'string' || typeof value.token !== 'string' || value.token.length < 32) {
    throw new Error('Remote settings need a relay URL and a token of at least 32 characters.');
  }
  return { url: normalizeRelayURL(value.url), token: value.token };
}

/** @param {string} file @returns {Promise<RemoteConfig | undefined>} */
export async function readConfig(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read remote settings at ${file}. Run /remote setup to replace them, or set both PI_REMOTE_URL and PI_REMOTE_TOKEN.`);
  }
  try {
    const value = JSON.parse(text);
    if (value?.version !== 1) throw new Error('Unsupported settings version');
    return validatedConfig(value);
  } catch {
    // JSON parser errors can include file contents. Never include credentials in
    // errors that may reach the terminal, logs, or an RPC client.
    throw new Error(`Invalid remote settings at ${file}. Run /remote setup to replace them, or set both PI_REMOTE_URL and PI_REMOTE_TOKEN.`);
  }
}

/** @param {string} file @param {RemoteConfig} value @param {AbortSignal} [signal] */
export async function saveConfig(file, value, signal) {
  const config = validatedConfig(value);
  signal?.throwIfAborted();
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.pi-remote-${randomToken()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`, { flag: 'wx', mode: 0o600, signal });
    signal?.throwIfAborted();
    // Replacing the file atomically also ensures previously permissive modes
    // are not retained and existing symlinks are not followed when writing.
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

/** @param {string} file @param {NodeJS.ProcessEnv} env */
export async function resolveConfig(file, env) {
  // Explicit deployment settings take precedence and need not read a local
  // file at all when both variables are supplied.
  const saved = env.PI_REMOTE_URL && env.PI_REMOTE_TOKEN ? undefined : await readConfig(file);
  const url = normalizeRelayURL(env.PI_REMOTE_URL || saved?.url || 'http://localhost:8787');
  if (saved && env.PI_REMOTE_URL && !env.PI_REMOTE_TOKEN && url !== saved.url) {
    throw new Error('Set PI_REMOTE_TOKEN too when overriding the saved relay URL, or run /remote setup. Saved tokens are not sent to a different relay.');
  }
  return { url, token: env.PI_REMOTE_TOKEN || saved?.token };
}
