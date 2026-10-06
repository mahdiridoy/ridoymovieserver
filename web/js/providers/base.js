/*
 * Provider adapter contract.
 *
 * Every provider module default-exports an object created with defineProvider():
 *
 *   {
 *     key, label, needsProxy, capabilities,
 *     search({ query, page, signal })        -> Page
 *     browse({ kind, page, signal })         -> Page   (optional)
 *     details({ id, signal })                -> MediaDetails
 *     streams({ id, season, episode, signal }) -> Release[]
 *     home({ signal })                       -> HomeSection[]  (optional)
 *     subtitles({ id, resourceId, ... })     -> SubtitleOption[] (optional)
 *     status({ signal })                     -> { ok, status, detail }
 *   }
 *
 * Page = { items: CatalogItem[], page, hasMore }
 * All returned models are plain JS objects shaped like the Rust structs
 * (see src/providers/models.rs) — snake_case keys preserved for fidelity.
 */

import { ProviderError, request, getJSON, getText } from '../api.js';
import { PROVIDERS, parseProvider } from '../state.js';

export function defineProvider(def) {
  const key = def.key;
  const meta = PROVIDERS[key] || { key, label: def.label || key, needsProxy: false, bdix: false };
  return {
    key,
    label: def.label || meta.label,
    needsProxy: def.needsProxy ?? meta.needsProxy ?? false,
    bdix: def.bdix ?? meta.bdix ?? false,
    capabilities: {
      search: true,
      browse: false,
      details: true,
      streams: true,
      subtitles: false,
      home: false,
      ...(def.capabilities || {}),
    },
    ...def,
  };
}

export function page(items, pageNo = 1, hasMore = false) {
  return { items: items || [], page: pageNo, hasMore: Boolean(hasMore) };
}

export function catalogItem({ provider, id, title, media_type = 'movie', year = null, poster_url = null, season_count = null }) {
  return {
    id: String(id ?? ''),
    provider: parseProvider(provider) || provider,
    title: String(title || 'Unknown'),
    media_type: media_type === 'series' ? 'series' : 'movie',
    year: year ? String(year) : null,
    poster_url: poster_url || null,
    season_count: season_count ?? null,
    stype: media_type === 'series' ? 2 : 1,
    release_year: year ? String(year) : '',
    cover_url: poster_url || null,
  };
}

export function emptyDetails({ provider, id, title = 'Unknown', media_type = 'movie', poster_url = null, year = null }) {
  return {
    id: String(id ?? ''),
    provider: parseProvider(provider) || provider,
    title: String(title || 'Unknown'),
    media_type: media_type === 'series' ? 'series' : 'movie',
    year: year || null,
    description: null,
    tagline: null,
    imdb_rating: null,
    director: null,
    stars: null,
    prints: null,
    audios: null,
    poster_url: poster_url || null,
    duration: null,
    duration_seconds: null,
    genres: [],
    seasons: [],
    dubs: [],
    stype: media_type === 'series' ? 2 : 1,
    release_year: year || '',
  };
}

export function release({ provider, filename, quality = null, codec = null, language = null, size_bytes = null, season = null, episode = null, mirrors = [], resource_id = null }) {
  return {
    provider: parseProvider(provider) || provider,
    filename: String(filename || 'Unknown Release'),
    quality,
    codec,
    language,
    size_bytes: size_bytes ?? null,
    season: season ?? null,
    episode: episode ?? null,
    mirrors: mirrors || [],
    resource_id: resource_id ?? null,
  };
}

export function mirror({ label, resolver_url, headers = [], direct_file = false }) {
  return { label: String(label || 'Direct'), resolver_url: String(resolver_url || ''), headers: headers || [], direct_file: Boolean(direct_file) };
}

export function resolutionU64(rel) {
  const q = String(rel.quality || '').trim();
  if (!q) return 1080;
  if (/^(4k|uhd)$/i.test(q)) return 2160;
  const n = Number.parseInt(q.replace(/[pP]$/, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1080;
}

export function sortReleases(releases) {
  return [...releases].sort((a, b) => {
    const d = resolutionU64(b) - resolutionU64(a);
    if (d !== 0) return d;
    return (b.size_bytes || 0) - (a.size_bytes || 0);
  });
}

/** Translate any thrown value into a ProviderError tagged with this provider. */
export function wrapError(err, providerKey, providerLabel) {
  if (err instanceof ProviderError) {
    if (!err.provider) err.provider = providerLabel || providerKey;
    return err;
  }
  if (err?.name === 'AbortError') return new ProviderError('aborted', '', { provider: providerLabel || providerKey });
  return new ProviderError('network', String(err?.message || err), { provider: providerLabel || providerKey });
}

/**
 * Standard status probe: tries a cheap request against the provider origin.
 * Result is cached in the store so the settings page can show provider health.
 */
export function makeProbe(originUrl, { providerKey, providerLabel, needsProxy = false }) {
  return async ({ signal } = {}) => {
    const res = await request({
      url: originUrl,
      method: 'GET',
      signal,
      timeoutMs: 9000,
      provider: providerLabel || providerKey,
      headers: { accept: 'text/html,application/json' },
    });
    return { ok: res.status >= 200 && res.status < 400, status: res.status, via: res.via };
  };
}

export { ProviderError, request, getJSON, getText };
