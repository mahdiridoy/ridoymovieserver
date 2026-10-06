/*
 * MovieBox JSON → model adapters — port of src/providers/moviebox/adapt.rs
 */

import { extract4DigitYear, cleanMovieboxTitle } from '../../utils/title.js';
import { catalogItem, emptyDetails, release, mirror } from '../base.js';

function asString(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function firstString(obj, keys) {
  for (const k of keys) {
    const s = asString(obj?.[k]);
    if (s !== null) return s;
  }
  return null;
}

function asNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

const DEPRECATION_MARKERS = [
  '1c7de0bd3393702d9191801f15f88f8d',
  '9a0461bc39da389663bf3dbb17091d3f',
  'b164fbfb4347792950bdfbfb563d39d9',
  '/notice.mp4',
];

export function isDeprecationNoticeUrl(url) {
  const lower = String(url || '').toLowerCase();
  if (DEPRECATION_MARKERS.some((m) => lower.includes(m))) return true;
  return lower.includes('macdn.aoneroom.com') && lower.includes('/other/');
}

function toDashMpd(urlStr) {
  const base = String(urlStr || '').replace(/\*+$/, '').replace(/\/+$/, '');
  if (base.startsWith('http://') || base.startsWith('https://')) return `${base}/index.mpd`;
  return null;
}

function decodeBase64Padded(s) {
  let str = String(s || '');
  const padding = (4 - (str.length % 4)) % 4;
  str += '='.repeat(padding);
  try {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToText(bytes) {
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Port of resolve_dash_manifest_from_policy. */
export function resolveDashManifestFromPolicy(signCookie) {
  for (const part of String(signCookie || '').split(';')) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf('urlprefix=');
    if (idx !== -1) {
      const prefixPart = trimmed.slice(idx + 'urlprefix='.length);
      const b64Token = (prefixPart.split(':')[0] || prefixPart).trim();
      const normalized = b64Token.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = decodeBase64Padded(normalized);
      if (bytes) {
        const text = bytesToText(bytes);
        if (text) {
          const mpd = toDashMpd(text);
          if (mpd) return mpd;
        }
      }
    }
    if (trimmed.startsWith('CloudFront-Policy=')) {
      const policyClean = trimmed.slice('CloudFront-Policy='.length).trim();
      const normalized = policyClean.replace(/-/g, '+').replace(/_/g, '/').replace(/~/g, '/');
      const bytes = decodeBase64Padded(normalized);
      if (!bytes) continue;
      let json;
      try {
        json = JSON.parse(bytesToText(bytes) || '');
      } catch {
        continue;
      }
      const resource = json?.Statement?.[0]?.Resource;
      if (typeof resource === 'string') {
        const mpd = toDashMpd(resource);
        if (mpd) return mpd;
      }
    }
  }
  return null;
}

/* ---------------- catalog ---------------- */

export function subjectJsonToCatalogItem(s) {
  if (!s || typeof s !== 'object') return null;
  const idStr = asString(s.subjectId) ?? (asNumber(s.subjectId) !== null ? String(asNumber(s.subjectId)) : null)
    ?? asString(s.id) ?? (asNumber(s.id) !== null ? String(asNumber(s.id)) : null);
  if (!idStr) return null;

  const title = asString(s.title) || asString(s.name) || 'Unknown';
  const stype = asNumber(s.subjectType) ?? asNumber(s.stype) ?? 1;

  const yearRaw = asString(s.releaseDate) ?? asString(s.year) ?? asString(s.releaseInfo);
  const year = yearRaw ? extract4DigitYear(yearRaw) : '';
  const poster = asString(s.cover?.url) ?? asString(s.coverUrl) ?? asString(s.poster) ?? asString(s.pic);
  const seasonCount = asNumber(s.season);

  return catalogItem({
    provider: 'moviebox',
    id: idStr,
    title,
    media_type: stype === 2 ? 'series' : 'movie',
    year: year || null,
    poster_url: poster,
    season_count: seasonCount !== null ? Math.trunc(seasonCount) : null,
  });
}

export function searchJsonToCatalog(payload) {
  const items = [];
  const results = payload?.data?.results ?? payload?.results;
  let subjects = null;
  if (Array.isArray(results) && results.length) {
    subjects = asArray(results[0]?.subjects);
  }
  if (!subjects || !subjects.length) {
    subjects = asArray(payload?.data?.list ?? payload?.list);
  }
  for (const s of subjects) {
    const item = subjectJsonToCatalogItem(s);
    if (item) items.push(item);
  }
  return items;
}

export function homepageJsonToCatalog(payload) {
  const items = [];
  const seen = new Set();
  const groups = asArray(payload?.items ?? (Array.isArray(payload) ? payload : null));
  const metricById = {};

  for (const group of groups) {
    const groupSubjects = [];
    for (const b of asArray(group?.banner?.banners)) {
      if (b?.subject) groupSubjects.push(b.subject);
    }
    for (const c of asArray(group?.customData?.items)) {
      if (c?.subject) groupSubjects.push(c.subject);
    }
    for (const s of asArray(group?.subjects)) groupSubjects.push(s);

    groupSubjects.forEach((subjectVal, index) => {
      const catalogItemValue = subjectJsonToCatalogItem(subjectVal);
      if (!catalogItemValue) return;
      if (seen.has(catalogItemValue.id)) return;
      seen.add(catalogItemValue.id);
      metricById[catalogItemValue.id] = {
        trending: asNumber(subjectVal.trending) ?? asNumber(subjectVal.hotScore) ?? (1000 - Math.min(index, 999)),
        rating: asNumber(subjectVal.rating) ?? asNumber(subjectVal.score),
        popularity: asNumber(subjectVal.playCount) ?? asNumber(subjectVal.hot),
        groupTitle: asString(group?.title) ?? asString(group?.name) ?? '',
      };
      items.push(catalogItemValue);
    });
  }
  return { items, metrics: metricById, groups };
}

/* ---------------- details ---------------- */

export function detailsJsonToMediaDetails(payload) {
  const subject = payload?.data?.subject ?? payload?.subject ?? payload;
  if (!subject || typeof subject !== 'object') {
    throw Object.assign(new Error('Missing subject'), { kind: 'parsing' });
  }

  const idStr = asString(subject.subjectId)
    ?? (asNumber(subject.subjectId) !== null ? String(asNumber(subject.subjectId)) : null)
    ?? asString(subject.id)
    ?? (asNumber(subject.id) !== null ? String(asNumber(subject.id)) : null);
  if (!idStr) throw Object.assign(new Error('Missing subject id'), { kind: 'not_found' });

  const title = asString(subject.title) || 'Unknown';
  const stype = asNumber(subject.subjectType) ?? asNumber(subject.stype) ?? 1;
  const yearRaw = asString(subject.releaseDate) ?? asString(subject.year);
  const year = yearRaw ? extract4DigitYear(yearRaw) : '';

  const durationRaw = asNumber(subject.duration);
  let duration = null;
  let durationSeconds = null;
  if (durationRaw !== null && durationRaw > 0) {
    duration = `${Math.floor(durationRaw / 60)}m`;
    durationSeconds = durationRaw;
  } else if (typeof subject.duration === 'string' && subject.duration.trim() && subject.duration.trim() !== '0m' && subject.duration.trim() !== '0') {
    duration = subject.duration.trim();
    const m = duration.match(/(\d+)\s*h/);
    const mm = duration.match(/(\d+)\s*m/);
    if (m || mm) {
      durationSeconds = (Number(m?.[1] || 0) * 3600) + (Number(mm?.[1] || 0) * 60);
    }
  }

  const ratingRaw = subject.imdbRatingValue ?? subject.rating;
  let imdbRating = null;
  if (typeof ratingRaw === 'number' && Number.isFinite(ratingRaw)) imdbRating = ratingRaw.toFixed(1);
  else if (typeof ratingRaw === 'string' && ratingRaw) imdbRating = ratingRaw;

  const details = emptyDetails({
    provider: 'moviebox',
    id: idStr,
    title,
    media_type: stype === 2 ? 'series' : 'movie',
    poster_url: asString(subject.cover?.url) ?? asString(subject.coverUrl),
    year: year || null,
  });

  details.description = asString(subject.description) ?? asString(subject.intro);
  details.tagline = asString(subject.tagline);
  details.imdb_rating = imdbRating;
  details.director = asString(subject.director);
  details.stars = asString(subject.stars);
  details.prints = asString(subject.prints);
  details.audios = asString(subject.audios);
  details.duration = duration;
  details.duration_seconds = durationSeconds;
  details.genres = asArray(subject.genre ?? subject.genres).map((g) => asString(g)).filter(Boolean);

  const seasonsNode = subject.seasons;
  const seasonsArr = Array.isArray(seasonsNode) ? seasonsNode : asArray(seasonsNode?.seasons);
  for (const s of seasonsArr) {
    const seNum = Math.trunc(asNumber(s?.se) ?? 1);
    const episodes = [];
    const epNode = asArray(s?.episodeNumbers);
    if (epNode.length) {
      for (const ep of epNode) {
        const epNum = asNumber(ep);
        if (epNum !== null) episodes.push({ season: seNum, number: Math.trunc(epNum), title: null, overview: null });
      }
    } else {
      const maxEp = asNumber(s?.maxEp);
      if (maxEp !== null && maxEp > 0) {
        for (let n = 1; n <= Math.trunc(maxEp); n += 1) {
          episodes.push({ season: seNum, number: n, title: null, overview: null });
        }
      }
    }
    details.seasons.push({ number: seNum, episodes });
  }

  for (const d of asArray(subject.dubs)) {
    const subjectId = asString(d?.subjectId) ?? (asNumber(d?.subjectId) !== null ? String(asNumber(d.subjectId)) : null)
      ?? asString(d?.id) ?? (asNumber(d?.id) !== null ? String(asNumber(d.id)) : null) ?? '';
    const language = asString(d?.lanName) ?? asString(d?.language) ?? asString(d?.lang) ?? 'Unknown';
    const label = asString(d?.title) ?? asString(d?.name) ?? asString(d?.lanName) ?? language;
    details.dubs.push({ subject_id: subjectId, language, label });
  }

  return details;
}

/* ---------------- releases ---------------- */

export function resourceItemToRelease(item) {
  if (!item || typeof item !== 'object') return null;
  if (item._addon_release && typeof item._addon_release === 'object') return item._addon_release;

  const filename = firstString(item, ['fileName', 'title']) || 'Unknown Release';

  const resRaw = item.resolution;
  let quality = null;
  if (typeof resRaw === 'number' && Number.isFinite(resRaw)) quality = `${Math.trunc(resRaw)}p`;
  else if (typeof resRaw === 'string' && resRaw) quality = resRaw;

  const codec = firstString(item, ['codecName', 'codec']);
  const language = firstString(item, ['language', 'lanName']);

  let sizeBytes = null;
  if (typeof item.size === 'number') sizeBytes = item.size;
  else if (typeof item.size === 'string' && /^\d+$/.test(item.size.trim())) sizeBytes = Number(item.size);

  const season = asNumber(item.se);
  const episode = asNumber(item.ep);
  const resourceId = asString(item.resourceId) ?? (asNumber(item.resourceId) !== null ? String(asNumber(item.resourceId)) : null)
    ?? asString(item.id) ?? (asNumber(item.id) !== null ? String(asNumber(item.id)) : null);

  const mirrors = [];
  const linkRaw = asString(item.resourceLink) ?? asString(item.url);
  if (linkRaw && !isDeprecationNoticeUrl(linkRaw)) {
    const label = firstString(item, ['uploadBy', 'source']) || 'Direct';
    mirrors.push(mirror({ label, resolver_url: linkRaw, direct_file: false }));
  }

  if (!mirrors.length) return null;

  return release({
    provider: 'moviebox',
    filename,
    quality,
    codec,
    language,
    size_bytes: sizeBytes,
    season: season !== null ? Math.trunc(season) : null,
    episode: episode !== null ? Math.trunc(episode) : null,
    mirrors,
    resource_id: resourceId,
  });
}

export function resourceJsonToReleases(payload) {
  const items = asArray(payload?.list ?? (Array.isArray(payload) ? payload : null));
  return items.map(resourceItemToRelease).filter(Boolean);
}

export function playInfoJsonToReleases(payload, season, episode, userAgent) {
  const data = payload?.data ?? payload;
  const titlePrefix = cleanMovieboxTitle(asString(data?.title) || 'MovieBox Stream') || 'MovieBox Stream';
  const streams = asArray(data?.streams);
  const out = [];

  for (const stream of streams) {
    const streamId = asString(stream?.id) ?? (asNumber(stream?.id) !== null ? String(asNumber(stream.id)) : null);
    const formatType = asString(stream?.format) || 'MP4';
    const codec = firstString(stream, ['codecName', 'codec']);

    let sizeBytes = null;
    if (typeof stream?.size === 'number') sizeBytes = stream.size;
    else if (typeof stream?.size === 'string' && /^\d+$/.test(stream.size.trim())) sizeBytes = Number(stream.size);

    const resolutionsStr = asString(stream?.resolutions) ?? asString(data?.displayResolutions) ?? '1080,720,480';
    const signCookie = asString(stream?.signCookie) || '';
    const streamUrl = asString(stream?.url) || '';

    const manifestUrl = resolveDashManifestFromPolicy(signCookie)
      ?? (isDeprecationNoticeUrl(streamUrl) ? null : (streamUrl.startsWith('http') ? streamUrl : null));
    if (!manifestUrl) continue;

    const headers = [
      ['Referer', 'https://sportslive.wine'],
      ['User-Agent', userAgent],
    ];
    if (signCookie) {
      const clean = signCookie.replace(/;\s*$/, '').split(';').map((s) => s.trim()).filter(Boolean).join('; ');
      if (clean) headers.push(['Cookie', clean]);
    }

    let parsedResolutions = resolutionsStr.split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);
    parsedResolutions = [...new Set(parsedResolutions)].sort((a, b) => b - a);
    const resList = parsedResolutions.length ? parsedResolutions : [1080];

    const codecDisp = codec || formatType;
    const highestRes = resList[0] || 1080;

    for (const res of resList) {
      const resLabel = `${res}p`;
      const filename = season > 0 && episode > 0
        ? `${titlePrefix} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} ${resLabel} ${codecDisp}`
        : `${titlePrefix} ${resLabel} ${codecDisp}`;

      let scaledSize = null;
      if (sizeBytes !== null) {
        if (res >= highestRes || highestRes <= 0) scaledSize = sizeBytes;
        else {
          const scale = Math.min(1, Math.max(0.15, (res / highestRes) ** 1.6));
          scaledSize = Math.round(sizeBytes * scale);
        }
      }

      out.push(release({
        provider: 'moviebox',
        filename,
        quality: resLabel,
        codec,
        language: null,
        size_bytes: scaledSize,
        season: season > 0 ? season : null,
        episode: episode > 0 ? episode : null,
        mirrors: [mirror({ label: `${resLabel} ${codecDisp}`, resolver_url: manifestUrl, headers, direct_file: true })],
        resource_id: streamId,
      }));
    }
  }

  return out;
}

/* ---------------- subtitles ---------------- */

export function captionsJsonToOptions(payload) {
  const captions = asArray(payload?.extCaptions ?? payload?.data?.extCaptions);
  const seen = new Set();
  const out = [];
  for (const cap of captions) {
    const url = asString(cap?.url);
    if (!url || url.includes('aa348f2541d13ffe')) continue;
    let size = 0;
    if (typeof cap?.size === 'number') size = cap.size;
    else if (typeof cap?.size === 'string' && /^\d+$/.test(cap.size.trim())) size = Number(cap.size);
    if (size > 0 && size <= 50) continue;
    const rawName = (asString(cap?.lanName)?.trim() || asString(cap?.lan) || 'Unknown');
    if (rawName.toLowerCase() === 'in' && (size === 0 || size <= 100)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ name: rawName, url });
  }
  return out;
}
