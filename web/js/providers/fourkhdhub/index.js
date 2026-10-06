/*
 * 4KHDHub provider — port of src/providers/fourkhdhub/{client,mod}.rs
 *
 * Browser notes:
 *  - 4khdhub.one sends no CORS headers, so every page travels through the
 *    user-configured proxy (needsProxy: true); api.js falls back to it on its
 *    own, so no proxy logic lives here.
 *  - Rust's resolve_release resolves each mirror (7s cap) and then byte-range
 *    preflights the candidates to measure seekability. The browser HTTP layer
 *    exposes neither the redirect target nor the response content-type, so the
 *    HTTP 206 probe cannot be ported: candidates are extracted, accepted only
 *    after validate_playback_url and returned score-sorted instead.
 */

import {
  defineProvider, page, release, mirror, sortReleases, wrapError,
  ProviderError, request, getText,
} from '../base.js';
import { parseSearch, parseDetails, parseReleases } from './parser.js';
import { resolveMirrorCandidates, score, validatePlaybackUrl, BROWSER_UA } from './hubcloud.js';

const PROVIDER_KEY = 'fourkhdhub';
const PROVIDER_LABEL = '4KHDHub';

/** DEFAULT_BASE_URL (client.rs) */
const BASE_URL = 'https://4khdhub.one/';
const BASE_HOSTNAME = new URL(BASE_URL).hostname;
/** Referer merged into resolved mirror headers (client.rs :: resolve_release). */
const REFERER = 'https://4khdhub.one';

const REQUEST_TIMEOUT_MS = 20000;
const RESOLVE_TIMEOUT_MS = 7000;
const MAX_PARALLEL_RESOLVERS = 6;
const PAGE_CACHE_TTL_MS = 60000;

const PAGE_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'user-agent': BROWSER_UA,
};

/** Failures that affect every mirror at once — rethrown instead of skipped. */
const SYSTEMIC_KINDS = new Set(['aborted', 'cors', 'proxy_required', 'proxy_failed', 'rate_limited']);

let pageCache = null;

/** client.rs :: provider_url — ids stay on the provider origin. */
function providerUrl(id) {
  const trimmed = String(id ?? '').replace(/^\/+/, '');
  let url;
  try {
    url = new URL(trimmed, BASE_URL);
  } catch {
    throw new ProviderError('parsing', `Invalid URL: ${id}`, { provider: PROVIDER_LABEL });
  }
  if (url.hostname !== BASE_HOSTNAME) {
    throw new ProviderError('parsing', `Invalid URL: ${id}`, { provider: PROVIDER_LABEL });
  }
  return url.href;
}

/** client.rs :: fetch_cached_page — one slot, 60s TTL, shared by details/streams. */
async function fetchProviderPage(id, signal) {
  const url = providerUrl(id);
  const now = Date.now();
  if (pageCache && pageCache.url === url && now - pageCache.at < PAGE_CACHE_TTL_MS) {
    return pageCache.html;
  }
  const html = await getText({
    url,
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    provider: PROVIDER_LABEL,
    headers: PAGE_HEADERS,
  });
  pageCache = { url, at: Date.now(), html };
  return html;
}

/** Bounded fan-out so a page full of mirrors cannot flood the proxy. */
async function runPool(items, limit, worker) {
  let cursor = 0;
  let failure = null;
  const runner = async () => {
    while (failure === null) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index]);
      } catch (err) {
        if (failure === null) failure = err;
        return;
      }
    }
  };
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) runners.push(runner());
  await Promise.all(runners);
  if (failure !== null) throw failure;
}

/** client.rs :: resolve_release — 7s per mirror, aborted by the caller's signal. */
async function resolveWithTimeout(entry, signal) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) throw new ProviderError('aborted', '', { provider: PROVIDER_LABEL });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RESOLVE_TIMEOUT_MS);

  try {
    return await resolveMirrorCandidates(entry.resolver_url, {
      label: entry.label,
      headers: entry.headers,
      signal: controller.signal,
    });
  } catch (err) {
    if (signal?.aborted) throw new ProviderError('aborted', '', { provider: PROVIDER_LABEL });
    if (timedOut) throw new ProviderError('timeout', 'mirror resolver timed out', { provider: PROVIDER_LABEL });
    throw wrapError(err, PROVIDER_KEY, PROVIDER_LABEL);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function mergeHeaders(headers) {
  const merged = (Array.isArray(headers) ? headers : []).map((pair) => [...pair]);
  if (!merged.some(([name]) => String(name).toLowerCase() === 'referer')) {
    merged.push(['Referer', REFERER]);
  }
  if (!merged.some(([name]) => String(name).toLowerCase() === 'user-agent')) {
    merged.push(['User-Agent', BROWSER_UA]);
  }
  return merged;
}

/** Candidate list → playable mirrors: validate, dedup by URL, best score first. */
function buildMirrors(candidates) {
  const seen = new Set();
  const usable = [];
  for (const candidate of candidates) {
    let url;
    try {
      url = validatePlaybackUrl(candidate.url);
    } catch {
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    usable.push({ url, label: candidate.label, headers: candidate.headers, rank: score(url, candidate.label) });
  }
  usable.sort((left, right) => left.rank - right.rank);
  return usable.map((candidate) => mirror({
    label: candidate.label,
    resolver_url: candidate.url,
    headers: mergeHeaders(candidate.headers),
    direct_file: true,
  }));
}

export default defineProvider({
  key: PROVIDER_KEY,
  label: PROVIDER_LABEL,
  needsProxy: true,
  capabilities: { search: true, browse: false, details: true, streams: true, subtitles: true, home: false },

  async search({ query, page: pageNo = 1, signal } = {}) {
    try {
      const searchUrl = `${BASE_URL}?${new URLSearchParams({ s: String(query ?? '') })}`;
      const html = await getText({
        url: searchUrl,
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        provider: PROVIDER_LABEL,
        headers: PAGE_HEADERS,
      });
      const items = parseSearch(BASE_URL, html);
      return page(items, pageNo, false);
    } catch (err) {
      throw wrapError(err, PROVIDER_KEY, PROVIDER_LABEL);
    }
  },

  async details({ id, signal } = {}) {
    try {
      const html = await fetchProviderPage(id, signal);
      return parseDetails(id, html);
    } catch (err) {
      throw wrapError(err, PROVIDER_KEY, PROVIDER_LABEL);
    }
  },

  async streams({ id, season = 0, episode = 0, signal } = {}) {
    try {
      const seasonNum = Number(season) || 0;
      const episodeNum = Number(episode) || 0;

      const html = await fetchProviderPage(id, signal);
      const releases = parseReleases(html, seasonNum, episodeNum);
      if (releases.length === 0) return [];

      const tasks = [];
      releases.forEach((rel, relIndex) => {
        for (const entry of rel.mirrors) tasks.push({ relIndex, entry });
      });
      const perRelease = releases.map(() => []);

      await runPool(tasks, MAX_PARALLEL_RESOLVERS, async (task) => {
        if (signal?.aborted) throw new ProviderError('aborted', '', { provider: PROVIDER_LABEL });
        try {
          const candidates = await resolveWithTimeout(task.entry, signal);
          perRelease[task.relIndex].push(...candidates);
        } catch (err) {
          // Rust ignores failed mirror tasks (`if let Ok(cand_list)`).
          if (err instanceof ProviderError && SYSTEMIC_KINDS.has(err.kind)) throw err;
        }
      });

      const out = [];
      for (let i = 0; i < releases.length; i += 1) {
        const mirrors = buildMirrors(perRelease[i]);
        if (mirrors.length === 0) continue;
        const rel = releases[i];
        out.push(release({
          provider: PROVIDER_KEY,
          filename: rel.filename,
          quality: rel.quality,
          codec: rel.codec,
          language: rel.language,
          size_bytes: rel.size_bytes,
          season: rel.season,
          episode: rel.episode,
          mirrors,
          resource_id: rel.resource_id,
        }));
      }

      if (out.length === 0) {
        throw new ProviderError('network', 'No working 4KHDHub mirrors found.', { provider: PROVIDER_LABEL });
      }
      return sortReleases(out);
    } catch (err) {
      throw wrapError(err, PROVIDER_KEY, PROVIDER_LABEL);
    }
  },

  async subtitles() {
    // mod.rs declares supports_subtitles, but the Rust client has no subtitle
    // extraction path (captions are MovieBox-only in service.rs).
    return [];
  },

  async status({ signal } = {}) {
    try {
      const res = await request({
        url: BASE_URL,
        method: 'GET',
        signal,
        timeoutMs: 9000,
        provider: PROVIDER_LABEL,
        headers: { accept: 'text/html,application/json' },
      });
      return { ok: res.status >= 200 && res.status < 400, status: res.status, detail: res.via || '' };
    } catch (err) {
      const wrapped = wrapError(err, PROVIDER_KEY, PROVIDER_LABEL);
      if (wrapped.status > 0) {
        return { ok: wrapped.status >= 200 && wrapped.status < 400, status: wrapped.status, detail: wrapped.kind };
      }
      return { ok: false, status: 0, detail: wrapped.kind || 'network' };
    }
  },
});
