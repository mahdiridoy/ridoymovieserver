/* Shared page scaffolding: view mounting, headers, loading and error states. */

import { el, mount, clear } from '../utils/sanitize.js';
import { icon, emptyState, spinner, ghostAction } from '../utils/helpers.js';
import { proxyConfigured } from '../api.js';

export const view = () => document.getElementById('view');

export function renderView(...children) {
  const root = view();
  if (!root) return null;
  mount(root, ...children);
  root.scrollTop = 0;
  return root;
}

export function clearView() {
  const root = view();
  if (root) clear(root);
}

/** Standard page header block. `actions` are nodes placed right of the title. */
export function pageShell({ title = '', subtitle = '', actions = null, children = [] }) {
  const hasHeader = Boolean(title || subtitle || actions);
  return el('section', { class: 'page' },
    hasHeader
      ? el('header', { class: 'page-head' },
        el('div', { class: 'page-head-text' },
          title ? el('h1', { class: 'page-title', text: title }) : null,
          subtitle ? el('p', { class: 'page-sub', text: subtitle }) : null),
        actions ? el('div', { class: 'page-head-actions' }, ...[].concat(actions)) : null)
      : null,
    ...[].concat(children));
}

export function gridSkeleton(count = 10, label = 'Loading') {
  return el('div', { class: 'grid-wrap' },
    el('div', { class: 'grid', id: 'skeleton-grid', 'aria-busy': 'true', 'aria-label': label }),
    spinner(label));
}

export function section({ title, action = null, children = [] }) {
  return el('section', { class: 'section' },
    title || action
      ? el('div', { class: 'section-head' },
        title ? el('h2', { class: 'section-title', text: title }) : null,
        action)
      : null,
    ...[].concat(children));
}

/**
 * Non-fatal provider failure summary. Explains proxy requirements honestly
 * instead of silently hiding the failure.
 */
export function errorBanner(errors, { onRetry = null } = {}) {
  if (!errors?.length) return null;
  const needsProxy = errors.some((e) => e.error?.kind === 'proxy_required' || e.error?.kind === 'cors');
  const needsProxyUnconfigured = needsProxy && !proxyConfigured();

  const lines = errors.map((e) => {
    const msg = e.error?.userMessage?.() || e.error?.message || 'Request failed';
    return el('li', {},
      el('strong', { text: e.label || e.provider || 'Provider' }),
      el('span', { text: ` — ${msg}` }));
  });

  const banner = el('div', { class: 'callout', role: 'status' },
    icon(needsProxy ? 'cloudoff' : 'warning', 'ico'),
    el('div', {},
      el('strong', { text: needsProxyUnconfigured ? 'Some sources need a CORS proxy' : 'Some sources are unavailable' }),
      el('p', { text: needsProxyUnconfigured
        ? 'The provider blocks browser requests directly. Add a proxy URL in Settings → Data & network to fetch its catalog through your own endpoint.'
        : 'Other results below are unaffected. Check Settings → Providers for details.' }),
      el('ul', { class: 'callout-list' }, ...lines),
      onRetry ? ghostAction('Retry', 'refresh', onRetry) : null));
  return banner;
}

export function inlineError(error, { onRetry = null, title = 'Could not load' } = {}) {
  const message = error?.userMessage?.() || error?.message || String(error);
  return emptyState({
    icon: 'error',
    error: true,
    title,
    message,
    action: onRetry ? ghostAction('Try again', 'refresh', onRetry) : null,
  });
}

/** Segmented filter control (returns node; calls onChange with value). */
export function segmented({ label, options, value, onChange }) {
  const group = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((opt) => {
    const btn = el('button', {
      class: `seg-btn${opt.value === value ? ' is-active' : ''}`,
      type: 'button',
      role: 'radio',
      'aria-checked': String(opt.value === value),
      text: opt.label,
      onclick: () => {
        for (const b of buttons) {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-checked', String(b === btn));
        }
        onChange(opt.value);
      },
    });
    group.appendChild(btn);
    return btn;
  });
  return group;
}
