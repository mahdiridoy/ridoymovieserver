/*
 * MovieBox request signing — port of src/providers/moviebox/crypto.rs
 *
 * Web Crypto has no MD5, so a compact RFC 1321 implementation lives here.
 * Signing only ever produces headers; when the app runs through a configured
 * proxy the computed headers are sent as JSON fields (browsers forbid setting
 * User-Agent / X-Forwarded-For directly).
 */

const SECRET = new Uint8Array([
  0xef, 0xa8, 0x91, 0x97, 0x4e, 0xec, 0xd3, 0x14, 0x8d, 0xf6, 0x3a, 0xa6, 0x11, 0x60, 0x2d, 0xef,
  0xd1, 0x01, 0x25, 0x9b, 0xa5, 0x21, 0x02, 0x2c, 0x57, 0xae, 0x05, 0x66, 0xbd, 0x8e,
]);

const SIGNATURE_BODY_MAX_BYTES = 102400;

/* ---------------- MD5 ---------------- */

function safeAdd(x, y) {
  const l = (x & 0xffff) + (y & 0xffff);
  const m = (x >> 16) + (y >> 16) + (l >> 16);
  return (m << 16) | (l & 0xffff);
}
function rotl(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
function cmn(q, a, b, x, s, t) { return safeAdd(rotl(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

function md5cycle(x, k) {
  let [a, b, c, d] = x;
  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);

  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);

  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);

  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);

  x[0] = safeAdd(a, x[0]);
  x[1] = safeAdd(b, x[1]);
  x[2] = safeAdd(c, x[2]);
  x[3] = safeAdd(d, x[3]);
}

function md5blk(bytes, offset) {
  const w = new Array(16);
  for (let i = 0; i < 16; i += 1) {
    const j = offset + i * 4;
    w[i] = bytes[j] | (bytes[j + 1] << 8) | (bytes[j + 2] << 16) | (bytes[j + 3] << 24);
  }
  return w;
}

export function md5Bytes(input) {
  const bytes = input instanceof Uint8Array ? input : new TextEncoder().encode(String(input ?? ''));
  const n = bytes.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 0; i + 64 <= n; i += 64) md5cycle(state, md5blk(bytes, i));
  const tail = new Uint8Array(64);
  const rem = n - i;
  tail.set(bytes.subarray(i, i + rem));
  tail[rem] = 0x80;
  if (rem >= 56) {
    md5cycle(state, md5blk(tail, 0));
    tail.fill(0, 0, 64);
  }
  const bitLen = n * 8;
  tail[56] = bitLen & 0xff;
  tail[57] = (bitLen >>> 8) & 0xff;
  tail[58] = (bitLen >>> 16) & 0xff;
  tail[59] = (bitLen >>> 24) & 0xff;
  tail[60] = Math.floor(bitLen / 0x100000000) & 0xff;
  tail[61] = (Math.floor(bitLen / 0x100000000) >>> 8) & 0xff;
  tail[62] = (Math.floor(bitLen / 0x100000000) >>> 16) & 0xff;
  tail[63] = (Math.floor(bitLen / 0x100000000) >>> 24) & 0xff;
  md5cycle(state, md5blk(tail, 0));

  const out = new Uint8Array(16);
  for (i = 0; i < 4; i += 1) {
    out[i * 4] = state[i] & 0xff;
    out[i * 4 + 1] = (state[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (state[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (state[i] >>> 24) & 0xff;
  }
  return out;
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function md5Hex(input) {
  return toHex(md5Bytes(input));
}

export function hmacMd5(key, message) {
  const keyBytes = key instanceof Uint8Array ? key : new TextEncoder().encode(String(key));
  const msgBytes = message instanceof Uint8Array ? message : new TextEncoder().encode(String(message ?? ''));
  let k = keyBytes;
  if (k.length > 64) k = md5Bytes(k);
  const pad = new Uint8Array(64);
  pad.set(k);
  const inner = new Uint8Array(64 + msgBytes.length);
  for (let i = 0; i < 64; i += 1) inner[i] = pad[i] ^ 0x36;
  inner.set(msgBytes, 64);
  const innerDigest = md5Bytes(inner);
  const outer = new Uint8Array(64 + 16);
  for (let i = 0; i < 64; i += 1) outer[i] = pad[i] ^ 0x5c;
  outer.set(innerDigest, 64);
  return md5Bytes(outer);
}

export function base64Encode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64Decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- Signing ---------------- */

function sortedQueryString(url) {
  let parsed;
  try {
    parsed = new URL(url, 'https://placeholder.invalid');
  } catch {
    return '';
  }
  const params = new Map();
  for (const [k, v] of parsed.searchParams.entries()) {
    if (!params.has(k)) params.set(k, []);
    params.get(k).push(v);
  }
  if (!params.size) return '';
  const keys = [...params.keys()].sort();
  const parts = [];
  for (const key of keys) {
    for (const val of params.get(key)) parts.push(`${key}=${val}`);
  }
  return parts.join('&');
}

function canonicalUrl(url) {
  try {
    const parsed = new URL(url, 'https://placeholder.invalid');
    const query = sortedQueryString(url);
    return query ? `${parsed.pathname}?${query}` : parsed.pathname;
  } catch {
    return url;
  }
}

export function buildCanonicalString({ method, accept = '', contentType = '', url, body = null, timestampMs }) {
  let bodyHash = '';
  let bodyLength = '';
  if (body !== null && body !== undefined) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    bodyLength = String(bytes.length);
    const truncated = bytes.length > SIGNATURE_BODY_MAX_BYTES ? bytes.subarray(0, SIGNATURE_BODY_MAX_BYTES) : bytes;
    bodyHash = md5Hex(truncated);
  }
  return [
    String(method || 'GET').toUpperCase(),
    accept,
    contentType,
    bodyLength,
    String(timestampMs),
    bodyHash,
    canonicalUrl(url),
  ].join('\n');
}

export function generateXClientToken(ts) {
  const tsStr = String(ts);
  const reversed = [...tsStr].reverse().join('');
  return `${tsStr},${md5Hex(reversed)}`;
}

export function generateXTrSignature({ method, accept, contentType, url, body, timestampMs }) {
  const canonical = buildCanonicalString({ method, accept, contentType, url, body, timestampMs });
  const mac = hmacMd5(SECRET, canonical);
  return `${timestampMs}|2|${base64Encode(mac)}`;
}

const ANDROID_VERSIONS = [
  ['9', 'PQ3A.190605.03081104'],
  ['10', 'QP1A.191005.007.A3'],
  ['11', 'RP1A.200720.011'],
  ['12', 'S1B.220414.015'],
  ['13', 'TQ2A.230405.003'],
];
const REDMI_DEVICES = [
  ['23078RKD5C', 'Redmi'], ['2201117TY', 'Redmi'], ['2201117TG', 'Redmi'],
  ['22101316G', 'Redmi'], ['21121210G', 'Redmi'], ['M2012K11AG', 'Redmi'], ['M2007J20CG', 'Redmi'],
];
const VERSION_CODES = [50020117, 50020118, 50020119, 50020120, 50020121];
const NETWORK_TYPES = ['NETWORK_WIFI', 'NETWORK_MOBILE'];
const TIMEZONES = ['Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'America/New_York', 'Europe/London'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomHex(len) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

function randomUuid() {
  return [randomHex(8), randomHex(4), randomHex(4), randomHex(4), randomHex(12)].join('-');
}

export function randomSpoofedIp() {
  const prefixes = ['103.241', '49.36', '117.195', '106.198', '122.162', '157.32', '182.70', '103.58', '27.60', '59.90'];
  const prefix = pick(prefixes);
  const c = 1 + Math.floor(Math.random() * 253);
  const d = 1 + Math.floor(Math.random() * 253);
  return `${prefix}.${c}.${d}`;
}

export function generateClientInfoAndUa() {
  const android = pick(ANDROID_VERSIONS);
  const device = pick(REDMI_DEVICES);
  const versionCode = pick(VERSION_CODES);
  const network = pick(NETWORK_TYPES);
  const timezone = pick(TIMEZONES);
  const gaid = randomUuid();
  const deviceId = randomHex(32);

  const userAgent = `com.community.oneroom/${versionCode} (Linux; U; Android ${android[0]}; en_US; ${device[0]}; Build/${android[1]}; Cronet/135.0.7012.3)`;
  const clientInfo = JSON.stringify({
    package_name: 'com.community.oneroom',
    version_name: '4.0.01.0813.03',
    version_code: versionCode,
    os: 'android',
    os_version: android[0],
    install_ch: 'ps',
    device_id: deviceId,
    install_store: 'ps',
    gaid,
    brand: device[1],
    model: device[0],
    system_language: 'en',
    net: network,
    region: 'US',
    timezone,
    sp_code: '40401',
    'X-Play-Mode': '2',
  });

  return { userAgent, clientInfo };
}

export const STREAM_REFERER = 'https://sportslive.wine';

/**
 * Full signed header set for a MovieBox call.
 * Returned as a plain object so it can be passed to the proxy verbatim.
 */
export function buildSignedHeaders({ method, url, body = null, authToken = null, userAgent, clientInfo, spoofedIp, timestampMs = Date.now() }) {
  const accept = 'application/json';
  const contentType = 'application/json';
  const headers = {
    'user-agent': userAgent,
    accept,
    'content-type': contentType,
    'x-client-token': generateXClientToken(timestampMs),
    'x-tr-signature': generateXTrSignature({ method, accept, contentType, url, body, timestampMs }),
    'x-client-info': clientInfo,
    'x-client-status': '0',
    'x-forwarded-for': spoofedIp,
  };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  return headers;
}
