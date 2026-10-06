/*
 * HTTP layer.
 *
 * Browser reality: most provider origins do not send CORS headers, so a
 * direct fetch fails. MovieBox additionally requires HMAC-MD5 signing and
 * spoofed headers which browsers forbid setting directly. We therefore
 * support a user-configured relay (proxy):
 *
 *   POST {proxyBase}
 *   body:   { url, method, headers, body }
 *   reply:  { status, headers, body }        (body = text)
 *
 * Settings:  proxyMode = 'auto' | 'always' | 'never'
 *   auto   → try direct first, fall back to the proxy on network/CORS failure
 *   always → always use the proxy
 *   never  → direct only (works for CORS-enabled hosts like Cinemeta)
 *
 * No proxy is bundled: users point this at their own relay. When a provider
 * needs a proxy and none is configured, callers receive a `proxy_required`
 * ProviderError and the UI explains exactly what to do.
 */

import { getSettings } from './state.js';

export const ERROR_KINDS = [
  'aborted', 'network', 'cors', 'proxy_required', 'proxy_failed',
  'rate_limited', 'not_found', 'http', 'parsing', 'bad_request', 'timeout',
];

export class ProviderError extends Error {
  constructor(kind, message = '', { status = 0, provider = '', detail = '' } = {}) {
    super(message || kind);
    this.name = 'ProviderError';
    this.kind = ERROR_KINDS.includes(kind) ? kind : 'network';
    this.status = status;
    this.provider = provider;
    this.detail = detail;
  }

  /** User-facing copy, mirroring ProviderError::user_message in Rust. */
  userMessage(providerLabel = this.provider) {
    const label = providerLabel || 'Provider';
    switch (this.kind) {
      case 'proxy_required':
        return `${label} cannot be reached directly from the browser. Add a proxy URL in Settings → Proxy to enable this provider.`;
      case 'proxy_failed':
        return `${label}: the configured proxy responded incorrectly. Check the proxy URL in Settings.`;
      case 'cors':
        return `${label} blocked the request (no CORS). Configure a proxy in Settings to use this provider.`;
      case 'network':
        return `Cannot reach ${label}.`;
      case 'timeout':
        return `${label} timed out.`;
      case 'rate_limited':
        return `Rate limited by ${label}. Try again in a moment.`;
      case 'not_found':
        return 'No results found.';
      case 'http':
        return `${label} error (${this.status || 'HTTP'}).`;
      case 'parsing':
        return `${label} returned data that could not be parsed.`;
      case 'bad_request':
        return this.message || `Invalid request for ${label}.`;
      case 'aborted':
        return 'Request cancelled.';
      default:
        return `${label} is unavailable right now.`;
    }
  }

  get needsProxy() {
    return this.kind === 'proxy_required' || this.kind === 'cors' || this.kind === 'proxy_failed';
  }
}

export function proxyConfigured() {
  const s = getSettings();
  return Boolean(s.proxyBase && String(s.proxyBase).trim());
}

export function proxyBase() {
  const s = getSettings();
  const raw = String(s.proxyBase || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw, location.href).href;
  } catch {
    return '';
  }
}

function isAbort(err) {
  return err?.name === 'AbortError' || err?.code === 20;
}

function shouldUseProxy(directResult, directError) {
  const mode = getSettings().proxyMode || 'auto';
  if (mode === 'never') return false;
  if (!proxyConfigured()) return false;
  if (mode === 'always') return true;
  // auto: use proxy when the direct attempt failed at the network/CORS layer
  if (directError) return true;
  if (directResult && directResult.status === 0) return true;
  return false;
}

async function directFetch({ url, method = 'GET', headers = {}, body, signal, timeoutMs }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: ctrl.signal,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
      referrerPolicy: 'no-referrer',
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), body: text, via: 'direct' };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function proxyFetch({ url, method = 'GET', headers = {}, body, signal, timeoutMs }) {
  const endpoint = proxyBase();
  if (!endpoint) throw new ProviderError('proxy_required', 'No proxy configured');
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = timeoutMs ? Math.max(timeoutMs, 5000) : null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ url, method, headers, body: typeof body === 'string' ? body : undefined }),
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) {
      throw new ProviderError('proxy_failed', `Proxy returned HTTP ${res.status}`, { status: res.status });
    }
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new ProviderError('proxy_failed', 'Proxy did not return JSON');
    }
    if (payload && typeof payload === 'object' && payload.error) {
      throw new ProviderError('proxy_failed', String(payload.error));
    }
    const status = Number(payload?.status ?? 0);
    const headersOut = {};
    if (payload?.headers && typeof payload.headers === 'object') {
      for (const [k, v] of Object.entries(payload.headers)) headersOut[String(k).toLowerCase()] = String(v);
    }
    let text = payload?.body ?? '';
    if (typeof text !== 'string') text = JSON.stringify(text);
    return { status, ok: status >= 200 && status < 300, headers: headersOut, body: text, via: 'proxy' };
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Core request. Resolves with { status, ok, headers, body, via }.
 * Throws ProviderError on transport failure.
 */
export async function request({
  url,
  method = 'GET',
  headers = {},
  body = null,
  signal = null,
  timeoutMs = 20000,
  provider = '',
} = {}) {
  if (!url) throw new ProviderError('bad_request', 'Missing URL', { provider });
  if (signal?.aborted) throw new ProviderError('aborted', '', { provider });

  const mode = getSettings().proxyMode || 'auto';
  const useProxyFirst = mode === 'always' && proxyConfigured();

  if (useProxyFirst) {
    try {
      const res = await proxyFetch({ url, method, headers, body, signal, timeoutMs });
      if (res.status === 404) throw new ProviderError('not_found', '', { provider, status: 404 });
      if (res.status === 429) throw new ProviderError('rate_limited', '', { provider, status: 429 });
      if (res.status === 0) throw new ProviderError('proxy_failed', 'Proxy did not reach the target', { provider });
      if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, { provider, status: res.status });
      return res;
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') throw err;
      if (isAbort(err)) throw new ProviderError('aborted', '', { provider });
      throw err instanceof ProviderError ? err : new ProviderError('proxy_failed', String(err?.message || err), { provider });
    }
  }

  let directResult = null;
  let directError = null;
  try {
    directResult = await directFetch({ url, method, headers, body, signal, timeoutMs });
  } catch (err) {
    if (isAbort(err)) {
      if (signal?.aborted) throw new ProviderError('aborted', '', { provider });
      throw new ProviderError('timeout', '', { provider });
    }
    directError = err;
  }

  if (directResult && directResult.status > 0) {
    if (directResult.status === 404) throw new ProviderError('not_found', '', { provider, status: 404 });
    if (directResult.status === 429) throw new ProviderError('rate_limited', '', { provider, status: 429 });
    if (!directResult.ok) throw new ProviderError('http', `HTTP ${directResult.status}`, { provider, status: directResult.status });
    return directResult;
  }

  if (shouldUseProxy(null, directError)) {
    try {
      const res = await proxyFetch({ url, method, headers, body, signal, timeoutMs });
      if (res.status === 404) throw new ProviderError('not_found', '', { provider, status: 404 });
      if (res.status === 429) throw new ProviderError('rate_limited', '', { provider, status: 429 });
      if (res.status === 0) throw new ProviderError('proxy_failed', 'Proxy did not reach the target', { provider });
      if (!res.ok) throw new ProviderError('http', `HTTP ${res.status}`, { provider, status: res.status });
      return res;
    } catch (err) {
      if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'rate_limited')) throw err;
      if (isAbort(err)) throw new ProviderError('aborted', '', { provider });
      throw err instanceof ProviderError ? err : new ProviderError('proxy_failed', String(err?.message || err), { provider });
    }
  }

  if (directError instanceof TypeError) {
    if (!proxyConfigured()) throw new ProviderError('cors', directError.message, { provider });
    throw new ProviderError('network', directError.message, { provider });
  }
  throw new ProviderError('network', String(directError?.message || 'Network error'), { provider });
}

/** Convenience wrappers. */
export async function getJSON(opts) {
  const headers = { accept: 'application/json', ...(opts.headers || {}) };
  const res = await request({ ...opts, method: 'GET', headers });
  try {
    return JSON.parse(res.body);
  } catch (err) {
    throw new ProviderError('parsing', err.message, { provider: opts.provider || '' });
  }
}

export async function getText(opts) {
  const res = await request({ ...opts, method: opts.method || 'GET' });
  return res.body;
}

export async function postJSON(opts) {
  const headers = { 'content-type': 'application/json', accept: 'application/json', ...(opts.headers || {}) };
  const res = await request({ ...opts, method: 'POST', headers, body: opts.body ?? '{}' });
  try {
    return JSON.parse(res.body);
  } catch (err) {
    throw new ProviderError('parsing', err.message, { provider: opts.provider || '' });
  }
}

/**
 * Probe a URL for reachability without reading the body.
 * Used by provider status checks and BDIX detection.
 */
export async function probe(url, { signal, timeoutMs = 8000, provider = '' } = {}) {
  try {
    const res = await request({ url, method: 'GET', signal, timeoutMs, provider, headers: { range: 'bytes=0-0' } });
    return { ok: res.status >= 200 && res.status < 400, status: res.status, via: res.via };
  } catch (err) {
    if (err instanceof ProviderError) return { ok: false, status: err.status, via: '', error: err };
    return { ok: false, status: 0, via: '', error: err };
  }
}

export function normalizeBaseUrl(input) {
  if (!input) return '';
  let raw = String(input).trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    return u.origin;
  } catch {
    return '';
  }
}
