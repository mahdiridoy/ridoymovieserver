/*
 * 4KHDHub HTML → model adapters — port of src/providers/fourkhdhub/parser.rs
 *
 * Pages are read through DOMParser; only text nodes and attribute values are
 * consumed, so provider markup can never re-enter the running document.
 */

import { ProviderError, catalogItem, emptyDetails, release, mirror } from '../base.js';
import { extract4DigitYear, parseSizeBytes } from '../../utils/title.js';

const PROVIDER_LABEL = '4KHDHub';

const SEL_CARD = 'a.movie-card';
const SEL_CARD_TITLE = '.movie-card-title';
const SEL_CARD_META = '.movie-card-meta';
const SEL_H1 = 'h1';
const SEL_CONTENT_DESC = '.content-section p.mt-4';
const SEL_TAGLINE = '.movie-tagline';
const SEL_IMDB = '.imdb-score';
const SEL_BADGE_A = '.badge-outline a';
const SEL_METADATA_ITEM = '.metadata-item';
const SEL_METADATA_LABEL = '.metadata-label';
const SEL_METADATA_VALUE = '.metadata-value';
const SEL_EPISODE_ITEM = '#episodes .episode-download-item';
const SEL_DOWNLOAD_ITEM = '.download-item';
const SEL_EPISODE_FILE_TITLE = '.episode-file-title';
const SEL_FILE_TITLE = '.file-title';
const SEL_LINK_HREF = 'a[href]';
const SEL_BADGE_SIZE = '.badge-size, .badge';
const SEL_OG_IMAGE = 'meta[property="og:image"]';
const SEL_OG_TITLE = 'meta[property="og:title"]';
const SEL_META_DESC = 'meta[name="description"]';

const GENRES = new Set([
  'action', 'adventure', 'animation', 'comedy', 'crime', 'documentary', 'drama',
  'family', 'fantasy', 'history', 'horror', 'music', 'mystery', 'romance',
  'science fiction', 'sci-fi', 'thriller', 'war', 'western',
]);

const LANG_PATTERNS = [
  [['hindi', 'hin'], 'Hindi'],
  [['english', 'eng'], 'English'],
  [['tamil', 'tam'], 'Tamil'],
  [['telugu', 'tel'], 'Telugu'],
  [['kannada', 'kan'], 'Kannada'],
  [['malayalam', 'mal'], 'Malayalam'],
  [['bengali', 'ben', 'bangla'], 'Bengali'],
  [['marathi', 'mar'], 'Marathi'],
  [['punjabi', 'pan', 'pun'], 'Punjabi'],
  [['gujarati', 'guj'], 'Gujarati'],
  [['urdu', 'urd'], 'Urdu'],
  [['japanese', 'jap', 'jpn'], 'Japanese'],
  [['korean', 'kor'], 'Korean'],
  [['chinese', 'chi', 'mandarin', 'cantonese'], 'Chinese'],
  [['spanish', 'spa', 'esp', 'castilian'], 'Spanish'],
  [['french', 'fre', 'fra'], 'French'],
  [['german', 'ger', 'deu'], 'German'],
  [['italian', 'ita'], 'Italian'],
  [['portuguese', 'por'], 'Portuguese'],
  [['russian', 'rus'], 'Russian'],
  [['arabic', 'ara'], 'Arabic'],
  [['turkish', 'tur'], 'Turkish'],
  [['thai'], 'Thai'],
  [['indonesian', 'ind'], 'Indonesian'],
  [['vietnamese', 'vie'], 'Vietnamese'],
  [['polish', 'pol'], 'Polish'],
  [['dutch', 'dut', 'nld'], 'Dutch'],
  [['swedish', 'swe'], 'Swedish'],
  [['danish', 'dan'], 'Danish'],
  [['norwegian', 'nor'], 'Norwegian'],
  [['finnish', 'fin'], 'Finnish'],
];

export function parseHtml(html) {
  return new DOMParser().parseFromString(String(html ?? ''), 'text/html');
}

function collectText(node, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out.push(child.data);
    else if (child.nodeType === 1) collectText(child, out);
  }
}

/** text_of(): join descendant text nodes with " ", then collapse whitespace. */
function textOf(node) {
  if (!node) return null;
  const parts = [];
  collectText(node, parts);
  const text = parts.join(' ').split(/\s+/).filter(Boolean).join(' ');
  return text === '' ? null : text;
}

function firstText(root, selector) {
  for (const node of root.querySelectorAll(selector)) {
    const text = textOf(node);
    if (text !== null) return text;
  }
  return null;
}

function metaContent(root, selector) {
  const node = root.querySelector(selector);
  return node ? node.getAttribute('content') : null;
}

function findMetadata(root, label) {
  for (const item of root.querySelectorAll(SEL_METADATA_ITEM)) {
    const current = textOf(item.querySelector(SEL_METADATA_LABEL));
    if (current === null || current !== label) continue;
    const value = textOf(item.querySelector(SEL_METADATA_VALUE));
    if (value !== null) return value;
  }
  return null;
}

function firstFourDigitYear(value) {
  const year = extract4DigitYear(value);
  return year === '' ? null : year;
}

function isGenre(value) {
  return GENRES.has(value.toLowerCase());
}

/** to_ascii_uppercase — only ASCII case may change, so index math stays stable. */
function asciiUpper(value) {
  return String(value).replace(/[a-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 32));
}

/** strip_trailing_year */
function stripTrailingYear(value) {
  const trimmed = String(value).trim();
  const start = trimmed.length - 6;
  if (start < 0) return trimmed;
  const isParenthesizedYear = trimmed[start] === '('
    && trimmed.endsWith(')')
    && /^[0-9]+$/.test(trimmed.slice(start + 1, -1));
  return isParenthesizedYear ? trimmed.slice(0, start).trimEnd() : trimmed;
}

/** parse_season_count — trailing "S<n>" markers only (leading 'S' required). */
function parseSeasonCount(value) {
  const text = String(value);
  const marker = text.indexOf('S');
  if (marker === -1) return null;
  let max = null;
  for (const part of text.slice(marker).split(/[- •]/)) {
    if (!part.startsWith('S')) continue;
    const digits = part.slice(1);
    if (!/^[0-9]+$/.test(digits)) continue;
    const count = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(count)) continue;
    if (max === null || count > max) max = count;
  }
  return max;
}

/** parse_season_episode — first ASCII "S<digits>E<digits>" pair in the name. */
function parseSeasonEpisode(value) {
  const upper = asciiUpper(value);
  const len = upper.length;
  const limit = Math.max(0, len - 4);
  const isDigit = (ch) => ch >= '0' && ch <= '9';

  for (let index = 0; index < limit; index += 1) {
    if (upper[index] !== 'S') continue;

    let seasonEnd = -1;
    for (let i = index + 1; i < len; i += 1) {
      if (!isDigit(upper[i])) { seasonEnd = i; break; }
    }
    if (seasonEnd === -1) continue;
    if (seasonEnd === index + 1 || upper[seasonEnd] !== 'E') continue;

    let episodeEnd = len;
    for (let i = seasonEnd + 1; i < len; i += 1) {
      if (!isDigit(upper[i])) { episodeEnd = i; break; }
    }
    if (episodeEnd === seasonEnd + 1) continue;

    const season = Number.parseInt(upper.slice(index + 1, seasonEnd), 10);
    const episode = Number.parseInt(upper.slice(seasonEnd + 1, episodeEnd), 10);
    if (Number.isSafeInteger(season) && Number.isSafeInteger(episode)) return [season, episode];
  }
  return null;
}

/** detect_quality */
function detectQuality(value) {
  const lower = value.toLowerCase();
  if (lower.includes('2160p') || lower.includes('2160') || lower.includes('4k') || lower.includes('uhd')) return '2160p';
  if (lower.includes('1080p') || lower.includes('1080') || lower.includes('fhd')) return '1080p';
  if (lower.includes('720p') || lower.includes('720') || lower.includes('hd')) return '720p';
  if (lower.includes('480p') || lower.includes('480') || lower.includes('sd')) return '480p';
  return null;
}

/** detect_codec */
function detectCodec(value) {
  const lower = value.toLowerCase();
  if (lower.includes('av1')) return 'AV1';
  if (lower.includes('h.265') || lower.includes('h265') || lower.includes('x265')) return 'H.265';
  if (lower.includes('hevc')) return 'HEVC';
  if (lower.includes('h.264') || lower.includes('h264') || lower.includes('x264')) return 'H.264';
  if (lower.includes('remux')) return 'REMUX';
  return null;
}

/** detect_language — earliest word-boundary match wins, names deduped. */
function detectLanguage(value) {
  const lower = value.toLowerCase();
  const found = [];

  for (const [patterns, name] of LANG_PATTERNS) {
    for (const pattern of patterns) {
      let searchIdx = 0;
      let pos = lower.indexOf(pattern, searchIdx);
      while (pos !== -1) {
        const endPos = pos + pattern.length;
        const prevOk = pos === 0 || !/\p{L}/u.test(lower.charAt(pos - 1));
        const nextOk = endPos >= lower.length || !/\p{L}/u.test(lower.charAt(endPos));
        if (prevOk && nextOk) {
          if (!found.some((entry) => entry.name === name)) found.push({ pos, name });
          break;
        }
        searchIdx = pos + 1;
        pos = lower.indexOf(pattern, searchIdx);
      }
    }
  }

  if (found.length) {
    found.sort((a, b) => a.pos - b.pos);
    return found.map((entry) => entry.name).join(', ');
  }
  if (lower.includes('multi audio') || lower.includes('multi-audio')) return 'Multi Audio';
  if (lower.includes('dual audio') || lower.includes('dual-audio')) return 'Dual Audio';
  return null;
}

/** normalize_language_label */
function normalizeLanguageLabel(value) {
  const detected = detectLanguage(value);
  if (detected !== null) return detected;
  const joined = String(value)
    .split(/[|/+,]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(', ');
  const lower = joined.toLowerCase();
  if (joined === '' || new TextEncoder().encode(joined).length > 80
    || lower === 'n/a' || lower === 'na' || lower === 'unknown') {
    return null;
  }
  return joined;
}

function isArchive(value) {
  const lower = value.toLowerCase();
  return lower.endsWith('.zip') || lower.includes('complete season') || lower.includes('season pack');
}

function normalizeFilename(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/* ---------------- search ---------------- */

export function parseSearch(base, html) {
  const doc = parseHtml(html);
  const baseHost = new URL(base).hostname;
  const items = [];

  for (const node of doc.querySelectorAll(SEL_CARD)) {
    const href = node.getAttribute('href');
    if (!href) continue;

    let url;
    try { url = new URL(href, base); } catch { continue; }
    if (url.hostname !== baseHost) continue;

    const title = textOf(node.querySelector(SEL_CARD_TITLE));
    if (title === null) continue;

    const metaText = textOf(node.querySelector(SEL_CARD_META)) ?? '';
    const poster = node.querySelector('img')?.getAttribute('src') || null;

    items.push(catalogItem({
      provider: 'fourkhdhub',
      id: url.pathname,
      title,
      media_type: href.includes('-series-') ? 'series' : 'movie',
      year: firstFourDigitYear(metaText),
      poster_url: poster,
      season_count: parseSeasonCount(metaText),
    }));
  }
  return items;
}

/* ---------------- details ---------------- */

function parseSeasons(doc) {
  const seasons = new Map();

  for (const node of doc.querySelectorAll(SEL_EPISODE_ITEM)) {
    const filename = textOf(node.querySelector(SEL_EPISODE_FILE_TITLE)) ?? '';
    const parsed = parseSeasonEpisode(filename);
    if (!parsed) continue;
    const [season, episode] = parsed;
    if (!seasons.has(season)) seasons.set(season, new Map());
    const episodes = seasons.get(season);
    if (!episodes.has(episode)) {
      episodes.set(episode, { season, number: episode, title: null, overview: null });
    }
  }

  // BTreeMap iteration order — seasons and episodes ascending.
  return [...seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([number, episodes]) => ({
      number,
      episodes: [...episodes.entries()].sort((a, b) => a[0] - b[0]).map(([, episode]) => episode),
    }));
}

export function parseDetails(id, html) {
  const doc = parseHtml(html);

  const fromH1 = firstText(doc, SEL_H1);
  const rawTitle = fromH1 ?? metaContent(doc, SEL_OG_TITLE);
  if (rawTitle === null || rawTitle === undefined) {
    throw new ProviderError('parsing', 'title missing', { provider: PROVIDER_LABEL });
  }

  const mediaType = String(id).includes('-series-') ? 'series' : 'movie';
  const description = firstText(doc, SEL_CONTENT_DESC) ?? metaContent(doc, SEL_META_DESC);
  const tagline = firstText(doc, SEL_TAGLINE);
  const imdbRating = firstText(doc, SEL_IMDB);
  const posterUrl = metaContent(doc, SEL_OG_IMAGE);

  let year = null;
  const releaseValue = findMetadata(doc, 'Release:');
  if (releaseValue !== null) year = firstFourDigitYear(releaseValue);
  if (year === null) {
    const lastAir = findMetadata(doc, 'Last Air:');
    if (lastAir !== null) year = firstFourDigitYear(lastAir);
  }
  if (year === null) year = firstFourDigitYear(rawTitle);

  const genres = [];
  for (const node of doc.querySelectorAll(SEL_BADGE_A)) {
    const text = textOf(node);
    if (text !== null && isGenre(text)) genres.push(text);
  }

  const details = emptyDetails({
    provider: 'fourkhdhub',
    id,
    title: stripTrailingYear(rawTitle),
    media_type: mediaType,
    poster_url: posterUrl || null,
    year,
  });
  details.description = description || null;
  details.tagline = tagline || null;
  details.imdb_rating = imdbRating || null;
  details.director = findMetadata(doc, 'Director:');
  details.stars = findMetadata(doc, 'Stars:');
  details.prints = findMetadata(doc, 'Prints:') ?? findMetadata(doc, 'Print:');
  details.audios = findMetadata(doc, 'Audios:');
  details.genres = genres;
  details.seasons = parseSeasons(doc);
  return details;
}

/* ---------------- releases ---------------- */

export function parseReleases(html, season, episode) {
  const doc = parseHtml(html);
  const itemSelector = season > 0 ? SEL_EPISODE_ITEM : SEL_DOWNLOAD_ITEM;
  const filenameSelector = season > 0 ? SEL_EPISODE_FILE_TITLE : SEL_FILE_TITLE;
  const pageLanguage = (() => {
    const value = findMetadata(doc, 'Audios:');
    return value === null ? null : normalizeLanguageLabel(value);
  })();

  const grouped = new Map();

  for (const item of doc.querySelectorAll(itemSelector)) {
    const filename = textOf(item.querySelector(filenameSelector)) ?? '';
    if (filename === '' || isArchive(filename)) continue;

    const parsedEpisode = parseSeasonEpisode(filename);
    if (season > 0 && (parsedEpisode === null || parsedEpisode[0] !== season || parsedEpisode[1] !== episode)) {
      continue;
    }

    const mirrors = [];
    for (const link of item.querySelectorAll(SEL_LINK_HREF)) {
      const href = link.getAttribute('href');
      if (!href || !href.startsWith('https://') || href.includes('logout')) continue;
      const label = textOf(link) ?? 'Source';
      mirrors.push(mirror({
        label,
        resolver_url: href,
        direct_file: !href.includes('hubcloud.')
          && !href.includes('hubdrive.')
          && !href.includes('greenmotors.')
          && !href.includes('greenmountmotors.'),
      }));
    }
    if (mirrors.length === 0) continue;

    let sizeText = null;
    for (const node of item.querySelectorAll(SEL_BADGE_SIZE)) {
      const text = textOf(node);
      if (text !== null && parseSizeBytes(text) !== null) { sizeText = text; break; }
    }

    const key = normalizeFilename(filename);
    let entry = grouped.get(key);
    if (!entry) {
      entry = release({
        provider: 'fourkhdhub',
        filename,
        quality: detectQuality(filename),
        codec: detectCodec(filename),
        language: detectLanguage(filename) ?? pageLanguage,
        size_bytes: sizeText !== null ? parseSizeBytes(sizeText) : null,
        season: parsedEpisode ? parsedEpisode[0] : null,
        episode: parsedEpisode ? parsedEpisode[1] : null,
        mirrors: [],
        resource_id: null,
      });
      grouped.set(key, entry);
    }
    for (const candidate of mirrors) {
      if (!entry.mirrors.some((existing) => existing.resolver_url === candidate.resolver_url)) {
        entry.mirrors.push(candidate);
      }
    }
  }

  return [...grouped.values()];
}
