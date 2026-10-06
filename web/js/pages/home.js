import { el, img, safeUrl } from '../utils/sanitize.js';
import { badge, emptyState, icon, setActiveNav, skeletonCards } from '../utils/helpers.js';
import { errorBanner, pageShell, renderView, section, view } from '../components/shell.js';
import { detailPathFor, favoriteButton, mediaGrid, sectionBlock } from '../components/cards.js';
import { formatYear } from '../utils/format.js';
import {
  getSettings, isInProgress, listFavorites, listHistory, providerLabel,
} from '../state.js';
import { discover, loadHome } from '../catalog.js';

const PROXY_HINT = 'No titles came back from your enabled providers. Most of them need a proxy URL in Settings → Data & network before a browser can reach them.';

function watchPathFor(item) {
  const id = encodeURIComponent(String(item.id));
  return item.media_type === 'series'
    ? `#/watch/${item.provider}/${id}/0/1`
    : `#/watch/${item.provider}/${id}`;
}

function recordToCatalog(record) {
  return {
    provider: record.provider,
    id: record.subject_id,
    title: record.title,
    media_type: Number(record.stype) === 2 ? 'series' : 'movie',
    year: record.release_year || '',
    poster_url: record.cover_url || '',
    stype: Number(record.stype) || 1,
  };
}

function heroNode(item) {
  const backdrop = safeUrl(item.poster_url);
  const kind = item.media_type === 'series' ? 'Series' : 'Movie';

  return el('section', { class: 'hero', 'aria-label': `Featured: ${item.title}` },
    backdrop
      ? img(backdrop, '', {
        class: 'hero-bg',
        eager: true,
        style: { filter: 'blur(2px) saturate(1.05)', transform: 'scale(1.06)' },
      })
      : null,
    el('div', { class: 'hero-inner' },
      el('h1', { class: 'hero-title', text: item.title }),
      el('p', { class: 'hero-meta' },
        item.year ? badge(formatYear(item.year)) : null,
        badge(kind, 'badge-accent'),
        badge(providerLabel(item.provider))),
      el('div', { class: 'btn-row' },
        el('a', {
          class: 'btn',
          href: watchPathFor(item),
          'aria-label': `Play ${item.title}`,
        }, icon('play'), el('span', { text: 'Play' })),
        el('a', {
          class: 'btn btn-ghost',
          href: detailPathFor(item),
          'aria-label': `More info about ${item.title}`,
        }, icon('info'), el('span', { text: 'More info' })),
        favoriteButton(item))));
}

function skeletonNode() {
  return el('div', { class: 'page', 'aria-busy': 'true' },
    el('p', { class: 'sr-only', text: 'Loading home page' }),
    el('div', { class: 'sk sk-hero', 'aria-hidden': 'true' }),
    el('div', { class: 'section' },
      el('div', { class: 'grid' }, skeletonCards(12))),
    el('div', { class: 'section' },
      el('div', { class: 'grid' }, skeletonCards(8))));
}

export async function render(ctx, opts = {}) {
  ctx.setTitle('Home');
  setActiveNav('home');

  const signal = ctx.signal;
  const continueItems = getSettings().continueWatching
    ? listHistory().filter(isInProgress).slice(0, 14).map(recordToCatalog)
    : [];

  let disposed = false;
  let loaded = false;
  let homeData = { hero: [], sections: [], errors: [] };
  let fallbackItems = [];

  function favoriteItems() {
    return listFavorites()
      .slice()
      .sort((a, b) => (Number(b.added_at) || 0) - (Number(a.added_at) || 0))
      .slice(0, 14)
      .map(recordToCatalog);
  }

  function emptyNode(hasErrors) {
    return emptyState({
      icon: 'film',
      title: 'Nothing to show yet',
      message: hasErrors
        ? 'The providers above could not be reached. Add a proxy URL in Settings → Data & network, then press Retry.'
        : PROXY_HINT,
      action: el('a', { class: 'btn', href: '#/settings', text: 'Open settings' }),
    });
  }

  function pageNode() {
    const children = [];
    const errors = homeData.errors || [];
    const heroItem = (homeData.hero || []).find((item) => item && item.poster_url) || null;
    const rows = [];

    if (continueItems.length) {
      rows.push(sectionBlock({
        id: 'continue',
        title: 'Continue watching',
        items: continueItems,
        link: { href: '#/history', label: 'See all' },
      }));
    }

    const favorites = favoriteItems();
    if (favorites.length) {
      rows.push(sectionBlock({
        id: 'favorites',
        title: 'Your favorites',
        items: favorites,
        link: { href: '#/favorites', label: 'See all' },
      }));
    }

    for (const block of homeData.sections || []) {
      if (block?.items?.length) rows.push(sectionBlock(block));
    }

    if (fallbackItems.length) {
      rows.push(section({
        title: 'Popular movies',
        children: [mediaGrid(fallbackItems)],
      }));
    }

    const banner = errorBanner(errors, { onRetry: () => { void reload(); } });
    const hasContent = Boolean(heroItem) || rows.length > 0;

    if (banner) children.push(banner);
    if (heroItem) children.push(heroNode(heroItem));
    else children.push(pageShell({
      title: 'Home',
      subtitle: 'Featured rows from the providers you have enabled.',
    }));
    children.push(...rows);
    if (!hasContent) children.push(emptyNode(errors.length > 0));

    return el('div', { class: 'page' }, ...children);
  }

  function draw({ preserveScroll = false } = {}) {
    if (disposed || signal.aborted || !loaded) return;
    const root = view();
    const scrollTop = preserveScroll && root ? root.scrollTop : null;
    const pageY = preserveScroll ? window.scrollY : 0;

    renderView(pageNode());

    if (root && scrollTop !== null) root.scrollTop = scrollTop;
    if (preserveScroll) window.scrollTo({ top: pageY });
  }

  async function reload() {
    if (disposed || signal.aborted) return;
    loaded = false;
    renderView(skeletonNode());

    let data;
    try {
      data = await loadHome({ signal });
    } catch (err) {
      data = { hero: [], sections: [], errors: [{ provider: 'catalog', label: 'Catalog', error: err }] };
    }
    if (disposed || signal.aborted) return;

    const errors = Array.isArray(data.errors) ? [...data.errors] : [];
    let fallback = [];
    if (!(data.sections || []).length && errors.length) {
      try {
        const fb = await discover({ kind: 'movie', signal, limit: 24 });
        if (disposed || signal.aborted) return;
        fallback = fb.items || [];
        errors.push(...(fb.errors || []));
      } catch (err) {
        errors.push({ provider: 'catalog', label: 'Catalog', error: err });
      }
      if (disposed || signal.aborted) return;
    }

    homeData = {
      hero: data.hero || [],
      sections: data.sections || [],
      errors,
    };
    fallbackItems = fallback;
    loaded = true;
    draw();
  }

  function onCardClick(event) {
    const target = event.target;
    const anchor = target && target.closest ? target.closest('a.card') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    event.preventDefault();
    ctx.navigate(href);
  }

  const root = view();
  const onFavoritesChanged = () => {
    if (disposed || signal.aborted) return;
    draw({ preserveScroll: true });
  };

  if (root) root.addEventListener('click', onCardClick);
  document.addEventListener('favorites-changed', onFavoritesChanged);

  await reload();

  return () => {
    disposed = true;
    document.removeEventListener('favorites-changed', onFavoritesChanged);
    if (root) root.removeEventListener('click', onCardClick);
  };
}
