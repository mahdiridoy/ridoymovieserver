/*
 * Port of src/providers/moviebox/title.rs :: clean_moviebox_title
 * Used for identity matching (favorites/history dedup) and display cleanup.
 */

const LANGUAGE_TAGS = [
  'hindi', 'tamil', 'telugu', 'kannada', 'malayalam', 'bengali', 'marathi',
  'punjabi', 'gujarati', 'urdu', 'english', 'spanish', 'french', 'german',
  'italian', 'japanese', 'korean', 'chinese', 'russian', 'portuguese',
  'turkish', 'arabic', 'dub', 'audio', 'multi', 'season',
];

function includesIgnoreCase(haystack, needle) {
  if (!needle) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function lastIndexOfIgnoreCase(haystack, needle) {
  if (!needle) return haystack.length;
  return haystack.toLowerCase().lastIndexOf(needle.toLowerCase());
}

export function cleanMovieboxTitle(rawTitle) {
  let title = String(rawTitle ?? '').trim();
  if (!title) return '';

  while (title.startsWith('[')) {
    const closePos = title.indexOf(']');
    if (closePos === -1) break;
    const remainder = title.slice(closePos + 1).trim();
    if (!remainder) break;
    title = remainder;
  }

  const bracketIdx = title.indexOf('[');
  if (bracketIdx > 0) title = title.slice(0, bracketIdx).trim();

  const parenIdx = title.indexOf('(');
  if (parenIdx > 0) {
    const inside = title.slice(parenIdx + 1);
    const insideContent = (inside.split(')')[0] || '').trim();
    const isYear = insideContent.length === 4
      && /^\d{4}$/.test(insideContent)
      && Number(insideContent) >= 1900
      && Number(insideContent) <= 2099;
    if (!isYear) title = title.slice(0, parenIdx).trim();
  }

  const dashIdx = title.lastIndexOf(' - ');
  if (dashIdx !== -1) {
    const suffix = title.slice(dashIdx + 3);
    const isTag = LANGUAGE_TAGS.some((tag) => includesIgnoreCase(suffix, tag))
      || (/^[sS]/.test(suffix) && /^[0-9-]+$/s.test(suffix.slice(1)));
    if (isTag) title = title.slice(0, dashIdx).trim();
  }

  const sIdx = title.lastIndexOf(' S');
  if (sIdx !== -1) {
    const suffix = title.slice(sIdx + 2);
    const isSeason = /^[0-9-S]+$/.test(suffix) && /^[0-9]/.test(suffix);
    if (isSeason) title = title.slice(0, sIdx).trim();
  }

  const seasonIdx = lastIndexOfIgnoreCase(title, ' season ');
  if (seasonIdx !== -1) title = title.slice(0, seasonIdx).trim();

  for (const sep of ['_', ' ', '.', '-']) {
    const pos = title.lastIndexOf(sep);
    if (pos !== -1) {
      const suffix = title.slice(pos + 1);
      const isRes = /[pP]$/.test(suffix)
        && suffix.length > 1
        && /^\d+$/.test(suffix.slice(0, -1))
        && Number(suffix.slice(0, -1)) >= 144
        && Number(suffix.slice(0, -1)) <= 8640;
      if (isRes) title = title.slice(0, pos).trim();
    }
  }

  const cleaned = title.replace(/[-:_\s]+$/, '').trim();
  return cleaned || String(rawTitle ?? '').trim();
}

export function stripEmojis(input) {
  let out = '';
  for (const ch of String(input ?? '')) {
    const u = ch.codePointAt(0);
    if (
      (u >= 0x1f000 && u <= 0x1faaf)
      || (u >= 0x2600 && u <= 0x27bf)
      || (u >= 0x2300 && u <= 0x23ff)
      || (u >= 0x2b00 && u <= 0x2bff)
      || (u >= 0xfe00 && u <= 0xfe0f)
      || u === 0x200d
    ) continue;
    out += ch;
  }
  return out;
}

export function cleanStreamText(input) {
  const withoutEmojis = stripEmojis(input);
  return withoutEmojis.replace(/\s+/g, ' ').trim();
}

/** 4-digit year extraction — port of extract_4digit_year. */
export function extract4DigitYear(raw) {
  const s = String(raw ?? '');
  const re = /[12]\d{3}/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0].length === 4) return m[0];
  }
  return '';
}

/** Port of parse_size_bytes ("2.25 GB", "450MB", "1.5 GiB" …). */
export function parseSizeBytes(text) {
  const str = String(text ?? '');
  if (!str.trim()) return null;
  const multipliers = {
    T: 1099511627776, TB: 1099511627776, TIB: 1099511627776,
    G: 1073741824, GB: 1073741824, GIB: 1073741824,
    M: 1048576, MB: 1048576, MIB: 1048576,
    K: 1024, KB: 1024, KIB: 1024,
  };
  const parts = str.split(/\s+/);
  for (let i = 0; i < parts.length; i += 1) {
    const clean = parts[i].replace(/[^0-9.]/g, '');
    const num = Number.parseFloat(clean);
    if (Number.isFinite(num) && i + 1 < parts.length) {
      const unit = parts[i + 1].replace(/[^a-zA-Z]/g, '').toUpperCase();
      if (multipliers[unit]) return Math.round(num * multipliers[unit]);
    }
    const upper = parts[i].toUpperCase();
    for (const suffix of ['TIB', 'TB', 'GIB', 'GB', 'MIB', 'MB', 'KIB', 'KB']) {
      if (upper.endsWith(suffix)) {
        const numStr = upper.slice(0, -suffix.length);
        const n = Number.parseFloat(numStr);
        if (Number.isFinite(n)) return Math.round(n * multipliers[suffix]);
      }
    }
  }
  return null;
}
