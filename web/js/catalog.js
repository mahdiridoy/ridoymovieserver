/*
 * Provider registry + cross-provider aggregation.
 *
 * Aggregation rules:
 *  - only enabled providers run,
 *  - each provider is isolated: a rejection never breaks the whole query,
 *  - results dedupe by `provider:id` first, then by normalized title+year+type,
 *  - every outcome is recorded in provider status so Settings can show health.
 */

import moviebox from './providers/moviebox/index.js';
import fourkhdhub from './providers/fourkhdhub/index.js';
import dramachi from './providers/dramachi/index.js';
import { circleftp, dhakaflix } from './providers/bdix/index.js';
import { ProviderError } from './api.js';
import {
  getSettings,
  getProviderStatus,
  setProviderStatus,
  providerLabel,
  enabledProviders as enabledProviderKeys,
} from './state.js';
import { cleanMovieboxTitle } from './utils/title.js';

export const REGISTRY = {
  moviebox,
  fourkhdhub,
  dramachi,
  bdix_circleftp: circleftp,
  bdix_dhakaflix: dhakaflix,
};

export function getProvider(key) {
  return REGISTRY[key] || null;
}

export function activeProviders() {
  return enabledProviderKeys()
    .map((key) => REGISTRY[key])
    .filter(Boolean);
}

function dedupeKey(item) {
  return `${item.provider}:${item.id}`;
}

function softKey(item) {
  return `${cleanMovieboxTitle(item.title).toLowerCase()}|${item.year || ''}|${item.media_type}`;
}

function matchesKind(item, kind) {
  if (!kind || kind === 'all') return true;
  if (kind === 'movie') return item.media_type === 'movie';
  if (kind === 'series') return item.media_type === 'series';
  if (kind === 'drama') return true;
  return true;
}

/**
 * Fan out a search across enabled providers.
 * Returns { items, errors: [{provider,label,error}], partial }.
 */
export async function searchAggregated({ query, kind = 'all', page: pageNo = 1, signal, limit = 60 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { items: [], errors: [], partial: false };

  const providers = activeProviders().filter((p) => p.capabilities.search);
  const results = await Promise.allSettled(providers.map((p) => p.search({ query: q, page: pageNo, signal })));

  const items = [];
  const errors = [];
  const seenIds = new Set();
  const seenSoft = new Set();

  results.forEach((res, i) => {
    const provider = providers[i];
    if (res.status === 'fulfilled') {
      setProviderStatus(provider.key, 'ok');
      for (const item of res.value.items || []) {
        if (!matchesKind(item, kind)) continue;
        const idKey = dedupeKey(item);
        if (seenIds.has(idKey)) continue;
        seenIds.add(idKey);
        const sKey = softKey(item);
        if (seenSoft.has(sKey)) continue;
        seenSoft.add(sKey);
        items.push(item);
      }
    } else {
      const err = res.reason instanceof ProviderError
        ? res.reason
        : new ProviderError('network', String(res.reason?.message || res.reason));
      if (err.kind === 'aborted') return;
      errors.push({ provider: provider.key, label: provider.label, error: err });
      setProviderStatus(provider.key, err.needsProxy ? 'proxy_required' : 'error', err.kind);
    }
  });

  return { items: items.slice(0, limit), errors, partial: errors.length > 0 && items.length > 0 };
}

export async function detailsFor(providerKey, id, { signal, preview = null } = {}) {
  const provider = getProvider(providerKey);
  if (!provider) throw new ProviderError('bad_request', `Unknown provider "${providerKey}"`);
  try {
    const details = await provider.details({ id, signal });
    setProviderStatus(provider.key, 'ok');
    return details;
  } catch (err) {
    const wrapped = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message || err));
    if (wrapped.kind !== 'aborted') {
      setProviderStatus(provider.key, wrapped.needsProxy ? 'proxy_required' : 'error', wrapped.kind);
    }
    if (preview && wrapped.kind !== 'aborted') return detailsFromPreview(providerKey, id, preview);
    throw wrapped;
  }
}

/** Minimal details built from a search result — only used as a labelled fallback. */
export function detailsFromPreview(providerKey, id, preview) {
  return {
    id,
    provider: providerKey,
    title: preview.title || 'Unknown',
    media_type: preview.media_type || 'movie',
    year: preview.year || null,
    description: null,
    tagline: null,
    imdb_rating: null,
    director: null,
    stars: null,
    prints: null,
    audios: null,
    poster_url: preview.poster_url || null,
    duration: null,
    duration_seconds: null,
    genres: [],
    seasons: [],
    dubs: [],
    stype: preview.stype || (preview.media_type === 'series' ? 2 : 1),
    release_year: preview.year || '',
    incomplete: true,
  };
}

export async function streamsFor(providerKey, { id, season = 0, episode = 0, signal, preview = null } = {}) {
  const provider = getProvider(providerKey);
  if (!provider) throw new ProviderError('bad_request', `Unknown provider "${providerKey}"`);
  if (!provider.capabilities.streams) throw new ProviderError('bad_request', `${provider.label} cannot provide streams`);

  try {
    const releases = await provider.streams({ id, season, episode, signal });
    setProviderStatus(provider.key, 'ok');
    if (!releases.length) throw new ProviderError('not_found', 'No stream sources available', { provider: provider.label });
    return releases;
  } catch (err) {
    const wrapped = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message || err));
    if (wrapped.kind !== 'aborted') {
      setProviderStatus(provider.key, wrapped.needsProxy ? 'proxy_required' : 'error', wrapped.kind);
    }
    // Fallback: try sibling providers with a matching title (only if preview given).
    if (preview && (wrapped.kind === 'not_found' || wrapped.kind === 'proxy_required' || wrapped.kind === 'cors')) {
      const fallback = await trySiblingStreams({ exclude: providerKey, preview, season, episode, signal });
      if (fallback) return fallback;
    }
    throw wrapped;
  }
}

async function trySiblingStreams({ exclude, preview, season, episode, signal }) {
  const title = cleanMovieboxTitle(preview.title || '').toLowerCase();
  if (!title) return null;
  const candidates = activeProviders()
    .filter((p) => p.key !== exclude && p.capabilities.search && p.capabilities.streams && p.key !== 'moviebox');
  for (const provider of candidates) {
    try {
      const res = await provider.search({ query: preview.title, page: 1, signal });
      const match = (res.items || []).find((item) => cleanMovieboxTitle(item.title).toLowerCase() === title
        && (item.year || '') === (preview.year || ''));
      if (!match) continue;
      const releases = await provider.streams({ id: match.id, season, episode, signal });
      if (releases.length) return releases;
    } catch { /* next candidate */ }
  }
  return null;
}

/* ---------------- Home ---------------- */

function metricSort(items, metrics, field, count = 12) {
  return [...items]
    .sort((a, b) => {
      const ma = Number(metrics?.[a.id]?.[field] ?? -1);
      const mb = Number(metrics?.[b.id]?.[field] ?? -1);
      return mb - ma;
    })
    .slice(0, count);
}

/**
 * Build home sections. Returns { hero, sections, errors }.
 * Sections are derived from the MovieBox homepage payload (same as the TUI's
 * browse presets, which sort that payload by metric).
 */
export async function loadHome({ signal } = {}) {
  const settings = getSettings();
  const sections = [];
  const errors = [];
  let hero = [];

  const homeProviderKey = REGISTRY[settings.homeProvider] ? settings.homeProvider : 'moviebox';
  const homeProvider = REGISTRY[homeProviderKey];

  if (homeProvider?.capabilities.home) {
    try {
      const payload = await homeProvider.home({ page: 1, signal });
      setProviderStatus(homeProvider.key, 'ok');
      const { items, metrics } = payload;
      if (items.length) {
        hero = items.slice(0, 8).filter((i) => i.poster_url);
        sections.push({ id: 'trending', title: 'Trending Now', items: metricSort(items, metrics, 'trending', 14) });
        sections.push({ id: 'top-rated', title: 'Top Rated', items: metricSort(items, metrics, 'rating', 14) });
        sections.push({ id: 'most-watched', title: 'Most Watched', items: metricSort(items, metrics, 'popularity', 14) });
        sections.push({ id: 'latest', title: `New on ${homeProvider.label}`, items: items.slice(0, 14) });
      }
    } catch (err) {
      if (err?.kind !== 'aborted') {
        const wrapped = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message || err));
        errors.push({ provider: homeProvider.key, label: homeProvider.label, error: wrapped });
        setProviderStatus(homeProvider.key, wrapped.needsProxy ? 'proxy_required' : 'error', wrapped.kind);
      }
    }
  }

  return { hero, sections, errors };
}

/** Fallback discovery for Movies / Series / Drama pages when home is empty. */
export async function discover({ kind = 'movie', signal, limit = 40 } = {}) {
  const seeds = kind === 'series'
    ? ['breaking bad', 'the office', 'stranger things', 'dark', 'attack on titan']
    : kind === 'drama'
      ? ['crash landing on you', 'descendants of the sun', 'jujutsu kaisen', 'demon hunter', 'the glory']
      : ['interstellar', 'inception', 'the dark knight', 'dune', 'oppenheimer'];

  const collected = [];
  const errors = [];
  const seen = new Set();

  for (const seed of seeds) {
    if (signal?.aborted) break;
    try {
      const res = await searchAggregated({ query: seed, kind, signal, limit: 12 });
      errors.push(...res.errors);
      for (const item of res.items) {
        const key = `${item.provider}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        collected.push(item);
      }
    } catch { /* seed failed — continue */ }
    if (collected.length >= limit) break;
  }

  return { items: collected.slice(0, limit), errors };
}

export async function probeProviders({ signal } = {}) {
  const providers = activeProviders().filter((p) => typeof p.status === 'function');
  const results = await Promise.allSettled(providers.map(async (p) => {
    const res = await p.status({ signal });
    setProviderStatus(p.key, res.ok ? 'ok' : (res.detail === 'proxy_required' ? 'proxy_required' : 'error'), res.detail || '');
    return { key: p.key, label: p.label, ...res };
  }));
  return results.map((r, i) => (r.status === 'fulfilled'
    ? r.value
    : { key: providers[i].key, label: providers[i].label, ok: false, status: 0, detail: String(r.reason?.message || r.reason) }));
}

export function providerHealth(key) {
  return getProviderStatus(key);
}

export function labelFor(key) {
  return providerLabel(key);
}
