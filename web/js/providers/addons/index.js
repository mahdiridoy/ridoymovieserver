/*
 * Stremio-style addon client — port of
 * src/providers/addons/{client,models,adapter,aggregator,mod}.rs
 *
 * Manifests are DATA only: this module never fetches, evaluates or injects
 * JavaScript from an addon. Every body travels through the api.js layer
 * (Cinemeta is CORS-enabled; other hosts fall back to the configured proxy).
 *
 * URL patterns (Rust AddonClient):
 *   {base}/manifest.json
 *   {base}/catalog/{type}/{catalogId}.json
 *   {base}/catalog/{type}/{catalogId}/search={query}.json
 *   {base}/meta/{type}/{id}.json
 *   {base}/stream/{type}/{id}.json            (series episodes: {id}:{season}:{episode})
 */

import {
  page, catalogItem, emptyDetails, release, mirror, sortReleases, wrapError,
  ProviderError, getJSON,
} from '../base.js';
import { listAddons } from '../../state.js';
import { safeUrl } from '../../utils/sanitize.js';
import { extract4DigitYear, cleanStreamText, parseSizeBytes } from '../../utils/title.js';

const PROVIDER_KEY = 'addons';
const PROVIDER_LABEL = 'Addons';

const MANIFEST_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 12000;
const STREAM_TIMEOUT_MS = 5000;
const MANIFEST_CACHE_TTL_MS = 5 * 60 * 1000;
const CATALOG_PAGE_SIZE = 50;

const TYPE_HINTS = ['movie', 'series', 'tv', 'anime', 'other'];
const TYPE_ORDER = ['series', 'movie', 'tv', 'anime', 'other'];
const DEFAULT_SEARCH_TYPES = ['movie', 'series'];

/* ---------------- helpers ---------------- */

function asString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return (asString(value) || '').trim();
}

function normalizeStringList(value) {
  if (typeof value === 'string') {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const s = asString(entry);
    if (s && s.trim()) out.push(s.trim());
    else if (entry && typeof entry === 'object') {
      const name = asString(entry.name);
      if (name && name.trim()) out.push(name.trim());
    }
  }
  return out;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

function httpUrlOrThrow(value, what) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ProviderError('bad_request', `${what} is missing`, { provider: PROVIDER_LABEL });
  const safe = safeUrl(raw);
  if (!safe || !/^https?:\/\//i.test(safe)) {
    throw new ProviderError('bad_request', `${what} must be an http(s) URL`, { provider: PROVIDER_LABEL });
  }
  return safe;
}

function normalizeManifestUrl(raw) {
  let url = String(raw ?? '').trim();
  if (!url) {
    throw new ProviderError('bad_request', 'Addon manifest URL is missing', { provider: PROVIDER_LABEL });
  }
  if (/^stremio:\/\//i.test(url)) url = `https://${url.slice('stremio://'.length)}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;

  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  const suffix = cut === -1 ? '' : url.slice(cut);
  url = base.endsWith('/manifest.json')
    ? `${base}${suffix}`
    : `${base.replace(/\/+$/, '')}/manifest.json${suffix}`;

  return httpUrlOrThrow(url, 'Addon manifest URL');
}

function baseAddonUrl(manifestUrl) {
  const normalized = normalizeManifestUrl(manifestUrl);
  const idx = normalized.lastIndexOf('/manifest.json');
  if (idx !== -1) return normalized.slice(0, idx);
  return normalized.replace(/\/+$/, '');
}

function addonSource(addon) {
  return String(addon?.url || addon?.transportUrl || '').trim();
}

function addonTypes(addon) {
  return normalizeStringList(addon?.types);
}

function describeError(err) {
  if (err instanceof ProviderError) return `${err.kind}${err.message ? `: ${err.message}` : ''}`;
  return String(err?.message || err);
}

const manifestCache = new Map();

function readManifestCache(key) {
  const hit = manifestCache.get(key);
  if (!hit) return null;
  if (hit.expires > Date.now()) return hit.manifest;
  manifestCache.delete(key);
  return null;
}

function writeManifestCache(key, manifest) {
  manifestCache.set(key, { manifest, expires: Date.now() + MANIFEST_CACHE_TTL_MS });
}

function validateManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProviderError('parsing', 'Addon manifest is not an object', { provider: PROVIDER_LABEL });
  }
  const id = text(raw.id);
  const name = text(raw.name);
  if (!name) throw new ProviderError('parsing', 'Addon manifest missing valid name', { provider: PROVIDER_LABEL });
  if (!id) throw new ProviderError('parsing', 'Addon manifest missing id', { provider: PROVIDER_LABEL });

  const resources = [];
  if (Array.isArray(raw.resources)) {
    for (const entry of raw.resources) {
      if (typeof entry === 'string') {
        const simple = entry.trim();
        if (simple) resources.push({ name: simple, types: [], idPrefixes: [] });
        continue;
      }
      if (entry && typeof entry === 'object') {
        const resourceName = text(entry.name);
        if (resourceName) {
          resources.push({
            name: resourceName,
            types: normalizeStringList(entry.types),
            idPrefixes: normalizeStringList(entry.idPrefixes),
          });
        }
      }
    }
  } else if (typeof raw.resources === 'string') {
    for (const part of raw.resources.split(',')) {
      const simple = part.trim();
      if (simple) resources.push({ name: simple, types: [], idPrefixes: [] });
    }
  }

  const catalogs = [];
  for (const entry of asArray(raw.catalogs)) {
    if (!entry || typeof entry !== 'object') continue;
    const type = text(entry.type);
    const catalogId = text(entry.id);
    if (!type || !catalogId) continue;
    catalogs.push({ type, id: catalogId, name: text(entry.name) || catalogId });
  }

  const idPrefixes = [...new Set([
    ...normalizeStringList(raw.idPrefixes),
    ...resources.flatMap((resource) => resource.idPrefixes),
  ])];

  const logo = text(raw.logo);

  return {
    id,
    name,
    version: text(raw.version),
    description: text(raw.description),
    logo: isHttpUrl(logo) ? logo : null,
    types: normalizeStringList(raw.types),
    catalogs,
    resources,
    idPrefixes,
  };
}

function providesResource(manifest, resourceName) {
  return manifest.resources.some((r) => r.name.toLowerCase() === resourceName.toLowerCase());
}

function parseCatalogList(raw) {
  if (Array.isArray(raw)) return raw.filter((entry) => entry && typeof entry === 'object');
  if (!raw || typeof raw !== 'object') return [];
  const list = raw.metas ?? raw.items ?? raw.results;
  return Array.isArray(list) ? list.filter((entry) => entry && typeof entry === 'object') : [];
}

function parseStreamList(raw) {
  if (Array.isArray(raw)) return raw.filter((entry) => entry && typeof entry === 'object');
  if (!raw || typeof raw !== 'object') return [];
  return Array.isArray(raw.streams)
    ? raw.streams.filter((entry) => entry && typeof entry === 'object')
    : [];
}

function isSeriesMeta(meta) {
  const type = text(meta?.type).toLowerCase();
  return type === 'series' || type === 'tv' || type === 'anime' || asArray(meta?.videos).length > 0;
}

function metaTitle(meta) {
  return text(meta?.name) || text(meta?.title) || 'Unknown';
}

function metaToCatalogItem(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const rawId = text(meta.id);
  if (!rawId) return null;
  const isSeries = isSeriesMeta(meta);
  const yearRaw = asString(meta.releaseInfo) ?? asString(meta.year) ?? asString(meta.released) ?? '';
  return catalogItem({
    provider: PROVIDER_KEY,
    id: `${isSeries ? 'series' : 'movie'}:${rawId}`,
    title: metaTitle(meta),
    media_type: isSeries ? 'series' : 'movie',
    year: extract4DigitYear(yearRaw) || null,
    poster_url: asString(meta.poster) ?? asString(meta.cover) ?? null,
  });
}

function encodeAddonQuery(query) {
  return encodeURIComponent(String(query ?? '')).replace(
    /[!'()*._~-]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

function toUsize(value) {
  const n = asString(value) ?? (typeof value === 'number' && Number.isFinite(value) ? String(value) : null);
  if (n === null || n.trim() === '') return null;
  const parsed = Number.parseInt(n.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function joinNames(meta, keys) {
  for (const key of keys) {
    const names = normalizeStringList(meta?.[key]);
    if (names.length) return names.join(', ');
  }
  return null;
}

function buildSeasons(meta, videos) {
  const seasonMap = new Map();
  for (const video of videos) {
    if (!video || typeof video !== 'object') continue;
    const seasonNumber = toUsize(video.season) ?? 1;
    const episodeNumber = toUsize(video.episode) ?? toUsize(video.number) ?? 1;
    if (!seasonMap.has(seasonNumber)) seasonMap.set(seasonNumber, new Map());
    const episodes = seasonMap.get(seasonNumber);
    if (episodes.has(episodeNumber)) continue;
    episodes.set(episodeNumber, {
      season: seasonNumber,
      number: episodeNumber,
      title: asString(video.title) ?? asString(video.name) ?? null,
      overview: asString(video.overview) ?? asString(video.description) ?? null,
    });
  }

  if (!seasonMap.size) {
    const fallback = meta?.seriesInfo?.seasons ?? meta?.seasons;
    if (Array.isArray(fallback)) {
      for (const entry of fallback) {
        if (typeof entry === 'number' && Number.isFinite(entry)) {
          seasonMap.set(Math.trunc(entry), new Map());
          continue;
        }
        if (!entry || typeof entry !== 'object') continue;
        const seasonNumber = toUsize(entry.number ?? entry.season ?? entry.seasonNumber)
          ?? (seasonMap.size + 1);
        const episodes = new Map();
        for (const episode of asArray(entry.episodes)) {
          if (typeof episode === 'number' && Number.isFinite(episode)) {
            const epNumber = Math.trunc(episode);
            if (!episodes.has(epNumber)) episodes.set(epNumber, { season: seasonNumber, number: epNumber, title: null, overview: null });
            continue;
          }
          if (!episode || typeof episode !== 'object') continue;
          const epNumber = toUsize(episode.number ?? episode.episode) ?? (episodes.size + 1);
          if (episodes.has(epNumber)) continue;
          episodes.set(epNumber, {
            season: seasonNumber,
            number: epNumber,
            title: asString(episode.title) ?? asString(episode.name) ?? null,
            overview: asString(episode.overview) ?? asString(episode.description) ?? null,
          });
        }
        seasonMap.set(seasonNumber, episodes);
      }
    }
  }

  return [...seasonMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, episodes]) => ({
      number,
      episodes: [...episodes.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, episode]) => episode),
    }));
}

function metaToDetails(meta, detailsId) {
  const isSeries = isSeriesMeta(meta);
  const yearRaw = asString(meta.releaseInfo) ?? asString(meta.year) ?? asString(meta.released) ?? '';
  const year4 = extract4DigitYear(yearRaw);
  const year = year4 || (yearRaw.trim() ? yearRaw.trim() : null);

  const details = emptyDetails({
    provider: PROVIDER_KEY,
    id: detailsId,
    title: metaTitle(meta),
    media_type: isSeries ? 'series' : 'movie',
    poster_url: asString(meta.poster) ?? asString(meta.cover) ?? asString(meta.background) ?? null,
    year,
  });

  details.description = asString(meta.description) ?? asString(meta.overview) ?? asString(meta.synopsis) ?? null;
  details.imdb_rating = asString(meta.imdbRating) ?? asString(meta.rating) ?? null;
  details.director = joinNames(meta, ['director'])
    ?? joinNames(meta, ['directors'])
    ?? joinNames(meta, ['writers'])
    ?? joinNames(meta, ['writer']);
  details.stars = joinNames(meta, ['cast']) ?? joinNames(meta, ['stars']);
  details.duration = asString(meta.runtime) ?? null;
  const genres = normalizeStringList(meta.genres);
  details.genres = genres.length ? genres : normalizeStringList(meta.genre);
  details.seasons = buildSeasons(meta, asArray(meta.videos));

  return details;
}

/* ---------------- adapter token parsers (adapter.rs) ---------------- */

function parseQuality(input) {
  const upper = String(input ?? '').toUpperCase();
  if (upper.includes('2160P') || upper.includes('4K') || upper.includes('UHD')) return '2160p';
  if (upper.includes('1080P') || upper.includes('FHD') || upper.includes('FULL HD') || upper.includes('FULLHD')) return '1080p';
  const words = upper.split(/[^0-9A-Za-z]+/);
  if (upper.includes('720P') || words.includes('HD')) return '720p';
  if (upper.includes('480P') || words.includes('SD')) return '480p';
  return null;
}

function parseCodec(input) {
  const upper = String(input ?? '').toUpperCase();
  if (upper.includes('HEVC') || upper.includes('X265') || upper.includes('H.265') || upper.includes('H265')) return 'HEVC/x265';
  if (upper.includes('X264') || upper.includes('H.264') || upper.includes('H264') || upper.includes('AVC')) return 'AVC/x264';
  if (upper.includes('AV1')) return 'AV1';
  return null;
}

const AUDIO_CANDIDATES = [
  ['HINDI', 'Hindi'],
  ['ENGLISH', 'English'],
  ['ENG', 'English'],
  ['HIN', 'Hindi'],
  ['TAMIL', 'Tamil'],
  ['TELUGU', 'Telugu'],
  ['BENGALI', 'Bengali'],
  ['BEN', 'Bengali'],
  ['MALAYALAM', 'Malayalam'],
  ['KANNADA', 'Kannada'],
  ['MARATHI', 'Marathi'],
  ['PUNJABI', 'Punjabi'],
  ['GUJARATI', 'Gujarati'],
  ['URDU', 'Urdu'],
  ['SPANISH', 'Spanish'],
  ['FRENCH', 'French'],
  ['GERMAN', 'German'],
  ['ITALIAN', 'Italian'],
  ['JAPANESE', 'Japanese'],
  ['JAP', 'Japanese'],
  ['KOREAN', 'Korean'],
  ['KOR', 'Korean'],
  ['RUSSIAN', 'Russian'],
  ['CHINESE', 'Chinese'],
  ['DUAL', 'Dual Audio'],
  ['MULTI', 'Multi Audio'],
];

function parseAudioTracks(input) {
  const upper = String(input ?? '').toUpperCase();
  const langs = [];
  for (const [needle, label] of AUDIO_CANDIDATES) {
    if (upper.includes(needle) && !langs.includes(label)) langs.push(label);
  }
  return langs.length ? langs.join(' + ') : null;
}

function isAsciiDigit(code) {
  return code >= 48 && code <= 57;
}

function isAsciiAlphanumeric(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function parseSeasonEpisode(input) {
  const value = String(input ?? '');
  const len = value.length;
  let i = 0;

  while (i < len) {
    const code = value.charCodeAt(i);

    if ((code === 83 || code === 115) && i + 1 < len && isAsciiDigit(value.charCodeAt(i + 1))) {
      if (i === 0 || !isAsciiAlphanumeric(value.charCodeAt(i - 1))) {
        const seasonStart = i + 1;
        let seasonEnd = seasonStart;
        while (seasonEnd < len && isAsciiDigit(value.charCodeAt(seasonEnd))) seasonEnd += 1;
        if (seasonEnd < len && (seasonEnd - seasonStart) <= 3) {
          const seasonNumber = Number.parseInt(value.slice(seasonStart, seasonEnd), 10);
          if (Number.isFinite(seasonNumber)) {
            let episodeIdx = seasonEnd;
            while (episodeIdx < len && (value[episodeIdx] === '.' || value[episodeIdx] === ' ' || value[episodeIdx] === '_' || value[episodeIdx] === '-')) episodeIdx += 1;
            if (episodeIdx < len
              && (value[episodeIdx] === 'E' || value[episodeIdx] === 'e')
              && episodeIdx + 1 < len
              && isAsciiDigit(value.charCodeAt(episodeIdx + 1))) {
              const episodeStart = episodeIdx + 1;
              let episodeEnd = episodeStart;
              while (episodeEnd < len && isAsciiDigit(value.charCodeAt(episodeEnd))) episodeEnd += 1;
              if ((episodeEnd - episodeStart) <= 4) {
                const episodeNumber = Number.parseInt(value.slice(episodeStart, episodeEnd), 10);
                if (Number.isFinite(episodeNumber)) return [seasonNumber, episodeNumber];
              }
            }
          }
        }
      }
    }

    if ((code === 120 || code === 88)
      && i > 0
      && isAsciiDigit(value.charCodeAt(i - 1))
      && i + 1 < len
      && isAsciiDigit(value.charCodeAt(i + 1))) {
      let seasonStart = i - 1;
      while (seasonStart > 0 && isAsciiDigit(value.charCodeAt(seasonStart - 1))) seasonStart -= 1;
      if (seasonStart === 0 || !isAsciiAlphanumeric(value.charCodeAt(seasonStart - 1))) {
        const seasonStr = value.slice(seasonStart, i);
        let episodeEnd = i + 1;
        while (episodeEnd < len && isAsciiDigit(value.charCodeAt(episodeEnd))) episodeEnd += 1;
        const episodeStr = value.slice(i + 1, episodeEnd);
        if (seasonStr.length <= 3 && episodeStr.length <= 4) {
          const seasonNumber = Number.parseInt(seasonStr, 10);
          const episodeNumber = Number.parseInt(episodeStr, 10);
          if (seasonNumber > 0 && seasonNumber < 100 && episodeNumber > 0 && episodeNumber < 10000) {
            return [seasonNumber, episodeNumber];
          }
        }
      }
    }

    i += 1;
  }

  const upper = value.toUpperCase();
  const seasonPos = upper.indexOf('SEASON ');
  if (seasonPos !== -1) {
    const seasonDigits = upper.slice(seasonPos + 7).replace(/^ +/, '').match(/^\d+/);
    if (seasonDigits) {
      const episodePos = upper.indexOf('EPISODE ');
      if (episodePos !== -1) {
        const episodeDigits = upper.slice(episodePos + 8).replace(/^ +/, '').match(/^\d+/);
        if (episodeDigits) return [Number.parseInt(seasonDigits[0], 10), Number.parseInt(episodeDigits[0], 10)];
      }
    }
  }

  const onlyEpisodePos = upper.indexOf('EPISODE ');
  if (onlyEpisodePos !== -1) {
    const episodeDigits = upper.slice(onlyEpisodePos + 8).replace(/^ +/, '').match(/^\d+/);
    if (episodeDigits) return [1, Number.parseInt(episodeDigits[0], 10)];
  }

  return null;
}

function extractDomainLabel(input) {
  const urlClean = String(input ?? '').trim();
  const withoutProtocol = urlClean.startsWith('https://')
    ? urlClean.slice('https://'.length)
    : (urlClean.startsWith('http://') ? urlClean.slice('http://'.length) : urlClean);
  const host = withoutProtocol.split(/[/?:#]/)[0]?.trim();
  if (!host) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.');
  if (parts.length < 2) return null;
  const penultimate = parts[parts.length - 2];
  const mainPart = (penultimate === 'co' || penultimate === 'com') && parts.length >= 3
    ? parts[parts.length - 3]
    : penultimate;
  if (!mainPart || mainPart === 'www' || mainPart === 'api' || mainPart === 'cdn') return null;
  return mainPart
    .split(/[-_]/)
    .map((word) => (word ? `${word[0].toUpperCase()}${word.slice(1)}` : ''))
    .join(' ');
}

function detectStreamHost(addonName, streamName, url) {
  const labels = [];
  for (const rawLine of String(streamName ?? '').split('\n')) {
    const trimmed = rawLine.trim().replace(/^[[()\s]+/, '').replace(/[\s)\]]+$/, '');
    if (trimmed && trimmed.toLowerCase() !== addonName.toLowerCase() && !labels.includes(trimmed)) {
      labels.push(trimmed);
    }
  }
  const domainLabel = extractDomainLabel(url);
  if (domainLabel
    && domainLabel.toLowerCase() !== addonName.toLowerCase()
    && !labels.some((label) => label.toLowerCase() === domainLabel.toLowerCase())) {
    labels.push(domainLabel);
  }
  return labels.length ? `${addonName} · ${labels[0]}` : addonName;
}

const ALLOWED_STREAM_HEADERS = new Set([
  'user-agent', 'referer', 'origin', 'range', 'x-forwarded-for', 'accept', 'accept-language',
]);

function streamItemToRelease(addonName, stream, season, episode) {
  if (!stream || typeof stream !== 'object') return null;
  const url = String(stream.url ?? '').trim();
  if (!isHttpUrl(url)) return null;

  const streamName = asString(stream.name) ?? '';
  const streamTitle = asString(stream.title) ?? '';
  const streamDescription = asString(stream.description) ?? '';
  const combinedText = `${streamName} ${streamTitle} ${streamDescription}`;

  const wantedSeason = Math.max(0, Math.trunc(Number(season) || 0));
  const wantedEpisode = Math.max(0, Math.trunc(Number(episode) || 0));
  if (wantedSeason > 0 && wantedEpisode > 0) {
    const parsed = parseSeasonEpisode(combinedText);
    if (parsed && (parsed[0] !== wantedSeason || parsed[1] !== wantedEpisode)) return null;
  }

  const hints = stream.behaviorHints && typeof stream.behaviorHints === 'object' ? stream.behaviorHints : null;
  const sizeFromHints = typeof hints?.videoSize === 'number' && Number.isFinite(hints.videoSize)
    ? Math.trunc(hints.videoSize)
    : null;

  const rawFilenameSource = asString(stream.title) ?? asString(stream.description) ?? asString(stream.name) ?? null;
  const firstLine = rawFilenameSource ? (rawFilenameSource.split('\n')[0] || '').trim() : '';
  const filename = cleanStreamText(firstLine || `${addonName} Stream`);
  const language = parseAudioTracks(combinedText);

  const headers = [];
  if (hints?.headers && typeof hints.headers === 'object') {
    for (const [key, value] of Object.entries(hints.headers)) {
      if (ALLOWED_STREAM_HEADERS.has(String(key).toLowerCase())) {
        headers.push([String(key), String(value)]);
      }
    }
  }

  return release({
    provider: PROVIDER_KEY,
    filename,
    quality: parseQuality(combinedText),
    codec: parseCodec(combinedText),
    language: language ? cleanStreamText(language) : null,
    size_bytes: sizeFromHints ?? parseSizeBytes(combinedText),
    season: wantedSeason > 0 ? wantedSeason : null,
    episode: wantedEpisode > 0 ? wantedEpisode : null,
    mirrors: [
      mirror({
        label: cleanStreamText(detectStreamHost(addonName, streamName, url)),
        resolver_url: url,
        headers,
        direct_file: true,
      }),
    ],
    resource_id: null,
  });
}

function mergeReleases(releases) {
  const merged = [];
  const byUrl = new Map();
  for (const item of releases) {
    const direct = item.mirrors?.[0]?.resolver_url || '';
    if (!direct) {
      merged.push(item);
      continue;
    }
    const existing = byUrl.get(direct);
    if (!existing) {
      byUrl.set(direct, item);
      merged.push(item);
      continue;
    }
    for (const itemMirror of item.mirrors) {
      const alreadyPresent = existing.mirrors.some(
        (existingMirror) => existingMirror.resolver_url === itemMirror.resolver_url
          && existingMirror.label === itemMirror.label,
      );
      if (!alreadyPresent) existing.mirrors.push(itemMirror);
    }
  }
  return merged;
}

function sortAddonsByType(addons, type) {
  const preferred = addons.filter((addon) => addonTypes(addon).includes(type));
  const rest = addons.filter((addon) => !addonTypes(addon).includes(type));
  return [...preferred, ...rest];
}

function splitTypeHint(id) {
  const rawId = String(id ?? '').trim();
  const colon = rawId.indexOf(':');
  if (colon > 0) {
    const prefix = rawId.slice(0, colon).toLowerCase();
    if (TYPE_HINTS.includes(prefix)) return { typeHint: prefix, cleanId: rawId.slice(colon + 1) };
  }
  return { typeHint: null, cleanId: rawId };
}

function searchTypesFor(addon) {
  const declared = addonTypes(addon);
  if (!declared.length) return [...DEFAULT_SEARCH_TYPES];
  const ordered = [
    ...DEFAULT_SEARCH_TYPES.filter((type) => declared.includes(type)),
    ...declared.filter((type) => !DEFAULT_SEARCH_TYPES.includes(type)),
  ];
  return ordered.length ? ordered : [...DEFAULT_SEARCH_TYPES];
}

async function resolveCatalogTargets(addon, types, signal) {
  let manifest = null;
  try {
    manifest = await fetchManifest(addonSource(addon), { signal });
  } catch {
    manifest = null;
  }
  return types.map((type) => {
    const catalogs = manifest ? manifest.catalogs.filter((entry) => entry.type === type) : [];
    const chosen = catalogs.find((entry) => entry.id === 'top') || catalogs[0];
    return { type, catalogId: chosen ? chosen.id : 'top' };
  });
}

async function fetchCatalogSearch(addon, target, query, signal) {
  const base = baseAddonUrl(addonSource(addon));
  const url = `${base}/catalog/${target.type}/${target.catalogId}/search=${encodeAddonQuery(query)}.json`;
  const payload = await getJSON({ url, signal, timeoutMs: REQUEST_TIMEOUT_MS, provider: PROVIDER_LABEL });
  return parseCatalogList(payload);
}

/* ---------------- public surface ---------------- */

export async function fetchManifest(url, { signal } = {}) {
  const normalized = normalizeManifestUrl(url);
  const cached = readManifestCache(normalized);
  if (cached) return cached;

  let payload;
  try {
    payload = await getJSON({
      url: normalized,
      signal,
      timeoutMs: MANIFEST_TIMEOUT_MS,
      provider: PROVIDER_LABEL,
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw wrapError(err, PROVIDER_KEY, PROVIDER_LABEL);
  }

  const manifest = validateManifest(payload);
  writeManifestCache(normalized, manifest);
  return manifest;
}

export async function listCatalogs(installed = listAddons(), { signal } = {}) {
  const addons = (Array.isArray(installed) ? installed : []).filter((addon) => addon && addonSource(addon));
  const settled = await Promise.allSettled(
    addons.map((addon) => fetchManifest(addonSource(addon), { signal })),
  );

  const entries = [];
  const failures = [];

  settled.forEach((result, index) => {
    const addon = addons[index];
    if (result.status === 'rejected') {
      failures.push({
        addonId: String(addon?.id || ''),
        addonName: String(addon?.name || ''),
        url: addonSource(addon),
        error: describeError(result.reason),
      });
      return;
    }
    const manifest = result.value;
    if (!manifest.catalogs.length) return;
    const addonLogo = isHttpUrl(addon?.logo) ? String(addon.logo).trim() : null;
    for (const catalog of manifest.catalogs) {
      entries.push({
        addonId: String(addon?.id || manifest.id),
        addonName: String(addon?.name || manifest.name),
        logo: manifest.logo || addonLogo,
        type: catalog.type,
        id: catalog.id,
        name: catalog.name,
      });
    }
  });

  if (failures.length) {
    entries.failures = failures;
    console.warn('[addons] skipped unreachable manifests', failures);
  }
  return entries;
}

export async function searchCatalog(installed, query, { signal } = {}) {
  const q = String(query ?? '').trim();
  const addons = (installed ?? listAddons()).filter((addon) => addon && addonSource(addon));

  if (!addons.length) {
    throw new ProviderError(
      'bad_request',
      'No catalog/metadata addon enabled. Install one from Settings → Addons.',
      { provider: PROVIDER_LABEL },
    );
  }
  if (!q) return [];

  const combined = [];
  for (const addon of addons) {
    const targets = await resolveCatalogTargets(addon, searchTypesFor(addon), signal);
    if (!targets.length) continue;

    const batches = await Promise.all(
      targets.map((target) => fetchCatalogSearch(addon, target, q, signal).catch(() => null)),
    );
    for (const batch of batches) {
      if (batch && batch.length) combined.push(...batch);
    }
    if (combined.length) break;
  }

  const seen = new Set();
  const items = [];
  for (const meta of combined) {
    const item = metaToCatalogItem(meta);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

export async function fetchCatalog(installed, { type = 'movie', id = 'top', page: pageNo = 1, search, signal } = {}) {
  const addons = (installed ?? listAddons()).filter((addon) => addon && addonSource(addon));
  let candidates = addons.filter((addon) => {
    const declared = addonTypes(addon);
    return !declared.length || declared.includes(type);
  });
  if (!candidates.length) candidates = addons;
  if (!candidates.length) {
    throw new ProviderError(
      'bad_request',
      'No catalog/metadata addon enabled. Install one from Settings → Addons.',
      { provider: PROVIDER_LABEL },
    );
  }

  const extras = [];
  if (search !== undefined && search !== null && String(search).trim()) {
    extras.push(`search=${encodeAddonQuery(String(search).trim())}`);
  }
  const size = CATALOG_PAGE_SIZE;
  if (pageNo > 1) extras.push(`skip=${(pageNo - 1) * size}&limit=${size}`);

  let firstError = null;
  let sawSuccess = false;

  for (const addon of candidates) {
    const base = baseAddonUrl(addonSource(addon));
    const endpoint = extras.length
      ? `${base}/catalog/${type}/${id}/${extras.join('&')}.json`
      : `${base}/catalog/${type}/${id}.json`;
    let items;
    try {
      const payload = await getJSON({ url: endpoint, signal, timeoutMs: REQUEST_TIMEOUT_MS, provider: PROVIDER_LABEL });
      items = parseCatalogList(payload).map(metaToCatalogItem).filter(Boolean);
      sawSuccess = true;
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'aborted') throw err;
      if (!firstError) firstError = err;
      continue;
    }
    if (items.length) return page(items, pageNo, items.length >= size);
  }

  if (firstError && !sawSuccess) throw wrapError(firstError, PROVIDER_KEY, PROVIDER_LABEL);
  return page([], pageNo, false);
}

export async function fetchDetails(installed, { id, type, signal } = {}) {
  const rawId = String(id ?? '').trim();
  if (!rawId) {
    throw new ProviderError('bad_request', 'Missing addon id', { provider: PROVIDER_LABEL });
  }

  const { typeHint, cleanId } = splitTypeHint(rawId);
  const requestedType = text(type).toLowerCase();
  const typesToTry = typeHint
    ? [typeHint, ...TYPE_ORDER.filter((entry) => entry !== typeHint)]
    : (TYPE_HINTS.includes(requestedType)
      ? [requestedType, ...TYPE_ORDER.filter((entry) => entry !== requestedType)]
      : [...TYPE_ORDER]);

  const addons = (installed ?? listAddons()).filter((addon) => addon && addonSource(addon));
  if (!addons.length) {
    throw new ProviderError(
      'bad_request',
      'No addon installed. Install one from Settings → Addons.',
      { provider: PROVIDER_LABEL },
    );
  }

  const ordered = sortAddonsByType(addons, typesToTry[0]);
  let bestDetail = null;

  for (const addon of ordered) {
    const base = baseAddonUrl(addonSource(addon));
    for (const candidateType of typesToTry) {
      const endpoint = `${base}/meta/${candidateType}/${cleanId}.json`;
      let meta;
      try {
        const payload = await getJSON({ url: endpoint, signal, timeoutMs: REQUEST_TIMEOUT_MS, provider: PROVIDER_LABEL });
        if (!payload || typeof payload !== 'object') continue;
        meta = payload.meta && typeof payload.meta === 'object' ? payload.meta : payload;
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'aborted') throw err;
        continue;
      }

      if (text(meta.id) !== cleanId) continue;
      if (!text(meta.name) && !text(meta.title)) continue;

      const hasVideos = asArray(meta.videos).length > 0;
      const metaType = text(meta.type).toLowerCase();
      const wantsSeries = hasVideos || metaType === 'series' || metaType === 'tv';
      const wantsMovieHint = typeHint === 'movie' && metaType === 'movie';

      if (wantsSeries || wantsMovieHint) {
        const seriesFlag = isSeriesMeta(meta);
        const detailsId = typeHint ? `${typeHint}:${cleanId}` : `${seriesFlag ? 'series' : 'movie'}:${text(meta.id) || cleanId}`;
        return metaToDetails(meta, detailsId);
      }
      if (!bestDetail) bestDetail = { meta, typeHint, cleanId };
    }
  }

  if (bestDetail) {
    const seriesFlag = isSeriesMeta(bestDetail.meta);
    const detailsId = bestDetail.typeHint
      ? `${bestDetail.typeHint}:${bestDetail.cleanId}`
      : `${seriesFlag ? 'series' : 'movie'}:${text(bestDetail.meta.id) || bestDetail.cleanId}`;
    return metaToDetails(bestDetail.meta, detailsId);
  }

  throw new ProviderError('not_found', `No addon metadata for ${rawId}`, { provider: PROVIDER_LABEL });
}

export async function fetchStreams(installed, { id, type, season = 0, episode = 0, signal } = {}) {
  const rawId = String(id ?? '').trim();
  if (!rawId) {
    throw new ProviderError('bad_request', 'Missing addon id', { provider: PROVIDER_LABEL });
  }

  const { typeHint, cleanId } = splitTypeHint(rawId);
  const requestedType = text(type).toLowerCase() || typeHint || '';
  const resolvedType = TYPE_HINTS.includes(requestedType)
    ? requestedType
    : ((Number(season) > 0 && Number(episode) > 0) ? 'series' : 'movie');

  const seasonNumber = Math.max(0, Math.trunc(Number(season) || 0));
  const episodeNumber = Math.max(0, Math.trunc(Number(episode) || 0));
  const useEpisodeId = resolvedType !== 'movie' && seasonNumber > 0 && episodeNumber > 0;
  const streamId = useEpisodeId ? `${cleanId}:${seasonNumber}:${episodeNumber}` : cleanId;

  const addons = (installed ?? listAddons()).filter((addon) => addon && addonSource(addon));
  const collected = [];
  const failures = [];

  for (const addon of addons) {
    const addonName = String(addon.name || 'Addon');
    let manifest = null;
    try {
      manifest = await fetchManifest(addonSource(addon), { signal });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'aborted') throw err;
      console.warn(`[addons] manifest unavailable for ${addonName}: ${describeError(err)}`);
    }

    if (manifest) {
      if (!providesResource(manifest, 'stream')) continue;
      if (manifest.idPrefixes.length) {
        const matchesPrefix = manifest.idPrefixes.some(
          (prefix) => cleanId.startsWith(prefix) || rawId.startsWith(prefix),
        );
        if (!matchesPrefix) continue;
      }
    }

    const base = baseAddonUrl(addonSource(addon));
    const endpoint = `${base}/stream/${resolvedType}/${streamId}.json`;
    let payload;
    try {
      payload = await getJSON({
        url: endpoint,
        signal,
        timeoutMs: STREAM_TIMEOUT_MS,
        provider: PROVIDER_LABEL,
      });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'aborted') throw err;
      failures.push({ addon: addonName, error: describeError(err) });
      continue;
    }

    const streams = parseStreamList(payload);
    const releases = [];
    for (const stream of streams) {
      const item = streamItemToRelease(manifest?.name || addonName, stream, seasonNumber, episodeNumber);
      if (item) releases.push(item);
    }
    if (streams.length && !releases.length) {
      console.warn(`[addons] ${addonName} returned streams but none matched`);
    }
    collected.push(...releases);
  }

  if (failures.length) console.warn('[addons] stream requests failed', failures);

  return sortReleases(mergeReleases(collected));
}
