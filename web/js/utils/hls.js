/*
 * Lazy CDN loader for hls.js / dash.js.
 *
 * Browsers cannot play HLS (.m3u8) natively except Safari, and DASH not at
 * all, so the libraries are fetched from jsDelivr only when a stream actually
 * needs them. Everything fails closed: if a library cannot load, the caller
 * shows an error instead of a silent broken <video>.
 */

import { ProviderError } from '../api.js';

const HLS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
const DASH_URL = 'https://cdn.jsdelivr.net/npm/dashjs@4.7.4/dist/dash.all.min.js';
const CDN_TIMEOUT_MS = 15000;

let hlsLoading = null;
let dashLoading = null;

function loadScriptOnce(url, cacheKey) {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (window[cacheKey]) return Promise.resolve(window[cacheKey]);

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-lib="${cacheKey}"]`);
    const script = existing || document.createElement('script');
    const timer = setTimeout(() => {
      reject(new ProviderError('timeout', `Timed out loading ${url}`));
    }, CDN_TIMEOUT_MS);

    script.src = url;
    script.async = true;
    script.dataset.lib = cacheKey;
    script.onload = () => {
      clearTimeout(timer);
      resolve(window[cacheKey] || null);
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new ProviderError('network', `Could not load ${url}`));
    };
    if (!existing) document.head.appendChild(script);
  });
}

export function loadHls() {
  if (!hlsLoading) {
    hlsLoading = loadScriptOnce(HLS_URL, 'Hls').then((Hls) => {
      if (!Hls || !Hls.isSupported()) {
        hlsLoading = null;
        return null;
      }
      return Hls;
    }).catch((err) => { hlsLoading = null; throw err; });
  }
  return hlsLoading;
}

export function loadDash() {
  if (!dashLoading) {
    dashLoading = loadScriptOnce(DASH_URL, 'dashjs').then((dashjs) => dashjs || null)
      .catch((err) => { dashLoading = null; throw err; });
  }
  return dashLoading;
}

export function isHlsUrl(url) {
  return /\.m3u8(\?|#|$)/i.test(String(url || ''));
}

export function isDashUrl(url) {
  return /\.mpd(\?|#|$)/i.test(String(url || ''));
}

/** True when the browser can decode the URL without MSE (no CORS needed). */
export function canPlayNatively(video, url) {
  if (!video) return false;
  if (isDashUrl(url)) return Boolean(video.canPlayType('application/dash+xml'));
  if (isHlsUrl(url)) return Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  return /\.(mp4|webm|ogg|mov|m4v|m4a|mp3|aac|wav)(\?|#|$)/i.test(String(url || ''));
}

/**
 * MSE engines fetch manifests with XHR, which requires CORS headers on the
 * stream host. Native <video> does not. Probe directly (never through the
 * proxy — the engine will not use it either) so we can fail fast and explain
 * the real reason instead of hanging for the watchdog timeout.
 */
async function probeCors(url, { signal } = {}) {
  try {
    const res = await fetch(url, { method: 'GET', mode: 'cors', signal });
    return res;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ProviderError('cors',
      'This stream host sends no cross-origin (CORS) permission headers, so this browser cannot play it. The server would have to allow other origins, or you can copy the URL into an external player (VLC, mpv).');
  }
}

/**
 * Attach a stream to a <video> element.
 * Returns { mode: 'native'|'hls'|'dash', stop() }.
 * Throws ProviderError when the stream cannot be played in a browser.
 */
export async function attachStream(video, url, { signal, headers = {} } = {}) {
  if (!video) throw new ProviderError('bad_request', 'No video element');
  const target = String(url || '');
  if (!target) throw new ProviderError('bad_request', 'Empty stream URL');
  void headers;

  if (isDashUrl(target)) {
    if (!video.canPlayType('application/dash+xml')) {
      await probeCors(target, { signal });
    }
    const dashjs = await loadDash();
    if (!dashjs) throw new ProviderError('network', 'Could not load the DASH playback engine');
    const player = dashjs.MediaPlayer().create();
    player.initialize(video, target, false);
    return {
      mode: 'dash',
      stop() { try { player.destroy(); } catch { /* already gone */ } },
    };
  }

  const wantsHls = isHlsUrl(target);
  const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');

  if (!wantsHls || nativeHls) {
    video.src = target;
    return { mode: 'native', stop() { video.removeAttribute('src'); video.load(); } };
  }

  await probeCors(target, { signal });
  const Hls = await loadHls();
  if (!Hls) throw new ProviderError('network', 'Could not load the HLS playback engine');
  const hls = new Hls({ maxBufferLength: 30, manifestLoadingMaxRetry: 3 });
  hls.loadSource(target);
  hls.attachMedia(video);
  return {
    mode: 'hls',
    stop() { try { hls.destroy(); } catch { /* already gone */ } },
  };
}

export const STREAM_HEADERS_NOTE = 'Browsers cannot attach custom Referer or Cookie headers to media requests; streams that require them may refuse to play.';
