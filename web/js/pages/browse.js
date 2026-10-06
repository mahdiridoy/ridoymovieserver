import { el } from '../utils/sanitize.js';
import { emptyState, ghostAction, setActiveNav, skeletonCards } from '../utils/helpers.js';
import {
  errorBanner, gridSkeleton, inlineError, pageShell, renderView, view,
} from '../components/shell.js';
import { mediaGrid } from '../components/cards.js';
import { plural } from '../utils/format.js';
import { providerLabel } from '../state.js';
import { discover, loadHome } from '../catalog.js';

const COPY = {
  movie: { title: 'Movies', subtitle: 'Movies from every provider you have enabled.' },
  series: { title: 'Series', subtitle: 'Episodic shows from every provider you have enabled.' },
  drama: { title: 'Anime & Drama', subtitle: 'Anime and Asian dramas from every provider you have enabled.' },
};

const NAV_KEY = { movie: 'movies', series: 'series', drama: 'drama' };

function matchesKind(item, kind) {
  if (kind === 'movie') return item.media_type === 'movie';
  if (kind === 'series') return item.media_type === 'series';
  return true;
}

function loadingGrid(label) {
  const node = gridSkeleton(12, label);
  const grid = node.querySelector('#skeleton-grid');
  if (grid) grid.appendChild(skeletonCards(12));
  return node;
}

export async function render(ctx, opts = {}) {
  const kind = ['movie', 'series', 'drama'].includes(opts.kind) ? opts.kind : 'movie';
  const { title, subtitle } = COPY[kind];

  ctx.setTitle(title);
  setActiveNav(NAV_KEY[kind]);

  const signal = ctx.signal;
  let disposed = false;

  function emptyNode(hasErrors) {
    return emptyState({
      icon: 'film',
      title: 'Nothing to show yet',
      message: hasErrors
        ? 'The providers above did not return anything for this page. Check Settings → Providers, add a proxy URL if one is required, then press Refresh.'
        : 'No titles matched right now. The catalogues of your enabled providers may be empty, or every source may be unreachable — a proxy URL in Settings → Data & network usually fixes that.',
      action: el('a', { class: 'btn', href: '#/settings', text: 'Open settings' }),
    });
  }

  async function reload() {
    if (disposed || signal.aborted) return;

    const refresh = ghostAction('Refresh', 'refresh', () => { void reload(); });
    renderView(pageShell({
      title,
      subtitle,
      actions: [refresh],
      children: [loadingGrid('Loading titles')],
    }));

    let home;
    let disc;
    try {
      [home, disc] = await Promise.all([
        loadHome({ signal }),
        discover({ kind, signal, limit: 40 }),
      ]);
    } catch (err) {
      if (disposed || signal.aborted) return;
      renderView(pageShell({
        title,
        subtitle,
        actions: [refresh],
        children: [inlineError(err, { onRetry: () => { void reload(); } })],
      }));
      return;
    }
    if (disposed || signal.aborted) return;

    const errors = [...(home.errors || []), ...(disc.errors || [])];
    const items = [];
    const seen = new Set();
    const push = (item) => {
      if (!item || !matchesKind(item, kind)) return;
      const key = `${item.provider}:${item.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push(item);
    };
    for (const block of home.sections || []) {
      for (const item of block.items || []) push(item);
    }
    for (const item of disc.items || []) push(item);

    const children = [];
    const banner = errorBanner(errors, { onRetry: () => { void reload(); } });
    if (banner) children.push(banner);

    if (items.length) {
      const labels = [...new Set(items.map((item) => providerLabel(item.provider)))];
      children.push(el('p', {
        class: 'result-count',
        text: `${plural(items.length, 'title')} · ${labels.join(', ')}`,
      }));
      children.push(mediaGrid(items));
    } else {
      children.push(emptyNode(errors.length > 0));
    }

    renderView(pageShell({
      title,
      subtitle,
      actions: [ghostAction('Refresh', 'refresh', () => { void reload(); })],
      children,
    }));
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
  if (root) root.addEventListener('click', onCardClick);

  await reload();

  return () => {
    disposed = true;
    if (root) root.removeEventListener('click', onCardClick);
  };
}
