/*
 * BDIX providers — CircleFTP and DhakaFlix.
 * Port of src/providers/bdix/{common.rs, circleftp/{client,parser,mod}.rs,
 * dhakaflix/{client,mod}.rs}
 *
 * Browser notes:
 *  - Both providers only resolve inside a BDIX network (Bangladeshi ISP
 *    intranet). Outside one every request fails at the network/CORS layer and
 *    `status()` reports `detail: 'bdix_required'` instead of throwing.
 *  - Their origins are plain `http://`, which an https page blocks as mixed
 *    content before CORS is even considered. `needsProxy` stays false (they are
 *    intranet origins, not CORS-hostile public APIs) but the user-configured
 *    proxy in Settings → Proxy covers the mixed-content case.
 */

import {
  defineProvider, page, catalogItem, emptyDetails, release, mirror,
  sortReleases, wrapError, ProviderError, request, getJSON,
} from '../base.js';
import { extract4DigitYear } from '../../utils/title.js';

const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };
const REQUEST_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 3000;
const TRANSPORT_KINDS = new Set(['network', 'cors', 'timeout', 'proxy_required', 'proxy_failed']);

/* ------------- shared helpers — src/providers/bdix/common.rs ------------- */

function detectAudioLanguage(text) {
  const lower = String(text ?? '').toLowerCase();
  if (lower.includes('hindi')) return 'Hindi';
  if (lower.includes('bengali') || lower.includes('bangla')) return 'Bengali';
  if (lower.includes('tamil')) return 'Tamil';
  if (lower.includes('telugu')) return 'Telugu';
  if (lower.includes('dual')) return 'Dual Audio';
  if (lower.includes('multi')) return 'Multi Audio';
  if (lower.includes('english')) return 'English';
  return null;
}

function detectResolution(text) {
  const lower = String(text ?? '').toLowerCase();
  if (lower.includes('2160p') || lower.includes('4k')) return '4K';
  if (lower.includes('1080p')) return '1080p';
  if (lower.includes('720p')) return '720p';
  if (lower.includes('480p')) return '480p';
  return null;
}

function detectCodec(text) {
  const lower = String(text ?? '').toLowerCase();
  if (lower.includes('x265') || lower.includes('hevc')) return 'HEVC';
  if (lower.includes('x264') || lower.includes('h264')) return 'x264';
  if (lower.includes('av1')) return 'AV1';
  return null;
}

/* ------------------------------ shared plumbing ------------------------------ */

function isTransportError(err) {
  if (!(err instanceof ProviderError)) return true;
  return TRANSPORT_KINDS.has(err.kind);
}

/** POST JSON and parse the reply; an unparseable body yields null (Rust: `if let Ok(json)`). */
async function postJsonLoose(url, payload, { signal, provider, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const res = await request({
    url,
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
    signal,
    timeoutMs,
    provider,
  });
  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
}

/**
 * Reachability probe — port of crate::net::probe_url (HEAD, success/redirect
 * counts as up). A transport-level failure means "not on BDIX".
 */
async function probeOrigin(url, key, label, signal) {
  try {
    const res = await request({ url, method: 'HEAD', signal, timeoutMs: PROBE_TIMEOUT_MS, provider: label, headers: {} });
    return { ok: res.status >= 200 && res.status < 400, status: res.status, detail: res.via || '' };
  } catch (err) {
    const wrapped = wrapError(err, key, label);
    if (wrapped.status > 0) {
      return { ok: wrapped.status >= 200 && wrapped.status < 400, status: wrapped.status, detail: wrapped.kind };
    }
    return { ok: false, status: 0, detail: 'bdix_required' };
  }
}

/* =========================================================================== */
/* CircleFTP — src/providers/bdix/circleftp                                    */
/* =========================================================================== */

const CFT_KEY = 'bdix_circleftp';
const CFT_LABEL = 'CircleFTP (BDIX)';

/** client.rs constants (identical strings, kept for parity). */
const BASE_URL = 'http://new.circleftp.net:5000';
const API_URL = `${BASE_URL}/api`;
const POSTS_URL = `${API_URL}/posts`;
const UPLOADS_URL = `${BASE_URL}/uploads/`;

const AUDIO_TAGS = [
  ['hindi', 'Hindi'],
  ['bengali', 'Bengali'],
  ['bangla', 'Bengali'],
  ['english', 'English'],
  ['tamil', 'Tamil'],
  ['telugu', 'Telugu'],
  ['malayalam', 'Malayalam'],
  ['korean', 'Korean'],
  ['dual audio', 'Dual Audio'],
  ['multi audio', 'Multi Audio'],
];

const PRINT_TAGS = [
  ['cam', 'CAM'],
  ['hdcam', 'CAM'],
  ['hdtc', 'HDTC'],
  ['tc', 'HDTC'],
  ['hdrip', 'HDRip'],
  ['hd rip', 'HDRip'],
  ['webrip', 'WEBRip'],
  ['web-rip', 'WEBRip'],
  ['webdl', 'WEB-DL'],
  ['web-dl', 'WEB-DL'],
  ['bluray', 'BluRay'],
  ['brrip', 'BluRay'],
];

let postCache = null;

/** `value` is a raw serde_json::Value: present-but-null blocks the fallback. */
function rawString(value, fallbackValue) {
  const source = value !== undefined ? value : fallbackValue;
  return typeof source === 'string' ? source : null;
}

/** serde_json number → String, &str → String, anything else → None. */
function yearValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value;
  return null;
}

/** str::split('/').next_back() + %20/%28/%29/%5B/%5D decoding (filename only). */
function decodeFileSegment(link) {
  const segments = String(link).split('/');
  const last = segments[segments.length - 1] ?? 'Video File';
  return last
    .replace(/%20/g, ' ')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%5B/g, '[')
    .replace(/%5D/g, ']');
}

/** CircleFtpSearchResponse → Vec<CatalogItem> (parser.rs :: circleftp_search_to_catalog). */
function circleftpSearchToCatalog(response) {
  const items = [];
  const posts = Array.isArray(response?.posts) ? response.posts : [];
  for (const post of posts) {
    if (!post || typeof post !== 'object') continue;
    if (typeof post.id !== 'number' && typeof post.id !== 'string') continue;

    // Option<String> fields: null and missing both mean "absent" → fall through.
    const title = (typeof post.title === 'string' ? post.title : null)
      ?? (typeof post.name === 'string' ? post.name : null)
      ?? 'Unknown';
    const mediaType = typeof post.type === 'string' && post.type === 'series' ? 'series' : 'movie';
    const image = typeof post.image === 'string'
      ? post.image
      : (typeof post.imageSm === 'string' ? post.imageSm : null);

    items.push(catalogItem({
      provider: CFT_KEY,
      id: String(post.id),
      title,
      media_type: mediaType,
      year: yearValue(post.year),
      poster_url: image !== null ? `${UPLOADS_URL}${image}` : null,
      season_count: null,
    }));
  }
  return items;
}

/** fetch_post — GET {API_URL}/posts/{id} with a 60s cache. */
async function fetchCftPost(id, signal) {
  if (postCache && postCache.id === id && Date.now() - postCache.at < 60000) {
    return postCache.data;
  }
  const data = await getJSON({
    url: `${API_URL}/posts/${id}`,
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
    provider: CFT_LABEL,
  });
  postCache = { id, at: Date.now(), data };
  return data;
}

/** HEAD {link} → content-length, 1200ms budget (fetch_size). */
async function fetchSize(link, signal) {
  try {
    const res = await request({ url: link, method: 'HEAD', signal, timeoutMs: 1200, provider: CFT_LABEL, headers: {} });
    const length = Number(res.headers?.['content-length']);
    return Number.isFinite(length) && length >= 0 ? length : null;
  } catch {
    return null;
  }
}

export const circleftp = defineProvider({
  key: 'bdix_circleftp',
  label: 'CircleFTP (BDIX)',
  needsProxy: false,
  bdix: true,
  capabilities: { search: true, browse: false, details: true, streams: true, subtitles: false, home: false },

  /** Rust: GET {API_URL}/posts?searchTerm={query}&order=desc (no pagination). */
  async search({ query, page: pageNo = 1, signal } = {}) {
    try {
      const url = new URL(POSTS_URL);
      url.searchParams.set('searchTerm', String(query ?? ''));
      url.searchParams.set('order', 'desc');
      const data = await getJSON({ url: url.href, signal, timeoutMs: REQUEST_TIMEOUT_MS, provider: CFT_LABEL });
      return page(circleftpSearchToCatalog(data), pageNo, false);
    } catch (err) {
      throw wrapError(err, CFT_KEY, CFT_LABEL);
    }
  },

  async details({ id, signal } = {}) {
    try {
      const idStr = String(id ?? '');
      const json = await fetchCftPost(idStr, signal);

      // Raw serde_json::Value reads: a present `null` does NOT fall back.
      const title = rawString(json.title, json.name) ?? 'Unknown';
      const type = typeof json.type === 'string' ? json.type : '';
      const mediaType = type === 'series' ? 'series' : 'movie';
      const posterImage = rawString(json.image, json.imageSm);
      const posterUrl = posterImage !== null ? `${UPLOADS_URL}${posterImage}` : null;

      const seasons = [];
      if (mediaType === 'series') {
        const content = Array.isArray(json.content) ? json.content : [];
        content.forEach((seasonVal, seasonIdx) => {
          const episodes = [];
          const episodeList = Array.isArray(seasonVal?.episodes) ? seasonVal.episodes : [];
          episodeList.forEach((episodeVal, episodeIdx) => {
            episodes.push({
              season: seasonIdx + 1,
              number: episodeIdx + 1,
              title: typeof episodeVal?.title === 'string' ? episodeVal.title : null,
              overview: null,
            });
          });
          seasons.push({ number: seasonIdx + 1, episodes });
        });
      }

      const genres = [];
      if (Array.isArray(json.categories)) {
        for (const category of json.categories) {
          const name = typeof category?.name === 'string' ? category.name : null;
          if (name !== null) genres.push(name);
        }
      }

      const titleFull = typeof json.title === 'string' ? json.title : '';
      const lowerTitle = titleFull.toLowerCase();
      const audios = AUDIO_TAGS.find(([tag]) => lowerTitle.includes(tag))?.[1] ?? null;
      const prints = PRINT_TAGS.find(([tag]) => lowerTitle.includes(tag))?.[1] ?? null;

      const details = emptyDetails({
        provider: CFT_KEY,
        id: idStr,
        title,
        media_type: mediaType,
        poster_url: posterUrl,
        year: yearValue(json.year),
      });
      details.description = typeof json.metaData === 'string' ? json.metaData : null;
      details.duration = typeof json.watchTime === 'string' ? json.watchTime : null;
      details.prints = prints;
      details.audios = audios;
      details.genres = genres;
      details.seasons = seasons;
      details.dubs = [];
      return details;
    } catch (err) {
      throw wrapError(err, CFT_KEY, CFT_LABEL);
    }
  },

  /** Rust: release_provider passes Some(season)/Some(episode) unconditionally. */
  async streams({ id, season = 0, episode = 0, signal } = {}) {
    try {
      const idStr = String(id ?? '');
      const json = await fetchCftPost(idStr, signal);
      const releases = [];

      const type = typeof json.type === 'string' ? json.type : '';
      const qualityStr = typeof json.quality === 'string' ? json.quality : 'HD';
      const quality = detectResolution(qualityStr) ?? qualityStr;
      const titleStr = typeof json.title === 'string' ? json.title : '';
      const codec = detectCodec(titleStr);
      const language = detectAudioLanguage(titleStr);

      const seasonNum = Number(season) || 0;
      const episodeNum = Number(episode) || 0;

      if (type === 'series') {
        const content = Array.isArray(json.content) ? json.content : [];
        const seasonIdx = Math.max(seasonNum - 1, 0);
        const episodeIdx = Math.max(episodeNum - 1, 0);
        const episodeList = Array.isArray(content[seasonIdx]?.episodes) ? content[seasonIdx].episodes : [];
        const episodeVal = episodeList[episodeIdx];
        const link = typeof episodeVal?.link === 'string' ? episodeVal.link : null;

        if (link !== null) {
          releases.push(release({
            provider: CFT_KEY,
            filename: decodeFileSegment(link),
            quality,
            codec,
            language,
            size_bytes: await fetchSize(link, signal),
            season: seasonNum,
            episode: episodeNum,
            mirrors: [mirror({ label: 'CircleFTP', resolver_url: link, headers: [], direct_file: true })],
            resource_id: null,
          }));
        }
      } else if (typeof json.content === 'string') {
        const link = json.content;
        releases.push(release({
          provider: CFT_KEY,
          filename: decodeFileSegment(link),
          quality,
          codec,
          language,
          size_bytes: await fetchSize(link, signal),
          season: null,
          episode: null,
          mirrors: [mirror({ label: 'CircleFTP', resolver_url: link, headers: [], direct_file: true })],
          resource_id: null,
        }));
      }

      return sortReleases(releases);
    } catch (err) {
      throw wrapError(err, CFT_KEY, CFT_LABEL);
    }
  },

  /** Rust BDIX probe: HEAD {POSTS_URL} (3s). Network/CORS failure ⇒ bdix_required. */
  async status({ signal } = {}) {
    return probeOrigin(POSTS_URL, CFT_KEY, CFT_LABEL, signal);
  },
});

/* =========================================================================== */
/* DhakaFlix — src/providers/bdix/dhakaflix                                    */
/* =========================================================================== */

const DF_KEY = 'bdix_dhakaflix';
const DF_LABEL = 'DhakaFlix (BDIX)';

/** client.rs :: SERVERS */
const SERVERS = [
  ['http://172.16.50.7', '/DHAKA-FLIX-7/'],
  ['http://172.16.50.14', '/DHAKA-FLIX-14/'],
  ['http://172.16.50.12', '/DHAKA-FLIX-12/'],
  ['http://172.16.50.9', '/DHAKA-FLIX-9/'],
];

const DEAD_TTL_MS = 60000;
const POSTER_CONCURRENCY = 6;
const POSTER_LIMIT = 20;

const recentFails = new Map();

function healthyServers() {
  const now = Date.now();
  return SERVERS.filter(([base]) => {
    const failedAt = recentFails.get(base);
    return failedAt === undefined || now - failedAt >= DEAD_TTL_MS;
  });
}

/** parse_dhakaflix_id — rfind(":/") splits base from path (ports stay intact). */
function parseDhakaflixId(id) {
  const raw = String(id ?? '');
  const pos = raw.lastIndexOf(':/');
  if (pos === -1) return null;
  return { base: raw.slice(0, pos), path: raw.slice(pos + 1) };
}

function safePercentDecode(value) {
  const raw = String(value ?? '');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** str::trim_start_matches(href) */
function trimStartMatches(source, prefix) {
  let out = source;
  while (prefix && out.startsWith(prefix)) out = out.slice(prefix.length);
  return out;
}

function splitPathParts(path) {
  return String(path ?? '').split('/').filter((part) => part !== '');
}

/** client.rs :: quality_score */
function qualityScore(name) {
  const lower = String(name ?? '').toLowerCase();
  if (lower.includes('2160p') || lower.includes('4k')) return 3;
  if (lower.includes('1080p')) return 2;
  if (lower.includes('720p')) return 1;
  return 0;
}

/** client.rs :: parse_title_and_year → [title, year|null] */
function parseTitleAndYear(rawTitle) {
  let title = String(rawTitle ?? '');
  let year = null;

  const start = title.lastIndexOf('(');
  if (start !== -1) {
    const relEnd = title.indexOf(')', start);
    if (relEnd !== -1) {
      const yearSlice = title.slice(start + 1, relEnd);
      const titleSlice = title.slice(0, start);
      const extracted = extract4DigitYear(yearSlice);
      if (extracted.length === 4 && yearSlice.trim().length === 4) {
        return [titleSlice.trim(), extracted];
      }
    }
  }

  const lower = title.toLowerCase();
  const qualities = [' 1080p', ' 720p', ' 480p', ' 2160p', ' 4k', ' hd', ' hdrip', ' webrip', ' hdcam'];
  for (const quality of qualities) {
    if (lower.endsWith(quality)) {
      const trimLen = title.length - quality.length;
      if (trimLen >= 0) title = title.slice(0, trimLen).trim();
      break;
    }
  }

  return [title, year];
}

/** client.rs :: dedup_best_quality */
function dedupBestQuality(entries) {
  const best = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([entry.item.title.toLowerCase(), entry.item.year]);
    const existing = best.get(key);
    if (existing && existing.quality >= entry.quality) continue;
    best.set(key, entry);
  }
  const out = [...best.values()];
  out.sort((a, b) => {
    const left = a.item.title.toLowerCase();
    const right = b.item.title.toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  return out;
}

function itemFromFolder({ base, href, folderPath, name }) {
  const decoded = safePercentDecode(name);
  const quality = qualityScore(decoded);
  const [cleanTitle, year] = parseTitleAndYear(decoded);
  const item = catalogItem({
    provider: DF_KEY,
    id: `${base}:${href}${trimStartMatches(folderPath, href)}`,
    title: cleanTitle,
    media_type: 'movie',
    year,
    poster_url: null,
    season_count: null,
  });
  return { item, quality };
}

/** Best-effort poster lookup (search only; failures are ignored). */
async function fetchPoster(entry, signal) {
  const parsed = parseDhakaflixId(entry.item.id);
  if (!parsed) return null;
  const parts = splitPathParts(parsed.path);
  if (!parts.length) return null;

  const apiHref = `/${parts[0]}/`;
  try {
    const json = await postJsonLoose(
      `${parsed.base}${apiHref}`,
      { action: 'get', items: { href: parsed.path, what: 1 } },
      { signal, provider: DF_LABEL },
    );
    const items = Array.isArray(json?.items) ? json.items : [];
    for (const file of items) {
      const href = typeof file?.href === 'string' ? file.href : null;
      if (href === null) continue;
      const lower = href.toLowerCase();
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png')) {
        return `${parsed.base}${href}`;
      }
    }
  } catch {
    /* best effort — Rust ignores poster failures */
  }
  return null;
}

async function fetchPosters(entries, signal) {
  const targets = entries.slice(0, POSTER_LIMIT);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(POSTER_CONCURRENCY, targets.length) }, async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const poster = await fetchPoster(targets[index], signal);
      if (poster) targets[index].item.poster_url = poster;
    }
  });
  await Promise.all(workers);
}

export const dhakaflix = defineProvider({
  key: 'bdix_dhakaflix',
  label: 'DhakaFlix (BDIX)',
  needsProxy: false,
  bdix: true,
  capabilities: { search: true, browse: false, details: true, streams: true, subtitles: false, home: false },

  /**
   * POST {base}{href} { action:'get', search:{href, pattern, ignorecase:true} }
   * against every healthy server, then dedup and (best-effort) fetch posters
   * for the first 20 hits.
   */
  async search({ query, page: pageNo = 1, signal } = {}) {
    try {
      const pattern = String(query ?? '');
      const perServer = await Promise.all(healthyServers().map(async ([base, href]) => {
        const results = [];
        try {
          const json = await postJsonLoose(
            `${base}${href}`,
            { action: 'get', search: { href, pattern, ignorecase: true } },
            { signal, provider: DF_LABEL },
          );
          const searchArr = Array.isArray(json?.search) ? json.search : [];
          for (const item of searchArr) {
            const itemHref = typeof item?.href === 'string' ? item.href : null;
            if (itemHref === null) continue;

            const isDir = itemHref.endsWith('/');
            const parts = splitPathParts(itemHref);
            if (!isDir && parts.length > 1) parts.pop();
            const folderPath = `/${parts.join('/')}/`;
            const name = parts[parts.length - 1];
            if (name === undefined) continue;

            results.push(itemFromFolder({ base, href, folderPath, name }));
          }
        } catch (err) {
          // Rust only records a transport failure; bad bodies just yield nothing.
          if (isTransportError(err)) {
            recentFails.set(base, Date.now());
            console.warn('dhakaflix search request failed', base);
          }
        }
        return results;
      }));

      const deduped = dedupBestQuality(perServer.flat());
      await fetchPosters(deduped, signal);
      return page(deduped.map((entry) => entry.item), pageNo, false);
    } catch (err) {
      throw wrapError(err, DF_KEY, DF_LABEL);
    }
  },

  /** Metadata comes from the id alone — no network call in the Rust client. */
  async details({ id, signal } = {}) {
    try {
      const idStr = String(id ?? '');
      let title = 'Unknown';
      const parsed = parseDhakaflixId(idStr);
      if (parsed) {
        const parts = splitPathParts(parsed.path);
        const name = parts[parts.length - 1];
        if (name !== undefined) title = safePercentDecode(name);
      }
      const [cleanTitle, year] = parseTitleAndYear(title);
      return emptyDetails({
        provider: DF_KEY,
        id: idStr,
        title: cleanTitle,
        media_type: 'movie',
        poster_url: null,
        year,
      });
    } catch (err) {
      throw wrapError(err, DF_KEY, DF_LABEL);
    }
  },

  /** POST {base}{href} { action:'get', items:{href: path, what: 1} } → video files. */
  async streams({ id, season = 0, episode = 0, signal } = {}) {
    void season; void episode; // Rust: ReleaseProvider::episode_streams ignores both
    try {
      const releases = [];
      const parsed = parseDhakaflixId(id);
      if (!parsed) return releases;
      const parts = splitPathParts(parsed.path);
      if (!parts.length) return releases;

      let apiHref = '/';
      for (const [serverBase, serverHref] of SERVERS) {
        if (parsed.base === serverBase) {
          apiHref = serverHref;
          break;
        }
      }

      const json = await postJsonLoose(
        `${parsed.base}${apiHref}`,
        { action: 'get', items: { href: parsed.path, what: 1 } },
        { signal, provider: DF_LABEL },
      );

      const items = Array.isArray(json?.items) ? json.items : [];
      for (const item of items) {
        const itemHref = typeof item?.href === 'string' ? item.href : null;
        const size = typeof item?.size === 'number' && Number.isInteger(item.size) && item.size >= 0
          ? item.size
          : null;
        if (itemHref === null || size === null) continue;

        const segments = itemHref.split('/');
        const filename = safePercentDecode(segments[segments.length - 1] ?? 'Unknown');
        const lower = filename.toLowerCase();
        if (!lower.endsWith('.mkv') && !lower.endsWith('.mp4')
          && !lower.endsWith('.avi') && !lower.endsWith('.webm')) continue;

        releases.push(release({
          provider: DF_KEY,
          filename,
          quality: detectResolution(lower) ?? 'HD',
          codec: detectCodec(lower),
          language: detectAudioLanguage(lower),
          size_bytes: size,
          season: null,
          episode: null,
          mirrors: [mirror({ label: 'DhakaFlix', resolver_url: `${parsed.base}${itemHref}`, headers: [], direct_file: true })],
          resource_id: null,
        }));
      }

      return sortReleases(releases);
    } catch (err) {
      throw wrapError(err, DF_KEY, DF_LABEL);
    }
  },

  /** Rust BDIX probe: HEAD every SERVERS origin until one answers (3s each). */
  async status({ signal } = {}) {
    const results = await Promise.all(
      SERVERS.map(([base]) => probeOrigin(base, DF_KEY, DF_LABEL, signal)),
    );
    const up = results.find((result) => result.ok);
    if (up) return up;
    const reached = results.find((result) => result.status > 0);
    if (reached) return reached;
    return { ok: false, status: 0, detail: 'bdix_required' };
  },
});
