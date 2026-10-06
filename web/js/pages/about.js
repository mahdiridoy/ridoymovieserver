import { el } from '../utils/sanitize.js';
import { badge, setActiveNav } from '../utils/helpers.js';
import { pageShell, renderView, section } from '../components/shell.js';
import { REGISTRY } from '../catalog.js';
import { getSettings, providerLabel } from '../state.js';

const DISCLAIMER = 'MovieBox-TUI does not host or store media. It plays publicly available streams. Users must comply with local laws.';

const PROVIDER_NOTES = {
  moviebox: 'Signed API — browser requests need a proxy configured in Settings.',
  fourkhdhub: 'Scrapes public pages — browser requests need a proxy configured in Settings.',
  dramachi: 'JSON API — browser requests need a proxy configured in Settings.',
  bdix_circleftp: 'BDIX networks only (Bangladesh ISPs) — off by default.',
  bdix_dhakaflix: 'BDIX networks only (Bangladesh ISPs) — off by default.',
};

export async function render(ctx, opts = {}) {
  ctx.setTitle('About');
  setActiveNav('about');

  const settings = getSettings();
  const providerRows = Object.keys(REGISTRY).map((key) => {
    const enabled = settings.providers ? settings.providers[key] !== false : true;
    return el('div', { class: 'panel-row' },
      el('div', { class: 'row-text' },
        el('strong', { text: providerLabel(key) }),
        el('span', { text: PROVIDER_NOTES[key] || 'No additional notes.' })),
      badge(enabled ? 'On' : 'Off', enabled ? 'badge-accent' : ''));
  });

  renderView(pageShell({
    title: 'About',
    subtitle: 'MovieBox Web — the MovieBox-TUI experience in your browser.',
    children: [
      section({
        title: 'What this is',
        children: [
          el('p', {
            text: 'MovieBox Web is a static, browser-based conversion of MovieBox-TUI, the Rust terminal application. It keeps the same core features — providers, search, details, favorites, history, Live TV and Stremio-style addons — as plain HTML, CSS and JavaScript that runs from GitHub Pages with no build step and no server of its own.',
          }),
          el('p', {
            text: 'Everything you see here is delivered as static files; the app talks to providers directly from your browser.',
          }),
        ],
      }),
      section({
        title: 'How data flows',
        children: [
          el('p', {
            text: 'Requests travel from your browser to the providers: direct when the provider allows it, or through an optional CORS proxy that you configure yourself.',
          }),
          el('p', {
            text: 'Favorites, history, watch progress, playlists, addons and settings stay in this browser’s localStorage and IndexedDB. They are never uploaded anywhere.',
          }),
          el('p', {
            text: 'There is no analytics, telemetry or tracking of any kind.',
          }),
        ],
      }),
      section({
        title: 'Providers',
        children: [el('div', { class: 'panel' }, ...providerRows)],
      }),
      section({
        title: 'Open source',
        children: [
          el('p', {},
            'MovieBox Web is free software released under the MIT OR Apache-2.0 licence. Source code: ',
            el('a', {
              href: 'https://github.com/MovieBox-TUI/MovieBox-TUI',
              target: '_blank',
              rel: 'noopener noreferrer',
              text: 'github.com/MovieBox-TUI/MovieBox-TUI',
            }),
            '.'),
        ],
      }),
      el('hr', { class: 'divider' }),
      el('p', { class: 'small', text: DISCLAIMER }),
    ],
  }));
}
