import { el } from '../utils/sanitize.js';
import { emptyState, icon, setActiveNav, skeletonCards } from '../utils/helpers.js';
import {
  errorBanner, gridSkeleton, inlineError, pageShell, renderView, segmented, view,
} from '../components/shell.js';
import { mediaGrid } from '../components/cards.js';
import { plural } from '../utils/format.js';
import { debounce } from '../utils/debounce.js';
import { getSettings } from '../state.js';
import { searchAggregated } from '../catalog.js';

const TYPES = ['all', 'movie', 'series'];

function loadingGrid(label) {
  const node = gridSkeleton(12, label);
  const grid = node.querySelector('#skeleton-grid');
  if (grid) grid.appendChild(skeletonCards(12));
  return node;
}

export async function render(ctx, opts = {}) {
  const signal = ctx.signal;
  const q = String(ctx.query.q || '').trim();
  const type = TYPES.includes(ctx.query.type) ? ctx.query.type : 'all';

  ctx.setTitle(q ? `Search — ${q}` : 'Search');
  setActiveNav('search');

  let disposed = false;
  const delay = Number(getSettings().searchDebounceMs) || 350;

  const pushQuery = debounce((value) => {
    if (disposed) return;
    ctx.navigate('/search', {
      q: value || undefined,
      type: type === 'all' ? undefined : type,
    }, { replace: true });
  }, delay);

  const input = el('input', {
    class: 'input',
    type: 'search',
    id: 'search-input',
    name: 'q',
    value: q,
    placeholder: 'Search movies, series, anime…',
    autocomplete: 'off',
    'aria-label': 'Search titles',
  });

  let lastValue = q;
  input.addEventListener('input', () => {
    const value = input.value;
    if (value === lastValue) return;
    lastValue = value;
    if (value.trim() === q) return;
    pushQuery(value);
  });

  const form = el('form', {
    class: 'search-bar',
    role: 'search',
    'aria-label': 'Search every enabled provider',
    onsubmit: (event) => {
      event.preventDefault();
      pushQuery.cancel();
      const value = input.value.trim();
      ctx.navigate('/search', { ...ctx.query, q: value || undefined });
    },
  },
  el('div', { class: 'search-input-wrap' }, icon('search'), input),
  el('button', { class: 'btn', type: 'submit' }, icon('search'), el('span', { text: 'Search' })),
  segmented({
    label: 'Filter results by type',
    options: [
      { value: 'all', label: 'All' },
      { value: 'movie', label: 'Movies' },
      { value: 'series', label: 'Series' },
    ],
    value: type,
    onChange: (value) => {
      pushQuery.cancel();
      ctx.navigate('/search', {
        ...ctx.query,
        q: q || undefined,
        type: value === 'all' ? undefined : value,
      });
    },
  }));

  function paint(children) {
    if (disposed) return;
    const active = document.activeElement;
    const focused = Boolean(active && active.id === 'search-input');
    let start = null;
    let end = null;
    if (focused) {
      try {
        start = active.selectionStart;
        end = active.selectionEnd;
      } catch {
        start = null;
        end = null;
      }
    }

    renderView(pageShell({
      title: 'Search',
      subtitle: 'One query across the providers you have enabled.',
      children: [form, ...children],
    }));

    if (!focused) return;
    const node = document.getElementById('search-input');
    if (!node) return;
    node.focus();
    const len = node.value.length;
    const from = Math.min(Math.max(start ?? len, 0), len);
    const to = Math.min(Math.max(end ?? len, 0), len);
    node.setSelectionRange(from, to);
  }

  async function run() {
    if (disposed || signal.aborted) return;

    if (!q) {
      paint([emptyState({
        icon: 'search',
        title: 'Search MovieBox, 4KHDHub, Dramachi and more',
        message: 'Type a title above. Press / to focus search anywhere.',
      })]);
      return;
    }

    paint([loadingGrid('Searching')]);

    let result;
    try {
      result = await searchAggregated({ query: q, kind: type, signal, limit: 60 });
    } catch (err) {
      if (disposed || signal.aborted) return;
      paint([inlineError(err, {
        onRetry: () => { void run(); },
        title: `Could not search for “${q}”`,
      })]);
      return;
    }
    if (disposed || signal.aborted) return;

    const items = result.items || [];
    const errors = result.errors || [];
    const children = [];

    if (errors.length) children.push(errorBanner(errors, { onRetry: () => { void run(); } }));

    if (items.length) {
      children.push(el('p', {
        class: 'result-count',
        text: `${plural(items.length, 'result')} for “${q}”`,
      }));
      children.push(mediaGrid(items));
    } else if (errors.length) {
      children.push(inlineError(errors[0] ? errors[0].error : null, {
        onRetry: () => { void run(); },
        title: `No results for “${q}”`,
      }));
    } else {
      children.push(emptyState({
        icon: 'search',
        title: `No results for “${q}”`,
        message: 'Nothing matched across your enabled providers. Try a shorter spelling or switch the type filter back to All.',
      }));
    }

    paint(children);
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

  await run();

  return () => {
    disposed = true;
    pushQuery.cancel();
    if (root) root.removeEventListener('click', onCardClick);
  };
}
