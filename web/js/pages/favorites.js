import { el } from '../utils/sanitize.js';
import {
  badge, confirmModal, emptyState, ghostAction, setActiveNav, toast,
} from '../utils/helpers.js';
import { pageShell, renderView, segmented, view } from '../components/shell.js';
import { mediaCard } from '../components/cards.js';
import { plural } from '../utils/format.js';
import { clearFavorites, listFavorites } from '../state.js';

export async function render(ctx, opts = {}) {
  ctx.setTitle('Favorites');
  setActiveNav('favorites');

  let filter = 'all';

  function allFavorites() {
    return listFavorites()
      .slice()
      .sort((a, b) => (Number(b.added_at) || 0) - (Number(a.added_at) || 0));
  }

  function visibleFavorites(items) {
    if (filter === 'movies') return items.filter((item) => Number(item.stype) === 1);
    if (filter === 'series') return items.filter((item) => Number(item.stype) === 2);
    return items;
  }

  function toCatalogItem(item) {
    return {
      provider: item.provider,
      id: item.subject_id,
      title: item.title,
      media_type: Number(item.stype) === 2 ? 'series' : 'movie',
      year: item.release_year || '',
      poster_url: item.cover_url || null,
    };
  }

  function bodyNode() {
    const items = allFavorites();
    if (!items.length) {
      return emptyState({
        icon: 'heart',
        title: 'No favorites yet',
        message: 'Save titles from any details page and they will appear here.',
        action: el('a', { class: 'btn', href: '#/home', text: 'Browse home' }),
      });
    }

    const shown = visibleFavorites(items);
    if (!shown.length) {
      return emptyState({
        icon: 'heart',
        title: 'Nothing in this filter',
        message: 'Your other saved titles are still here. Switch the filter above to see them.',
      });
    }

    return el('div', { class: 'grid' }, ...shown.map((item) => mediaCard(toCatalogItem(item))));
  }

  async function clearAll() {
    const confirmed = await confirmModal({
      title: 'Clear all favorites?',
      message: 'Every saved title will be removed from this browser. This cannot be undone.',
      confirmLabel: 'Clear favorites',
      danger: true,
    });
    if (!confirmed || ctx.signal.aborted) return;
    clearFavorites();
    toast({ type: 'success', title: 'Favorites cleared' });
    draw();
  }

  function pageNode() {
    const items = allFavorites();
    const children = [];

    if (items.length) {
      children.push(segmented({
        label: 'Filter favorites',
        options: [
          { value: 'all', label: 'All' },
          { value: 'movies', label: 'Movies' },
          { value: 'series', label: 'Series' },
        ],
        value: filter,
        onChange: (value) => {
          filter = value;
          draw({ focusFilter: true });
        },
      }));
    }
    children.push(bodyNode());

    return pageShell({
      title: 'Favorites',
      subtitle: 'Saved titles stay on this device.',
      actions: [
        badge(plural(items.length, 'title')),
        ghostAction('Clear all', 'trash', clearAll),
      ],
      children,
    });
  }

  function draw({ focusFilter = false, preserveScroll = true } = {}) {
    const root = view();
    const scrollTop = preserveScroll && root ? root.scrollTop : null;
    const pageY = preserveScroll ? window.scrollY : 0;

    renderView(pageNode());

    if (root && scrollTop !== null) root.scrollTop = scrollTop;
    window.scrollTo({ top: pageY });

    if (focusFilter) {
      const active = document.querySelector('#view .seg-btn[aria-checked="true"]');
      if (active) active.focus();
    }
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

  draw({ preserveScroll: false });

  const root = view();
  const onFavoritesChanged = () => {
    if (ctx.signal.aborted) return;
    draw();
  };

  if (root) root.addEventListener('click', onCardClick);
  document.addEventListener('favorites-changed', onFavoritesChanged);

  return () => {
    document.removeEventListener('favorites-changed', onFavoritesChanged);
    if (root) root.removeEventListener('click', onCardClick);
  };
}
