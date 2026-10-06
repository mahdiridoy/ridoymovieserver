/*
 * Dramachi provider — port of src/providers/dramachi/{client,models,mod}.rs
 *
 * Browser notes:
 *  - api.nodeobjects.com sends no CORS headers, so every call travels through
 *    the user-configured proxy (needsProxy: true). Without one the caller
 *    receives a `proxy_required` ProviderError and the UI explains the fix.
 *  - The Rust client's caches (60s title details, 60s episode lists capped at
 *    16 entries) are ported as module-level singletons.
 */

import {
  defineProvider, page, catalogItem, emptyDetails, release, mirror,
  sortReleases, wrapError, ProviderError, request, getJSON,
} from '../base.js';
import { parseSizeBytes } from '../../utils/title.js';

const KEY = 'dramachi';
const LABEL = 'Dramachi';

/** DEFAULT_BASE_URL (client.rs) */
const BASE_URL = 'https://api.nodeobjects.com/';
/** IMAGE_CDN_BASE (client.rs) */
const IMAGE_CDN_BASE = 'https://static.nodeobjects.com/thumbnail/';

const CACHE_TTL_MS = 60000;
const REQUEST_TIMEOUT_MS = 15000;
const EP_CACHE_MAX = 16;
const SEARCH_PAGE_SIZE = 15;

const EPISODE_PREFIXES = ['EPISODE', 'EP.', 'EP', 'E'];
const EPISODE_TITLE_SUFFIXES = [
  ' 720p', ' 1080p', ' 540p', ' 480p', ' 360p', ' DUB', ' hi DUB', ' ENG Subbed Full',
];

let titleCache = null;
const epListCache = new Map();

/* ---------------- helpers (free functions from client.rs) ---------------- */

/** percent_encoding::NON_ALPHANUMERIC — every byte outside [A-Za-z0-9] is escaped. */
function encodeParam(value) {
  return encodeURIComponent(String(value ?? ''))
    .replace(/[!'()*\-._~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function textOrNull(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function nonEmptyOrNull(value) {
  const text = textOrNull(value);
  return text !== null && text.trim() !== '' ? text : null;
}

function isMovieContent(content) {
  if (typeof content !== 'string') return false;
  const lower = content.toLowerCase();
  return lower === 'movies' || lower === 'movie';
}

function posterFromThumb(thumb) {
  const trimmed = typeof thumb === 'string' ? thumb.trim() : '';
  return trimmed ? `${IMAGE_CDN_BASE}${trimmed}` : null;
}

function splitGenres(raw) {
  const text = textOrNull(raw);
  if (text === null) return [];
  return text.split(',').map((part) => part.trim()).filter((part) => part !== '');
}

/** extract_leading_season_number */
function leadingSeasonNumber(name) {
  const lower = String(name ?? '').toLowerCase();
  if (!lower.startsWith('season')) return null;
  const after = lower.slice('season'.length).trim();
  const digits = /^[0-9]+/.exec(after)?.[0] ?? '';
  if (!digits) return null;
  const num = Number.parseInt(digits, 10);
  return Number.isFinite(num) ? num : null;
}

function compareSeasonKeys(a, b) {
  const left = leadingSeasonNumber(a) ?? Number.MAX_SAFE_INTEGER;
  const right = leadingSeasonNumber(b) ?? Number.MAX_SAFE_INTEGER;
  return left - right;
}

/** clean_episode_title */
function cleanEpisodeTitle(fTitle) {
  let title = String(fTitle ?? '').trim();
  for (const suffix of EPISODE_TITLE_SUFFIXES) {
    if (title.endsWith(suffix)) title = title.slice(0, title.length - suffix.length);
  }
  return title;
}

/** parse_episode_number */
function parseEpisodeNumber(fTitle) {
  const cleaned = cleanEpisodeTitle(fTitle);
  const upper = cleaned.toUpperCase();

  for (const prefix of EPISODE_PREFIXES) {
    let searchFrom = 0;
    while (searchFrom <= upper.length) {
      const pos = upper.indexOf(prefix, searchFrom);
      if (pos === -1) break;

      const prevChar = pos > 0 ? upper.charAt(pos - 1) : null;
      const validBoundary = prevChar === null
        || !/[\p{L}]/u.test(prevChar)
        || (prefix === 'E' && /^[0-9]$/.test(prevChar));

      const afterTrimmed = upper.slice(pos + prefix.length).replace(/^[\s\-._]+/, '');
      const digits = /^[0-9]+/.exec(afterTrimmed)?.[0] ?? '';
      if (validBoundary && digits) {
        const num = Number.parseInt(digits, 10);
        if (Number.isFinite(num)) return num;
      }
      searchFrom = pos + prefix.length;
    }
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const lastToken = tokens[tokens.length - 1];
  if (lastToken !== undefined && /^[0-9]+$/.test(lastToken)) {
    return Number.parseInt(lastToken, 10);
  }
  return null;
}

/** id.split_once("::") */
function splitCompositeId(raw) {
  const id = String(raw ?? '');
  const sep = id.indexOf('::');
  if (sep === -1) return { titleId: id.trim(), targetRip: null };
  return { titleId: id.slice(0, sep).trim(), targetRip: id.slice(sep + 2).trim() };
}

/**
 * Pagination: Dramachi's search payload carries `next_page` / `last_page`
 * (models.rs), which Rust parses but the TUI does not read — it instead marks
 * the crawl exhausted when a page returns fewer than 15 rows
 * (src/tui/app/requests.rs :: raw_count < 15). Use the payload when present and
 * fall back to that heuristic.
 */
function hasMoreResults(data, rawCount, pageNo) {
  const next = data?.next_page;
  if (typeof next === 'number' && Number.isFinite(next)) return next > pageNo;
  const last = data?.last_page;
  if (typeof last === 'number' && Number.isFinite(last)) return pageNo < last;
  return rawCount >= SEARCH_PAGE_SIZE;
}

/* ---------------- cached client calls ---------------- */

async function fetchTitleDetails(titleId, signal) {
  if (titleCache && titleCache.id === titleId && Date.now() - titleCache.at < CACHE_TTL_MS) {
    return titleCache.data;
  }
  const data = await getJSON({
    url: `${BASE_URL}?interface=title_v2&id=${encodeParam(titleId)}`,
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    provider: LABEL,
  });
  titleCache = { id: titleId, at: Date.now(), data };
  return data;
}

async function fetchEpisodes(titleId, rip, signal) {
  const key = `${titleId}::${rip}`;
  const cached = epListCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.episodes;

  const data = await getJSON({
    url: `${BASE_URL}?interface=eplist&season=${encodeParam(rip)}&id=${encodeParam(titleId)}`,
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    provider: LABEL,
  });

  const episodes = (Array.isArray(data?.episode_list) ? data.episode_list : []).slice();
  episodes.sort((a, b) => {
    const left = parseEpisodeNumber(a?.f_title) ?? Number.MAX_SAFE_INTEGER;
    const right = parseEpisodeNumber(b?.f_title) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });

  if (epListCache.size >= EP_CACHE_MAX) epListCache.clear();
  epListCache.set(key, { at: Date.now(), episodes });
  return episodes;
}

/** getFile → { streamUrl, filename } (fetch_file_stream) */
async function fetchFileStream(fid, disk, signal) {
  const data = await getJSON({
    url: `${BASE_URL}?interface=getFile&fid=${encodeParam(fid)}&findex=${encodeParam(disk)}`,
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    provider: LABEL,
  });

  const hostInfo = data?.hostInfo ?? null;
  if (!hostInfo) {
    throw new ProviderError('parsing', 'missing hostInfo in getFile', { provider: LABEL });
  }
  const fileInfo = Array.isArray(data?.fileInfo) ? data.fileInfo[0] : null;
  if (!fileInfo) {
    throw new ProviderError('not_found', 'Item not found', { provider: LABEL });
  }
  const rawUrl = textOrNull(fileInfo.url);
  if (rawUrl === null) {
    throw new ProviderError('parsing', 'missing url in fileInfo', { provider: LABEL });
  }

  const host = textOrNull(hostInfo.host) ?? '';
  const filename = textOrNull(fileInfo.filename)
    ?? textOrNull(fileInfo.f_title)
    ?? `${fid}.mkv`;
  const streamUrl = `https://${host.replace(/\/+$/, '')}/cdn/${rawUrl.replace(/^\/+/, '')}`;
  return { streamUrl, filename };
}

/* ---------------- series assembly (details) ---------------- */

function dubPriority(language) {
  const lower = String(language ?? '').toLowerCase();
  if (lower.includes('original') || lower === 'orig') return 0;
  if (lower.includes('english') || lower.includes('eng')) return 1;
  if (lower.includes('dub')) return 2;
  return 3;
}

async function fetchSeasonEpisodes(titleId, rip, seasonNumber, signal) {
  let episodes = [];
  try {
    episodes = await fetchEpisodes(titleId, rip, signal);
  } catch {
    episodes = []; // Rust: .unwrap_or_default()
  }

  if (!episodes.length) {
    return {
      number: seasonNumber,
      episodes: [{ season: seasonNumber, number: 1, title: null, overview: null }],
    };
  }

  const seen = new Set();
  const unique = [];
  episodes.forEach((ep, index) => {
    const fTitle = String(ep?.f_title ?? '');
    const number = parseEpisodeNumber(fTitle) ?? index + 1;
    if (seen.has(number)) return;
    seen.add(number);
    unique.push({
      season: seasonNumber,
      number,
      title: cleanEpisodeTitle(fTitle),
      overview: null,
    });
  });
  unique.sort((a, b) => a.number - b.number);
  return { number: seasonNumber, episodes: unique };
}

/** getFile → Release (episode_streams inner mapping); failures are logged and skipped. */
async function resolveEpisode(ep, seasonNum, episodeNum, signal) {
  const fid = ep.fid;
  const disk = ep.disk;
  try {
    const { streamUrl, filename } = await fetchFileStream(fid, disk, signal);
    const qualityRaw = textOrNull(ep.quality);
    const quality = qualityRaw !== null && qualityRaw !== '' ? qualityRaw : null;
    const sizeBytes = parseSizeBytes(textOrNull(ep.size) ?? '');
    return release({
      provider: KEY,
      filename,
      quality,
      codec: null,
      language: null,
      size_bytes: sizeBytes,
      season: seasonNum > 0 ? seasonNum : null,
      episode: episodeNum > 0 ? episodeNum : null,
      mirrors: [mirror({ label: 'Dramachi CDN', resolver_url: streamUrl, headers: [], direct_file: true })],
      resource_id: fid,
    });
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'aborted') throw err;
    console.warn(`failed to resolve Dramachi stream for fid ${fid}`, err);
    return null;
  }
}

/* ---------------- provider surface ---------------- */

export default defineProvider({
  key: 'dramachi',
  label: 'Dramachi',
  needsProxy: true,
  capabilities: { search: true, browse: false, details: true, streams: true, subtitles: false, home: false },

  async search({ query, page: pageNo = 1, signal } = {}) {
    try {
      const trimmed = String(query ?? '').trim();
      if (!trimmed) return page([], pageNo, false);

      const pageNumber = Math.max(1, Number(pageNo) || 1);
      const data = await getJSON({
        url: `${BASE_URL}?interface=search&q=${encodeParam(trimmed)}&filter=all&page=${pageNumber}`,
        signal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        provider: LABEL,
      });

      const rawItems = Array.isArray(data?.data) ? data.data : [];
      const items = [];
      for (const item of rawItems) {
        if (!item || typeof item !== 'object') continue;
        const id = textOrNull(item.id);
        if (id === null || id === '') continue;
        items.push(catalogItem({
          provider: KEY,
          id,
          title: typeof item.title === 'string' ? item.title : '',
          media_type: isMovieContent(item.content) ? 'movie' : 'series',
          year: nonEmptyOrNull(item.year),
          poster_url: posterFromThumb(item.thumb),
          season_count: null,
        }));
      }
      return page(items, pageNo, hasMoreResults(data, rawItems.length, pageNo));
    } catch (err) {
      throw wrapError(err, KEY, LABEL);
    }
  },

  async details({ id, signal } = {}) {
    try {
      const { titleId, targetRip } = splitCompositeId(id);
      if (!titleId) throw new ProviderError('not_found', 'Item not found', { provider: LABEL });

      const data = await fetchTitleDetails(titleId, signal);
      const album = Array.isArray(data?.album) ? data.album[0] : null;
      if (!album) throw new ProviderError('not_found', 'Item not found', { provider: LABEL });

      const mediaType = isMovieContent(album.content) ? 'movie' : 'series';
      const posterUrl = posterFromThumb(album.thumb);
      const genres = splitGenres(album.genres);
      const stars = (Array.isArray(data.cast) ? data.cast : [])
        .map((member) => nonEmptyOrNull(member?.name))
        .filter(Boolean);

      const seasonsMap = data?.seasons && typeof data.seasons === 'object' && !Array.isArray(data.seasons)
        ? data.seasons
        : null;
      const sortedSeasonKeys = seasonsMap ? Object.keys(seasonsMap).sort(compareSeasonKeys) : [];

      const dubs = [];
      let seasons = [];

      if (seasonsMap) {
        const seasonCount = Object.keys(seasonsMap).length;
        for (const [seasonKey, group] of Object.entries(seasonsMap)) {
          const versions = Array.isArray(group?.versions) ? group.versions : null;
          if (!versions) continue;
          for (const version of versions) {
            const versionName = String(version?.version_name ?? '');
            const rip = String(version?.rip ?? '');
            dubs.push({
              subject_id: `${titleId}::${rip}`,
              language: versionName,
              label: seasonCount > 1 ? `${seasonKey}: ${versionName}` : versionName,
            });
          }
        }
        dubs.sort((a, b) => dubPriority(a.language) - dubPriority(b.language));

        if (mediaType === 'series') {
          const seasonRips = sortedSeasonKeys.map((seasonKey) => {
            const group = seasonsMap[seasonKey];
            const versions = Array.isArray(group?.versions) ? group.versions : null;
            let rip = null;
            if (versions && versions.length) {
              const matched = targetRip !== null
                ? versions.find((version) => String(version?.rip ?? '') === targetRip)
                : null;
              const chosen = matched || versions[0];
              rip = String(chosen?.rip ?? '');
            }
            if (rip === null) rip = seasonKey;
            return { seasonNumber: leadingSeasonNumber(seasonKey) ?? 1, rip };
          });
          seasons = await Promise.all(
            seasonRips.map(({ seasonNumber, rip }) => fetchSeasonEpisodes(titleId, rip, seasonNumber, signal)),
          );
        }
      }

      const primaryId = targetRip !== null ? `${titleId}::${targetRip}` : titleId;
      const details = emptyDetails({
        provider: KEY,
        id: primaryId,
        title: typeof album.title === 'string' ? album.title : '',
        media_type: mediaType,
        poster_url: posterUrl,
        year: nonEmptyOrNull(album.year),
      });
      details.description = nonEmptyOrNull(album.storyline);
      details.tagline = null;
      details.imdb_rating = null;
      details.director = nonEmptyOrNull(album.director);
      details.stars = stars.length ? stars.join(', ') : null;
      details.prints = null;
      details.audios = null;
      details.poster_url = posterUrl;
      details.duration = null;
      details.genres = genres;
      details.seasons = seasons;
      details.dubs = dubs;
      return details;
    } catch (err) {
      throw wrapError(err, KEY, LABEL);
    }
  },

  async streams({ id, season = 0, episode = 0, signal } = {}) {
    try {
      const { titleId, targetRip } = splitCompositeId(id);
      if (!titleId) throw new ProviderError('not_found', 'Item not found', { provider: LABEL });

      const seasonNum = Number(season) || 0;
      const episodeNum = Number(episode) || 0;

      let ripToQuery = targetRip;
      if (ripToQuery === null) {
        const data = await fetchTitleDetails(titleId, signal);
        const seasonsMap = data?.seasons && typeof data.seasons === 'object' && !Array.isArray(data.seasons)
          ? data.seasons
          : null;

        let resolved = null;
        if (seasonsMap) {
          const firstVersionRip = (group) => {
            const versions = Array.isArray(group?.versions) ? group.versions : null;
            if (!versions || !versions.length) return null;
            return String(versions[0]?.rip ?? '');
          };

          if (seasonNum > 0) {
            const targetKey = `Season ${String(seasonNum).padStart(2, '0')}`;
            const group = seasonsMap[targetKey];
            if (group) resolved = firstVersionRip(group);
          }
          if (resolved === null) {
            const firstGroup = Object.values(seasonsMap)[0];
            if (firstGroup) resolved = firstVersionRip(firstGroup);
          }
        }

        if (resolved === null) {
          resolved = seasonNum > 0 ? `Season ${String(seasonNum).padStart(2, '0')}` : 'hd Rip';
        }
        ripToQuery = resolved;
      }

      const episodes = await fetchEpisodes(titleId, ripToQuery, signal);
      if (!episodes.length) return [];

      let matched;
      if (seasonNum === 0 && episodeNum === 0) {
        matched = episodes;
      } else {
        const exact = episodes.filter(
          (ep) => parseEpisodeNumber(ep?.f_title) === episodeNum,
        );
        if (exact.length) matched = exact;
        else if (episodeNum > 0 && episodeNum <= episodes.length) matched = [episodes[episodeNum - 1]];
        else matched = [];
      }

      const candidates = matched.filter(
        (ep) => typeof ep?.fid === 'string' && ep.fid !== ''
          && typeof ep?.disk === 'string' && ep.disk !== '',
      );

      const releases = await Promise.all(
        candidates.map((ep) => resolveEpisode(ep, seasonNum, episodeNum, signal)),
      );

      return sortReleases(releases.filter(Boolean));
    } catch (err) {
      throw wrapError(err, KEY, LABEL);
    }
  },

  async status({ signal } = {}) {
    try {
      const res = await request({
        url: BASE_URL,
        method: 'GET',
        signal,
        timeoutMs: 9000,
        provider: LABEL,
        headers: { accept: 'text/html,application/json' },
      });
      return { ok: res.status >= 200 && res.status < 400, status: res.status, detail: res.via || '' };
    } catch (err) {
      const wrapped = wrapError(err, KEY, LABEL);
      if (wrapped.status > 0) {
        return { ok: wrapped.status >= 200 && wrapped.status < 400, status: wrapped.status, detail: wrapped.kind };
      }
      return { ok: false, status: 0, detail: wrapped.kind || 'network' };
    }
  },
});
