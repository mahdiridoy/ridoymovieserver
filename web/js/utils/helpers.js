/* Shared UI helpers: icons, toasts, modals, empty states, skeletons. */

import { el } from './sanitize.js';

const ICONS = {
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm-1 3h2v2h-2zm0 4h2v5h-2z',
  check: 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z',
  warning: 'M12 3.5 1.8 21h20.4zm0 4.4.9 7h-1.8l-.9-7zM11 16h2v2h-2z',
  error: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm3.5 12.1-1.4 1.4L12 13.4l-2.1 2.1-1.4-1.4L10.6 12 8.5 9.9l1.4-1.4L12 10.6l2.1-2.1 1.4 1.4L13.4 12z',
  heart: 'M12 20.6 4.6 13.2a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9a4.6 4.6 0 1 1 6.5 6.5z',
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M7 5h3.5v14H7zm6.5 0H17v14h-3.5z',
  search: 'M10.5 3a7.5 7.5 0 1 0 4.55 13.46l4.24 4.25 1.42-1.42-4.25-4.24A7.5 7.5 0 0 0 10.5 3zm0 2a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z',
  close: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z',
  film: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm3.5 3.2v3.1l3-1.55zM14 15.5l4.5-2.6L14 10.3z',
  tv: 'M4 7h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zm5-4 2.5 3H8.5L7 5.5 9 3zm6 0 2 2.5-1.5 1.5h-3L15 3z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zM6 9h12l-1 12H7z',
  refresh: 'M12 5V2L7.5 6.5 12 11V8a5 5 0 1 1-5 5H5a7 7 0 1 0 7-8z',
  back: 'M15.5 4.5 8 12l7.5 7.5-1.4 1.4L5.2 12l8.9-8.9z',
  external: 'M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14zM5 6h5v2H7v10h10v-3h2v5H5z',
  star: 'M12 3.6l2.5 5.1 5.6.8-4 4 .9 5.6-5-2.7-5 2.7.9-5.6-4-4 5.6-.8z',
  history: 'M12 3a9 9 0 1 1-8.32 5.5H2v2h4.5V6h2v2.65A9 9 0 0 1 12 3zm-.9 3.6v5.16l4.03 2.37.9-1.54-3.13-1.85V6.6z',
  settings: 'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8zm8.5 3.4c0 .5-.05 1-.13 1.47l2.05 1.6-2 3.46-2.42-.98c-.74.62-1.57 1.1-2.47 1.42L15 21h-4l-.53-2.63a8.6 8.6 0 0 1-2.47-1.42l-2.42.98-2-3.46 2.05-1.6a8.9 8.9 0 0 1 0-2.94L3.58 9.4l2-3.46 2.42.98A8.6 8.6 0 0 1 10.47 5.5L11 2.9h4l.53 2.63c.9.31 1.73.8 2.47 1.42l2.42-.98 2 3.46-2.05 1.6c.08.48.13.97.13 1.47z',
  server: 'M4 4h16v6H4zm0 10h16v6H4zm3-7.2V8.2h2V6.8zm0 10v1.4h2V16.8z',
  cloudoff: 'M3.3 2 2 3.3l3.7 3.7H4a4.5 4.5 0 0 0 0 9h9.7l4 4 1.3-1.3zM6 10h7.4l1.6 1.6V16a3 3 0 0 1-.2 1H6a2.5 2.5 0 0 1 0-5zm8.5-5.9 1.2-1.2 3.5 3.5-1.2 1.2A4.5 4.5 0 0 0 14 6.1V6h-2v.1z',
  grid: 'M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z',
  volume: 'M4 9v6h3.5L13 19V5L7.5 9H4zm12.1 3a3.5 3.5 0 0 0-1.6-2.9v5.8a3.5 3.5 0 0 0 1.6-2.9zm-1.6-7.2v1.9a6 6 0 0 1 0 10.6v1.9a7.9 7.9 0 0 0 0-14.4z',
  mute: 'M4 9v6h3.5L13 19V5L7.5 9H4zm12 3 3.4 3.4 1.4-1.4L17.4 11l3.4-3.4-1.4-1.4L16 9.6 12.6 6.2 11.2 7.6 14.6 11l-3.4 3.4 1.4 1.4z',
  fullscreen: 'M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zM4 15h2v3h3v2H4zm14 0h2v5h-5v-2h3z',
  minimize: 'M9 4h2v5H6V7h3zm4 0h2v3h3v2h-5zM6 15h5v2H7v3H4v-5zm12 0h2v5h-5v-2h3z',
  next: 'M6 5.5v13l9-6.5zm9.5 0H18v13h-2.5z',
  prev: 'M18 5.5v13l-9-6.5zm-9.5 0H6v13h2.5z',
  pip: 'M20 5H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1zm-11 9H6v3h3zm8-1h-5v4h5z',
};

export function icon(name, cls = 'ico') {
  const path = ICONS[name] || ICONS.info;
  return el('svg', { class: cls, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    el('path', { d: path, fill: 'currentColor' }));
}

/* ---------------- Toasts ---------------- */

export function toast({ type = 'info', title = '', message = '', timeout = 4200 } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return () => {};
  const iconName = type === 'success' ? 'check' : type === 'error' ? 'error' : type === 'warning' ? 'warning' : 'info';
  const node = el('div', { class: `toast toast-${type}` },
    icon(iconName, 'ico toast-ico'),
    el('div', {},
      el('strong', { text: title || type.toUpperCase() }),
      message ? el('p', { text: message }) : null,
    ),
    el('button', { class: 'toast-close', type: 'button', 'aria-label': 'Dismiss', onclick: () => dismiss() },
      icon('close', 'ico')),
  );
  root.appendChild(node);
  let timer = timeout ? setTimeout(dismiss, timeout) : null;
  function dismiss() {
    if (timer) clearTimeout(timer);
    node.remove();
  }
  return dismiss;
}

/* ---------------- Modal ---------------- */

let activeModalCleanup = null;

export function openModal({ title, body, actions = [], wide = false, onClose = null }) {
  const root = document.getElementById('modal-root');
  if (!root) return () => {};
  if (activeModalCleanup) activeModalCleanup();

  const prevFocus = document.activeElement;
  const backdrop = el('div', { class: 'modal-backdrop', role: 'presentation' });
  const dialog = el('div', {
    class: `modal${wide ? ' modal-wide' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title || 'Dialog',
  });

  const titleEl = el('h2', { text: title || '' });
  const closeBtn = el('button', {
    class: 'icon-btn', type: 'button', 'aria-label': 'Close dialog',
    onclick: () => close(),
  }, icon('close'));

  dialog.appendChild(el('div', { class: 'modal-head' }, titleEl, closeBtn));
  const bodyWrap = el('div', { class: 'modal-body' });
  if (typeof body === 'string') bodyWrap.textContent = body;
  else if (body) bodyWrap.appendChild(body);
  dialog.appendChild(bodyWrap);

  if (actions.length) {
    dialog.appendChild(el('div', { class: 'modal-foot' }, ...actions));
  }

  backdrop.appendChild(dialog);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  root.appendChild(backdrop);

  function onKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const focusables = dialog.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey, true);

  const focusTarget = dialog.querySelector('input, select, textarea, button:not(.icon-btn)') || closeBtn;
  requestAnimationFrame(() => focusTarget.focus());

  function close(result) {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    activeModalCleanup = null;
    if (prevFocus && prevFocus.focus) prevFocus.focus();
    if (onClose) onClose(result);
  }
  activeModalCleanup = close;
  return close;
}

export function confirmModal({ title = 'Are you sure?', message = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const close = openModal({
      title,
      body: message,
      onClose: () => { if (!done) resolve(false); },
      actions: [
        el('button', { class: 'btn btn-ghost', type: 'button', text: 'Cancel', onclick: () => { done = true; resolve(false); close(); } }),
        el('button', {
          class: `btn${danger ? ' btn-danger' : ''}`, type: 'button', text: confirmLabel,
          onclick: () => { done = true; resolve(true); close(); },
        }),
      ],
    });
  });
}

/* ---------------- Empty / error states ---------------- */

export function emptyState({ icon: ic = 'search', title = '', message = '', action = null, error = false }) {
  return el('div', { class: `empty${error ? ' error' : ''}` },
    icon(ic, 'ico ico-xl'),
    el('h3', { text: title }),
    message ? el('p', { text: message }) : null,
    action || null,
  );
}

export function skeletonCards(count = 10) {
  const tpl = document.getElementById('tpl-skeleton-card');
  const fragNodes = document.createDocumentFragment();
  for (let i = 0; i < count; i += 1) {
    if (tpl) fragNodes.appendChild(tpl.content.cloneNode(true));
    else fragNodes.appendChild(el('div', { class: 'card skeleton-card' },
      el('div', { class: 'sk sk-poster' }),
      el('div', { class: 'sk sk-line w80' }),
      el('div', { class: 'sk sk-line w50' })));
  }
  return fragNodes;
}

export function spinner(label = 'Loading') {
  return el('div', { class: 'empty' },
    el('div', { class: 'big-play is-loading', 'aria-hidden': 'true' }),
    el('p', { class: 'muted', text: label }));
}

/* ---------------- misc ---------------- */

export function badge(text, cls = '') {
  return el('span', { class: `badge${cls ? ` ${cls}` : ''}`, text });
}

export function primaryAction(label, iconName, onclick) {
  return el('button', { class: 'btn', type: 'button', onclick }, icon(iconName), el('span', { text: label }));
}

export function ghostAction(label, iconName, onclick) {
  return el('button', { class: 'btn btn-ghost', type: 'button', onclick }, icon(iconName), el('span', { text: label }));
}

export function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach((node) => {
    const match = node.dataset.nav === name;
    node.classList.toggle('active', match);
    if (match) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
}
