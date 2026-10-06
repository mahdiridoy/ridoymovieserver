/*
 * M3U/M3U8 playlist parser — port of src/providers/tv/{parser,models}.rs
 *
 * Pure string parsing: no DOM, no eval, no network. Playlist fetching,
 * caching and the 15MB size limit stay with the caller (the Rust
 * M3UParser::fetch_playlist) — this module only turns text into channels.
 *
 * Channel keys: id, name, group, logo, url, tvgId, tvgName, tvgLogo.
 */

const UNGROUPED = 'Ungrouped';
const BOM = '\uFEFF';

function emptyPending() {
  return { name: '', group: '', tvgId: '', tvgName: '', tvgLogo: '' };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value ?? '').trim());
}

function stripWrappingQuotes(value) {
  const raw = String(value ?? '').trim();
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function extractAttr(line, attrName) {
  const nameLength = attrName.length;
  for (let i = 0; i + nameLength + 2 <= line.length; i += 1) {
    if (!line.startsWith(attrName, i)) continue;
    if (line[i + nameLength] !== '=') continue;
    const quote = line[i + nameLength + 1];
    if (quote !== '"' && quote !== "'") continue;
    const start = i + nameLength + 2;
    const end = line.indexOf(quote, start);
    if (end !== -1) return line.slice(start, end);
  }
  return '';
}

function findTitleComma(line) {
  let inQuote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ',') {
      return i;
    }
  }
  return line.indexOf(',');
}

function nameFromUrl(url) {
  let pathname = '';
  let hostname = '';
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname;
    hostname = parsed.hostname;
  } catch {
    pathname = String(url).split(/[?#]/)[0];
  }
  let segment = pathname.split('/').filter(Boolean).pop() || '';
  if (segment) {
    try {
      segment = decodeURIComponent(segment);
    } catch { /* keep the raw segment */ }
  }
  if (segment) return segment;
  return hostname || 'Channel';
}

function stableHash(value) {
  const input = String(value ?? '');
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) + code) >>> 0;
  }
  return `${fnv.toString(16).padStart(8, '0')}${djb.toString(16).padStart(8, '0')}`;
}

export function parseM3U(text) {
  const source = String(text ?? '');
  const channels = [];
  const groups = [];
  const seenGroups = new Set();
  const seenUrls = new Set();
  let skipped = 0;
  let pending = emptyPending();
  let extGrp = '';

  for (const rawLine of source.split(/\r?\n/)) {
    let line = rawLine.trim();
    while (line.startsWith(BOM)) line = line.slice(1);
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const tvgId = extractAttr(line, 'tvg-id');
      const tvgName = extractAttr(line, 'tvg-name');
      const tvgLogo = extractAttr(line, 'tvg-logo');
      const groupTitle = extractAttr(line, 'group-title');
      if (tvgId) pending.tvgId = tvgId;
      if (tvgName) pending.tvgName = tvgName;
      if (tvgLogo) pending.tvgLogo = tvgLogo;
      if (groupTitle) pending.group = groupTitle;

      const commaIndex = findTitleComma(line);
      if (commaIndex !== -1) {
        const title = line.slice(commaIndex + 1).trim();
        if (title) pending.name = title;
      }
      continue;
    }

    if (line.startsWith('#EXTGRP:')) {
      extGrp = stripWrappingQuotes(line.slice('#EXTGRP:'.length));
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = line;
    const current = pending;
    pending = emptyPending();

    if (!isHttpUrl(url)) {
      skipped += 1;
      continue;
    }
    if (seenUrls.has(url)) {
      skipped += 1;
      continue;
    }
    seenUrls.add(url);

    const name = current.name || nameFromUrl(url);
    const group = current.group || extGrp || UNGROUPED;
    const channel = {
      id: current.tvgId || stableHash(url),
      name,
      group,
      logo: current.tvgLogo || '',
      url,
      tvgId: current.tvgId || '',
      tvgName: current.tvgName || '',
      tvgLogo: current.tvgLogo || '',
    };
    channels.push(channel);
    if (!seenGroups.has(group)) {
      seenGroups.add(group);
      groups.push(group);
    }
  }

  return { channels, skipped, groups };
}

export function groupChannels(channels) {
  const map = new Map();
  for (const channel of channels || []) {
    const key = channel?.group || UNGROUPED;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(channel);
  }
  return map;
}

export function searchChannels(channels, query) {
  const list = Array.isArray(channels) ? channels : [];
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [...list];
  return list.filter((channel) => String(channel?.name ?? '').toLowerCase().includes(needle)
    || String(channel?.group ?? '').toLowerCase().includes(needle));
}
