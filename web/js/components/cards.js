/* Shared media presentation components. */

import { el, img, mount, safeUrl } from '../utils/sanitize.js';
import { icon, badge, toast, confirmModal } from '../utils/helpers.js';
import {
  isFavorite, toggleFavorite, getResumePoint, getShowHistory, isInProgress, progressPercent,
} from '../state.js';
import { formatYear, formatRuntime, relativeTime } from '../utils/format.js';

export function detailPathFor(item) {
  const kind = item.media_type === 'series' ? 'series' : 'movie';
  return `#/${kind}/${item.provider}/${encodeURIComponent(item.id)}`;
}

export function posterNode(item, { eager = false } = {}) {
  const url = safeUrl(item.poster_url);
  const holder = el('div', { class: 'card-poster' });
  if (url) {
    const image = img(url, `${item.title} poster`, { eager });
    image.addEventListener('img-error', () => {
      mount(holder, fallbackPoster(item));
    });
    holder.appendChild(image);
    holder.appendChild(el('div', { class: 'card-badges' },
      item.year ? badge(formatYear(item.year), 'badge-rating') : null,
      item.media_type === 'series' ? badge('Series', 'badge-accent') : null,
    ));
  } else {
    mount(holder, fallbackPoster(item));
  }
  return holder;
}

function fallbackPoster(item) {
  return el('div', { class: 'poster-fallback' },
    el('strong', { text: String(item.title || '?').slice(0, 2) }),
    el('span', { text: String(item.title || 'Untitled').slice(0, 30) }));
}

function resumeBar(item) {
  const historyEntry = getShowHistory(item.provider, item.id);
  const resume = getResumePoint(item.provider, item.id, historyEntry?.season || 0, historyEntry?.episode || 0);
  const source = historyEntry || (resume ? { progress_seconds: resume.position, duration_seconds: resume.duration, completed: resume.completed } : null);
  if (!source) return null;
  if (source.completed) {
    return el('div', { class: 'resume-meta' }, el('span', { class: 'episode-watched', text: 'Watched' }));
  }
  const pct = progressPercent(source);
  if (pct === null && !isInProgress(source)) return null;
  return el('div', {},
    el('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': String(Math.round(pct || 0)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      el('span', { style: { width: `${Math.max(2, Math.round(pct || 0))}%` } })),
    el('div', { class: 'resume-meta' },
      el('span', { text: historyEntry ? `S${String(historyEntry.season).padStart(2, '0')}E${String(historyEntry.episode).padStart(2, '0')}` : 'Resume' }),
      el('span', { text: relativeTime(historyEntry?.timestamp ? historyEntry.timestamp * 1000 : Date.now()) })));
}

export function favoriteButton(item, { compact = false } = {}) {
  const identity = {
    provider: item.provider,
    subject_id: item.id,
    title: item.title,
    stype: item.media_type === 'series' ? 2 : 1,
    release_year: item.year || item.release_year || '',
  };
  const active = isFavorite(identity);
  const btn = el('button', {
    class: `mini-btn${active ? ' is-fav' : ''}`,
    type: 'button',
    'aria-pressed': String(active),
    'aria-label': active ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`,
    title: active ? 'Remove from favorites' : 'Add to favorites',
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nowFav = toggleFavorite(identity);
      btn.classList.toggle('is-fav', nowFav);
      btn.setAttribute('aria-pressed', String(nowFav));
      btn.setAttribute('aria-label', nowFav ? `Remove ${item.title} from favorites` : `Add ${item.title} to favorites`);
      toast({
        type: nowFav ? 'success' : 'info',
        title: nowFav ? 'Added to favorites' : 'Removed from favorites',
        message: item.title,
        timeout: 2200,
      });
      document.dispatchEvent(new CustomEvent('favorites-changed'));
    },
  }, icon('heart'));
  if (compact) btn.querySelector('svg').style.width = '16px';
  return btn;
}

/** Clickable media card used by grids and horizontal rows. */
export function mediaCard(item, { showResume = true, eager = false } = {}) {
  const anchor = el('a', {
    class: 'card',
    href: detailPathFor(item),
    'aria-label': `${item.title}${item.year ? `, ${item.year}` : ''}`,
  });

  anchor.appendChild(posterNode(item, { eager }));

  const actions = el('div', { class: 'card-actions' },
    el('a', {
      class: 'mini-btn', href: `#/watch/${item.provider}/${encodeURIComponent(item.id)}/0/1`,
      'aria-label': `Play ${item.title}`,
      onclick: (e) => { e.stopPropagation(); },
    }, icon('play'), el('span', { text: 'Play' })),
    favoriteButton(item, { compact: true }),
  );
  anchor.appendChild(actions);

  anchor.appendChild(el('p', { class: 'card-title', text: item.title }));
  const meta = [item.year ? formatYear(item.year) : '', item.media_type === 'series' ? 'Series' : 'Movie']
    .filter(Boolean).join(' · ');
  anchor.appendChild(el('p', { class: 'card-meta', text: meta }));

  if (showResume) {
    const bar = resumeBar(item);
    if (bar) anchor.appendChild(bar);
  }
  return anchor;
}

export function mediaGrid(items, { showResume = true } = {}) {
  const grid = el('div', { class: 'grid' });
  for (const item of items) grid.appendChild(mediaCard(item, { showResume }));
  return grid;
}

export function sectionBlock({ id, title, items, link = null, showResume = true }) {
  if (!items?.length) return null;
  return el('section', { class: 'section', 'aria-labelledby': `sec-${id}` },
    el('div', { class: 'section-head' },
      el('h2', { class: 'section-title', id: `sec-${id}`, text: title }),
      link ? el('a', { class: 'section-link', href: link.href, text: link.label }) : null),
    el('div', { class: 'row-scroller', role: 'list' },
      ...items.map((item) => mediaCard(item, { showResume }))));
}

export function detailsMeta(details) {
  const bits = [];
  if (details.year) bits.push(formatYear(details.year));
  if (details.duration) bits.push(formatRuntime(details.duration) || details.duration);
  if (details.media_type === 'series' && details.seasons?.length) {
    bits.push(`${details.seasons.length} season${details.seasons.length > 1 ? 's' : ''}`);
  }
  return bits.filter(Boolean);
}

export { toast, confirmModal };
