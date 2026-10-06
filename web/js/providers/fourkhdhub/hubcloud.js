/*
 * 4KHDHub mirror resolvers — port of src/providers/fourkhdhub/hubcloud.rs
 *
 * Resolvers fetch the mirror pages through api.js (CORS proxy fallback comes
 * from that layer) and only ever return URLs extracted from those pages after
 * validate_playback_url has accepted them.
 */

import { ProviderError, request } from '../base.js';
import { parseHtml } from './parser.js';

const PROVIDER_LABEL = '4KHDHub';

/** crate::net::DEFAULT_BROWSER_USER_AGENT (client.rs :: BROWSER_UA) */
export const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const INTENT_PLAYBACK = 'playback';
const INTENT_DOWNLOAD = 'download';
const REQUEST_TIMEOUT_MS = 20000;

const SEL_DOWNLOAD = "a#download, a.btn-primary, a.btn-success, a.btn[href*='/download/'], a[href*='/download/'], a[href*='gamerxyt.com'], a[href*='hubcloud.php']";
const SEL_LINKS = 'a[href]';

/** src/providers/moviebox/adapt.rs :: is_deprecation_notice_url */
const DEPRECATION_MARKERS = [
  '1c7de0bd3393702d9191801f15f88f8d',
  '9a0461bc39da389663bf3dbb17091d3f',
  'b164fbfb4347792950bdfbfb563d39d9',
  '/notice.mp4',
];

function isDeprecationNoticeUrl(url) {
  const lower = String(url || '').toLowerCase();
  if (DEPRECATION_MARKERS.some((marker) => lower.includes(marker))) return true;
  return lower.includes('macdn.aoneroom.com') && lower.includes('/other/');
}

function invalidUrl(raw) {
  return new ProviderError('parsing', `Invalid URL: ${raw}`, { provider: PROVIDER_LABEL });
}

async function fetchHtml(url, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const res = await request({
    url,
    method: 'GET',
    signal,
    timeoutMs,
    provider: PROVIDER_LABEL,
    headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'user-agent': BROWSER_UA },
  });
  return res.body;
}

/* ---------------- URL validation ---------------- */

function parseIPv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isPublicIPv4(octets) {
  const [a, b, c, d] = octets;
  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a === 255 && b === 255 && c === 255 && d === 255) return false;
  return true;
}

function ipv6FirstHextet(host) {
  const body = host.replace(/^\[/, '').replace(/\]$/, '');
  if (!body.includes(':')) return null;
  if (!/^[0-9a-f:.]+$/i.test(body)) return null;
  const head = body.startsWith('::') ? body.slice(2).split(':')[0] : body.split(':')[0];
  if (head === '') return 0;
  if (!/^[0-9a-f]{1,4}$/i.test(head)) return null;
  return Number.parseInt(head, 16);
}

function isPublicIPv6(host) {
  const first = ipv6FirstHextet(host);
  if (first === null) return null;
  const body = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (body === '::1' || body === '::') return false;
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link local fe80::/10
  return true;
}

/**
 * normalize_playback_url_str — WHATWG URL parsing already percent-encodes the
 * path, so the manual encoder below only runs for inputs `new URL` rejects.
 */
function normalizePlaybackUrl(raw) {
  const text = String(raw ?? '');
  try {
    return new URL(text);
  } catch {
    // fall through
  }

  const schemeIdx = text.indexOf('://');
  if (schemeIdx === -1) return null;
  const afterScheme = text.slice(schemeIdx + 3);
  let hostEnd = afterScheme.length;
  for (const marker of ['/', '?', '#']) {
    const idx = afterScheme.indexOf(marker);
    if (idx !== -1 && idx < hostEnd) hostEnd = idx;
  }
  const host = afterScheme.slice(0, hostEnd);
  if (host === '' || host.includes(' ')) return null;
  const schemeHost = text.slice(0, schemeIdx + 3 + hostEnd);
  const rest = afterScheme.slice(hostEnd);

  const queryIdx = rest.search(/[?#]/);
  const pathPart = queryIdx === -1 ? rest : rest.slice(0, queryIdx);
  const queryFragment = queryIdx === -1 ? '' : rest.slice(queryIdx);

  // percent_encoding::NON_ALPHANUMERIC per path segment (':' separators kept).
  const encodedPath = pathPart
    .split('/')
    .map((segment) => segment
      .split(':')
      .map((sub) => encodeURIComponent(sub)
        .replace(/[!'()*\-._~]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`))
      .join(':'))
    .join('/');

  try {
    return new URL(`${schemeHost}${encodedPath}${queryFragment}`);
  } catch {
    return null;
  }
}

/** validate_playback_url */
export function validatePlaybackUrl(raw) {
  const url = normalizePlaybackUrl(raw);
  if (!url || url.protocol !== 'https:' || url.hostname === '') throw invalidUrl(raw);

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  const ipv4 = parseIPv4(host);
  const ipv6Public = isPublicIPv6(host);

  if (host === 'localhost'
    || host.endsWith('.local')
    || (ipv4 !== null && !isPublicIPv4(ipv4))
    || ipv6Public === false
    || path.endsWith('.zip')
    || path.includes('login.php')
    || path.includes('logout')
    || host.includes('greenmotors.')
    || host.includes('greenmountmotors.')
    || isDeprecationNoticeUrl(raw)) {
    throw invalidUrl(raw);
  }
  return url.toString();
}

function validateResolverUrl(raw) {
  const url = (() => { try { return new URL(raw); } catch { return null; } })();
  if (!url || url.protocol !== 'https:' || !url.hostname.includes('hubcloud.')
    || !url.pathname.startsWith('/drive/')) {
    throw invalidUrl(raw);
  }
}

function validateHubdriveUrl(raw) {
  const url = (() => { try { return new URL(raw); } catch { return null; } })();
  if (!url || url.protocol !== 'https:' || !url.hostname.includes('hubdrive.')
    || !url.pathname.startsWith('/file/')) {
    throw invalidUrl(raw);
  }
}

function validateGreenmotorsUrl(raw) {
  const url = (() => { try { return new URL(raw); } catch { return null; } })();
  if (!url || url.protocol !== 'https:'
    || (!url.hostname.includes('greenmotors.') && !url.hostname.includes('greenmountmotors.'))) {
    throw invalidUrl(raw);
  }
}

/* ---------------- scoring ---------------- */

/** score — ResolutionIntent ordering from hubcloud.rs */
export function score(url, label, intent = INTENT_PLAYBACK) {
  const value = `${url} ${label}`.toLowerCase();

  if (intent === INTENT_DOWNLOAD) {
    if (value.includes('pixel.hubcloud.')
      || value.includes('googleusercontent.com')
      || value.includes('cloudflarestorage.com')
      || value.includes('r2.cloudflarestorage.com')
      || value.includes('fsl server')
      || value.includes('r2.dev')
      || value.includes('workers.dev')
      || value.includes('watch online')) return 0;
    if (value.includes('storage.googleapis.com')
      || value.includes('hubcloud.cx/re/')
      || value.includes('hubcloud.fans/re/')) return 1;
    if (value.includes('pixeldrain')) return 2;
    if (value.includes('googlevideo.com')
      || value.includes('testzip.php')
      || value.includes('vcloud.php')
      || value.includes('drive.php')
      || value.includes('gpdl.')) return 3;
    return 4;
  }

  if (value.includes('pixel.hubcloud.')
    || value.includes('googleusercontent.com')
    || value.includes('googlevideo.com')
    || value.includes('cloudflarestorage.com')
    || value.includes('r2.cloudflarestorage.com')
    || value.includes('fsl server')
    || value.includes('10gbps')
    || value.includes('r2.dev')
    || value.includes('watch online')) return 0;
  if (value.includes('storage.googleapis.com')
    || value.includes('hubcloud.cx/re/')
    || value.includes('hubcloud.fans/re/')) return 1;
  if (value.includes('pixeldrain')) return 2;
  if (value.includes('testzip.php')
    || value.includes('vcloud.php')
    || value.includes('drive.php')
    || value.includes('gpdl.')) return 3;
  return 4;
}

function cleanLabel(label) {
  const clean = String(label ?? '').split(/\s+/).filter(Boolean).join(' ');
  return clean === '' ? 'Direct' : clean;
}

/* ---------------- base64 / payload helpers ---------------- */

function b64decode(input) {
  let text = String(input ?? '').trim();
  if (text === '') return null;
  const remainder = text.length % 4;
  if (remainder === 1) return null;
  if (remainder) text += '='.repeat(4 - remainder);
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function rot13(input) {
  return String(input).replace(/[a-zA-Z]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 77) return String.fromCharCode(code + 13);
    if (code >= 78 && code <= 90) return String.fromCharCode(code - 13);
    if (code >= 97 && code <= 109) return String.fromCharCode(code + 13);
    if (code >= 110 && code <= 122) return String.fromCharCode(code - 13);
    return ch;
  });
}

/** decode_greenmotors_payload — b64 → b64 → rot13 → b64 → JSON["o"] → b64 */
function decodeGreenmotorsPayload(payload) {
  const step1 = b64decode(payload);
  if (step1 === null) return null;
  const step2 = b64decode(step1);
  if (step2 === null) return null;
  const step3 = rot13(step2);
  const step4 = b64decode(step3);
  if (step4 === null) return null;
  let json;
  try { json = JSON.parse(step4); } catch { return null; }
  const target = json?.o;
  if (typeof target !== 'string') return null;
  return b64decode(target);
}

/** extract_greenmotors_payload — `s('o','<payload>',…)` inside the page script. */
function extractGreenmotorsPayload(html) {
  const needle = 's(';
  let searchIdx = 0;

  for (;;) {
    const pos = html.indexOf(needle, searchIdx);
    if (pos === -1) return null;
    const absPos = pos + needle.length;
    const rest = html.slice(absPos).replace(/^\s+/, '');

    let afterKey;
    if (rest.startsWith("'o'")) afterKey = rest.slice(3);
    else if (rest.startsWith('"o"')) afterKey = rest.slice(3);
    else { searchIdx = absPos; continue; }

    const afterComma = afterKey.replace(/^\s+/, '');
    if (!afterComma.startsWith(',')) { searchIdx = absPos; continue; }

    const trimmed = afterComma.slice(1).replace(/^\s+/, '');
    const quote = trimmed.charAt(0);
    if (quote !== "'" && quote !== '"') { searchIdx = absPos; continue; }

    const payloadSlice = trimmed.slice(1);
    const end = payloadSlice.indexOf(quote);
    if (end !== -1) return payloadSlice.slice(0, end);
    searchIdx = absPos;
  }
}

function unpackGreenmotorsUrl(html) {
  const payload = extractGreenmotorsPayload(html);
  if (payload === null) return null;
  return decodeGreenmotorsPayload(payload);
}

/** extract_hubcloud_drive_url */
function extractHubcloudDriveUrl(html) {
  const doc = parseHtml(html);
  for (const node of doc.querySelectorAll(SEL_LINKS)) {
    const raw = node.getAttribute('href');
    if (!raw) continue;
    let url;
    try { url = new URL(raw); } catch { continue; }
    if (url.hostname.includes('hubcloud.') && url.pathname.startsWith('/drive/')) return url.toString();
  }
  return null;
}

/** unwrap_watch_online_url — `?u=<base64 https…>` on pages.dev links. */
function unwrapWatchOnlineUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!url.hostname.includes('pages.dev')) return null;
  const encoded = url.searchParams.get('u');
  if (encoded === null) return null;
  const decoded = b64decode(encoded);
  if (decoded !== null && decoded.startsWith('https://')) return decoded;
  return null;
}

/** pixeldrain_api_url */
function pixeldrainApiUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!url.hostname.includes('pixeldrain.')) return null;

  let id = null;
  if (url.pathname.startsWith('/u/')) {
    id = url.pathname.slice('/u/'.length).replace(/^\/+/, '').replace(/\/+$/, '');
  } else if (url.pathname.startsWith('/api/file/')) {
    id = url.pathname.slice('/api/file/'.length).replace(/^\/+/, '').replace(/\/+$/, '');
  }
  if (id === null || !/^[0-9a-z_-]+$/i.test(id)) return null;
  return `https://${url.hostname}/api/file/${id}?download`;
}

/** extract_script_pixeldrain_urls */
function extractScriptPixeldrainUrls(html) {
  const urls = [];
  const prefixes = [
    'https://pixeldrain.dev/u/',
    'https://pixeldrain.com/u/',
    'https://pixeldrain.dev/api/file/',
    'https://pixeldrain.com/api/file/',
  ];

  for (const prefix of prefixes) {
    let remainder = html;
    for (;;) {
      const offset = remainder.indexOf(prefix);
      if (offset === -1) break;
      const candidate = remainder.slice(offset);
      let end = candidate.length;
      for (let i = 0; i < candidate.length; i += 1) {
        const ch = candidate[i];
        if (ch === '"' || ch === "'" || ch === '<' || ch === '\\' || /\s/.test(ch)) { end = i; break; }
      }
      const url = pixeldrainApiUrl(candidate.slice(0, end));
      if (url !== null && !urls.includes(url)) urls.push(url);
      remainder = candidate.slice(end);
    }
  }
  return urls;
}

/* ---------------- resolvers ---------------- */

/** resolve — HubCloud `/drive/` page → resolver page → playable candidates. */
export async function resolveHubcloud(driveUrl, { signal } = {}) {
  validateResolverUrl(driveUrl);
  const driveHtml = await fetchHtml(driveUrl, { signal });
  const driveDoc = parseHtml(driveHtml);

  let resolverUrl = null;
  for (const node of driveDoc.querySelectorAll(SEL_DOWNLOAD)) {
    const href = node.getAttribute('href');
    if (href && href.startsWith('https://')) { resolverUrl = href; break; }
  }
  if (resolverUrl === null) {
    throw new ProviderError('parsing', 'HubCloud resolver link missing', { provider: PROVIDER_LABEL });
  }

  const resolverHtml = await fetchHtml(resolverUrl, { signal });
  const resolverDoc = parseHtml(resolverHtml);

  const candidates = extractScriptPixeldrainUrls(resolverHtml)
    .map((url) => ({ url, label: 'PixelDrain', headers: [], score: score(url, 'PixelDrain') }));

  for (const node of resolverDoc.querySelectorAll(SEL_LINKS)) {
    const href = node.getAttribute('href');
    if (!href) continue;
    const label = node.textContent ?? '';

    let handled = false;
    const unwrapped = unwrapWatchOnlineUrl(href);
    if (unwrapped !== null) {
      try {
        const valid = validatePlaybackUrl(unwrapped);
        candidates.push({ url: valid, label: 'Watch Online', headers: [], score: score(valid, 'Watch Online') });
        handled = true;
      } catch {
        handled = false;
      }
    }
    if (handled) continue;

    try {
      const validated = validatePlaybackUrl(href);
      const url = pixeldrainApiUrl(validated) ?? validated;
      candidates.push({ url, label: cleanLabel(label), headers: [], score: score(url, label) });
    } catch {
      // Rust: validate_playback_url(href).ok() — invalid links are skipped.
    }
  }

  candidates.sort((left, right) => left.score - right.score);

  // Rust: resolved.dedup_by(|l, r| l.0 == r.0) — consecutive duplicates only.
  const resolved = [];
  for (const candidate of candidates) {
    const last = resolved[resolved.length - 1];
    if (last && last.url === candidate.url) continue;
    resolved.push(candidate);
  }
  if (resolved.length === 0) {
    throw new ProviderError('network', 'no candidates found', { provider: PROVIDER_LABEL });
  }
  return resolved;
}

/** resolve_hubdrive — HubDrive `/file/` page → nested HubCloud drive link. */
export async function resolveHubdrive(driveUrl, { signal } = {}) {
  validateHubdriveUrl(driveUrl);
  const html = await fetchHtml(driveUrl, { signal });
  const hubcloudUrl = extractHubcloudDriveUrl(html);
  if (hubcloudUrl === null) {
    throw new ProviderError('parsing', 'HubDrive HubCloud mirror missing', { provider: PROVIDER_LABEL });
  }
  return resolveHubcloud(hubcloudUrl, { signal });
}

/** resolve_greenmotors — unpacks the obfuscated intermediate redirector. */
export async function resolveGreenmotors(driveUrl, { signal } = {}) {
  validateGreenmotorsUrl(driveUrl);
  const html = await fetchHtml(driveUrl, { signal });
  const targetUrl = unpackGreenmotorsUrl(html);
  if (targetUrl === null) {
    throw new ProviderError('parsing', 'GreenMotors mirror target missing', { provider: PROVIDER_LABEL });
  }
  if (targetUrl.includes('hubcloud.')) return resolveHubcloud(targetUrl, { signal });
  if (targetUrl.includes('hubdrive.')) return resolveHubdrive(targetUrl, { signal });
  return [{ url: validatePlaybackUrl(targetUrl), label: 'Direct', headers: [], score: 0 }];
}

/**
 * resolveMirrorCandidates — client.rs :: resolve_release dispatch for the
 * Playback intent: pick the resolver by host, or accept a direct link.
 */
export async function resolveMirrorCandidates(resolverUrl, { label = 'Direct', headers = [], signal } = {}) {
  if (resolverUrl.includes('hubcloud.')) return resolveHubcloud(resolverUrl, { signal });
  if (resolverUrl.includes('hubdrive.')) return resolveHubdrive(resolverUrl, { signal });
  if (resolverUrl.includes('greenmotors.') || resolverUrl.includes('greenmountmotors.')) {
    return resolveGreenmotors(resolverUrl, { signal });
  }
  const url = validatePlaybackUrl(resolverUrl);
  return [{ url, label, headers, score: score(url, label) }];
}
