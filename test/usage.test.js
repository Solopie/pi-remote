import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWeeklyUsage } from '../src/usage.js';
const token = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'private-account' } })).toString('base64url')}.signature`;
const model = { provider: 'openai-codex' };
const registry = { isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token }) };
const now = () => 1800000000000;
const response = data => async () => ({ ok: true, json: async () => data });

test('Codex weekly quota is used percentage, not remaining or the short window', async () => {
  const result = await fetchWeeklyUsage(model, registry, { now, fetch: async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers['ChatGPT-Account-Id'], 'private-account');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ plan_type: 'plus', secret: 'private-response', rate_limit: {
      primary_window: { limit_window_seconds: 18000, used_percent: 8 },
      secondary_window: { limit_window_seconds: 604800, used_percent: 66, reset_after_seconds: 3600 }
    } }) };
  } });
  assert.deepEqual(result, { provider: 'openai-codex', status: 'available', usedPercent: 66,
    resetsAt: now() + 3600000, updatedAt: now(), plan: 'plus' });
  for (const secret of [token, 'private-account', 'private-response']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('Claude OAuth weekly quota uses seven_day, with safe reset parsing', async () => {
  const data = await fetchWeeklyUsage({ provider: 'anthropic' }, { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'sk-ant-oat-test-secret' }) }, { now, fetch: async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
    return { ok: true, json: async () => ({ five_hour: { utilization: 80 }, seven_day: { utilization: 0, resets_at: '2027-02-01T00:00:00Z' } }) };
  } });
  assert.equal(data.status, 'available'); assert.equal(data.usedPercent, 0);
  assert.equal(data.resetsAt, Date.parse('2027-02-01T00:00:00Z'));
});

test('unsupported providers and API-key accounts do not make quota requests', async () => {
  const fetch = () => { assert.fail('Must not request usage'); };
  assert.equal((await fetchWeeklyUsage({ provider: 'openrouter' }, registry, { fetch })).status, 'unsupported');
  assert.equal((await fetchWeeklyUsage(model, { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'sk-api-key' }) }, { fetch })).status, 'unavailable');
});

test('errors, missing weekly windows and invalid percentages never report a made-up quota', async () => {
  const values = [{}, { rate_limit: { secondary_window: { limit_window_seconds: 18000, used_percent: 80 } } },
    ...[undefined, -1, 101, '66', NaN].map(used_percent => ({ rate_limit: { secondary_window: { limit_window_seconds: 604800, used_percent } } }))];
  for (const value of values) assert.equal((await fetchWeeklyUsage(model, registry, { fetch: response(value) })).status, 'unavailable');
  assert.equal((await fetchWeeklyUsage(model, registry, { fetch: async () => { throw Error(token); } })).status, 'unavailable');
  assert.equal((await fetchWeeklyUsage(model, registry, { fetch: async () => ({ ok: false }) })).status, 'unavailable');
  assert.equal((await fetchWeeklyUsage(model, { ...registry, getApiKeyAndHeaders: async () => ({ ok: false, error: token }) })).status, 'unavailable');
});

test('Codex primary windows can be weekly and provider reset timestamps are preserved', async () => {
  const data = await fetchWeeklyUsage(model, registry, { now, fetch: response({ rate_limit: {
    primary_window: { limit_window_seconds: 604800, used_percent: 100, reset_at: 1800003600 }
  } }) });
  assert.equal(data.usedPercent, 100); assert.equal(data.resetsAt, 1800003600000);
});
