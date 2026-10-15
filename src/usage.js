const WEEK = 7 * 24 * 60 * 60;
/** @typedef {{provider: string, status: string, usedPercent: number|null, resetsAt: number|null, updatedAt: number|null, plan: string|null}} WeeklyUsage */
/** @returns {WeeklyUsage} */
export function unavailableUsage(provider = '', status = 'unavailable') {
  return { provider: provider.slice(0, 128), status, usedPercent: null, resetsAt: null, updatedAt: null, plan: null };
}
const percentage = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;

// Only bounded usage data leaves this module; credentials and raw API responses never do.
/**
 * @param {any} model
 * @param {any} registry
 * @param {{fetch?: typeof globalThis.fetch, now?: () => number, signal?: AbortSignal}} options
 * @returns {Promise<WeeklyUsage>}
 */
export async function fetchWeeklyUsage(model, registry, { fetch: request = fetch, now = Date.now, signal } = {}) {
  const provider = model?.provider || '';
  const empty = unavailableUsage(provider);
  if (!['openai-codex', 'anthropic'].includes(provider)) return unavailableUsage(provider, 'unsupported');
  try {
    const auth = await registry?.getApiKeyAndHeaders(model);
    if (!auth?.ok || !auth.apiKey) return empty;
    // The SDK's isUsingOAuth flag is not reliable for every native provider.
    // Codex must have an account-bearing JWT; Claude must use an OAuth token.
    if (provider === 'anthropic' && !auth.apiKey.startsWith('sk-ant-oat')) return empty;
    const headers = { Authorization: `Bearer ${auth.apiKey}` };
    let url;
    if (provider === 'openai-codex') {
      // The Codex provider itself obtains this account ID from the bearer JWT.
      const claims = JSON.parse(Buffer.from(auth.apiKey.split('.')[1], 'base64url').toString());
      const account = claims['https://api.openai.com/auth']?.chatgpt_account_id;
      if (typeof account !== 'string' || !account || account.length > 256) return empty;
      headers['ChatGPT-Account-Id'] = account;
      url = 'https://chatgpt.com/backend-api/wham/usage';
    } else {
      headers['anthropic-beta'] = 'oauth-2025-04-20';
      url = 'https://api.anthropic.com/api/oauth/usage';
    }
    const response = await request(url, { headers, redirect: 'error', signal });
    if (!response.ok) return empty;
    const data = await response.json(), updatedAt = now();
    let usedPercent, resetsAt = null, plan = null;
    if (provider === 'openai-codex') {
      const window = [data.rate_limit?.primary_window, data.rate_limit?.secondary_window]
        .find(window => window?.limit_window_seconds === WEEK);
      if (!window || !percentage(window.used_percent)) return empty;
      usedPercent = window.used_percent;
      if (Number.isFinite(window.reset_at) && window.reset_at > 0) resetsAt = window.reset_at * 1000;
      else if (Number.isFinite(window.reset_after_seconds) && window.reset_after_seconds >= 0) resetsAt = updatedAt + window.reset_after_seconds * 1000;
      if (typeof data.plan_type === 'string') plan = data.plan_type.slice(0, 64);
    } else {
      if (!percentage(data.seven_day?.utilization)) return empty;
      usedPercent = data.seven_day.utilization;
      const reset = typeof data.seven_day.resets_at === 'string' ? Date.parse(data.seven_day.resets_at) : NaN;
      if (Number.isFinite(reset)) resetsAt = reset;
    }
    if (!Number.isSafeInteger(resetsAt) || resetsAt <= 0) resetsAt = null;
    return { provider: provider.slice(0, 128), status: 'available', usedPercent, resetsAt, updatedAt, plan };
  } catch { return empty; }
}
