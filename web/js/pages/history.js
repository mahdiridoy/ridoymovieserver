import { el, img, mount, safeUrl } from '../utils/sanitize.js';
import {
  confirmModal, emptyState, ghostAction, icon, setActiveNav, toast,
} from '../utils/helpers.js';
import { pageShell, renderView, segmented, view } from '../components/shell.js';
import { detailPathFor } from '../components/cards.js';
import { formatTime, formatYear, relativeTime } from '../utils/format.js';
import {
  clearHistory,
  listHistory,
  markWatched,
  providerLabel,
  removeHistoryEntry,
  removeShowFromHistory,
} from '../state.js';
import { buildHash } from '../router.js';

const pad2 = (value) => String(value).padStart(2, '0');

export async function render(ctx, opts = {}) {
  ctx.setTitle('History');
  setActiveNav('history');

  let filter = 'all';

  function allEntries() {
    return listHistory();
  }

  function visibleEntries(entries) {
    if (filter === 'progress') {
      return entries.filter((entry) => !entry.completed && (Number(entry.progress_seconds) || 0) > 0);
    }
    if (filter === 'watched') return entries.filter((entry) => Boolean(entry.completed));
    return entries;
  }

  function watchHref(entry) {
    const provider = encodeURIComponent(entry.provider);
    const id = encodeURIComponent(entry.subject_id);
    const season = Number(entry.season) || 0;
    const episode = Number(entry.episode) || 0;
    return Number(entry.stype) === 2
      ? buildHash(`/watch/${provider}/${id}/${season}/${episode}`)
      : buildHash(`/watch/${provider}/${id}`);
  }

  function thumbNode(entry) {
    const box = el('div', {
      class: 'episode-thumb',
      style: { width: '72px', aspectRatio: '2 / 3' },
    });
    const url = safeUrl(entry.cover_url);

    if (url) {
      const image = img(url, `${entry.title} poster`, {
        style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' },
      });
      image.addEventListener('img-error', () => mount(box, thumbFallback(entry)));
      box.appendChild(image);
    } else {
      mount(box, thumbFallback(entry));
    }
    return box;
  }

  function thumbFallback(entry) {
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
      text: String(entry.title || '?').slice(0, 2),
    });
  }

  function rowNode(entry) {
    const isSeries = Number(entry.stype) === 2;
    const season = Number(entry.season) || 0;
    const episode = Number(entry.episode) || 0;
    const progress = Number(entry.progress_seconds) || 0;
    const duration = Number(entry.duration_seconds) || 0;
    const completed = Boolean(entry.completed);
    const percent = duration > 0
      ? Math.min(100, Math.max(0, (progress / duration) * 100))
      : (completed ? 100 : 0);
    const episodeCode = isSeries || season > 0
      ? `S${pad2(season)}E${pad2(episode)}`
      : '';
    const metaText = [
      providerLabel(entry.provider),
      episodeCode,
      formatYear(entry.release_year),
      relativeTime((Number(entry.timestamp) || 0) * 1000),
    ].filter(Boolean).join(' · ');
    const timeText = duration > 0
      ? `${formatTime(progress)} / ${formatTime(duration)}`
      : formatTime(progress);
    const detailItem = {
      provider: entry.provider,
      id: entry.subject_id,
      title: entry.title,
      media_type: isSeries ? 'series' : 'movie',
    };
    const resumeLabel = progress > 0 && !completed ? 'Resume' : 'Play';

    async function markAsWatched() {
      markWatched(entry);
      toast({ type: 'success', title: 'Marked as watched', message: entry.title });
      draw();
    }

    async function removeEntry() {
      const confirmed = await confirmModal({
        title: 'Remove from history?',
        message: `${entry.title} will be removed from your watch history on this device.`,
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!confirmed || ctx.signal.aborted) return;

      if (isSeries && season > 0 && episode > 0) {
        removeHistoryEntry(entry.provider, entry.subject_id, season, episode);
      } else {
        removeShowFromHistory(entry.provider, entry.subject_id);
      }
      toast({ type: 'info', title: 'Removed from history', message: entry.title });
      draw();
    }

    return el('li', { class: 'episode' },
      thumbNode(entry),
      el('div', { class: 'episode-body' },
        el('strong', {},
          el('a', { href: detailPathFor(detailItem), text: entry.title })),
        el('p', { text: metaText }),
        el('div', {
          class: 'progress',
          role: 'progressbar',
          'aria-label': `Watch progress for ${entry.title}`,
          'aria-valuenow': String(Math.round(percent)),
          'aria-valuemin': '0',
          'aria-valuemax': '100',
        }, el('span', { style: { width: `${Math.round(percent)}%` } })),
        el('div', { class: 'resume-meta' },
          el('span', { text: timeText }),
          completed ? el('span', { class: 'episode-watched', text: 'Watched' }) : null)),
      el('div', { class: 'btn-row' },
        el('a', {
          class: 'btn btn-sm',
          href: watchHref(entry),
          'aria-label': `${resumeLabel} ${entry.title}`,
        }, icon('play'), el('span', { text: resumeLabel })),
        ghostAction('Mark watched', 'check', markAsWatched),
        ghostAction('Remove', 'trash', removeEntry)));
  }

  function bodyNode() {
    const entries = allEntries();
    if (!entries.length) {
      return emptyState({
        icon: 'history',
        title: 'No watch history',
        message: 'Titles you play appear here so you can pick up where you left off.',
        action: el('a', { class: 'btn', href: '#/home', text: 'Browse home' }),
      });
    }

    const shown = visibleEntries(entries);
    if (!shown.length) {
      return emptyState({
        icon: 'history',
        title: 'Nothing in this view',
        message: 'No history entries match this filter right now.',
      });
    }

    return el('ul', { class: 'episode-list' }, ...shown.map(rowNode));
  }

  async function clearAll() {
    const confirmed = await confirmModal({
      title: 'Clear watch history?',
      message: 'Every history entry and its saved progress will be removed from this device. This cannot be undone.',
      confirmLabel: 'Clear history',
      danger: true,
    });
    if (!confirmed || ctx.signal.aborted) return;
    clearHistory();
    toast({ type: 'success', title: 'History cleared' });
    draw();
  }

  function pageNode() {
    return pageShell({
      title: 'History',
      subtitle: 'Watch history stays on this device.',
      actions: [
        segmented({
          label: 'Filter history',
          options: [
            { value: 'all', label: 'All' },
            { value: 'progress', label: 'In progress' },
            { value: 'watched', label: 'Watched' },
          ],
          value: filter,
          onChange: (value) => {
            filter = value;
            draw({ focusFilter: true });
          },
        }),
        ghostAction('Clear all', 'trash', clearAll),
      ],
      children: [bodyNode()],
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

  draw({ preserveScroll: false });
}
