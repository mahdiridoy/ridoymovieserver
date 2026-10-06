/*
 * In-browser player page.
 *
 * Native <video> for mp4/webm; hls.js / dash.js are lazy-loaded from a CDN
 * only when the stream is .m3u8 / .mpd (see utils/hls.js). Browsers cannot
 * attach Referer/Cookie headers to media requests, so sources that require
 * them are offered with copy-URL fallback instead of failing silently.
 */

import { el, safeUrl, mount } from '../utils/sanitize.js';
import { icon, toast, emptyState } from '../utils/helpers.js';
import { pageShell, inlineError, errorBanner, renderView } from '../components/shell.js';
import { formatTime, formatSize, clamp } from '../utils/format.js';
import {
  getSettings, providerLabel, parseProvider,
  historyItemFromDetails, recordHistoryStart, updateHistoryProgress,
  getResumePoint, setResumePoint,
} from '../state.js';
import { detailsFor, streamsFor, getProvider } from '../catalog.js';
import { ProviderError } from '../api.js';
import { attachStream, STREAM_HEADERS_NOTE, isHlsUrl, isDashUrl, canPlayNatively } from '../utils/hls.js';

const SAVE_INTERVAL_MS = 5000;
const WATCHDOG_MS = 20000;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function episodeLabel(season, episode) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function flattenSources(releases) {
  const out = [];
  const seen = new Set();
  for (const rel of releases || []) {
    for (const m of rel.mirrors || []) {
      const url = safeUrl(m.resolver_url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        mirror: m,
        release: rel,
        label: [rel.quality, rel.language, m.label].filter(Boolean).join(' · ') || rel.filename || 'Source',
      });
    }
  }
  return out;
}

function pickStartIndex(sources, video) {
  const wanted = getSettings().player?.preferredQuality || 'auto';
  let pool = sources.map((s, i) => ({ s, i }));
  if (wanted !== 'auto') {
    const filtered = pool.filter(({ s }) => String(s.release.quality || '').includes(wanted)
      || s.label.includes(wanted));
    if (filtered.length) pool = filtered;
  }
  // Prefer sources the browser can decode natively (no CORS requirements);
  // MSE engines need CORS permission the stream hosts often lack.
  const ranked = [...pool].sort((a, b) => Number(canPlayNatively(video, b.s.url)) - Number(canPlayNatively(video, a.s.url)));
  return ranked[0].i;
}

export async function render(ctx, opts = {}) {
  const { provider = '', id = '' } = ctx.params;
  const isMovie = Boolean(opts.movie);
  const season = isMovie ? 0 : Number.parseInt(ctx.params.season ?? '0', 10) || 0;
  const episode = isMovie ? 0 : Number.parseInt(ctx.params.episode ?? '1', 10) || 1;
  const providerName = providerLabel(provider);

  /* ---------------- state ---------------- */

  let disposed = false;
  let details = null;
  let sources = [];
  let activeIndex = -1;
  let engine = null;
  let watchdogTimer = null;
  let idleTimer = null;
  let saveAt = 0;
  let dragging = false;
  let historyRecorded = false;
  let detailError = null;
  let streamError = null;
  let baseItem = null;
  let nextTarget = null;
  let prevTarget = null;

  const settings = getSettings();
  const cleanId = String(id);
  const backPath = `/${isMovie ? 'movie' : 'series'}/${provider}/${encodeURIComponent(cleanId)}`;

  function episodeList() {
    const out = [];
    for (const s of details?.seasons || []) {
      for (const e of s.episodes || []) out.push({ season: s.number, number: e.number, title: e.title });
    }
    return out;
  }

  function computeNeighbours() {
    nextTarget = null;
    prevTarget = null;
    if (isMovie || !details?.seasons?.length) return;
    const list = episodeList();
    const idx = list.findIndex((e) => e.season === season && e.number === episode);
    if (idx < 0) return;
    if (idx + 1 < list.length) nextTarget = list[idx + 1];
    if (idx > 0) prevTarget = list[idx - 1];
  }

  function watchHref(target) {
    if (!target) return null;
    if (isMovie) return `#/watch/${provider}/${encodeURIComponent(cleanId)}`;
    return `#/watch/${provider}/${encodeURIComponent(cleanId)}/${target.season}/${target.number}`;
  }

  /* ---------------- DOM ---------------- */

  const video = el('video', { preload: 'auto', playsinline: '' });
  video.setAttribute('playsinline', '');
  video.controls = false;

  const seekPlayed = el('span', { class: 'played' });
  const seekBuffered = el('span', { class: 'buffered' });
  const seekKnob = el('span', { class: 'knob' });
  const seek = el('div', {
    class: 'seek',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'Seek',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': '0',
  }, seekBuffered, seekPlayed, seekKnob);

  const timeCurrent = el('span', { class: 'time-now', text: '0:00' });
  const timeLeft = el('span', { class: 'time-left', text: '-0:00' });

  const bigPlay = el('button', { class: 'big-play', type: 'button', 'aria-label': 'Play', onclick: () => togglePlay() }, icon('play'));
  const skipBtn = el('button', {
    class: 'skip-btn',
    type: 'button',
    hidden: true,
    text: 'Next episode',
    onclick: () => { if (nextTarget) ctx.navigate(watchHref(nextTarget).slice(1)); },
  });

  const playPauseBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Play', onclick: () => togglePlay() }, icon('play'));
  const muteBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Mute', onclick: () => toggleMute() }, icon('volume'));
  const volumeSlider = el('input', { class: 'volume-slider', type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume' });

  const prevBtn = el('a', { class: 'icon-btn', href: '#/home', 'aria-label': 'Previous episode', hidden: true }, icon('prev'));
  const nextBtn = el('a', { class: 'icon-btn', href: '#/home', 'aria-label': 'Next episode', hidden: true }, icon('next'));

  const speedPop = el('div', { class: 'menu-pop', role: 'menu', hidden: true });
  const speedBtn = el('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Playback speed', 'aria-haspopup': 'true', 'aria-expanded': 'false',
    onclick: () => toggleSpeedMenu(),
  }, icon('refresh'));

  const pipBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Picture in picture', hidden: !document.pictureInPictureEnabled, onclick: () => togglePip() }, icon('pip'));
  const fsBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fullscreen', onclick: () => toggleFullscreen() }, icon('fullscreen'));

  const titleH2 = el('h2', { text: cleanId });
  const subtitleP = el('p', { text: providerName });

  const drawerToggleBtn = el('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Stream sources', 'aria-haspopup': 'true', 'aria-expanded': 'false',
    onclick: () => setDrawer(!drawerOpen()),
  }, icon('grid'));

  const sourcesDrawer = el('aside', { class: 'player-sources', 'aria-label': 'Stream sources', 'aria-hidden': 'true' },
    el('header', {},
      el('h3', { text: 'Sources' }),
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Close sources',
        onclick: () => setDrawer(false),
      }, icon('close'))),
    el('div', { class: 'source-scroll' }),
    el('p', { class: 'empty-note', style: { padding: '0 14px 14px', fontSize: '0.76rem', color: 'rgba(255,255,255,0.55)' }, text: STREAM_HEADERS_NOTE }));

  const errorBox = el('div', { class: 'player-error', hidden: true, role: 'alert' });

  const overlay = el('div', { class: 'player-overlay' },
    el('div', { class: 'player-top' },
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Leave player',
        onclick: () => leave(),
      }, icon('back')),
      el('div', { class: 'player-title-block' }, titleH2, subtitleP),
      el('div', { class: 'player-top-spacer' }),
      drawerToggleBtn,
      fsBtn),
    el('div', { class: 'player-center' }, bigPlay),
    skipBtn,
    el('div', { class: 'player-bottom' },
      el('div', { class: 'seek-row' }, timeCurrent, seek, timeLeft),
      el('div', { class: 'controls-row' },
        playPauseBtn, prevBtn, nextBtn,
        el('div', { class: 'controls-spacer' }),
        el('div', { class: 'volume-group' }, muteBtn, volumeSlider),
        el('div', { class: 'speed-menu' }, speedBtn, speedPop),
        pipBtn, fsBtn)));

  const stage = el('div', { class: 'player-stage' }, video, overlay, sourcesDrawer, errorBox);
  const root = el('div', { class: 'player-page', role: 'dialog', 'aria-label': 'Video player' }, stage);

  /* ---------------- helpers ---------------- */

  function setLoading(on) {
    bigPlay.classList.toggle('is-loading', Boolean(on));
    stage.classList.toggle('is-playing', Boolean(on) || (!video.paused && !video.ended));
    if (on) { bigPlay.hidden = false; }
  }

  function updatePlayUi() {
    const playing = !video.paused && !video.ended;
    const glyph = playing ? 'pause' : 'play';
    mount(playPauseBtn, icon(glyph));
    mount(bigPlay, icon(glyph));
    playPauseBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    bigPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    bigPlay.hidden = playing;
    stage.classList.toggle('is-playing', playing);
    if (playing) armIdle();
  }

  function togglePlay() {
    if (video.paused) video.play().catch((err) => {
      if (err?.name !== 'AbortError') toast({ type: 'warning', title: 'Autoplay blocked', message: 'Press play to start.' });
    });
    else video.pause();
  }

  function toggleMute() {
    video.muted = !video.muted;
    mount(muteBtn, icon(video.muted ? 'mute' : 'volume'));
    muteBtn.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
  }

  function toggleSpeedMenu() {
    const open = speedPop.hasAttribute('hidden');
    if (open) drawSpeedMenu();
    speedPop.toggleAttribute('hidden', !open);
    speedBtn.setAttribute('aria-expanded', String(open));
  }

  function drawSpeedMenu() {
    mount(speedPop);
    speedPop.appendChild(el('h5', { text: 'Speed' }));
    for (const s of SPEEDS) {
      speedPop.appendChild(el('button', {
        class: s === video.playbackRate ? 'active' : '',
        type: 'button',
        role: 'menuitem',
        text: s === 1 ? 'Normal' : `${s}×`,
        onclick: () => {
          video.playbackRate = s;
          speedPop.toggleAttribute('hidden', true);
          speedBtn.setAttribute('aria-expanded', 'false');
          drawSpeedMenu();
        },
      }));
    }
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else stage.requestFullscreen?.().catch(() => {});
  }

  function setDrawer(open) {
    sourcesDrawer.classList.toggle('open', open);
    sourcesDrawer.setAttribute('aria-hidden', String(!open));
    drawerToggleBtn.setAttribute('aria-expanded', String(open));
    if (!open) sourcesDrawer.classList.remove('open');
  }

  function drawerOpen() {
    return sourcesDrawer.classList.contains('open');
  }

  async function togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      toast({ type: 'warning', title: 'Picture-in-picture unavailable' });
    }
  }

  function armIdle() {
    stage.classList.remove('is-idle');
    clearTimeout(idleTimer);
    if (video.paused) return;
    idleTimer = setTimeout(() => stage.classList.add('is-idle'), 2600);
  }

  function updateSeekUi() {
    const dur = video.duration || 0;
    const cur = video.currentTime || 0;
    const pct = dur ? (cur / dur) * 100 : 0;
    seek.style.setProperty('--p', `${pct}%`);
    seek.setAttribute('aria-valuenow', String(Math.round(pct)));
    seek.setAttribute('aria-valuetext', `${formatTime(cur)} of ${formatTime(dur)}`);
    timeCurrent.textContent = formatTime(cur);
    timeLeft.textContent = `-${formatTime(Math.max(0, dur - cur))}`;
    if (video.buffered?.length && dur) {
      const end = video.buffered.end(video.buffered.length - 1);
      seek.style.setProperty('--b', `${Math.min(100, (end / dur) * 100)}%`);
    }
    const showSkip = !isMovie && nextTarget && dur > 0 && cur / dur > 0.8;
    skipBtn.toggleAttribute('hidden', !showSkip);
  }

  /* ---------------- errors ---------------- */

  function showError(message, { title = 'Playback failed', detail = '', canRetry = true } = {}) {
    if (disposed) return;
    mount(errorBox);
    errorBox.removeAttribute('hidden');
    const actions = [];
    if (canRetry) actions.push(el('button', {
      class: 'btn', type: 'button', text: 'Retry',
      onclick: () => { hideError(); selectSource(activeIndex, { force: true }); },
    }));
    if (sources.length > 1) actions.push(el('button', {
      class: 'btn btn-ghost', type: 'button', text: 'Choose another source',
      onclick: () => { hideError(); setDrawer(true); },
    }));
    if (sources[activeIndex]) actions.push(el('button', {
      class: 'btn btn-ghost', type: 'button', text: 'Copy stream URL',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(sources[activeIndex].url);
          toast({ type: 'success', title: 'Copied', message: 'Paste it into an external player.' });
        } catch {
          toast({ type: 'error', title: 'Could not copy', message: sources[activeIndex].url });
        }
      },
    }));
    errorBox.appendChild(icon('error', 'ico ico-xl'));
    errorBox.appendChild(el('h3', { text: title }));
    errorBox.appendChild(el('p', { text: message }));
    errorBox.appendChild(el('div', { class: 'btn-row' }, ...actions));
    if (detail) errorBox.appendChild(el('pre', { text: detail }));
    setLoading(false);
  }

  function hideError() {
    errorBox.setAttribute('hidden', '');
    mount(errorBox);
  }

  /* ---------------- sources ---------------- */

  function drawSources() {
    const scroll = sourcesDrawer.querySelector('.source-scroll');
    if (!scroll) return;
    mount(scroll);
    if (!sources.length) {
      scroll.appendChild(el('p', { class: 'empty-note', text: 'No sources loaded yet.' }));
      return;
    }
    sources.forEach((s, i) => {
      const tags = [];
      if (s.release.quality) tags.push(el('span', { class: 'source-tag good', text: s.release.quality }));
      tags.push(el('span', { class: `source-tag ${s.mirror.direct_file ? 'good' : 'warn'}`, text: s.mirror.direct_file ? 'Direct' : 'Resolver' }));
      if (s.release.size_bytes) tags.push(el('span', { class: 'source-tag', text: formatSize(s.release.size_bytes) }));
      if (s.mirror.headers?.length) tags.push(el('span', { class: 'source-tag warn', text: 'Needs headers' }));
      if (isHlsUrl(s.url)) tags.push(el('span', { class: 'source-tag', text: 'HLS' }));
      if (isDashUrl(s.url)) tags.push(el('span', { class: 'source-tag', text: 'DASH' }));

      let host = '';
      try { host = new URL(s.url).host; } catch { host = ''; }

      scroll.appendChild(el('button', {
        class: `source-card${i === activeIndex ? ' active' : ''}`,
        type: 'button',
        'aria-pressed': String(i === activeIndex),
        onclick: () => selectSource(i),
      },
      el('strong', { text: s.label }),
      el('span', { class: 'source-sub', text: [host, s.release.filename].filter(Boolean).join(' — ') }),
      el('div', { class: 'source-tags' }, ...tags)));
    });
  }

  function armWatchdog() {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      if (disposed || !video.seekable?.length) {
        showError('The stream did not start in time. The server may be unreachable from your network.', {
          title: 'Stream timed out',
          detail: sources[activeIndex]?.url || '',
        });
      }
    }, WATCHDOG_MS);
  }

  function clearWatchdog() {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }

  async function selectSource(index, { force = false, autoplay = true } = {}) {
    if (!sources.length) return false;
    if (index === activeIndex && !force) return true;
    if (index < 0 || index >= sources.length) return false;

    activeIndex = index;
    drawSources();
    hideError();
    setLoading(true);

    if (engine) { try { engine.stop(); } catch { /* already gone */ } engine = null; }
    video.removeAttribute('src');
    clearWatchdog();

    try {
      engine = await attachStream(video, sources[index].url, { signal: ctx.signal });
    } catch (err) {
      if (disposed || ctx.signal.aborted) return false;
      // Media-level CORS failures carry a precise explanation in err.message;
      // the generic userMessage() would wrongly suggest a proxy fix.
      const message = err?.kind === 'cors'
        ? (err.message || err.userMessage?.(providerName))
        : (err?.userMessage?.(providerName) || err?.message || String(err));
      showError(message, {
        title: err?.kind === 'cors' ? 'Blocked by the stream server' : 'Could not open this source',
        detail: sources[index].url,
      });
      return false;
    }
    if (disposed || ctx.signal.aborted) return false;

    armWatchdog();
    drawSubtitles();
    if (autoplay && settings.player?.autoplay) {
      video.play().catch(() => { /* autoplay blocked — big play button is visible */ });
    }
    return true;
  }

  /* ---------------- subtitles ---------------- */

  async function drawSubtitles() {
    const rel = sources[activeIndex]?.release;
    const impl = getProvider(providerNameToKey());
    if (!impl?.capabilities?.subtitles || typeof impl.subtitles !== 'function') return;
    try {
      const options = await impl.subtitles({
        id: cleanId,
        resourceId: rel?.resource_id || undefined,
        season,
        episode,
        signal: ctx.signal,
      });
      if (disposed || ctx.signal.aborted || !options?.length) return;
      video.querySelectorAll('track').forEach((t) => t.remove());
      for (const opt of options) {
        const url = safeUrl(opt.url);
        if (!url) continue;
        const track = el('track', {
          kind: 'subtitles', label: opt.name || 'Subtitles', srclang: 'und', src: url,
        });
        track.addEventListener('error', () => {
          if (!disposed) toast({ type: 'warning', title: 'Subtitle failed to load', message: opt.name || url, timeout: 4000 });
        });
        video.appendChild(track);
      }
    } catch { /* subtitles are best-effort */ }
  }

  function providerNameToKey() {
    return parseProvider(provider) || provider;
  }

  /* ---------------- history / progress ---------------- */

  function ensureBaseItem() {
    if (baseItem) return baseItem;
    if (details) {
      baseItem = historyItemFromDetails(provider, details, season, episode);
    } else {
      baseItem = {
        provider: parseProvider(provider) || provider,
        subject_id: cleanId,
        title: cleanId,
        cover_url: null,
        stype: isMovie ? 1 : 2,
        release_year: '',
        season,
        episode,
        timestamp: Math.floor(Date.now() / 1000),
        duration_seconds: null,
        progress_seconds: 0,
        completed: false,
      };
    }
    return baseItem;
  }

  function recordStart() {
    if (historyRecorded || disposed) return;
    historyRecorded = true;
    const item = ensureBaseItem();
    const resume = getResumePoint(provider, cleanId, season, episode);
    recordHistoryStart(item, resume?.position || 0);
  }

  function saveProgress(force = false) {
    if (disposed) return;
    const dur = video.duration || 0;
    if (!dur || !Number.isFinite(dur)) return;
    const now = Date.now();
    if (!force && now - saveAt < SAVE_INTERVAL_MS) return;
    saveAt = now;
    const completed = video.ended || (video.currentTime / dur) >= 0.95;
    setResumePoint(provider, cleanId, season, episode, Math.round(video.currentTime), Math.round(dur), completed);
    updateHistoryProgress(ensureBaseItem(), video.currentTime, dur, completed);
  }

  function leave() {
    saveProgress(true);
    ctx.navigate(backPath);
  }

  /* ---------------- events ---------------- */

  const listeners = [];
  function on(target, type, handler, extra) {
    target.addEventListener(type, handler, extra);
    listeners.push([target, type, handler, extra]);
  }

  function seekFromPointer(e) {
    const rect = seek.getBoundingClientRect();
    const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    if (video.duration) video.currentTime = frac * video.duration;
    updateSeekUi();
  }

  on(seek, 'pointerdown', (e) => { dragging = true; seek.setPointerCapture?.(e.pointerId); seekFromPointer(e); });
  on(seek, 'pointermove', (e) => { if (dragging) seekFromPointer(e); });
  on(seek, 'pointerup', () => { dragging = false; saveProgress(true); });
  on(seek, 'pointercancel', () => { dragging = false; });
  on(seek, 'keydown', (e) => {
    if (e.key === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 10); e.preventDefault(); }
    if (e.key === 'ArrowRight') { video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); e.preventDefault(); }
    if (e.key === ' ' || e.key === 'Enter') { togglePlay(); e.preventDefault(); }
  });

  on(volumeSlider, 'input', () => { video.volume = Number(volumeSlider.value); video.muted = video.volume === 0; mount(muteBtn, icon(video.muted ? 'mute' : 'volume')); });
  on(video, 'play', updatePlayUi);
  on(video, 'pause', () => { updatePlayUi(); saveProgress(true); });
  on(video, 'loadedmetadata', () => {
    clearWatchdog();
    setLoading(false);
    volumeSlider.value = String(video.muted ? 0 : video.volume);
    updateSeekUi();
    applyResume();
    recordStart();
  });
  on(video, 'canplay', () => { clearWatchdog(); setLoading(false); });
  on(video, 'timeupdate', () => { updateSeekUi(); saveProgress(); });
  on(video, 'progress', updateSeekUi);
  on(video, 'seeked', () => saveProgress(true));
  on(video, 'waiting', () => setLoading(true));
  on(video, 'playing', () => { setLoading(false); updatePlayUi(); });
  on(video, 'ended', onEnded);
  on(video, 'error', () => {
    if (disposed) return;
    const code = video.error?.code;
    const map = {
      1: 'Playback was aborted.',
      2: 'A network error interrupted the download.',
      3: 'The video could not be decoded (corrupt or unsupported format).',
      4: 'This source is not supported or was rejected by the server.',
    };
    showError(map[code] || 'Unknown playback error.', {
      title: 'Playback error',
      detail: sources[activeIndex]?.url || '',
    });
  });
  on(stage, 'pointermove', armIdle);
  on(video, 'click', togglePlay);
  on(video, 'dblclick', toggleFullscreen);

  on(document, 'keydown', onKeyDown);

  function onKeyDown(e) {
    if (disposed) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target === seek) return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); video.currentTime = Math.max(0, video.currentTime - 10); break;
      case 'ArrowRight': e.preventDefault(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 10); break;
      case 'ArrowUp': e.preventDefault(); video.volume = clamp(video.volume + 0.1, 0, 1); volumeSlider.value = String(video.volume); break;
      case 'ArrowDown': e.preventDefault(); video.volume = clamp(video.volume - 0.1, 0, 1); volumeSlider.value = String(video.volume); break;
      case 'm': toggleMute(); break;
      case 'f': toggleFullscreen(); break;
      case 's': setDrawer(!drawerOpen()); break;
      case 'Escape':
        if (drawerOpen()) setDrawer(false);
        else if (!speedPop.hasAttribute('hidden')) { speedPop.setAttribute('hidden', ''); speedBtn.setAttribute('aria-expanded', 'false'); }
        else leave();
        break;
      default: break;
    }
  }

  function applyResume() {
    if (!settings.player?.resumeEnabled) return;
    const resume = getResumePoint(provider, cleanId, season, episode);
    if (!resume) return;
    const pos = resume.position || 0;
    const dur = video.duration || 0;
    if (pos > 5 && dur && pos < dur - 30) video.currentTime = pos;
  }

  function onEnded() {
    saveProgress(true);
    updatePlayUi();
    if (isMovie || !settings.player?.autoplayNext || !nextTarget) {
      bigPlay.hidden = false;
      return;
    }
    toast({ type: 'info', title: 'Next episode', message: nextTarget.title || episodeLabel(nextTarget.season, nextTarget.number), timeout: 3000 });
    ctx.navigate(watchHref(nextTarget).slice(1));
  }

  /* ---------------- initial load ---------------- */

  function drawChrome() {
    const title = details?.title || cleanId;
    titleH2.textContent = title;
    const bits = [providerName];
    if (!isMovie) bits.unshift(episodeLabel(season, episode));
    subtitleP.textContent = bits.join(' · ');
    document.title = `${title}${!isMovie ? ` ${episodeLabel(season, episode)}` : ''} — MovieBox Web`;
    if (details?.poster_url) {
      const poster = safeUrl(details.poster_url);
      if (poster) video.setAttribute('poster', poster);
    }
    prevBtn.toggleAttribute('hidden', !prevTarget);
    nextBtn.toggleAttribute('hidden', !nextTarget);
    prevBtn.setAttribute('href', watchHref(prevTarget) || '#/home');
    nextBtn.setAttribute('href', watchHref(nextTarget) || '#/home');
    drawSources();
  }

  function drawFatalError(err) {
    const wrapped = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message || err));
    root.remove();
    renderView(pageShell({
      title: 'Cannot play this title',
      children: [
        errorBanner([{ provider, label: providerName, error: wrapped }]),
        inlineError(wrapped, {
          title: 'No playable source',
          onRetry: () => ctx.navigate(`/${isMovie ? 'movie' : 'series'}/${provider}/${encodeURIComponent(cleanId)}${isMovie ? '' : `/${season}/${episode}`}`, ctx.query, { replace: true }),
        }),
        el('div', { class: 'btn-row' },
          el('a', { class: 'btn btn-ghost', href: `#${backPath}`, text: 'Back to details' }),
          el('a', { class: 'btn btn-ghost', href: '#/settings', text: 'Settings' })),
      ].filter(Boolean),
    }));
  }

  mount(document.getElementById('view'), emptyState({ icon: 'film', title: 'Loading player…', message: 'Fetching sources.' }));
  document.body.appendChild(root);
  setLoading(true);

  const [detailsRes, streamsRes] = await Promise.allSettled([
    detailsFor(provider, cleanId, { signal: ctx.signal }),
    streamsFor(provider, { id: cleanId, season, episode, signal: ctx.signal }),
  ]);

  if (disposed || ctx.signal.aborted) return () => cleanup();
  if (detailsRes.status === 'fulfilled') details = detailsRes.value;
  else if (detailsRes.reason?.name !== 'AbortError') detailError = detailsRes.reason;

  if (streamsRes.status === 'fulfilled') {
    sources = flattenSources(streamsRes.value);
  } else if (streamsRes.reason?.name !== 'AbortError') {
    streamError = streamsRes.reason;
  }

  if (streamError && !sources.length) {
    drawFatalError(streamError);
    return () => cleanup();
  }

  computeNeighbours();
  drawChrome();
  if (detailError) {
    toast({
      type: 'warning',
      title: 'Details unavailable',
      message: detailError?.userMessage?.() || 'Playing with limited metadata.',
      timeout: 4000,
    });
  }

  if (!sources.length) {
    drawFatalError(streamError || new ProviderError('not_found', 'No playable stream URLs were returned.', { provider: providerName }));
    return () => cleanup();
  }

  await selectSource(pickStartIndex(sources, video));

  /* ---------------- cleanup ---------------- */

  function cleanup() {
    if (disposed) return;
    saveProgress(true);
    disposed = true;
    clearWatchdog();
    clearTimeout(idleTimer);
    for (const [target, type, handler, extra] of listeners) target.removeEventListener(type, handler, extra);
    if (engine) { try { engine.stop(); } catch { /* already gone */ } engine = null; }
    video.pause();
    root.remove();
    mount(document.getElementById('view'));
  }

  return cleanup;
}
