/*
 * Central application state.
 *
 * Ports the semantics of src/favorites.rs, src/history.rs and src/config.rs:
 *  - one consolidated history entry per title (latest episode wins),
 *  - per-episode resume points in a separate compact map,
 *  - SubjectIdentity.matches() dedup for favorites + history,
 *  - schema-versioned JSON persisted through storage.js.
 */

import { STORAGE_KEYS, loadJSON, saveJSON, loadList, saveList, storageMode } from './storage.js';
import { cleanMovieboxTitle } from './utils/title.js';

/* ================= Providers ================= */

export const PROVIDERS = {
  moviebox: { key: 'moviebox', label: 'MovieBox', aliases: ['movie_box'], bdix: false, needsProxy: true },
  fourkhdhub: { key: 'fourkhdhub', label: '4KHDHub', aliases: ['4khdhub', 'four_k_hd_hub'], bdix: false, needsProxy: true },
  dramachi: { key: 'dramachi', label: 'Dramachi', aliases: [], bdix: false, needsProxy: true },
  bdix_circleftp: { key: 'bdix_circleftp', label: 'CircleFTP (BDIX)', aliases: ['circleftp (bdix)', 'bdix_circle_ftp'], bdix: true, needsProxy: false },
  bdix_dhakaflix: { key: 'bdix_dhakaflix', label: 'DhakaFlix (BDIX)', aliases: ['dhakaflix (bdix)', 'bdix_dhaka_flix'], bdix: true, needsProxy: false },
  addons: { key: 'addons', label: 'Addons', aliases: ['addon'], bdix: false, needsProxy: false },
  tv: { key: 'tv', label: 'Live TV', aliases: [], bdix: false, needsProxy: false },
};

export const BUILTIN_PROVIDER_ORDER = [
  'moviebox', 'fourkhdhub', 'dramachi', 'bdix_circleftp', 'bdix_dhakaflix',
];

export function parseProvider(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  for (const def of Object.values(PROVIDERS)) {
    if (def.key === raw || def.aliases.includes(raw)) return def.key;
  }
  return null;
}

export function providerLabel(value) {
  const key = parseProvider(value);
  if (key) return PROVIDERS[key].label;
  return String(value ?? '').trim() || 'Unknown';
}

/* ================= Identity matching ================= */

/**
 * Port of SubjectIdentity::matches (src/models.rs).
 * `stype`: 1 = movie, 2 = series.
 */
export function identityMatches(a, b) {
  if (!a || !b) return false;
  if (Number(a.stype) !== Number(b.stype)) return false;

  const pa = parseProvider(a.provider);
  const pb = parseProvider(b.provider);
  const sameProvider = pa && pb
    ? pa === pb
    : String(a.provider ?? '').trim().toLowerCase() === String(b.provider ?? '').trim().toLowerCase();
  if (!sameProvider) return false;

  const idA = String(a.subject_id ?? a.id ?? '');
  const idB = String(b.subject_id ?? b.id ?? '');
  if (idA && idB) return idA === idB;

  const titleA = cleanMovieboxTitle(a.title).toLowerCase();
  const titleB = cleanMovieboxTitle(b.title).toLowerCase();
  if (titleA && titleA === titleB) {
    const yearA = String(a.release_year ?? a.year ?? '').trim();
    const yearB = String(b.release_year ?? b.year ?? '').trim();
    if (yearA && yearB) return yearA === yearB;
    return true;
  }
  return false;
}

export function identityKey(identity) {
  const provider = parseProvider(identity.provider) || String(identity.provider ?? '').trim().toLowerCase();
  const subjectId = String(identity.subject_id ?? identity.id ?? '');
  if (subjectId) return `${provider}:${subjectId}:${identity.stype ?? 1}`;
  return `${provider}:${cleanMovieboxTitle(identity.title).toLowerCase()}:${identity.release_year ?? identity.year ?? ''}:${identity.stype ?? 1}`;
}

/* ================= Settings ================= */

export const THEMES = [
  { key: 'mocha', label: 'Mocha', scheme: 'dark', swatch: ['#11111b', '#89b4fa', '#f5c2e7'] },
  { key: 'latte', label: 'Latte', scheme: 'light', swatch: ['#eff1f5', '#1e66f5', '#ea76cb'] },
  { key: 'macchiato', label: 'Macchiato', scheme: 'dark', swatch: ['#181926', '#8aadf4', '#f5bde6'] },
  { key: 'frappe', label: 'Frappé', scheme: 'dark', swatch: ['#232634', '#8caaee', '#f2b8c6'] },
  { key: 'nord', label: 'Nord', scheme: 'dark', swatch: ['#2e3440', '#88c0d0', '#b48ead'] },
  { key: 'tokyonight', label: 'Tokyo Night', scheme: 'dark', swatch: ['#16161e', '#7aa2f7', '#bb9af7'] },
  { key: 'dracula', label: 'Dracula', scheme: 'dark', swatch: ['#191a21', '#bd93f9', '#ff79c6'] },
  { key: 'gruvbox', label: 'Gruvbox', scheme: 'dark', swatch: ['#1d2021', '#83a598', '#d3869b'] },
  { key: 'rosepine', label: 'Rosé Pine', scheme: 'dark', swatch: ['#191724', '#c4a7e7', '#eb6f92'] },
];

export const DEFAULT_SETTINGS = {
  schemaHint: 1,
  theme: 'mocha',
  proxyBase: '',
  proxyMode: 'auto', // 'auto' | 'always' | 'never'
  providers: {
    moviebox: true,
    fourkhdhub: true,
    dramachi: true,
    bdix_circleftp: false,
    bdix_dhakaflix: false,
    addons: true,
  },
  homeProvider: 'moviebox',
  language: 'en',
  safeSearch: true,
  continueWatching: true,
  searchDebounceMs: 350,
  maxHistory: 100,
  player: {
    autoplay: true,
    autoplayNext: true,
    autoplayPreviews: false,
    resumeEnabled: true,
    preferredQuality: 'auto',
    preferredAudio: 'auto',
  },
  tv: {
    rememberGroup: true,
    lastGroup: '',
  },
};

/* ================= Emitter ================= */

class Emitter {
  constructor() { this.map = new Map(); }
  on(event, fn) {
    if (!this.map.has(event)) this.map.set(event, new Set());
    this.map.get(event).add(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) { this.map.get(event)?.delete(fn); }
  emit(event, payload) {
    const set = this.map.get(event);
    if (set) for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`listener for ${event} failed`, err); }
    }
    const anySet = this.map.get('*');
    if (anySet) for (const fn of [...anySet]) {
      try { fn(event, payload); } catch (err) { console.error('wildcard listener failed', err); }
    }
  }
}

/* ================= Store ================= */

export const store = new Emitter();

function deepMerge(base, patch) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  if (!patch || typeof patch !== 'object') return out;
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/* --- settings --- */

let settings = deepMerge(DEFAULT_SETTINGS, loadJSON(STORAGE_KEYS.settings, {}));

export function getSettings() {
  return settings;
}

export function updateSettings(patch) {
  settings = deepMerge(settings, patch);
  saveJSON(STORAGE_KEYS.settings, settings);
  store.emit('settings', settings);
  return settings;
}

export function resetSettings() {
  settings = { ...DEFAULT_SETTINGS, providers: { ...DEFAULT_SETTINGS.providers }, player: { ...DEFAULT_SETTINGS.player }, tv: { ...DEFAULT_SETTINGS.tv } };
  saveJSON(STORAGE_KEYS.settings, settings);
  store.emit('settings', settings);
  return settings;
}

/* --- theme --- */

function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
}

export function resolvedTheme() {
  const t = settings.theme;
  if (t === 'system') return systemPrefersDark() ? 'mocha' : 'latte';
  return THEMES.some((th) => th.key === t) ? t : 'mocha';
}

export function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.setAttribute('data-theme', theme);
  const def = THEMES.find((t) => t.key === theme);
  document.documentElement.setAttribute('data-theme-scheme', def?.scheme || 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', def?.scheme === 'light' ? '#eff1f5' : '#11111b');
}

export function setTheme(themeKey) {
  updateSettings({ theme: themeKey });
  applyTheme();
}

export function toggleQuickTheme() {
  const scheme = document.documentElement.getAttribute('data-theme-scheme');
  const next = scheme === 'light' ? 'mocha' : 'latte';
  setTheme(next);
  return next;
}

/* --- favorites --- */

function loadFavorites() {
  const list = loadList(STORAGE_KEYS.favorites);
  return list.filter((item) => item && item.subject_id !== undefined);
}

let favorites = loadFavorites();

function persistFavorites() {
  saveList(STORAGE_KEYS.favorites, favorites);
  store.emit('favorites', favorites);
}

export function listFavorites() {
  return [...favorites];
}

export function isFavorite(identity) {
  if (!identity) return false;
  return favorites.some((item) => identityMatches(item, identity));
}

export function favoriteFromDetails(provider, details) {
  const title = cleanMovieboxTitle(details.title) || details.title;
  return {
    provider: parseProvider(provider) || provider,
    subject_id: details.id,
    title,
    cover_url: details.poster_url || null,
    stype: details.media_type === 'series' || (details.seasons && details.seasons.length) ? 2 : 1,
    release_year: details.year || '',
    added_at: Math.floor(Date.now() / 1000),
  };
}

export function favoriteFromResult(result) {
  return {
    provider: parseProvider(result.provider) || result.provider,
    subject_id: result.id,
    title: cleanMovieboxTitle(result.title) || result.title,
    cover_url: result.cover_url || null,
    stype: Number(result.stype) || 1,
    release_year: result.release_year || '',
    added_at: Math.floor(Date.now() / 1000),
  };
}

/** Returns true when the item is now a favorite. */
export function toggleFavorite(item) {
  const idx = favorites.findIndex((existing) => identityMatches(existing, item));
  if (idx >= 0) {
    favorites.splice(idx, 1);
    persistFavorites();
    return false;
  }
  favorites.push({ ...item, added_at: item.added_at || Math.floor(Date.now() / 1000) });
  persistFavorites();
  return true;
}

export function removeFavorite(identity) {
  const before = favorites.length;
  favorites = favorites.filter((item) => !identityMatches(item, identity));
  if (favorites.length !== before) persistFavorites();
}

export function clearFavorites() {
  favorites = [];
  persistFavorites();
}

/* --- history --- */

function loadHistory() {
  const list = loadList(STORAGE_KEYS.history);
  return Array.isArray(list) ? list : [];
}

let history = loadHistory();

function sameShow(a, b) {
  return identityMatches(a, b);
}

function consolidateHistory() {
  const sorted = [...history].sort((x, y) => (x.timestamp || 0) - (y.timestamp || 0));
  const out = [];
  let changed = false;
  for (const item of sorted) {
    const existing = out.find((e) => sameShow(e, item));
    if (existing) {
      changed = true;
      if ((item.timestamp || 0) >= (existing.timestamp || 0)) {
        const cover = item.cover_url || existing.cover_url;
        Object.assign(existing, item);
        existing.cover_url = cover || existing.cover_url;
      } else if (!existing.cover_url && item.cover_url) {
        existing.cover_url = item.cover_url;
      }
    } else {
      out.push({ ...item });
    }
  }
  if (out.length !== history.length) changed = true;
  history = out;
  return changed;
}

function persistHistory() {
  const max = Number(settings.maxHistory) || 100;
  if (history.length > max) history.splice(0, history.length - max);
  saveList(STORAGE_KEYS.history, history);
  store.emit('history', history);
}

export function listHistory() {
  return [...history].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
}

export function historyItemFromDetails(provider, details, season = 0, episode = 0) {
  const stype = details.media_type === 'series' || (details.seasons && details.seasons.length) ? 2 : 1;
  return {
    provider: parseProvider(provider) || provider,
    subject_id: details.id,
    title: cleanMovieboxTitle(details.title) || details.title,
    cover_url: details.poster_url || null,
    stype,
    release_year: details.year || '',
    season: Number(season) || 0,
    episode: Number(episode) || 0,
    timestamp: Math.floor(Date.now() / 1000),
    duration_seconds: details.duration_seconds ?? null,
    progress_seconds: 0,
    completed: false,
    stream_filename: null,
  };
}

export function getHistoryItem(provider, subjectId, season = 0, episode = 0) {
  const pk = parseProvider(provider) || provider;
  return history.find((item) => {
    const sameProvider = (parseProvider(item.provider) || item.provider) === pk;
    if (!sameProvider) return false;
    if (item.subject_id !== subjectId) return false;
    if (item.stype === 1) return true;
    return item.season === season && item.episode === episode;
  }) || null;
}

export function getShowHistory(provider, subjectId) {
  const pk = parseProvider(provider) || provider;
  return history.find((item) => (parseProvider(item.provider) || item.provider) === pk
    && item.subject_id === subjectId) || null;
}

function upsertHistory(item) {
  const normalized = { ...item, timestamp: item.timestamp || Math.floor(Date.now() / 1000) };
  history = history.filter((existing) => !sameShow(existing, normalized));
  history.push(normalized);
  const max = Number(settings.maxHistory) || 100;
  if (history.length > max) history.splice(0, history.length - max);
}

export function recordHistoryStart(baseItem, startPosition = 0) {
  const existing = history.find((i) => sameShow(i, baseItem));
  const item = { ...baseItem };
  if (existing) {
    if (!item.cover_url && existing.cover_url) item.cover_url = existing.cover_url;
    if (existing.season === item.season && existing.episode === item.episode) {
      item.progress_seconds = Math.max(existing.progress_seconds || 0, startPosition);
      item.duration_seconds = item.duration_seconds ?? existing.duration_seconds ?? null;
      item.completed = existing.completed;
    } else {
      item.progress_seconds = startPosition;
    }
  } else {
    item.progress_seconds = startPosition;
  }
  item.timestamp = Math.floor(Date.now() / 1000);
  upsertHistory(item);
  persistHistory();
  return item;
}

export function updateHistoryProgress(item, progress, duration, completed) {
  const next = {
    ...item,
    progress_seconds: Math.max(0, Math.round(progress || 0)),
    duration_seconds: duration ?? item.duration_seconds ?? null,
    completed: Boolean(completed),
    timestamp: Math.floor(Date.now() / 1000),
  };
  const existing = history.find((i) => sameShow(i, next));
  if (existing
    && existing.season === next.season
    && existing.episode === next.episode
    && (existing.progress_seconds || 0) >= next.progress_seconds
    && (next.timestamp - (existing.timestamp || 0)) < 60) {
    return;
  }
  upsertHistory(next);
  persistHistory();
}

export function markWatched(item) {
  upsertHistory({ ...item, completed: true, timestamp: Math.floor(Date.now() / 1000) });
  persistHistory();
}

export function removeHistoryEntry(provider, subjectId, season = 0, episode = 0) {
  const pk = parseProvider(provider) || provider;
  history = history.filter((i) => !((parseProvider(i.provider) || i.provider) === pk
    && i.subject_id === subjectId
    && i.season === season
    && i.episode === episode));
  persistHistory();
}

export function removeShowFromHistory(provider, subjectId) {
  const pk = parseProvider(provider) || provider;
  history = history.filter((i) => !((parseProvider(i.provider) || i.provider) === pk
    && i.subject_id === subjectId));
  persistHistory();
}

export function clearHistory() {
  history = [];
  persistHistory();
}

export function isEpisodeWatched(provider, subjectId, season, episode) {
  const pk = parseProvider(provider) || provider;
  const entry = history.find((i) => (parseProvider(i.provider) || i.provider) === pk
    && i.subject_id === subjectId
    && i.season === season
    && i.episode === episode);
  return Boolean(entry && entry.completed);
}

export function isInProgress(entry) {
  if (!entry || entry.completed) return false;
  if ((entry.progress_seconds || 0) < 30) return false;
  const dur = entry.duration_seconds;
  if (!dur) return false;
  if (entry.progress_seconds >= dur * 0.9) return false;
  return true;
}

export function progressPercent(entry) {
  const dur = entry?.duration_seconds;
  if (!dur || dur <= 0) return null;
  return Math.min(100, Math.max(0, ((entry.progress_seconds || 0) / dur) * 100));
}

/* --- per-episode resume points --- */

function progressKey(provider, subjectId, season, episode) {
  const pk = parseProvider(provider) || provider;
  return `${pk}::${subjectId}::${season}::${episode}`;
}

function loadProgressMap() {
  const data = loadJSON(STORAGE_KEYS.progress, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

let progressMap = loadProgressMap();

export function getResumePoint(provider, subjectId, season = 0, episode = 0) {
  return progressMap[progressKey(provider, subjectId, season, episode)] || null;
}

export function setResumePoint(provider, subjectId, season, episode, position, duration, completed = false) {
  const key = progressKey(provider, subjectId, season, episode);
  const existing = progressMap[key];
  const next = {
    position: Math.max(0, Math.round(position || 0)),
    duration: duration && Number.isFinite(duration) ? Math.round(duration) : (existing?.duration ?? null),
    completed: Boolean(completed),
    updatedAt: Date.now(),
  };
  if (!next.completed && existing && existing.position > next.position
    && Date.now() - existing.updatedAt < 60000) return existing;
  progressMap[key] = next;
  saveJSON(STORAGE_KEYS.progress, progressMap);
  return next;
}

export function clearResumePoints() {
  progressMap = {};
  saveJSON(STORAGE_KEYS.progress, progressMap);
}

/* --- playlists (M3U) --- */

let playlists = loadList(STORAGE_KEYS.playlists);

function persistPlaylists() {
  saveList(STORAGE_KEYS.playlists, playlists);
  store.emit('playlists', playlists);
}

export function listPlaylists() {
  return [...playlists];
}

export function addPlaylist({ name, url }) {
  const item = {
    id: `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: String(name || 'Playlist').trim(),
    url: String(url || '').trim(),
    addedAt: Date.now(),
  };
  playlists = playlists.filter((p) => p.url !== item.url);
  playlists.push(item);
  persistPlaylists();
  return item;
}

export function removePlaylist(id) {
  playlists = playlists.filter((p) => p.id !== id);
  persistPlaylists();
}

/* --- addons (manifest data only — never executable code) --- */

let addons = loadList(STORAGE_KEYS.addons);

function persistAddons() {
  saveList(STORAGE_KEYS.addons, addons);
  store.emit('addons', addons);
}

export function listAddons() {
  return [...addons];
}

export function installAddon(manifest) {
  const normalized = {
    id: String(manifest.id || manifest.url || '').trim(),
    url: String(manifest.url || '').trim(),
    name: String(manifest.name || 'Unnamed addon').trim(),
    version: String(manifest.version || '').trim(),
    description: String(manifest.description || '').trim(),
    logo: manifest.logo || null,
    types: Array.isArray(manifest.types) ? manifest.types.slice(0, 8) : [],
    catalogs: Array.isArray(manifest.catalogs) ? manifest.catalogs.length : 0,
    installedAt: Date.now(),
    transportUrl: manifest.transportUrl || manifest.url,
  };
  addons = addons.filter((a) => a.id !== normalized.id);
  addons.push(normalized);
  persistAddons();
  return normalized;
}

export function uninstallAddon(id) {
  addons = addons.filter((a) => a.id !== id);
  persistAddons();
}

export function updateAddon(id, patch) {
  addons = addons.map((a) => (a.id === id ? { ...a, ...patch } : a));
  persistAddons();
}

/* --- provider runtime status (status probes) --- */

let providerState = loadJSON(STORAGE_KEYS.providerState, {}) || {};

export function getProviderStatus(key) {
  return providerState[key] || { status: 'unknown', checkedAt: 0, detail: '' };
}

export function setProviderStatus(key, status, detail = '') {
  providerState = {
    ...providerState,
    [key]: { status, detail: String(detail || ''), checkedAt: Date.now() },
  };
  saveJSON(STORAGE_KEYS.providerState, providerState);
  store.emit('providerStatus', { key, status, detail });
}

export function enabledProviders() {
  return BUILTIN_PROVIDER_ORDER.filter((key) => settings.providers?.[key] !== false);
}

/* --- data maintenance --- */

export function clearAllLocalData() {
  clearFavorites();
  clearHistory();
  clearResumePoints();
}

export function dataInfo() {
  return {
    favorites: favorites.length,
    history: history.length,
    progress: Object.keys(progressMap).length,
    playlists: playlists.length,
    addons: addons.length,
    mode: storageMode(),
  };
}

export function migrate() {
  const changed = consolidateHistory();
  if (changed) persistHistory();
}

store.on('settings', () => { /* subscribers registered by pages */ });
