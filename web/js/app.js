/*
 * Application bootstrap: navigation, theme, global shortcuts, route table.
 */

import { getSettings, applyTheme, resolvedTheme, toggleQuickTheme, migrate, store } from './state.js';
import { start as startRouter, register, navigate, parseHash, setNotFound } from './router.js';
import { cacheSweep } from './storage.js';
import { icon, setActiveNav, emptyState, toast } from './utils/helpers.js';
import { el, mount } from './utils/sanitize.js';

import * as homePage from './pages/home.js';
import * as browsePage from './pages/browse.js';
import * as searchPage from './pages/search.js';
import * as detailsPage from './pages/details.js';
import * as favoritesPage from './pages/favorites.js';
import * as historyPage from './pages/history.js';
import * as settingsPage from './pages/settings.js';
import * as addonsPage from './pages/addons.js';
import * as tvPage from './pages/tv.js';
import * as aboutPage from './pages/about.js';
import * as playerPage from './pages/player.js';

/* ---------------- Route table ---------------- */

const routes = [
  ['/', () => navigate('/home', null, { replace: true })],
  ['/home', (ctx) => homePage.render(ctx), { nav: 'home', title: 'Home' }],
  ['/movies', (ctx) => browsePage.render(ctx, { kind: 'movie' }), { nav: 'movies', title: 'Movies' }],
  ['/series', (ctx) => browsePage.render(ctx, { kind: 'series' }), { nav: 'series', title: 'Series' }],
  ['/drama', (ctx) => browsePage.render(ctx, { kind: 'drama' }), { nav: 'drama', title: 'Anime & Drama' }],
  ['/search', (ctx) => searchPage.render(ctx), { nav: 'search', title: 'Search' }],
  ['/movie/:provider/:id', (ctx) => detailsPage.render(ctx, { kind: 'movie' }), { title: 'Title' }],
  ['/series/:provider/:id', (ctx) => detailsPage.render(ctx, { kind: 'series' }), { title: 'Title' }],
  ['/drama/:provider/:id', (ctx) => detailsPage.render(ctx, { kind: 'drama' }), { title: 'Title' }],
  ['/tv', (ctx) => tvPage.render(ctx), { nav: 'tv', title: 'Live TV' }],
  ['/favorites', (ctx) => favoritesPage.render(ctx), { nav: 'favorites', title: 'Favorites' }],
  ['/history', (ctx) => historyPage.render(ctx), { nav: 'history', title: 'History' }],
  ['/addons', (ctx) => addonsPage.render(ctx), { nav: 'addons', title: 'Addons' }],
  ['/settings', (ctx) => settingsPage.render(ctx), { nav: 'settings', title: 'Settings' }],
  ['/about', (ctx) => aboutPage.render(ctx), { nav: 'about', title: 'About' }],
  ['/watch/:provider/:id/:season/:episode', (ctx) => playerPage.render(ctx), { nav: null, title: 'Playing' }],
  ['/watch/:provider/:id', (ctx) => playerPage.render(ctx, { movie: true }), { nav: null, title: 'Playing' }],
];

function navKeyForPath(path) {
  for (const route of routes) {
    if (!route[2]) continue;
    const pattern = route[0];
    const rx = new RegExp(`^${pattern.replace(/:([A-Za-z0-9_]+)/g, '[^/]+').replace(/\*/g, '.*')}/?$`);
    if (rx.test(path)) return route[2].nav;
  }
  if (path.startsWith('/movie/') || path.startsWith('/series/') || path.startsWith('/drama/')) return null;
  return null;
}

function titleForPath(path) {
  for (const route of routes) {
    if (!route[2]) continue;
    const pattern = route[0];
    const rx = new RegExp(`^${pattern.replace(/:([A-Za-z0-9_]+)/g, '[^/]+').replace(/\*/g, '.*')}/?$`);
    if (rx.test(path)) return route[2].title || '';
  }
  return '';
}

/* ---------------- Chrome ---------------- */

function setupNavigation() {
  const closeSheet = () => {
    document.body.classList.remove('nav-open');
    const toggle = document.getElementById('menu-toggle');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  };

  const menuToggle = document.getElementById('menu-toggle');
  menuToggle?.addEventListener('click', () => {
    const open = document.body.classList.toggle('nav-open');
    menuToggle.setAttribute('aria-expanded', String(open));
  });

  document.getElementById('sidebar')?.addEventListener('click', (e) => {
    if (e.target.closest('a')) closeSheet();
  });

  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('nav-open')
      && !e.target.closest('#sidebar')
      && !e.target.closest('#menu-toggle')) {
      closeSheet();
    }
  });

  const moreBtn = document.getElementById('more-toggle');
  moreBtn?.addEventListener('click', () => openMoreSheet(closeSheet));
}

function openMoreSheet(closeNav) {
  const root = document.getElementById('sheet-root');
  if (!root) return;
  mount(root);

  const backdrop = el('div', { class: 'sheet-backdrop', onclick: () => close() });
  const links = [
    ['#/series', 'tv', 'Series'],
    ['#/drama', 'film', 'Anime / Drama'],
    ['#/history', 'history', 'History'],
    ['#/addons', 'grid', 'Addons'],
    ['#/settings', 'settings', 'Settings'],
    ['#/about', 'info', 'About'],
  ];
  const sheet = el('div', { class: 'bottom-sheet', role: 'dialog', 'aria-label': 'More navigation' },
    el('div', { class: 'sheet-grabber' }),
    ...links.map(([href, ic, label]) => el('a', {
      class: 'sheet-link', href, onclick: () => close(),
    }, icon(ic), el('span', { text: label }))),
  );
  root.appendChild(backdrop);
  root.appendChild(sheet);

  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);

  function close() {
    document.removeEventListener('keydown', onKey);
    mount(root);
    closeNav?.();
  }
}

function setupTopSearch() {
  const form = document.getElementById('top-search');
  const input = document.getElementById('top-search-input');
  if (!form || !input) return;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    const { path, query } = parseHash();
    if (path === '/search') {
      navigate('/search', { ...query, q: q || undefined });
    } else {
      navigate('/search', q ? { q } : {});
    }
    input.blur();
  });

  let last = '';
  input.addEventListener('input', () => {
    const { path, query } = parseHash();
    if (path !== '/search') return;
    const value = input.value;
    if (value === last) return;
    last = value;
    window.clearTimeout(input._t);
    input._t = window.setTimeout(() => {
      navigate('/search', { ...query, q: value || undefined }, { replace: true });
    }, getSettings().searchDebounceMs || 350);
  });

  store.on('route', (payload) => {
    if (payload?.path === '/search') {
      const q = payload.query?.q || '';
      if (input.value !== q && document.activeElement !== input) {
        input.value = q;
        last = q;
      }
    }
  });
}

function setupThemeToggle() {
  document.getElementById('theme-quick')?.addEventListener('click', () => {
    const next = toggleQuickTheme();
    toast({ type: 'info', title: 'Theme', message: next === 'latte' ? 'Light theme' : 'Dark theme', timeout: 1600 });
  });
}

function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable;
    if (typing) return;
    if (e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      const topInput = document.getElementById('top-search-input');
      if (topInput) {
        topInput.focus();
        topInput.select();
      } else {
        navigate('/search');
      }
    } else if (e.key === 'Escape') {
      document.body.classList.remove('nav-open');
    }
  });
}

/* ---------------- Boot ---------------- */

function registerRoutes() {
  for (const [pattern, handler, meta] of routes) {
    register(pattern, handler, meta || {});
  }
  setNotFound((ctx) => {
    mount(document.getElementById('view'), emptyState({
      icon: 'search',
      title: 'Page not found',
      message: `Nothing matches ${ctx.path}.`,
      action: el('a', { class: 'btn', href: '#/home', text: 'Go home' }),
    }));
    setActiveNav(null);
    ctx.setTitle('Not found');
    return null;
  });
}

function watchRouteChrome() {
  window.addEventListener('hashchange', () => {
    const { path, query } = parseHash();
    setActiveNav(navKeyForPath(path));
    const title = titleForPath(path);
    document.title = title ? `${title} — MovieBox Web` : 'MovieBox Web';
    store.emit('route', { path, query });
    const menuToggle = document.getElementById('menu-toggle');
    if (menuToggle) menuToggle.setAttribute('aria-expanded', 'false');
  });
}

async function boot() {
  applyTheme();
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (getSettings().theme === 'system') applyTheme();
  });

  migrate();
  cacheSweep().catch(() => {});

  setupNavigation();
  setupTopSearch();
  setupThemeToggle();
  setupShortcuts();
  registerRoutes();
  watchRouteChrome();
  startRouter();

  const { path, query } = parseHash();
  setActiveNav(navKeyForPath(path));
  store.emit('route', { path, query });
}

boot().catch((err) => {
  console.error('boot failed', err);
  const view = document.getElementById('view');
  if (view) {
    mount(view, emptyState({
      icon: 'error',
      title: 'MovieBox Web failed to start',
      message: String(err?.message || err),
      error: true,
    }));
  }
});

export { resolvedTheme };
