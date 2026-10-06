/*
 * MovieBox provider — port of src/providers/moviebox/{client,session,mod}.rs
 *
 * Browser notes:
 *  - The API demands signed headers (User-Agent, X-Forwarded-For, HMAC-MD5
 *    signature) and sends no CORS headers, so every call must travel through
 *    the user-configured proxy. Without one we fail fast with `proxy_required`
 *    and the UI explains how to fix it.
 *  - Host pool, retry status codes and session handling mirror the Rust client.
 */

import { defineProvider, page, wrapError, ProviderError, request } from '../base.js';
import { proxyConfigured } from '../../api.js';
import {
  generateClientInfoAndUa,
  randomSpoofedIp,
  buildSignedHeaders,
  STREAM_REFERER,
} from './crypto.js';
import {
  searchJsonToCatalog,
  detailsJsonToMediaDetails,
  playInfoJsonToReleases,
  resourceJsonToReleases,
  homepageJsonToCatalog,
  captionsJsonToOptions,
} from './adapt.js';
import { sortReleases } from '../base.js';

const HOST_POOL = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api4sg.aoneroom.com',
  'https://api3.aoneroom.com',
  'https://api6sg.aoneroom.com',
  'https://api.inmoviebox.com',
];

const RETRY_STATUS_CODES = new Set([403, 406, 407, 429, 500, 502, 503, 504]);
const SESSION_KEY = 'moviebox.session.v1';

const identity = generateClientInfoAndUa();
const spoofedIp = randomSpoofedIp();

let activeHostIndex = 0;
let session = loadSession();
let sessionLock = null;

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && isValidSession(parsed)) return parsed;
  } catch { /* ignore */ }
  return null;
}

function saveSession(s) {
  session = s;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch { /* private mode */ }
}

function clearSession() {
  session = null;
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

function isValidSession(s) {
  if (!s?.token?.trim()) return false;
  const now = Math.floor(Date.now() / 1000);
  if (s.expires_at) return now + 60 < s.expires_at;
  return now < (s.created_at || 0) + 7 * 24 * 3600;
}

function parseJwtClaims(token) {
  const parts = String(token).split('.');
  if (parts.length < 3) return {};
  let payload = parts[1] || '';
  try {
    payload = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    const json = new TextDecoder().decode(
      Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)),
    );
    const val = JSON.parse(json);
    const uidRaw = val.userId ?? val.uid ?? val.sub;
    const uid = uidRaw === undefined || uidRaw === null ? null : String(uidRaw);
    const expRaw = val.exp;
    const exp = expRaw !== undefined && expRaw !== null && Number.isFinite(Number(expRaw))
      ? Number(expRaw) : null;
    return { uid, exp };
  } catch {
    return {};
  }
}

function ensureProxyOrThrow() {
  if (!proxyConfigured()) {
    throw new ProviderError(
      'proxy_required',
      'MovieBox requires a CORS proxy (signed browser-forbidden headers).',
      { provider: 'MovieBox' },
    );
  }
}

async function fetchFreshSession(signal) {
  const path = '/wefeed-mobile-bff/user-api/visitor-login';
  const val = await rawRequest('POST', path, '{}', { authToken: null, signal });
  const token = typeof val?.token === 'string' ? val.token.trim() : '';
  if (!token) throw new ProviderError('parsing', 'Missing visitor token', { provider: 'MovieBox' });
  const explicitUid = val.uid ?? val.userId;
  const claims = parseJwtClaims(token);
  const uid = explicitUid !== undefined && explicitUid !== null ? String(explicitUid) : claims.uid;
  return {
    token,
    user_id: uid ?? null,
    expires_at: claims.exp ?? null,
    created_at: Math.floor(Date.now() / 1000),
  };
}

async function ensureSession(signal) {
  if (isValidSession(session)) return session.token;
  if (sessionLock) {
    await sessionLock;
    if (isValidSession(session)) return session.token;
  }
  sessionLock = (async () => {
    try {
      const fresh = await fetchFreshSession(signal);
      saveSession(fresh);
      return fresh.token;
    } finally {
      sessionLock = null;
    }
  })();
  const token = await sessionLock;
  return token;
}

/**
 * One signed attempt across the host pool (mirrors request_hosts in client.rs).
 */
async function rawRequest(method, pathAndQuery, body, { authToken, signal, retried = false } = {}) {
  const startIdx = activeHostIndex;
  let lastError = null;
  let backoffMs = 50;

  for (let i = 0; i < HOST_POOL.length; i += 1) {
    if (signal?.aborted) throw new ProviderError('aborted', '', { provider: 'MovieBox' });
    if (i > 0) {
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = 50;
      if (signal?.aborted) throw new ProviderError('aborted', '', { provider: 'MovieBox' });
    }
    const idx = (startIdx + i) % HOST_POOL.length;
    const base = HOST_POOL[idx];
    const url = `${base}${pathAndQuery}`;
    const headers = buildSignedHeaders({
      method,
      url,
      body,
      authToken,
      userAgent: identity.userAgent,
      clientInfo: identity.clientInfo,
      spoofedIp,
    });

    let res;
    try {
      res = await request({
        url,
        method,
        headers,
        body: method === 'POST' ? body : null,
        signal,
        timeoutMs: 14000,
        provider: 'MovieBox',
      });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'aborted') throw err;
      lastError = err;
      activeHostIndex = (idx + 1) % HOST_POOL.length;
      continue;
    }

    if (RETRY_STATUS_CODES.has(res.status)) {
      activeHostIndex = (idx + 1) % HOST_POOL.length;
      if (res.status === 429) {
        const retryAfter = Number(res.headers?.['retry-after']);
        backoffMs = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 3000) : 400;
      }
      lastError = new ProviderError('http', `HTTP ${res.status}`, { status: res.status, provider: 'MovieBox' });
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      clearSession();
      if (!retried) {
        return rawRequest(method, pathAndQuery, body, { authToken: null, signal, retried: true });
      }
      throw new ProviderError('http', `HTTP ${res.status}`, { status: res.status, provider: 'MovieBox' });
    }

    if (res.status === 404) throw new ProviderError('not_found', '', { status: 404, provider: 'MovieBox' });
    if (res.status === 429) throw new ProviderError('rate_limited', '', { status: 429, provider: 'MovieBox' });

    if (res.status < 200 || res.status >= 300) {
      lastError = new ProviderError('http', `HTTP ${res.status}`, { status: res.status, provider: 'MovieBox' });
      activeHostIndex = idx;
      continue;
    }

    activeHostIndex = idx;
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch (err) {
      lastError = new ProviderError('parsing', String(err?.message || err), { provider: 'MovieBox' });
      continue;
    }

    absorbXUser(res.headers);
    return parsed && typeof parsed === 'object' && parsed.data !== undefined ? parsed.data : parsed;
  }

  throw lastError || new ProviderError('network', 'All MovieBox hosts exhausted', { provider: 'MovieBox' });
}

function absorbXUser(headers) {
  const raw = headers?.['x-user'];
  if (!raw) return;
  try {
    const json = JSON.parse(raw);
    if (typeof json?.token === 'string' && json.token.trim()) {
      const claims = parseJwtClaims(json.token);
      saveSession({
        token: json.token,
        user_id: String(json.uid ?? json.userId ?? claims.uid ?? ''),
        expires_at: claims.exp ?? null,
        created_at: Math.floor(Date.now() / 1000),
      });
    }
  } catch { /* ignore */ }
}

async function api(method, pathAndQuery, body, { signal } = {}) {
  ensureProxyOrThrow();
  const token = await ensureSession(signal);
  try {
    return await rawRequest(method, pathAndQuery, body, { authToken: token, signal });
  } catch (err) {
    if (err instanceof ProviderError && (err.kind === 'network' || err.kind === 'parsing') && !sessionLock) {
      clearSession();
      const fresh = await ensureSession(signal);
      return rawRequest(method, pathAndQuery, body, { authToken: fresh, signal });
    }
    throw err;
  }
}

function buildQuery(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/* ---------------- Provider surface ---------------- */

export default defineProvider({
  key: 'moviebox',
  label: 'MovieBox',
  needsProxy: true,
  capabilities: { search: true, browse: false, details: true, streams: true, subtitles: true, home: true },

  async search({ query, page: pageNo = 1, signal } = {}) {
    const payload = await api('POST', '/wefeed-mobile-bff/subject-api/search/v2', JSON.stringify({
      keyword: String(query || ''),
      page: pageNo,
      perPage: 15,
      subjectType: 0,
    }), { signal });
    const items = searchJsonToCatalog(payload);
    return page(items, pageNo, items.length >= 15);
  },

  async details({ id, signal } = {}) {
    const detailsPayload = await api('GET', `/wefeed-mobile-bff/subject-api/get${buildQuery({ subjectId: id })}`, null, { signal });
    const stype = Number(detailsPayload?.subjectType ?? detailsPayload?.stype ?? 1);
    if (stype === 2) {
      try {
        const seasonInfo = await api('GET', `/wefeed-mobile-bff/subject-api/season-info${buildQuery({ subjectId: id })}`, null, { signal });
        if (seasonInfo && typeof seasonInfo === 'object') {
          detailsPayload.seasons = seasonInfo;
        }
      } catch { /* season list is best-effort */ }
    }
    try {
      return detailsJsonToMediaDetails(detailsPayload);
    } catch (err) {
      throw wrapError(err, 'moviebox', 'MovieBox');
    }
  },

  async streams({ id, season = 0, episode = 0, signal } = {}) {
    const isEpisode = Number(season) > 0 && Number(episode) > 0;
    const playInfoPath = `/wefeed-mobile-bff/subject-api/play-info/v2${buildQuery(
      isEpisode ? { subjectId: id, se: season, ep: episode } : { subjectId: id },
    )}`;
    const resourcePath = `/wefeed-mobile-bff/subject-api/resource${buildQuery(
      isEpisode
        ? { subjectId: id, se: season, ep: episode, page: Math.floor((Number(episode) - 1) / 20) + 1, perPage: 20 }
        : { subjectId: id, page: 1, perPage: 20 },
    )}`;

    const [playInfo, resources] = await Promise.allSettled([
      api('GET', playInfoPath, null, { signal }),
      api('GET', resourcePath, null, { signal }),
    ]);

    const releases = [];
    const seen = new Set();
    const markSeen = (rel) => {
      const url = rel.mirrors?.[0]?.resolver_url;
      if (!url) return false;
      const base = url.split('?')[0];
      if (!base) return false;
      if (seen.has(base)) return true;
      seen.add(base);
      return false;
    };

    if (playInfo.status === 'fulfilled') {
      for (const rel of playInfoJsonToReleases(playInfo.value, Number(season), Number(episode), identity.userAgent)) {
        markSeen(rel);
        releases.push(rel);
      }
    }
    if (resources.status === 'fulfilled') {
      for (const rel of resourceJsonToReleases(resources.value)) {
        if (markSeen(rel)) continue;
        const seasonOk = !isEpisode
          || (rel.season === Number(season) && rel.episode === Number(episode))
          || (rel.season === null && rel.episode === null);
        if (seasonOk) releases.push(rel);
      }
    }

    if (!releases.length) {
      if (playInfo.status === 'rejected' && resources.status === 'rejected') {
        throw wrapError(playInfo.reason, 'moviebox', 'MovieBox');
      }
      throw new ProviderError('not_found', 'No stream sources available', { provider: 'MovieBox' });
    }
    return sortReleases(releases);
  },

  async subtitles({ id, resourceId, siblingIds = [], season = 0, episode = 0, signal } = {}) {
    const ids = [id, ...siblingIds].filter(Boolean);
    for (const sid of ids) {
      try {
        const payload = await api('GET', `/wefeed-mobile-bff/subject-api/get-ext-captions${buildQuery({ subjectId: sid, resourceId })}`, null, { signal });
        const options = captionsJsonToOptions(payload);
        if (options.length) return options;
      } catch { /* try next sibling id */ }
    }
    void season; void episode;
    return [];
  },

  async home({ page = 1, tabId = '2', signal } = {}) {
    const payload = await api('GET', `/wefeed-mobile-bff/tab-operating${buildQuery({ page, tabId, version: '' })}`, null, { signal });
    const { items, metrics } = homepageJsonToCatalog(payload);
    return { items, metrics, page };
  },

  async status({ signal } = {}) {
    if (!proxyConfigured()) {
      return { ok: false, status: 0, detail: 'proxy_required' };
    }
    const res = await request({
      url: `${HOST_POOL[activeHostIndex]}/`,
      method: 'GET',
      signal,
      timeoutMs: 9000,
      provider: 'MovieBox',
      headers: { accept: 'application/json' },
    });
    return { ok: res.status > 0 && res.status < 500, status: res.status, via: res.via };
  },
});

export { STREAM_REFERER, identity as movieboxIdentity };
