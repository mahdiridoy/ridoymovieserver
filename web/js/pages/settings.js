import { el, mount } from '../utils/sanitize.js';
import {
  icon, toast, badge, confirmModal, primaryAction, ghostAction, spinner, setActiveNav,
} from '../utils/helpers.js';
import { renderView, pageShell, section, inlineError } from '../components/shell.js';
import { relativeTime } from '../utils/format.js';
import {
  getSettings, updateSettings, resetSettings, THEMES, setTheme, applyTheme,
  getProviderStatus, setProviderStatus, enabledProviders, clearAllLocalData,
  dataInfo, providerLabel, PROVIDERS, listFavorites, listHistory,
} from '../state.js';
import { probeProviders, activeProviders, REGISTRY } from '../catalog.js';
import { normalizeBaseUrl, proxyConfigured, proxyBase } from '../api.js';
import { cacheClear, storageMode } from '../storage.js';

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

const PROXY_MODE_HINTS = {
  auto: 'Auto: try a direct request first, then fall back to your proxy when the provider refuses the browser.',
  always: 'Always: send every provider request through your proxy, even when the provider allows direct access.',
  never: 'Never: direct requests only. This fails for providers that block cross-origin browser requests (CORS).',
};

function themeSwatches(theme) {
  if (!theme || theme.key === 'system') return null;
  const root = document.documentElement;
  const original = root.getAttribute('data-theme');
  let colors = null;
  try {
    root.setAttribute('data-theme', theme.key);
    const computed = getComputedStyle(root);
    const read = (name) => computed.getPropertyValue(name).trim();
    const out = [read('--bg-primary'), read('--accent'), read('--accent-2')];
    if (out.every((value) => value && /^(#|rgb|hsl)/i.test(value))) colors = out;
  } catch {
    colors = null;
  }
  if (original === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', original);
  if (colors) return colors;
  return Array.isArray(theme.swatch) && theme.swatch.length ? theme.swatch.slice(0, 3) : null;
}

export async function render(ctx, opts = {}) {
  ctx.setTitle('Settings');
  setActiveNav('settings');

  let disposed = false;
  let probing = false;
  let rowsBody = null;
  let homeBody = null;
  let checkBtn = null;
  let proxyInput = null;
  let proxyNote = null;
  let proxyStatus = null;
  const timers = new Set();

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!disposed) fn();
    }, ms);
    timers.add(t);
    return t;
  };

  const savedHint = (node, text = 'Saved') => {
    if (!node) return;
    node.textContent = text;
    later(() => {
      if (node.textContent === text) node.textContent = '';
    }, 1800);
  };

  const dotClass = (status) => (status === 'ok' ? 'ok'
    : status === 'error' ? 'err'
      : status === 'proxy_required' ? 'warn' : '');

  const statusLabel = (status) => (status === 'ok' ? 'Reachable'
    : status === 'error' ? 'Failing'
      : status === 'proxy_required' ? 'Needs a proxy' : 'Not checked yet');

  const describeStatus = (stored) => (stored && stored.checkedAt
    ? `${statusLabel(stored.status)} · checked ${relativeTime(stored.checkedAt)}`
    : statusLabel(stored?.status));

  function toggleRow({ label, hint = '', checked, onChange }) {
    const state = el('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const input = el('input', {
      type: 'checkbox',
      checked: Boolean(checked),
      onchange: (e) => {
        onChange(Boolean(e.target.checked));
        savedHint(state);
      },
    });
    return el('label', { class: 'panel-row' },
      el('div', { class: 'row-text' },
        el('strong', { text: label }),
        hint ? el('span', { text: hint }) : null,
        state),
      el('span', { class: 'switch' }, input, el('span', { class: 'track', 'aria-hidden': 'true' })));
  }

  function selectRow({ label, hint = '', value, options, onChange }) {
    const state = el('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const select = el('select', {
      class: 'select',
      'aria-label': label,
      onchange: (e) => {
        onChange(e.target.value);
        savedHint(state);
      },
    });
    for (const option of options) {
      select.appendChild(el('option', { value: option.value, text: option.label }));
    }
    select.value = String(value ?? '');
    return el('label', { class: 'panel-row' },
      el('div', { class: 'row-text' },
        el('strong', { text: label }),
        hint ? el('span', { text: hint }) : null,
        state),
      select);
  }

  function numberField({ id, label, hint = '', value, min, max, step, onCommit }) {
    const state = el('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const input = el('input', {
      id,
      type: 'number',
      class: 'input',
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      'aria-describedby': hint ? `${id}-hint` : undefined,
      onchange: () => {
        const parsed = Number(input.value);
        if (!Number.isFinite(parsed)) {
          input.value = String(value);
          savedHint(state, 'Invalid value');
          return;
        }
        const next = Math.round(clamp(parsed, min, max));
        input.value = String(next);
        onCommit(next);
        savedHint(state);
      },
    });
    return el('div', { class: 'field' },
      el('label', { for: id, text: label }),
      input,
      hint ? el('span', { class: 'hint', id: `${id}-hint`, text: hint }) : null,
      state);
  }

  function appearanceSection() {
    const current = getSettings().theme;
    const options = [...THEMES, { key: 'system', label: 'System', system: true }];
    const grid = el('div', { class: 'theme-grid', role: 'group', 'aria-label': 'Theme' });

    const mocha = themeSwatches(THEMES.find((t) => t.key === 'mocha'));
    const latte = themeSwatches(THEMES.find((t) => t.key === 'latte'));

    for (const theme of options) {
      const active = current === theme.key;
      const colors = theme.system
        ? [mocha && mocha[0], latte && latte[0]].filter(Boolean)
        : themeSwatches(theme);
      const dots = el('div', { class: 'theme-dots', 'aria-hidden': 'true' });
      if (colors && colors.length) {
        for (const color of colors) dots.appendChild(el('i', { style: { background: color } }));
      } else {
        dots.appendChild(el('i', { style: { background: 'var(--surface-active)' } }));
      }
      grid.appendChild(el('button', {
        class: `theme-swatch${active ? ' active' : ''}`,
        type: 'button',
        'data-theme': theme.system ? 'system' : theme.key,
        'aria-pressed': String(active),
        'aria-label': theme.system
          ? 'Follow the system light or dark setting'
          : `Use the ${theme.label} theme`,
        onclick: () => {
          setTheme(theme.key);
          toast({ type: 'success', title: 'Theme', message: `${theme.label} applied.`, timeout: 1600 });
          repaint();
        },
      }, dots, el('span', { text: theme.label })));
    }

    return section({
      title: 'Appearance',
      children: [
        el('p', {
          class: 'muted small',
          text: 'Swatches show each theme\'s own background and accent colours. "System" follows your OS light or dark setting.',
        }),
        grid,
      ],
    });
  }

  function playbackSection() {
    const player = getSettings().player || {};
    const setPlayer = (key, value) => updateSettings({ player: { ...getSettings().player, [key]: value } });

    return section({
      title: 'Playback',
      children: [el('div', { class: 'panel' },
        toggleRow({
          label: 'Autoplay',
          hint: 'Start playback as soon as a title is opened.',
          checked: player.autoplay,
          onChange: (v) => setPlayer('autoplay', v),
        }),
        toggleRow({
          label: 'Autoplay next episode',
          hint: 'Continue into the next episode without asking.',
          checked: player.autoplayNext,
          onChange: (v) => setPlayer('autoplayNext', v),
        }),
        toggleRow({
          label: 'Resume playback',
          hint: 'Remember the position of every film and episode.',
          checked: player.resumeEnabled,
          onChange: (v) => setPlayer('resumeEnabled', v),
        }),
        toggleRow({
          label: 'Autoplay previews',
          hint: 'Play muted preview clips while browsing.',
          checked: player.autoplayPreviews,
          onChange: (v) => setPlayer('autoplayPreviews', v),
        }),
        selectRow({
          label: 'Preferred quality',
          hint: 'Used when a source offers several renditions.',
          value: player.preferredQuality || 'auto',
          options: [
            { value: 'auto', label: 'Auto' },
            { value: '1080p', label: '1080p' },
            { value: '720p', label: '720p' },
            { value: '480p', label: '480p' },
          ],
          onChange: (v) => setPlayer('preferredQuality', v),
        }))],
    });
  }

  function librarySection() {
    const settings = getSettings();
    return section({
      title: 'Library',
      children: [el('div', { class: 'panel' },
        toggleRow({
          label: 'Continue watching',
          hint: 'Keep resume points and show them on Home.',
          checked: settings.continueWatching,
          onChange: (v) => updateSettings({ continueWatching: v }),
        }),
        toggleRow({
          label: 'Safe search',
          hint: 'Filter adult results out of searches where the provider allows it.',
          checked: settings.safeSearch,
          onChange: (v) => updateSettings({ safeSearch: v }),
        }),
        numberField({
          id: 'search-debounce',
          label: 'Search debounce (ms)',
          hint: 'How long typing waits before a search runs. Range 100–1000 ms.',
          value: settings.searchDebounceMs,
          min: 100,
          max: 1000,
          step: 50,
          onCommit: (v) => updateSettings({ searchDebounceMs: v }),
        }),
        numberField({
          id: 'max-history',
          label: 'Maximum history entries',
          hint: 'Oldest entries are dropped past this limit. Range 10–500.',
          value: settings.maxHistory,
          min: 10,
          max: 500,
          step: 10,
          onCommit: (v) => updateSettings({ maxHistory: v }),
        }))],
    });
  }

  function providerRow(def) {
    const settings = getSettings();
    const enabled = def.key in (settings.providers || {})
      ? settings.providers[def.key] !== false
      : true;
    const stored = getProviderStatus(def.key);
    const state = el('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const input = el('input', {
      type: 'checkbox',
      checked: enabled,
      onchange: (e) => {
        const next = Boolean(e.target.checked);
        updateSettings({ providers: { ...getSettings().providers, [def.key]: next } });
        toast({
          type: 'success',
          title: def.label,
          message: next ? 'Provider enabled.' : 'Provider disabled.',
          timeout: 1600,
        });
        savedHint(state);
        paintHomeSelect();
      },
    });

    return el('label', { class: 'panel-row' },
      el('div', { class: 'row-text' },
        el('strong', { text: def.label }),
        el('span', {},
          el('span', { class: `status-dot ${dotClass(stored.status)}`.trim(), 'aria-hidden': 'true' }),
          el('span', { text: describeStatus(stored) })),
        stored.detail ? el('span', { text: String(stored.detail) }) : null,
        state),
      el('div', { class: 'btn-row' },
        def.needsProxy ? badge('Needs proxy') : null,
        el('span', { class: 'switch' }, input, el('span', { class: 'track', 'aria-hidden': 'true' }))));
  }

  function paintProviderRows() {
    if (!rowsBody) return;
    if (probing) {
      mount(rowsBody, spinner('Checking providers…'));
      return;
    }
    mount(rowsBody, ...Object.values(PROVIDERS).map(providerRow));
  }

  function paintHomeSelect() {
    if (!homeBody) return;
    const settings = getSettings();
    const enabled = enabledProviders();
    const keys = [...enabled];
    if (settings.homeProvider && !keys.includes(settings.homeProvider)) keys.push(settings.homeProvider);

    const options = keys.map((key) => ({
      value: key,
      label: `${providerLabel(key)}${REGISTRY[key]?.capabilities?.home ? '' : ' — no home feed'}${enabled.includes(key) ? '' : ' (disabled)'}`,
    }));
    if (!options.length) options.push({ value: 'moviebox', label: 'MovieBox — no home feed' });

    const state = el('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    const select = el('select', {
      class: 'select',
      'aria-label': 'Home page provider',
      onchange: (e) => {
        updateSettings({ homeProvider: e.target.value });
        savedHint(state);
        toast({ type: 'success', title: 'Home provider', message: `${providerLabel(e.target.value)} selected.`, timeout: 1600 });
        paintHomeSelect();
      },
    });
    for (const option of options) select.appendChild(el('option', { value: option.value, text: option.label }));
    select.value = options.some((option) => option.value === settings.homeProvider)
      ? settings.homeProvider
      : options[0].value;

    mount(homeBody,
      el('div', { class: 'panel' },
        el('h3', { text: 'Home provider' }),
        select,
        el('p', {
          class: 'muted small',
          text: `Enabled for search: ${activeProviders().map((p) => p.label).join(', ') || 'none'}. Home rows come from the provider selected above; providers marked "no home feed" leave Home empty.`,
        }),
        state));
  }

  async function runProbe() {
    if (probing) return;
    probing = true;
    const startedAt = Date.now();
    setCheckBusy(true);
    paintProviderRows();
    let failed = false;
    try {
      const results = await probeProviders({ signal: ctx.signal });
      if (ctx.signal?.aborted || disposed) return;
      for (const result of results) {
        const stored = getProviderStatus(result.key);
        if (!result.ok && (!stored.checkedAt || stored.checkedAt < startedAt)) {
          const detail = String(result.detail || '');
          setProviderStatus(result.key, detail.includes('proxy') ? 'proxy_required' : 'error', detail);
        }
      }
      const reachable = results.filter((r) => r.ok).length;
      if (results.length) {
        toast({
          type: reachable === results.length ? 'success' : 'info',
          title: 'Provider check',
          message: `${reachable} of ${results.length} enabled providers reachable${reachable < results.length && !proxyConfigured() ? ' — add a proxy URL below if you see proxy_required.' : '.'}`,
          timeout: 3200,
        });
      } else {
        toast({ type: 'info', title: 'Provider check', message: 'No enabled catalog providers to check.', timeout: 2600 });
      }
    } catch (err) {
      if (ctx.signal?.aborted || disposed) return;
      failed = true;
      const message = err?.userMessage?.() || err?.message || String(err);
      if (rowsBody) mount(rowsBody, inlineError(err, { title: 'Provider check failed', onRetry: runProbe }));
      toast({ type: 'error', title: 'Provider check failed', message });
    } finally {
      probing = false;
      if (!disposed && !ctx.signal?.aborted) {
        setCheckBusy(false);
        if (!failed) paintProviderRows();
      }
    }
  }

  function setCheckBusy(busy) {
    if (!checkBtn) return;
    checkBtn.disabled = busy;
    checkBtn.setAttribute('aria-busy', String(busy));
    mount(checkBtn, icon('refresh'), el('span', { text: busy ? 'Checking…' : 'Check now' }));
  }

  function providersSection() {
    rowsBody = el('div');
    homeBody = el('div');
    checkBtn = primaryAction('Check now', 'refresh', () => { runProbe(); });
    paintProviderRows();
    paintHomeSelect();

    return section({
      title: 'Providers',
      action: checkBtn,
      children: [
        el('p', {
          class: 'muted small',
          text: 'Enable or disable each source, then run a check to see what this browser can actually reach right now.',
        }),
        rowsBody,
        homeBody,
      ],
    });
  }

  function paintProxyStatus() {
    if (!proxyStatus) return;
    const configured = proxyConfigured();
    mount(proxyStatus,
      el('div', { class: 'btn-row' },
        badge(configured ? 'Proxy configured' : 'No proxy configured'),
        el('span', { class: 'muted small', text: configured ? proxyBase() : 'Providers marked "needs proxy" will report proxy_required.' })));
  }

  function commitProxy() {
    if (!proxyInput || !proxyNote) return;
    const raw = String(proxyInput.value || '').trim();
    if (!raw) {
      proxyInput.removeAttribute('aria-invalid');
      if (getSettings().proxyBase) {
        updateSettings({ proxyBase: '' });
        toast({ type: 'info', title: 'Proxy', message: 'Proxy URL cleared.', timeout: 1600 });
        paintProxyStatus();
        savedHint(proxyNote, 'Cleared');
      } else {
        savedHint(proxyNote, 'No proxy set');
      }
      return;
    }
    const normalized = normalizeBaseUrl(raw);
    if (!normalized) {
      proxyInput.setAttribute('aria-invalid', 'true');
      proxyNote.textContent = 'Enter a valid http:// or https:// URL.';
      return;
    }
    proxyInput.removeAttribute('aria-invalid');
    updateSettings({ proxyBase: raw });
    savedHint(proxyNote);
    toast({ type: 'success', title: 'Proxy', message: `Saving requests to ${normalized}.`, timeout: 1800 });
    paintProxyStatus();
  }

  function dataSection() {
    const settings = getSettings();
    const info = dataInfo();
    const mode = storageMode();
    const modeLabel = mode === 'local' ? 'localStorage (this browser)' : 'memory only (not persisted)';

    const modeSelect = el('select', {
      id: 'proxy-mode',
      class: 'select',
      'aria-label': 'Proxy mode',
      onchange: (e) => {
        const value = e.target.value;
        updateSettings({ proxyMode: value });
        toast({ type: 'success', title: 'Proxy mode', message: PROXY_MODE_HINTS[value], timeout: 2600 });
        const hint = document.getElementById('proxy-mode-hint');
        if (hint) hint.textContent = PROXY_MODE_HINTS[value];
      },
    });
    for (const value of ['auto', 'always', 'never']) {
      modeSelect.appendChild(el('option', { value, text: value[0].toUpperCase() + value.slice(1) }));
    }
    modeSelect.value = settings.proxyMode || 'auto';

    proxyNote = el('span', { class: 'hint', role: 'status', 'aria-live': 'polite' });
    proxyStatus = el('div');
    proxyInput = el('input', {
      id: 'proxy-base',
      type: 'url',
      class: 'input',
      value: String(settings.proxyBase || ''),
      placeholder: 'https://proxy.example',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-describedby': 'proxy-base-hint',
      onchange: () => commitProxy(),
      onkeydown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitProxy();
        }
      },
    });
    paintProxyStatus();

    const clearCacheBtn = ghostAction('Clear cached responses', 'trash', async () => {
      clearCacheBtn.disabled = true;
      try {
        const ok = await cacheClear();
        if (disposed) return;
        toast(ok
          ? { type: 'success', title: 'Cache cleared', message: 'Cached provider responses were removed.', timeout: 2200 }
          : { type: 'warning', title: 'Cache unavailable', message: 'This browser did not expose a response cache.', timeout: 2800 });
      } catch (err) {
        if (disposed) return;
        toast({ type: 'error', title: 'Cache clear failed', message: String(err?.message || err) });
      } finally {
        if (!disposed) clearCacheBtn.disabled = false;
      }
    });

    const exportBtn = primaryAction('Export favorites & history', 'external', () => exportData());

    const summary = el('div', { class: 'panel' },
      el('h3', { text: 'Stored on this device' }),
      dataRow('Favorites', info.favorites, 'Bookmarked titles.'),
      dataRow('History', info.history, 'Consolidated watch history entries.'),
      dataRow('Resume points', info.progress, 'Per-episode positions.'),
      dataRow('Playlists', info.playlists, 'Saved M3U playlists (see Live TV).'),
      dataRow('Addons', info.addons, 'Installed addon manifests (data only).'),
      dataRow('Storage mode', modeLabel, 'Where this data lives.'));

    return section({
      title: 'Data & network',
      children: [
        el('div', { class: 'panel' },
          el('h3', { text: 'CORS proxy' }),
          el('div', { class: 'field' },
            el('label', { for: 'proxy-mode', text: 'Proxy mode' }),
            modeSelect,
            el('span', { class: 'hint', id: 'proxy-mode-hint', text: PROXY_MODE_HINTS[settings.proxyMode] || PROXY_MODE_HINTS.auto })),
          el('div', { class: 'field' },
            el('label', { for: 'proxy-base', text: 'Proxy base URL' }),
            proxyInput,
            el('span', { class: 'hint', id: 'proxy-base-hint', text: 'A relay that accepts POST { url, method, headers, body } and answers { status, headers, body }. Leave empty to disable the proxy.' }),
            proxyNote),
          proxyStatus),
        el('div', { class: 'panel' },
          el('h3', { text: 'Cached responses' }),
          el('p', { class: 'muted small', text: 'Search, details and stream responses are cached in IndexedDB with a short TTL.' }),
          el('div', { class: 'btn-row' }, clearCacheBtn, exportBtn)),
        summary,
      ],
    });
  }

  function dataRow(label, value, hint) {
    return el('div', { class: 'panel-row' },
      el('div', { class: 'row-text' },
        el('strong', { text: label }),
        el('span', { text: hint })),
      el('span', { text: String(value) }));
  }

  function exportData() {
    try {
      const payload = {
        exportedAt: new Date().toISOString(),
        source: 'MovieBox Web (local browser storage)',
        favorites: listFavorites(),
        history: listHistory(),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = el('a', { href: url, download: 'moviebox-local-data.json' });
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      later(() => URL.revokeObjectURL(url), 4000);
      toast({ type: 'success', title: 'Export ready', message: 'moviebox-local-data.json downloaded.', timeout: 2400 });
    } catch (err) {
      toast({ type: 'error', title: 'Export failed', message: String(err?.message || err) });
    }
  }

  function dangerButton(label, iconName, onclick) {
    return el('button', { class: 'btn btn-danger', type: 'button', onclick },
      icon(iconName), el('span', { text: label }));
  }

  async function onResetSettings() {
    const ok = await confirmModal({
      title: 'Reset settings?',
      message: 'Theme, playback, library, provider and network settings return to their defaults. Favorites, history and playlists are kept.',
      confirmLabel: 'Reset settings',
      danger: true,
    });
    if (!ok || disposed) return;
    resetSettings();
    applyTheme();
    toast({ type: 'success', title: 'Settings reset', message: 'Defaults restored.', timeout: 2200 });
    repaint();
  }

  async function onClearData() {
    const ok = await confirmModal({
      title: 'Clear all local data?',
      message: 'Deletes favorites, watch history, resume points and cached responses from this browser. Settings and playlists are kept. This cannot be undone.',
      confirmLabel: 'Clear all local data',
      danger: true,
    });
    if (!ok || disposed) return;
    clearAllLocalData();
    let cacheMsg = 'Cached responses were removed.';
    try {
      const cleared = await cacheClear();
      if (!cleared) cacheMsg = 'The response cache is unavailable in this browser.';
    } catch {
      cacheMsg = 'The response cache could not be cleared.';
    }
    if (disposed) return;
    toast({ type: 'success', title: 'Local data cleared', message: `Favorites, history and resume points removed. ${cacheMsg}`, timeout: 3200 });
    repaint();
  }

  function dangerSection() {
    return section({
      title: 'Danger zone',
      children: [el('div', { class: 'panel' },
        el('div', { class: 'panel-row' },
          el('div', { class: 'row-text' },
            el('strong', { text: 'Reset settings' }),
            el('span', { text: 'Restore all settings on this page to their defaults.' })),
          dangerButton('Reset settings', 'refresh', () => { onResetSettings(); })),
        el('div', { class: 'panel-row' },
          el('div', { class: 'row-text' },
            el('strong', { text: 'Clear all local data' }),
            el('span', { text: 'Delete favorites, history, resume points and cached responses. Settings and playlists are kept.' })),
          dangerButton('Clear all local data', 'trash', () => { onClearData(); })))],
    });
  }

  function buildPage() {
    return pageShell({
      title: 'Settings',
      subtitle: 'Saved to this browser immediately — there is no Save button.',
      children: [
        appearanceSection(),
        playbackSection(),
        librarySection(),
        providersSection(),
        dataSection(),
        dangerSection(),
      ],
    });
  }

  function repaint() {
    const viewRoot = document.getElementById('view');
    const top = viewRoot ? viewRoot.scrollTop : 0;
    renderView(buildPage());
    if (viewRoot) viewRoot.scrollTop = top;
  }

  renderView(buildPage());

  return () => {
    disposed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
