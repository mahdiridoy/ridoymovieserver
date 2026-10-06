/* Title details page: hero, facts, season tabs, episode list. */

import { el, img, safeUrl } from '../utils/sanitize.js';
import { icon, ghostAction } from '../utils/helpers.js';
import { renderView, pageShell, inlineError, errorBanner } from '../components/shell.js';
import { favoriteButton } from '../components/cards.js';
import { formatRuntime, formatYear, formatTime } from '../utils/format.js';
import {
  providerLabel, getShowHistory, getResumePoint, isEpisodeWatched,
} from '../state.js';
import { detailsFor } from '../catalog.js';
import { ProviderError } from '../api.js';

function watchPath(details, season = 0, episode = 1) {
  const base = `#/watch/${details.provider}/${encodeURIComponent(details.id)}`;
  return details.media_type === 'series' ? `${base}/${season}/${episode}` : base;
}

function resumeTarget(details) {
  if (details.media_type !== 'series' || !details.seasons?.length) return { season: 0, episode: 1 };
  const history = getShowHistory(details.provider, details.id);
  if (history && !history.completed) return { season: history.season, episode: history.episode };
  if (history?.completed) {
    const next = nextEpisode(details, history.season, history.episode);
    if (next) return { season: next.season, episode: next.number };
  }
  const first = details.seasons[0];
  return { season: first.number, episode: first.episodes?.[0]?.number ?? 1 };
}

function nextEpisode(details, season, episode) {
  const list = details.seasons || [];
  const idx = list.findIndex((s) => s.number === season);
  if (idx < 0) return null;
  const current = list[idx];
  const eps = current.episodes || [];
  const pos = eps.findIndex((e) => e.number === episode);
  if (pos >= 0 && pos + 1 < eps.length) return { season, number: eps[pos + 1].number, title: eps[pos + 1].title };
  if (idx + 1 < list.length) {
    const nxt = list[idx + 1];
    return { season: nxt.number, number: nxt.episodes?.[0]?.number ?? 1, title: nxt.episodes?.[0]?.title };
  }
  return null;
}

function factsList(details) {
  const facts = [];
  if (details.director) facts.push(['Director', details.director]);
  if (details.stars) facts.push(['Stars', details.stars]);
  if (details.genres?.length) facts.push(['Genres', details.genres.join(', ')]);
  if (details.prints) facts.push(['Prints', details.prints]);
  if (details.audios) facts.push(['Audio', details.audios]);
  if (details.media_type === 'movie' && details.duration) facts.push(['Runtime', formatRuntime(details.duration) || details.duration]);
  if (details.release_year && details.year && String(details.release_year) !== String(details.year)) {
    facts.push(['Release', String(details.release_year)]);
  }
  return facts;
}

function drawHero(details) {
  const backdropUrl = safeUrl(details.poster_url);
  const metaBits = [];
  if (details.year) metaBits.push(el('span', { text: formatYear(details.year) }));
  if (details.media_type === 'series' && details.seasons?.length) {
    metaBits.push(el('span', { text: `${details.seasons.length} season${details.seasons.length > 1 ? 's' : ''}` }));
  } else if (details.duration) {
    metaBits.push(el('span', { text: formatRuntime(details.duration) || '' }));
  }
  metaBits.push(el('span', { text: details.media_type === 'series' ? 'Series' : 'Movie' }));
  metaBits.push(el('span', { class: 'provider-tag', text: providerLabel(details.provider) }));

  const resume = resumeTarget(details);
  const history = getShowHistory(details.provider, details.id);
  const continueLabel = history && !history.completed && (history.progress_seconds || 0) > 5
    ? `Continue S${String(history.season).padStart(2, '0')}E${String(history.episode).padStart(2, '0')}`
    : (details.media_type === 'series' ? 'Play first episode' : 'Play');

  const playBtn = el('a', {
    class: 'btn',
    href: watchPath(details, resume.season, resume.episode),
    'aria-label': `${continueLabel}: ${details.title}`,
  }, icon('play'), el('span', { text: continueLabel }));

  const facts = factsList(details);

  return el('div', { class: 'details-hero' },
    backdropUrl ? el('div', { class: 'details-backdrop', style: { backgroundImage: `url("${backdropUrl}")` } }) : null,
    el('div', { class: 'details-body' },
      details.poster_url
        ? el('div', { class: 'details-poster' }, img(safeUrl(details.poster_url), `${details.title} poster`))
        : null,
      el('div', { class: 'details-info' },
        el('h1', { class: 'details-title', text: details.title }),
        el('div', { class: 'details-meta' },
          ...metaBits,
          details.imdb_rating ? el('span', { class: 'rating', text: `★ ${details.imdb_rating}` }) : null),
        el('div', { class: 'btn-row' }, playBtn, favoriteButton(details)),
        details.tagline ? el('p', { class: 'details-overview', text: `“${details.tagline}”` }) : null,
        details.description ? el('p', { class: 'details-overview', text: details.description })
          : el('p', { class: 'details-overview muted', text: 'No description available.' }),
        facts.length
          ? el('dl', { class: 'details-facts' },
            ...facts.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })]))
          : null)));
}

function drawEpisodes(details, activeSeason, onSeason) {
  const seasons = details.seasons || [];
  if (!seasons.length) return null;
  const safeSeason = seasons.some((s) => s.number === activeSeason) ? activeSeason : seasons[0].number;
  const season = seasons.find((s) => s.number === safeSeason);
  const history = getShowHistory(details.provider, details.id);

  const tabs = el('div', { class: 'season-tabs', role: 'tablist', 'aria-label': 'Seasons' },
    ...seasons.map((s) => el('button', {
      class: `season-tab${s.number === safeSeason ? ' active' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(s.number === safeSeason),
      text: s.name || (s.number > 0 ? `Season ${s.number}` : 'Specials'),
      onclick: () => onSeason(s.number),
    })));

  const list = el('div', { class: 'episode-list', role: 'list' });
  for (const ep of season?.episodes || []) {
    const watched = isEpisodeWatched(details.provider, details.id, season.number, ep.number);
    const isCurrent = history && history.season === season.number && history.episode === ep.number;
    const resume = isCurrent && !history.completed ? getResumePoint(details.provider, details.id, season.number, ep.number) : null;
    list.appendChild(el('a', {
      class: 'episode',
      href: watchPath(details, season.number, ep.number),
      role: 'listitem',
      'aria-label': `Play ${ep.title || `Episode ${ep.number}`}`,
    },
    el('div', { class: 'episode-num', text: String(ep.number) }),
    el('div', { class: 'episode-body' },
      el('strong', { text: ep.title || `Episode ${ep.number}` }),
      el('p', {},
        watched ? el('span', { class: 'episode-watched', text: 'Watched' })
          : el('span', { text: ep.overview ? String(ep.overview).slice(0, 140) : `Episode ${ep.number}` }),
        resume ? el('span', { class: 'muted', text: ` · resumes at ${formatTime(resume.position)}` }) : null)),
    watched ? icon('check', 'ico') : icon('play', 'ico')));
  }

  return el('section', { class: 'section', 'aria-label': 'Episodes' }, tabs, list);
}

export async function render(ctx, opts = {}) {
  const { provider = '', id = '' } = ctx.params;
  let activeSeason = null;
  let details = null;

  const draw = () => {
    const resume = details ? resumeTarget(details) : null;
    const incompleteNote = details?.incomplete
      ? el('div', { class: 'callout', role: 'status' },
        icon('warning', 'ico'),
        el('div', {},
          el('strong', { text: 'Full details unavailable' }),
          el('p', { text: `The provider returned a limited response, so some information may be missing.` })))
      : null;

    if (!activeSeason && details?.seasons?.length) activeSeason = resume?.season ?? details.seasons[0].number;

    const episodes = details ? drawEpisodes(details, activeSeason, (n) => { activeSeason = n; draw(); }) : null;

    renderView(pageShell({
      children: [
        drawHero(details),
        incompleteNote,
        episodes,
        el('div', { class: 'btn-row' },
          ghostAction('Back to home', 'back', () => ctx.navigate('/home'))),
      ].filter(Boolean),
    }));
  };

  renderView(pageShell({ title: 'Loading…', children: [] }));
  try {
    details = await detailsFor(provider, id, { signal: ctx.signal });
  } catch (err) {
    if (ctx.signal.aborted || err?.name === 'AbortError') return;
    const wrapped = err instanceof ProviderError ? err : new ProviderError('network', String(err?.message || err));
    renderView(pageShell({
      title: 'Could not load title',
      children: [
        errorBanner([{ provider, label: providerLabel(provider), error: wrapped }]),
        inlineError(wrapped, {
          title: 'Details request failed',
          onRetry: () => ctx.navigate(`/${opts.kind || 'movie'}/${provider}/${encodeURIComponent(id)}`, ctx.query, { replace: true }),
        }),
        el('div', { class: 'btn-row' },
          el('a', { class: 'btn btn-ghost', href: '#/settings', text: 'Open settings' }),
          el('a', { class: 'btn btn-ghost', href: '#/home', text: 'Go home' })),
      ].filter(Boolean),
    }));
    return;
  }
  if (ctx.signal.aborted) return;

  ctx.setTitle(details.title);
  draw();
}
