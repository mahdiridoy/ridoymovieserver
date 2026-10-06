/*
 * Hash-based router (required for GitHub Pages / static hosting).
 *
 * Routes are registered as:  #/movie/:provider/:id
 * Query strings live after `?`:  #/search?q=interstellar&filter=movie
 *
 * The active handler receives a context and may return a cleanup function
 * which runs before the next route renders. An AbortSignal is provided so
 * in-flight requests are cancelled on navigation.
 */

const routes = [];
let currentCleanup = null;
let currentController = null;
let currentKey = '';
let started = false;
let notFoundHandler = null;

function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/\/+$/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:([A-Za-z0-9_]+)/g, (_m, key) => {
      keys.push(key);
      return '/([^/]+)';
    })
    .replace(/\*/g, '.*');
  return { regex: new RegExp(`^${source}/?$`), keys };
}

export function register(pattern, handler, meta = {}) {
  const { regex, keys } = compile(pattern);
  routes.push({ pattern, regex, keys, handler, meta });
}

export function setNotFound(handler) {
  notFoundHandler = handler;
}

export function parseHash(hash = location.hash) {
  let raw = String(hash || '').replace(/^#/, '');
  if (!raw) raw = '/';
  if (!raw.startsWith('/')) raw = `/${raw}`;
  const [pathPart, queryPart = ''] = raw.split('?');
  const path = pathPart.replace(/\/+$/, '') || '/';
  const segments = path.split('/').filter(Boolean);
  const query = {};
  if (queryPart) {
    for (const [k, v] of new URLSearchParams(queryPart).entries()) {
      if (k) query[k] = v;
    }
  }
  return { path, segments, query, raw };
}

export function buildHash(path, query = null) {
  const clean = String(path || '/').startsWith('/') ? path : `/${path}`;
  const qs = query ? new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString() : '';
  return `#${clean}${qs ? `?${qs}` : ''}`;
}

export function navigate(path, query = null, { replace = false } = {}) {
  const target = buildHash(path, query);
  if (location.hash === target) {
    handleRoute();
    return;
  }
  if (replace) {
    const url = `${location.pathname}${location.search}${target}`;
    history.replaceState(null, '', url);
    handleRoute();
  } else {
    location.hash = target;
  }
}

export function currentRoute() {
  return parseHash();
}

function match(path) {
  for (const route of routes) {
    const m = route.regex.exec(path);
    if (m) {
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1] || ''); });
      return { route, params };
    }
  }
  return null;
}

async function handleRoute() {
  const parsed = parseHash();
  const key = `${parsed.path}?${new URLSearchParams(parsed.query).toString()}`;

  if (currentCleanup) {
    try { currentCleanup(); } catch (err) { console.error('route cleanup failed', err); }
    currentCleanup = null;
  }
  if (currentController) currentController.abort();
  currentController = new AbortController();

  const found = match(parsed.path);
  const signal = currentController.signal;
  const ctx = {
    ...parsed,
    params: found ? found.params : {},
    signal,
    meta: found ? found.route.meta : {},
    navigate: (p, q, opts) => navigate(p, q, opts),
    setTitle: (title) => { document.title = title ? `${title} — MovieBox Web` : 'MovieBox Web'; },
  };

  currentKey = key;

  try {
    if (found) {
      const result = found.route.handler(ctx);
      if (result && typeof result.then === 'function') {
        const resolved = await result;
        if (signal.aborted) {
          if (typeof resolved === 'function') resolved();
          return;
        }
        currentCleanup = typeof resolved === 'function' ? resolved : null;
      } else {
        currentCleanup = typeof result === 'function' ? result : null;
      }
    } else if (notFoundHandler) {
      const result = notFoundHandler(ctx);
      currentCleanup = typeof result === 'function' ? result : null;
    } else {
      navigate('/home', null, { replace: true });
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error('route render failed', err);
    const view = document.getElementById('view');
    if (view) {
      const { emptyState, icon } = await import('./utils/helpers.js');
      const { mount } = await import('./utils/sanitize.js');
      mount(view, emptyState({
        icon: 'error',
        title: 'This page failed to load',
        message: String(err?.message || err),
        error: true,
      }));
    }
  }

  if (signal.aborted) return;

  const view = document.getElementById('view');
  if (view) view.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

export function start() {
  if (started) return;
  started = true;
  window.addEventListener('hashchange', handleRoute);
  if (!location.hash || location.hash === '#') {
    history.replaceState(null, '', `${location.pathname}${location.search}#/home`);
  }
  handleRoute();
}

export function reload() {
  handleRoute();
}
