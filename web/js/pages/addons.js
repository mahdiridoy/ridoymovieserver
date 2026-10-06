import { el, img, mount, safeUrl } from '../utils/sanitize.js';
import {
  badge, confirmModal, emptyState, ghostAction, icon, setActiveNav, spinner, toast,
} from '../utils/helpers.js';
import { inlineError, pageShell, renderView, section, view } from '../components/shell.js';
import { plural, relativeTime } from '../utils/format.js';
import {
  getSettings, installAddon, listAddons, uninstallAddon, updateAddon,
} from '../state.js';
import { ProviderError, normalizeBaseUrl, proxyConfigured } from '../api.js';
import { fetchManifest } from '../providers/addons/index.js';

const CINEMETA_MANIFEST = 'https://v3-cinemeta.strem.io/manifest.json';

export async function render(ctx, opts = {}) {
  ctx.setTitle('Addons');
  setActiveNav('addons');

  let busy = false;
  const status = el('div', { class: 'install-status' });

  function resolveManifestUrl(raw) {
    const input = String(raw || '').trim();
    if (!input) return '';
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
    if (!normalizeBaseUrl(candidate)) return '';
    const safe = safeUrl(candidate);
    if (!safe || !/^https?:\/\//i.test(safe)) return '';
    return safe;
  }

  function reportError(err, title) {
    if (ctx.signal.aborted) return;
    if (err?.name === 'AbortError' || err?.kind === 'aborted') return;
    toast({
      type: 'error',
      title,
      message: err?.userMessage?.() || err?.message || String(err),
    });
  }

  async function runInstall({ getUrl, buttons }) {
    if (busy) return;
    const url = resolveManifestUrl(getUrl());
    if (!url) {
      reportError(new ProviderError(
        'bad_request',
        'Enter a valid http(s) manifest URL, for example https://example.com/manifest.json',
        { provider: 'Addons' },
      ), 'Invalid URL');
      return;
    }

    busy = true;
    for (const button of buttons) button.disabled = true;
    mount(status, spinner('Fetching manifest…'));

    let failure = null;
    try {
      const manifest = await fetchManifest(url, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      installAddon({ ...manifest, url, transportUrl: url });
      toast({ type: 'success', title: 'Addon installed', message: manifest.name });
      draw();
    } catch (err) {
      failure = err;
      reportError(err, 'Install failed');
    } finally {
      busy = false;
      for (const button of buttons) button.disabled = false;
    }
    if (!failure) mount(status);
    else mount(status, inlineError(failure, { title: 'Could not install addon' }));
  }

  async function refreshManifest(addon, button) {
    if (busy) return;
    const url = String(addon.url || addon.transportUrl || '').trim();
    if (!url) {
      reportError(new ProviderError(
        'bad_request',
        'No manifest URL is stored for this addon.',
        { provider: 'Addons' },
      ), 'Cannot refresh');
      return;
    }

    busy = true;
    button.disabled = true;
    mount(status, spinner('Refreshing manifest…'));
    const cacheBust = `${url.includes('?') ? '&' : '?'}cb=${Date.now()}`;

    let failure = null;
    try {
      const manifest = await fetchManifest(`${url}${cacheBust}`, { signal: ctx.signal });
      if (ctx.signal.aborted) return;
      updateAddon(addon.id, {
        ...manifest,
        id: addon.id,
        catalogs: Array.isArray(manifest.catalogs) ? manifest.catalogs.length : 0,
      });
      toast({ type: 'success', title: 'Manifest refreshed', message: manifest.name });
      draw();
    } catch (err) {
      failure = err;
      reportError(err, 'Refresh failed');
    } finally {
      busy = false;
      button.disabled = false;
    }
    if (!failure) mount(status);
    else mount(status, inlineError(failure, { title: 'Could not refresh manifest' }));
  }

  async function removeAddon(addon) {
    const confirmed = await confirmModal({
      title: `Uninstall ${addon.name}?`,
      message: 'Its catalogs and streams are removed from search and details. You can install it again from its manifest URL.',
      confirmLabel: 'Uninstall',
      danger: true,
    });
    if (!confirmed || ctx.signal.aborted) return;
    uninstallAddon(addon.id);
    toast({ type: 'success', title: 'Addon uninstalled', message: addon.name });
    draw();
  }

  function logoFallback(addon) {
    return el('div', {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: '700',
        color: 'var(--text-muted)',
      },
      text: String(addon.name || '?').slice(0, 2).toUpperCase(),
    });
  }

  function addonNode(addon) {
    const logoHolder = el('div', { class: 'addon-logo' });
    const logoUrl = safeUrl(addon.logo);
    if (logoUrl) {
      const image = img(logoUrl, `${addon.name} logo`, {
        style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
      });
      image.addEventListener('img-error', () => mount(logoHolder, logoFallback(addon)));
      logoHolder.appendChild(image);
    } else {
      mount(logoHolder, logoFallback(addon));
    }

    const types = Array.isArray(addon.types) && addon.types.length
      ? addon.types.join(', ')
      : 'No declared types';
    const catalogs = Number(addon.catalogs) || 0;
    const refreshBtn = ghostAction('Refresh manifest', 'refresh', () => refreshManifest(addon, refreshBtn));
    const uninstallBtn = ghostAction('Uninstall', 'trash', () => removeAddon(addon));

    return el('article', { class: 'addon-item' },
      logoHolder,
      el('div', { class: 'addon-main' },
        el('h4', {},
          el('span', { text: addon.name }),
          addon.version ? badge(addon.version) : null),
        el('p', { text: addon.description || 'No description provided by this manifest.' }),
        el('span', { class: 'addon-url', text: addon.url }),
        el('p', {
          class: 'muted small',
          text: `${types} · ${plural(catalogs, 'catalog')} · Installed ${relativeTime(addon.installedAt)}`,
        }),
        el('div', { class: 'addon-actions' }, refreshBtn, uninstallBtn)));
  }

  function installPanel() {
    const input = el('input', {
      class: 'input',
      id: 'addon-url',
      name: 'manifest-url',
      type: 'text',
      inputmode: 'url',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'https://example.com/manifest.json',
      'aria-describedby': 'addon-url-hint addon-url-proxy',
    });
    const buttons = [];
    const submit = () => runInstall({ getUrl: () => input.value, buttons });
    const installBtn = el('button', { class: 'btn', type: 'submit' },
      icon('plus'), el('span', { text: 'Install' }));
    const cinemetaBtn = ghostAction('Install Cinemeta', 'star', () => {
      input.value = CINEMETA_MANIFEST;
      submit();
    });
    buttons.push(installBtn, cinemetaBtn);

    const proxyHint = proxyConfigured()
      ? 'A proxy is configured in Settings, so it will be used automatically when this host blocks direct browser requests.'
      : 'The manifest host must answer requests from your browser. If it blocks them, add a proxy URL in Settings.';

    return el('form', {
      class: 'panel',
      onsubmit: (event) => {
        event.preventDefault();
        submit();
      },
    },
    el('h3', { text: 'Install an addon' }),
    el('div', { class: 'field' },
      el('label', { for: 'addon-url', text: 'Manifest URL' }),
      input,
      el('p', {
        class: 'hint',
        id: 'addon-url-hint',
        text: 'Paste a Stremio-compatible manifest URL, usually ending in /manifest.json. It is fetched as JSON and stored as data only.',
      })),
    el('div', { class: 'btn-row' }, installBtn, cinemetaBtn),
    el('p', { class: 'hint', id: 'addon-url-proxy', text: proxyHint }));
  }

  function installedSection(addons) {
    if (!addons.length) {
      return emptyState({
        icon: 'grid',
        title: 'No addons installed',
        message: 'Add a Stremio-compatible manifest URL to add its catalogs and streams to search and details.',
      });
    }
    return section({
      title: `Installed (${addons.length})`,
      children: addons.map((addon) => addonNode(addon)),
    });
  }

  function pageNode() {
    const addons = listAddons();
    const addonsEnabled = getSettings().providers?.addons !== false;

    return pageShell({
      title: 'Addons',
      subtitle: 'Stremio-compatible catalogs and streams, installed as data.',
      children: [
        el('div', { class: 'panel' },
          el('p', {
            text: 'Addons add catalogs and streams from Stremio-style manifests. Installing one fetches the manifest as JSON and stores only its data: name, version, description, logo, types and catalog list. No addon code is downloaded, injected or executed.',
          })),
        installPanel(),
        status,
        installedSection(addons),
        el('p', { class: 'muted small' },
          'Addons are disabled at runtime if the Providers toggle for Addons is off. ',
          el('strong', { text: `Current state: ${addonsEnabled ? 'on' : 'off'}.` }),
          ' Change it in Settings → Providers.'),
      ],
    });
  }

  function draw({ preserveScroll = true } = {}) {
    const root = view();
    const scrollTop = preserveScroll && root ? root.scrollTop : null;
    const pageY = preserveScroll ? window.scrollY : 0;

    renderView(pageNode());

    if (root && scrollTop !== null) root.scrollTop = scrollTop;
    window.scrollTo({ top: pageY });
  }

  draw({ preserveScroll: false });
}
