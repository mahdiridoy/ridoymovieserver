import { el, mount, img, safeUrl } from '../utils/sanitize.js';
import {
  icon, toast, emptyState, badge, openModal, confirmModal, primaryAction, ghostAction, setActiveNav,
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

const MAX_ROWS = 300;

const PROXY_HINT = 'The playlist host may be blocking browser requests (CORS). A relay under Settings â†’ Data & network usually fixes this.';

export async function render(ctx, opts = {}) {
  ctx.setTitle('Live TV');
  setActiveNav('tv');

  let disposed = false;
  let channels = [];
  let skipped = 0;
  let groupFilter = '';
  let query = '';
  let current = null;
  let streamCtl = null;
  let attachToken = 0;
  let activePlaylistId = null;
  let sourceLabel = '';
  let loadingId = null;
  let loadError = null;
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
      try { streamCtl.stop(); } catch {}
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

  function showPlayerError(err, noteArea, channel) {
    const message = err?.userMessage?.() || err?.message || String(err);
    const url = channel?.url || '';
    if (!noteArea || disposed) return;
    mount(noteArea,
      inlineError({ message }, { title: 'Stream could not be played' }),
      el('div', { class: 'btn-row', style: { marginTop: '8px' } },
        ghostAction('Copy stream URL', 'external', () => { copyStreamUrl(url); })),
      el('p', { class: 'muted small', text: STREAM_HEADERS_NOTE }));
    toast({ type: 'error', title: 'Playback failed', message });
  }

  function paintPlayer() {
    const area = nodes.player;
    if (!area) return;
    if (!current) {
      mount(area);
      return;
    }

    const token = ++attachToken;
    const video = el('video', {
      controls: true,
      playsinline: '',
      autoplay: true,
      class: 'tv-video',
      style: {
        display: 'block',
        width: '100%',
        aspectRatio: '16 / 9',
        maxHeight: '70vh',
        background: '#000',
        borderRadius: 'var(--radius)',
      },
      'aria-label': `${current.name} live stream`,
    });
    const noteArea = el('div');
    const meta = el('p', {
      class: 'muted small',
      text: isHlsUrl(current.url)
        ? 'HLS stream â€” played natively where the browser supports it, otherwise through hls.js.'
        : 'Direct media URL played natively by the browser.',
    });

    const panel = el('div', { class: 'panel' },
      el('div', { class: 'btn-row', style: { justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' } },
        el('div', {},
          el('h3', { text: current.name }),
          el('p', { class: 'muted small', text: sourceLabel ? `${current.group} Â· from ${sourceLabel}` : current.group })),
        ghostAction('Stop', 'close', () => {
          stopStream();
          current = null;
          paintPlayer();
          paintList();
        })),
      video,
      meta,
      noteArea);

    mount(area, panel);

    video.addEventListener('error', () => {
      if (disposed || token !== attachToken) return;
      showPlayerError({ message: video.error?.message || 'The browser could not play this stream.' }, noteArea, current);
    });

    attachStream(video, current.url, { signal: ctx.signal }).then((ctl) => {
      if (disposed || token !== attachToken || ctx.signal?.aborted) {
        try { ctl.stop(); } catch {}
        return;
      }
      streamCtl = ctl;
      let attempt = null;
      try { attempt = video.play(); } catch {}
      if (attempt && typeof attempt.catch === 'function') {
        attempt.catch(() => {
          if (disposed || token !== attachToken) return;
          mount(noteArea, el('p', {
            class: 'muted small',
            text: 'Autoplay was blocked by the browser â€” press Play in the player to start the stream.',
          }));
        });
      }
    }).catch((err) => {
      if (disposed || token !== attachToken || ctx.signal?.aborted) return;
      showPlayerError(err, noteArea, current);
    });
  }

  function play(channel) {
    stopStream();
    current = channel;
    paintPlayer();
    paintList();
    const viewRoot = document.getElementById('view');
    if (viewRoot && typeof viewRoot.scrollTo === 'function') viewRoot.scrollTo({ top: 0, behavior: 'smooth' });
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
      'aria-label': value ? `${label} group, ${count} channels` : `All groups, ${count} channels`,
      onclick: () => setGroup(value),
    }, el('span', { text: value ? `${label} (${count})` : `All (${count})` }));

    mount(area,
      chip('All', '', channels.length),
      ...groups.map((group) => chip(group, group, map.get(group).length)));
  }

  function channelRow(channel) {
    const playing = Boolean(current && current.url === channel.url);
    return el('div', { class: 'channel' },
      logoNode(channel),
      el('div', { style: { flex: '1', minWidth: '0' } },
        el('div', { class: 'channel-name', text: channel.name }),
        el('div', { class: 'btn-row', style: { marginTop: '4px' } },
          badge(channel.group || 'Ungrouped'),
          playing ? badge('Playing', 'badge-accent') : null)),
      primaryAction('Play', 'play', () => { play(channel); }));
  }

  function paintList() {
    const area = nodes.list;
    const count = nodes.count;
    if (!area) return;

    if (!channels.length) {
      if (count) count.textContent = '';
      mount(area, emptyState({
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
    const found = searchChannels(base, query);
    const shown = found.slice(0, MAX_ROWS);

    if (count) {
      const parts = [`${found.length} of ${channels.length} channels`];
      if (groupFilter) parts.push(`group "${groupFilter}"`);
      if (query) parts.push(`matching "${query}"`);
      if (sourceLabel) parts.push(`from ${sourceLabel}`);
      if (skipped) parts.push(`${skipped} playlist entries skipped`);
      if (found.length > shown.length) parts.push(`showing the first ${shown.length}`);
      count.textContent = `${parts.join(' Â· ')}.`;
    }

    if (!shown.length) {
      mount(area, emptyState({
        icon: 'search',
        title: 'No matching channels',
        message: query ? `Nothing matches "${query}" in this selection.` : 'This group has no channels.',
      }));
      return;
    }
    mount(area, ...shown.map(channelRow));
  }

  function paintTools() {
    const area = nodes.tools;
    if (!area) return;
    if (!channels.length) {
      mount(area);
      return;
    }
    mount(area, searchBar, nodes.chips);
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

  function playlistRow(playlist) {
    const busy = loadingId === playlist.id;
    const loadBtn = primaryAction(busy ? 'Loadingâ€¦' : 'Load', 'play', () => { loadPlaylist(playlist); });
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
      mount(area, el('p', {
        class: 'muted small',
        text: 'No saved playlists yet â€” add one below, or paste M3U text directly.',
      }));
      return;
    }
    mount(area, ...list.map(playlistRow));
  }

  function applyParsed(parsed, { id = null, label = '' } = {}) {
    channels = Array.isArray(parsed?.channels) ? parsed.channels : [];
    skipped = Number(parsed?.skipped || 0);
    activePlaylistId = id;
    sourceLabel = label;
    loadError = null;

    const tv = getSettings().tv || {};
    const map = groupChannels(channels);
    const remembered = tv.rememberGroup ? String(tv.lastGroup || '') : '';
    groupFilter = remembered && map.has(remembered) ? remembered : '';

    const droppedCurrent = Boolean(current && !channels.some((ch) => ch.url === current.url));
    if (droppedCurrent) {
      stopStream();
      current = null;
      paintPlayer();
    }

    paintError();
    paintTools();
    paintChips();
    paintList();
    paintPlaylists();
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
      if (channels.length) {
        toast({
          type: 'success',
          title: 'Playlist loaded',
          message: `${channels.length} channels from ${playlist.name}${skipped ? ` Â· ${skipped} skipped` : ''}.`,
          timeout: 2600,
        });
      } else {
        toast({
          type: 'warning',
          title: 'Playlist is empty',
          message: `${playlist.name} produced no playable channels${skipped ? ` (${skipped} entries skipped)` : ''}.`,
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
      message: `${item.name} saved â€” press Load to fetch its channels.`,
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
      el('span', { class: 'hint', text: 'Optional â€” defaults to the host name.' })),
    el('div', { class: 'field' },
      el('label', { for: 'tv-pl-url', text: 'Playlist URL' }),
      urlInput,
      el('span', {
        class: 'hint',
        text: 'An M3U / M3U8 address, fetched with your proxy settings from Settings â†’ Data & network when the host blocks the browser.',
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
      el('span', { class: 'hint', text: 'Parsed in your browser â€” the text is never uploaded.' }));

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
            message: `${parsed.channels.length} channels pasted${parsed.skipped ? ` Â· ${parsed.skipped} skipped` : ''}.`,
            timeout: 2600,
          });
        }),
      ],
    });
    return close;
  }

  function buildPage() {
    nodes.player = el('div');
    nodes.error = el('div');
    nodes.playlists = el('div');
    nodes.tools = el('div');
    nodes.chips = el('div', { class: 'seg', role: 'group', 'aria-label': 'Channel groups' });
    nodes.list = el('div', { class: 'channel-list' });
    nodes.count = el('p', { class: 'result-count' });

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

    return pageShell({
      title: 'Live TV',
      subtitle: 'M3U playlists played in your browser â€” nothing is uploaded.',
      children: [
        nodes.player,
        nodes.error,
        section({
          title: 'Playlists',
          action: ghostAction('Paste M3U', 'plus', () => { openPasteModal(); }),
          children: [nodes.playlists, addForm],
        }),
        section({
          title: 'Channels',
          children: [nodes.tools, nodes.count, nodes.list],
        }),
      ],
    });
  }

  function paintAll() {
    paintError();
    paintPlaylists();
    paintTools();
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

  return () => {
    disposed = true;
    stopStream();
    if (runSearch) runSearch.cancel();
    for (const off of offs) {
      try { off(); } catch {}
    }
  };
}
