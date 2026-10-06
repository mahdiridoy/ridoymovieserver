import { el, mount, img, safeUrl } from '../utils/sanitize.js';
import {
  icon, toast, emptyState, badge, openModal, confirmModal, primaryAction, ghostAction, setActiveNav, spinner,
} from '../utils/helpers.js';
import { renderView, pageShell, section, inlineError } from '../components/shell.js';
import { relativeTime } from '../utils/format.js';
import { debounce } from '../utils/debounce.js';
import {
  getSettings, updateSettings, listPlaylists, addPlaylist, removePlaylist, store,
} from '../state.js';
import { getText, normalizeBaseUrl, proxyConfigured, ProviderError } from '../api.js';
import { parseM3U, groupChannels, searchChannels } from '../providers/tv/m3u.js';
import { isHlsUrl, attachStream, STREAM_HEADERS_NOTE } from '../utils/hls.js';
import { BUILTIN_LABEL, builtInPlaylistUrl } from '../utils/builtinsource.js';

/* Rows rendered per batch — a 6,000+ channel guide must never mount at once. */
const ROW_CHUNK = 60;

/* Give a stream this long to start before reporting an honest timeout. */
const TUNE_TIMEOUT_MS = 20000;

const PROXY_HINT = 'The playlist host may be blocking browser requests (CORS). A relay under Settings → Data & network usually fixes this.';

const MIXED_CONTENT_MESSAGE = 'This channel streams over plain http://, which browsers block on https pages (mixed content). It cannot be played here — copy the stream URL into an external player (VLC, mpv), or choose an https channel.';

export async function render(ctx, opts = {}) {
  ctx.setTitle('Live TV');
  setActiveNav('tv');

  let disposed = false;
  let channels = [];
  let skipped = 0;
  let userChannels = [];
  let userSkipped = 0;
  let userLabel = '';
  let builtinChannels = [];
  let builtinSkipped = 0;
  let builtinState = 'idle'; // idle | loading | ready | error
  let builtinError = null;
  let groupFilter = '';
  let query = '';
  let current = null;
  let streamCtl = null;
  let attachToken = 0;
  let activePlaylistId = null;
  let loadError = null;
  let loadingId = null;

  /* Windowed guide list state */
  let foundRows = [];
  let renderedRows = 0;
  let moreObserver = null;
  let appendScheduled = false;

  const offs = [];

  const nodes = {};
  let nameInput = null;
  let urlInput = null;
  let addForm = null;
  let searchBar = null;
  let runSearch = null;

  function hostOf(url) {
    try {
      const safe = safeUrl(url);
      if (!safe) return 'Invalid URL';
      return new URL(safe).host || safe;
    } catch {
      return 'Invalid URL';
    }
  }

  function logoNode(channel) {
    const fallback = () => el('div', {
      class: 'channel-logo-fallback',
      'aria-hidden': 'true',
      text: (String(channel.name || '?').trim()[0] || '?').toUpperCase(),
    });
    const url = safeUrl(channel.logo);
    if (!url) return fallback();
    const image = img(url, `${channel.name} logo`, { class: 'channel-logo' });
    image.addEventListener('img-error', () => {
      if (image.isConnected) image.replaceWith(fallback());
    });
    return image;
  }

  function stopStream() {
    attachToken += 1;
    if (streamCtl) {
      try { streamCtl.stop(); } catch { /* already gone */ }
      streamCtl = null;
    }
  }

  async function copyStreamUrl(url) {
    if (!url || disposed) return;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) {
        throw new Error('Clipboard access is unavailable in this browser context.');
      }
      await navigator.clipboard.writeText(url);
      if (disposed) return;
      toast({ type: 'success', title: 'Copied', message: 'Stream URL copied to the clipboard.', timeout: 1800 });
    } catch (err) {
      if (disposed) return;
      toast({ type: 'error', title: 'Copy failed', message: String(err?.message || err) });
    }
  }

  function isMixedContentBlocked(url) {
    if (location.protocol !== 'https:') return false;
    try {
      return new URL(String(url || ''), location.href).protocol === 'http:';
    } catch {
      return false;
    }
  }

  function showPlayerError(err, noteArea, channel, title = 'Stream could not be played') {
    const message = err?.userMessage?.() || err?.message || String(err);
    const url = channel?.url || '';
    if (!noteArea || disposed) return;
    mount(noteArea,
      inlineError({ message }, { title, onRetry: () => { paintPlayer(); } }),
      el('div', { class: 'btn-row', style: { marginTop: '8px' } },
        ghostAction('Copy stream URL', 'external', () => { copyStreamUrl(url); })),
      el('p', { class: 'muted small', text: STREAM_HEADERS_NOTE }));
    toast({ type: 'error', title: 'Playback failed', message });
  }

  function channelSubtitle(channel) {
    const grp = String(channel.group || '');
    if (grp && grp !== 'Ungrouped') return grp;
    if (userChannels.includes(channel)) return userLabel || 'Imported playlist';
    if (builtinChannels.includes(channel)) return `${BUILTIN_LABEL} (built-in)`;
    return '';
  }

  function paintPlayer() {
    const area = nodes.player;
    if (!area) return;

    if (!current) {
      mount(area, el('div', { class: 'tv-frame tv-standby' },
        el('div', { class: 'tv-standby-inner', role: 'status' },
          icon('tv', 'ico ico-xl'),
          el('p', { text: 'Select a channel from the guide to start watching.' }),
          el('p', { class: 'muted small', text: 'Streams play right here — your playlists stay in this browser.' }))));
      return;
    }

    const token = ++attachToken;
    let tuneTimer = null;
    const video = el('video', {
      playsinline: '',
      autoplay: true,
      class: 'tv-video',
      'aria-label': `${current.name} live stream`,
    });
    const noteArea = el('div');
    const meta = el('p', {
      class: 'muted small',
      text: isHlsUrl(current.url)
        ? 'HLS stream — played natively where the browser supports it, otherwise through hls.js.'
        : 'Direct media URL played natively by the browser.',
    });
    const loadingOverlay = el('div', {
      class: 'tv-overlay tv-loading',
      role: 'status',
      'aria-live': 'polite',
    }, spinner('Tuning in…'));

    const playBtn = el('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': 'Pause',
      onclick: () => { togglePlay(); },
    }, icon('pause'));

    const syncPlayBtn = () => {
      if (disposed || token !== attachToken) return;
      const playing = !video.paused && !video.ended;
      mount(playBtn, icon(playing ? 'pause' : 'play'));
      playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    };

    const togglePlay = () => {
      if (disposed || token !== attachToken) return;
      if (video.paused) {
        let attempt = null;
        try { attempt = video.play(); } catch { /* ignore */ }
        if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
      } else {
        video.pause();
      }
    };

    const muteBtn = el('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': 'Mute',
      onclick: () => {
        video.muted = !video.muted;
        syncVolume();
      },
    }, icon('volume'));

    const volume = el('input', {
      class: 'tv-vol',
      type: 'range',
      min: '0',
      max: '1',
      step: '0.02',
      value: '1',
      'aria-label': 'Volume',
      oninput: (e) => {
        const v = Number(e.target.value);
        video.volume = Number.isFinite(v) ? v : 1;
        video.muted = video.volume === 0;
        syncVolume();
      },
    });

    const syncVolume = () => {
      if (disposed || token !== attachToken) return;
      const v = video.muted ? 0 : video.volume;
      if (document.activeElement !== volume) volume.value = String(v);
      mount(muteBtn, icon(v <= 0 ? 'mute' : 'volume'));
      muteBtn.setAttribute('aria-label', v <= 0 ? 'Unmute' : 'Mute');
    };

    const fsBtn = el('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': 'Enter fullscreen',
      onclick: () => {
        const frame = area.querySelector('.tv-frame');
        if (!frame) return;
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else if (frame.requestFullscreen) {
          frame.requestFullscreen().catch(() => {});
        }
      },
    }, icon('fullscreen'));

    const syncFullscreen = () => {
      if (disposed || token !== attachToken) return;
      const active = Boolean(document.fullscreenElement);
      mount(fsBtn, icon(active ? 'minimize' : 'fullscreen'));
      fsBtn.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
    };

    const num = String(current.tvgChno || '').trim();
    const chanbar = el('div', { class: 'tv-chanbar' },
      num ? el('span', { class: 'tv-chno tv-chno-live', 'aria-hidden': 'true', text: num }) : null,
      el('div', { class: 'tv-chanbar-text' },
        el('strong', { class: 'tv-chanbar-name', text: current.name }),
        el('span', { class: 'tv-chanbar-sub', text: channelSubtitle(current) })),
      badge('LIVE', 'badge-live'),
      el('span', { class: 'tv-spacer' }),
      el('button', {
        class: 'icon-btn tv-stop',
        type: 'button',
        'aria-label': 'Stop playback',
        onclick: () => {
          stopStream();
          current = null;
          paintPlayer();
          updateRowStates();
        },
      }, icon('close')));

    const controls = el('div', { class: 'tv-controls', role: 'group', 'aria-label': 'Player controls' },
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Previous channel',
        onclick: () => { stepChannel(-1); },
      }, icon('prev')),
      playBtn,
      el('button', {
        class: 'icon-btn',
        type: 'button',
        'aria-label': 'Next channel',
        onclick: () => { stepChannel(1); },
      }, icon('next')),
      el('span', { class: 'tv-spacer' }),
      muteBtn,
      volume,
      fsBtn);

    const screen = el('div', { class: 'tv-screen' }, chanbar, video, loadingOverlay);
    const frame = el('div', { class: 'tv-frame' }, screen, controls);

    mount(area, frame, el('div', { class: 'tv-undernote' }, meta, noteArea));

    video.addEventListener('play', syncPlayBtn);
    video.addEventListener('pause', syncPlayBtn);
    video.addEventListener('volumechange', syncVolume);
    video.addEventListener('playing', () => {
      if (disposed || token !== attachToken) return;
      loadingOverlay.hidden = true;
      if (tuneTimer) { clearTimeout(tuneTimer); tuneTimer = null; }
    });
    video.addEventListener('error', () => {
      if (disposed || token !== attachToken) return;
      loadingOverlay.hidden = true;
      if (tuneTimer) { clearTimeout(tuneTimer); tuneTimer = null; }
      showPlayerError({ message: video.error?.message || 'The browser could not play this stream.' }, noteArea, current);
    });
    video.addEventListener('click', () => { togglePlay(); });
    document.addEventListener('fullscreenchange', syncFullscreen);

    syncPlayBtn();
    syncVolume();
    syncFullscreen();

    if (isMixedContentBlocked(current.url)) {
      loadingOverlay.hidden = true;
      showPlayerError(
        { userMessage: () => MIXED_CONTENT_MESSAGE },
        noteArea,
        current,
        'Channel blocked as mixed content',
      );
      return;
    }

    tuneTimer = setTimeout(() => {
      if (disposed || token !== attachToken) return;
      if (!video.paused && video.readyState >= 3) return;
      loadingOverlay.hidden = true;
      showPlayerError(
        { userMessage: () => 'The stream did not start within 20 seconds — the channel may be offline or unreachable from this network.' },
        noteArea,
        current,
        'Channel did not start',
      );
    }, TUNE_TIMEOUT_MS);

    attachStream(video, current.url, { signal: ctx.signal }).then((ctl) => {
      if (disposed || token !== attachToken || ctx.signal?.aborted) {
        try { ctl.stop(); } catch { /* already gone */ }
        return;
      }
      streamCtl = ctl;
      let attempt = null;
      try { attempt = video.play(); } catch { /* ignore */ }
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(() => {
          if (disposed || token !== attachToken) return;
          loadingOverlay.hidden = true;
          mount(noteArea, el('p', {
            class: 'muted small',
            text: 'Autoplay was blocked by the browser — press Play in the player to start the stream.',
          }));
        });
      }
    }).catch((err) => {
      if (disposed || token !== attachToken || ctx.signal?.aborted) return;
      loadingOverlay.hidden = true;
      if (tuneTimer) { clearTimeout(tuneTimer); tuneTimer = null; }
      showPlayerError(err, noteArea, current);
    });
  }

  function play(channel) {
    stopStream();
    current = channel;
    paintPlayer();
    updateRowStates();
    if (nodes.stage && typeof nodes.stage.scrollIntoView === 'function') {
      try { nodes.stage.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
    }
  }

  function stepChannel(dir) {
    if (!channels.length) return;
    const idx = current ? channels.findIndex((c) => c.url === current.url) : -1;
    const base = idx === -1 ? (dir > 0 ? -1 : 0) : idx;
    const next = channels[(base + dir + channels.length) % channels.length];
    if (next) play(next);
  }

  function onKeydown(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!current) return;
    e.preventDefault();
    stepChannel(e.key === 'ArrowDown' ? 1 : -1);
  }

  function setGroup(value) {
    groupFilter = String(value || '');
    const tv = getSettings().tv || {};
    if (tv.rememberGroup) {
      updateSettings({ tv: { ...tv, lastGroup: groupFilter } });
    }
    paintChips();
    paintList();
  }

  function paintChips() {
    const area = nodes.chips;
    if (!area) return;
    const map = groupChannels(channels);
    const groups = [...map.keys()];
    if (groupFilter && !map.has(groupFilter)) groupFilter = '';

    const chip = (label, value, count) => el('button', {
      class: `seg-btn${groupFilter === value ? ' active' : ''}`,
      type: 'button',
      'aria-pressed': String(groupFilter === value),
      'aria-label': value ? `${label} group, ${count} channels` : `All channels, ${count} channels`,
      onclick: () => setGroup(value),
    }, el('span', { text: value ? `${label} (${count})` : `All channels (${count})` }));

    mount(area,
      chip('All', '', channels.length),
      ...groups.map((group) => chip(group, group, map.get(group).length)));
  }

  function channelRow(channel) {
    const playing = Boolean(current && current.url === channel.url);
    const num = String(channel.tvgChno || '').trim();
    const grp = String(channel.group || '');
    const showGroup = Boolean(grp && grp !== 'Ungrouped');
    const row = el('button', {
      class: `channel channel-row${playing ? ' is-current' : ''}`,
      type: 'button',
      'aria-label': `Play ${channel.name}${num ? `, channel ${num}` : ''}`,
      onclick: () => { play(channel); },
    },
    num ? el('span', { class: 'tv-chno', 'aria-hidden': 'true', text: num }) : null,
    logoNode(channel),
    el('div', { class: 'tv-row-text' },
      el('div', { class: 'channel-name', text: channel.name }),
      showGroup ? el('div', { class: 'channel-group', text: grp }) : null),
    playing ? badge('LIVE', 'badge-live') : null);
    if (playing) row.setAttribute('aria-current', 'true');
    return row;
  }

  function updateRowStates() {
    const area = nodes.list;
    if (!area) return;
    const rows = area.querySelectorAll('.channel-row');
    rows.forEach((row, i) => {
      const ch = foundRows[i];
      const playing = Boolean(current && ch && current.url === ch.url);
      row.classList.toggle('is-current', playing);
      if (playing) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
      const liveBadge = row.querySelector('.badge-live');
      if (playing && !liveBadge) row.appendChild(badge('LIVE', 'badge-live'));
      if (!playing && liveBadge) liveBadge.remove();
    });
  }

  function updateCount() {
    const count = nodes.count;
    if (!count) return;
    if (!channels.length) {
      count.textContent = '';
      return;
    }
    const parts = [`${foundRows.length} of ${channels.length} channels`];
    if (groupFilter) parts.push(`group "${groupFilter}"`);
    if (query) parts.push(`matching "${query}"`);
    if (builtinChannels.length) parts.push(`${BUILTIN_LABEL} built-in`);
    if (userChannels.length) {
      parts.push(`${userChannels.length} ${userLabel ? `from ${userLabel}` : 'imported'}`);
    }
    if (skipped) parts.push(`${skipped} playlist entries skipped`);
    if (foundRows.length > renderedRows) parts.push(`showing first ${renderedRows}`);
    count.textContent = `${parts.join(' · ')}.`;
  }

  function paintMore() {
    const remaining = foundRows.length - renderedRows;
    const show = remaining > 0;
    nodes.moreWrap.hidden = !show;
    if (show) {
      mount(nodes.moreBtn, icon('grid'), el('span', { text: `Show more channels (${remaining} remaining)` }));
    }
  }

  function moreVisible() {
    const btn = nodes.moreBtn;
    if (!btn || nodes.moreWrap.hidden) return false;
    const rect = btn.getBoundingClientRect();
    if (!rect.height) return false;
    /* Only continue while the sentinel is on/near screen — never when the
       guide has scrolled fully past the viewport (would chain forever). */
    return rect.bottom > 0 && rect.top < window.innerHeight + 400;
  }

  function appendRows() {
    const area = nodes.list;
    if (!area || disposed || !foundRows.length) return;
    if (renderedRows >= foundRows.length) {
      paintMore();
      return;
    }
    const next = foundRows.slice(renderedRows, renderedRows + ROW_CHUNK);
    for (const channel of next) {
      /* Keep the sentinel as the last child of the scroller so it is only
         reached (and observed) when the user scrolls near the list end. */
      const node = channelRow(channel);
      if (nodes.moreWrap.parentNode === area) area.insertBefore(node, nodes.moreWrap);
      else area.appendChild(node);
    }
    renderedRows += next.length;
    paintMore();
    updateCount();
    if (renderedRows < foundRows.length && moreVisible() && !appendScheduled) {
      appendScheduled = true;
      requestAnimationFrame(() => {
        appendScheduled = false;
        if (!disposed) appendRows();
      });
    }
  }

  function ensureMoreObserver() {
    if (moreObserver || typeof IntersectionObserver === 'undefined') return;
    moreObserver = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) appendRows();
    }, { rootMargin: '400px 0px' });
    moreObserver.observe(nodes.moreBtn);
  }

  function paintList() {
    const area = nodes.list;
    if (!area) return;

    if (!channels.length) {
      foundRows = [];
      renderedRows = 0;
      updateCount();
      nodes.moreWrap.hidden = true;
      mount(area, (builtinState === 'loading' || builtinState === 'idle')
        ? spinner('Loading live channels…')
        : emptyState({
          icon: 'tv',
          title: 'No live channels yet',
          message: 'Add an M3U playlist URL or paste playlist text to watch live TV.',
          action: primaryAction('Add playlist', 'plus', () => {
            if (nameInput) nameInput.focus();
            if (addForm) addForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }),
        }));
      return;
    }

    const map = groupChannels(channels);
    const base = groupFilter && map.has(groupFilter) ? map.get(groupFilter) : channels;
    foundRows = searchChannels(base, query);
    renderedRows = 0;

    if (!foundRows.length) {
      updateCount();
      nodes.moreWrap.hidden = true;
      mount(area, emptyState({
        icon: 'search',
        title: 'No matching channels',
        message: query ? `Nothing matches "${query}" in this selection.` : 'This group has no channels.',
      }));
      return;
    }

    mount(area);
    appendRows();
    area.appendChild(nodes.moreWrap);
    ensureMoreObserver();
  }

  function paintError() {
    const area = nodes.error;
    if (!area) return;
    if (!loadError) {
      mount(area);
      return;
    }
    mount(area,
      inlineError(loadError.error, { title: 'Could not load playlist', onRetry: loadError.retry }),
      loadError.needsProxyHint
        ? el('div', { class: 'callout', role: 'status' },
          icon('cloudoff', 'ico'),
          el('div', {},
            el('strong', { text: 'This playlist host may be refusing browser requests' }),
            el('p', { text: PROXY_HINT }),
            ghostAction('Open Settings', 'settings', () => { ctx.navigate('/settings'); })))
        : null);
  }

  function paintBuiltinNote() {
    const area = nodes.builtinNote;
    if (!area) return;
    if (builtinState === 'error') {
      mount(area,
        inlineError(builtinError, {
          title: 'Could not load the built-in guide',
          onRetry: () => { loadBuiltin({ manual: true }); },
        }),
        el('p', { class: 'muted small', text: 'The built-in guide is optional — your own playlists below still work.' }));
      return;
    }
    if (builtinState === 'loading' || builtinState === 'idle') {
      mount(area, el('div', { class: 'callout', role: 'status' },
        icon('refresh', 'ico'),
        el('div', {},
          el('strong', { text: 'Loading the built-in guide…' }),
          el('p', { text: 'Fetching and indexing channels — usually just a couple of seconds.' }))));
      return;
    }
    mount(area);
  }

  function builtinRow() {
    const statusText = builtinState === 'ready'
      ? `Auto-loaded on this page · ${builtinChannels.length} channels`
      : builtinState === 'error'
        ? 'Auto-loaded on this page — unavailable right now'
        : 'Auto-loaded on this page — loading…';
    return el('div', { class: 'playlist-item playlist-builtin' },
      el('div', {},
        el('div', { class: 'btn-row', style: { gap: '8px', alignItems: 'center' } },
          el('strong', { text: BUILTIN_LABEL }),
          badge('Built-in', 'badge-accent'),
          builtinState === 'ready' ? badge('Loaded', 'badge-accent') : null),
        el('div', { class: 'muted small', text: statusText })),
      builtinState === 'error'
        ? el('div', { class: 'btn-row' }, ghostAction('Retry', 'refresh', () => { loadBuiltin({ manual: true }); }))
        : null);
  }

  function playlistRow(playlist) {
    const busy = loadingId === playlist.id;
    const loadBtn = primaryAction(busy ? 'Loading…' : 'Load', 'play', () => { loadPlaylist(playlist); });
    loadBtn.disabled = busy;
    loadBtn.setAttribute('aria-busy', String(busy));
    const removeBtn = ghostAction('Remove', 'trash', () => { removePlaylistFlow(playlist); });

    return el('div', { class: 'playlist-item' },
      el('div', {},
        el('div', { class: 'btn-row', style: { gap: '8px', alignItems: 'center' } },
          el('strong', { text: playlist.name }),
          activePlaylistId === playlist.id ? badge('Loaded', 'badge-accent') : null),
        el('div', { class: 'url', text: hostOf(playlist.url) }),
        el('div', { class: 'url', text: `Added ${relativeTime(playlist.addedAt)}` })),
      el('div', { class: 'btn-row' }, loadBtn, removeBtn));
  }

  function paintPlaylists() {
    const area = nodes.playlists;
    if (!area) return;
    const list = listPlaylists();
    if (!list.length) {
      mount(area, builtinRow(), el('p', {
        class: 'muted small',
        text: 'No saved playlists yet — add one below, or paste M3U text directly.',
      }));
      return;
    }
    mount(area, builtinRow(), ...list.map(playlistRow));
  }

  function recomputeChannels() {
    channels = [...builtinChannels, ...userChannels];
    skipped = builtinSkipped + userSkipped;
  }

  function channelsChanged() {
    recomputeChannels();
    const map = groupChannels(channels);
    if (groupFilter && !map.has(groupFilter)) groupFilter = '';
    if (!groupFilter) {
      const tv = getSettings().tv || {};
      const remembered = tv.rememberGroup ? String(tv.lastGroup || '') : '';
      if (remembered && map.has(remembered)) groupFilter = remembered;
    }
    const droppedCurrent = Boolean(current && !channels.some((ch) => ch.url === current.url));
    if (droppedCurrent) {
      stopStream();
      current = null;
      paintPlayer();
    }
    paintError();
    paintBuiltinNote();
    paintChips();
    paintList();
    paintPlaylists();
  }

  function applyParsed(parsed, { id = null, label = '' } = {}) {
    userChannels = Array.isArray(parsed?.channels) ? parsed.channels : [];
    userSkipped = Number(parsed?.skipped || 0);
    activePlaylistId = id;
    userLabel = label;
    loadError = null;
    channelsChanged();
  }

  async function loadBuiltin({ manual = false } = {}) {
    if (builtinState === 'loading' || disposed) return;
    builtinState = 'loading';
    builtinError = null;
    paintBuiltinNote();
    paintPlaylists();
    paintList();
    try {
      const url = builtInPlaylistUrl();
      if (!url) throw new ProviderError('bad_request', 'The built-in guide location is unavailable.');
      const text = await getText({ url, signal: ctx.signal, provider: 'tv' });
      if (ctx.signal?.aborted || disposed) return;
      /* Yield once so the browser can paint before the single-pass parse. */
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      if (ctx.signal?.aborted || disposed) return;
      const parsed = parseM3U(text);
      if (disposed) return;
      builtinChannels = Array.isArray(parsed?.channels) ? parsed.channels : [];
      builtinSkipped = Number(parsed?.skipped || 0);
      builtinState = 'ready';
      channelsChanged();
      if (!builtinChannels.length) {
        toast({ type: 'warning', title: 'Built-in guide is empty', message: 'The source returned no playable channels.', timeout: 3200 });
      } else if (manual) {
        toast({ type: 'success', title: 'Guide updated', message: `${builtinChannels.length} built-in channels loaded.`, timeout: 2400 });
      }
    } catch (err) {
      if (ctx.signal?.aborted || disposed) return;
      if (err?.kind === 'aborted') return;
      builtinState = 'error';
      builtinError = err;
      paintBuiltinNote();
      paintPlaylists();
      paintList();
      if (manual) {
        toast({ type: 'error', title: 'Could not load built-in guide', message: err?.userMessage?.() || err?.message || String(err) });
      }
    }
  }

  async function loadPlaylist(playlist) {
    if (loadingId || disposed) return;
    loadingId = playlist.id;
    loadError = null;
    paintPlaylists();
    paintError();
    try {
      const text = await getText({ url: playlist.url, signal: ctx.signal, provider: 'tv' });
      if (ctx.signal?.aborted || disposed) return;
      applyParsed(parseM3U(text), { id: playlist.id, label: playlist.name });
      if (userChannels.length) {
        toast({
          type: 'success',
          title: 'Playlist loaded',
          message: `${userChannels.length} channels from ${playlist.name}${userSkipped ? ` · ${userSkipped} skipped` : ''}.`,
          timeout: 2600,
        });
      } else {
        toast({
          type: 'warning',
          title: 'Playlist is empty',
          message: `${playlist.name} produced no playable channels${userSkipped ? ` (${userSkipped} entries skipped)` : ''}.`,
          timeout: 3000,
        });
      }
    } catch (err) {
      if (ctx.signal?.aborted || disposed) return;
      const message = err?.userMessage?.() || err?.message || String(err);
      const kind = String(err?.kind || '');
      const needsProxyHint = ['cors', 'proxy_required', 'proxy_failed', 'network'].includes(kind)
        || (!proxyConfigured() && !kind);
      loadError = { error: err, message, needsProxyHint, retry: () => { loadPlaylist(playlist); } };
      paintError();
      toast({ type: 'error', title: 'Could not load playlist', message });
    } finally {
      loadingId = null;
      if (!disposed) paintPlaylists();
    }
  }

  async function removePlaylistFlow(playlist) {
    const ok = await confirmModal({
      title: 'Remove playlist?',
      message: `"${playlist.name}" will be deleted from this browser. Channels already loaded stay on screen.`,
      confirmLabel: 'Remove playlist',
      danger: true,
    });
    if (!ok || disposed) return;
    removePlaylist(playlist.id);
    if (activePlaylistId === playlist.id) activePlaylistId = null;
    paintPlaylists();
    toast({ type: 'success', title: 'Playlist removed', message: `${playlist.name} deleted.`, timeout: 1800 });
  }

  function addPlaylistFlow(note) {
    const name = String(nameInput?.value || '').trim();
    const url = String(urlInput?.value || '').trim();
    let parsed = null;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || !normalizeBaseUrl(url)) {
      if (note) note.textContent = 'Enter a valid http:// or https:// playlist URL.';
      if (urlInput) urlInput.focus();
      return;
    }
    const item = addPlaylist({ name: name || hostOf(url), url });
    if (nameInput) nameInput.value = '';
    if (urlInput) urlInput.value = '';
    if (note) note.textContent = '';
    paintPlaylists();
    toast({
      type: 'success',
      title: 'Playlist added',
      message: `${item.name} saved — press Load to fetch its channels.`,
      timeout: 2600,
    });
  }

  function buildAddForm() {
    nameInput = el('input', {
      id: 'tv-pl-name',
      class: 'input',
      type: 'text',
      placeholder: 'My playlist',
      autocomplete: 'off',
    });
    urlInput = el('input', {
      id: 'tv-pl-url',
      class: 'input',
      type: 'url',
      placeholder: 'https://example.com/playlist.m3u',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const note = el('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });

    addForm = el('form', {
      class: 'panel',
      'aria-label': 'Add playlist',
      onsubmit: (e) => {
        e.preventDefault();
        addPlaylistFlow(note);
      },
    },
    el('h3', { text: 'Add playlist' }),
    el('div', { class: 'field' },
      el('label', { for: 'tv-pl-name', text: 'Playlist name' }),
      nameInput,
      el('span', { class: 'hint', text: 'Optional — defaults to the host name.' })),
    el('div', { class: 'field' },
      el('label', { for: 'tv-pl-url', text: 'Playlist URL' }),
      urlInput,
      el('span', {
        class: 'hint',
        text: 'An M3U / M3U8 address, fetched with your proxy settings from Settings → Data & network when the host blocks the browser.',
      }),
      note),
    el('div', { class: 'btn-row' },
      primaryAction('Add playlist', 'plus', () => { addPlaylistFlow(note); }),
      ghostAction('Paste M3U instead', 'plus', () => { openPasteModal(); })));

    return addForm;
  }

  function openPasteModal() {
    const textarea = el('textarea', {
      id: 'tv-paste-text',
      class: 'textarea',
      rows: '12',
      'aria-label': 'M3U playlist text',
      placeholder: '#EXTM3U\n#EXTINF:-1 group-title="News",Channel name\nhttps://host/stream.m3u8',
    });
    const body = el('div', { class: 'field' },
      el('label', { for: 'tv-paste-text', text: 'Playlist text' }),
      textarea,
      el('span', { class: 'hint', text: 'Parsed in your browser — the text is never uploaded.' }));

    const close = openModal({
      title: 'Paste M3U playlist',
      body,
      wide: true,
      actions: [
        ghostAction('Cancel', 'close', () => { close(); }),
        primaryAction('Load channels', 'check', () => {
          const parsed = parseM3U(textarea.value);
          if (!parsed.channels.length) {
            toast({
              type: 'error',
              title: 'No channels found',
              message: parsed.skipped
                ? `${parsed.skipped} entries were skipped (duplicate or non-http URLs).`
                : 'This does not look like an M3U playlist.',
            });
            return;
          }
          applyParsed(parsed, { id: null, label: 'Pasted playlist' });
          close();
          toast({
            type: 'success',
            title: 'Playlist loaded',
            message: `${parsed.channels.length} channels pasted${parsed.skipped ? ` · ${parsed.skipped} skipped` : ''}.`,
            timeout: 2600,
          });
        }),
      ],
    });
    return close;
  }

  function buildPage() {
    nodes.player = el('div', { class: 'tv-player-host' });
    nodes.error = el('div');
    nodes.builtinNote = el('div');
    nodes.playlists = el('div');
    nodes.chips = el('div', { class: 'seg', role: 'group', 'aria-label': 'Channel groups' });
    nodes.list = el('div', { class: 'channel-list tv-guide-list' });
    nodes.count = el('p', { class: 'result-count' });
    nodes.moreBtn = el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { appendRows(); } });
    nodes.moreWrap = el('div', { class: 'load-more-wrap' }, nodes.moreBtn);

    searchBar = el('div', { class: 'search-bar' },
      el('div', { class: 'search-input-wrap' },
        icon('search', 'ico'),
        el('input', {
          type: 'search',
          class: 'input',
          id: 'tv-search',
          placeholder: 'Search channels',
          'aria-label': 'Search channels',
          value: query,
          oninput: (e) => { runSearch(e.target.value); },
        })));

    buildAddForm();

    nodes.stage = el('section', { class: 'tv-stage', 'aria-label': 'TV player' }, nodes.player);
    const guide = el('aside', { class: 'tv-guide', 'aria-label': 'Channel guide' },
      searchBar,
      nodes.chips,
      nodes.count,
      nodes.list);

    return pageShell({
      title: 'Live TV',
      subtitle: 'A built-in live guide plus your own M3U playlists — played in your browser, nothing is uploaded.',
      children: [
        nodes.builtinNote,
        nodes.error,
        el('div', { class: 'tv-shell' },
          nodes.stage,
          guide),
        section({
          title: 'Playlists',
          action: ghostAction('Paste M3U', 'plus', () => { openPasteModal(); }),
          children: [nodes.playlists, addForm],
        }),
      ],
    });
  }

  function paintAll() {
    paintError();
    paintBuiltinNote();
    paintPlaylists();
    paintChips();
    paintList();
    paintPlayer();
  }

  const remembered = getSettings().tv || {};
  groupFilter = remembered.rememberGroup ? String(remembered.lastGroup || '') : '';

  const debounceMs = Math.max(100, Math.min(1000, Number(getSettings().searchDebounceMs) || 350));
  runSearch = debounce((value) => {
    query = String(value || '');
    paintList();
  }, debounceMs);

  offs.push(store.on('playlists', () => {
    if (!disposed) paintPlaylists();
  }));

  renderView(buildPage());
  paintAll();
  document.addEventListener('keydown', onKeydown);
  /* Auto-load the built-in guide (fire-and-forget; failures degrade gracefully). */
  loadBuiltin();

  return () => {
    disposed = true;
    stopStream();
    if (runSearch) runSearch.cancel();
    document.removeEventListener('keydown', onKeydown);
    if (moreObserver) {
      try { moreObserver.disconnect(); } catch { /* ignore */ }
      moreObserver = null;
    }
    for (const off of offs) {
      try { off(); } catch { /* ignore */ }
    }
  };
}
