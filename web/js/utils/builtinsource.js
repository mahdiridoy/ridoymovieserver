/*
 * Built-in Live TV guide source.
 *
 * The playlist address is stored XOR-encoded + base64 and assembled only at
 * call time, so it never appears as plaintext in this file, in the DOM, in
 * any UI label, or in query parameters — only the friendly label below is
 * ever shown to users.
 *
 * HONEST LIMITATION (by design, not a defect): a static frontend cannot keep
 * a fetched URL truly secret. The browser must request it, so anyone with
 * DevTools / view-source / the network tab can recover it at runtime. This is
 * best-effort obfuscation against casual extraction only — it is NOT secrecy,
 * and no claim of "unhackable" or "hidden" should ever be made. Channel stream
 * URLs inside the playlist are likewise visible during playback (unavoidable).
 * No backend/proxy is used or invented to hide it.
 */

const PACKED = 'BRsCGRZYQFdAAx0NBQZEDQFUQg4fEUUSF0cNCgIiR0ICFwEBCzARXRYDRwFHWFE=';
const MASK = 'moviebox-built-in-live-guide-v1';

/** Friendly, user-visible label for the built-in source (never the URL). */
export const BUILTIN_LABEL = 'Live TV';

/** Decode the obfuscated playlist location at call time. */
export function builtInPlaylistUrl() {
  let binary = '';
  try {
    binary = atob(PACKED);
  } catch {
    return '';
  }
  const maskLen = MASK.length;
  let out = '';
  for (let i = 0; i < binary.length; i += 1) {
    out += String.fromCharCode(binary.charCodeAt(i) ^ MASK.charCodeAt(i % maskLen));
  }
  return out;
}
