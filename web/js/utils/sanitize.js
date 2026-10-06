/*
 * Safe DOM building.
 * String children are always inserted with textContent — never innerHTML —
 * so provider / addon metadata can never inject markup.
 * Use `staticHtml()` only for literal, developer-authored markup.
 */

const STATIC = Symbol('staticHtml');

export function staticHtml(strings, ...values) {
  return { __static: STATIC, value: strings.raw ? strings.raw.join('') : String(strings) };
}

function isStatic(node) {
  return node && typeof node === 'object' && node.__static === STATIC;
}

function appendChild(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) {
    for (const c of child) appendChild(parent, c);
    return;
  }
  if (child instanceof Node) {
    parent.appendChild(child);
    return;
  }
  if (isStatic(child)) {
    const tpl = document.createElement('template');
    tpl.innerHTML = child.value;
    parent.appendChild(tpl.content);
    return;
  }
  parent.appendChild(document.createTextNode(String(child)));
}

function applyProp(node, key, val) {
  if (val === null || val === undefined || val === false) return;
  if (key === 'class' || key === 'className') {
    if (Array.isArray(val)) node.className = val.filter(Boolean).join(' ');
    else node.setAttribute('class', String(val));
    return;
  }
  if (key === 'style' && typeof val === 'object') {
    Object.assign(node.style, val);
    return;
  }
  if (key === 'dataset' && typeof val === 'object') {
    for (const [k, v] of Object.entries(val)) {
      if (v !== null && v !== undefined) node.dataset[k] = String(v);
    }
    return;
  }
  if (key === 'text') {
    node.textContent = String(val);
    return;
  }
  if (key.startsWith('on') && typeof val === 'function') {
    const evt = key.slice(2).toLowerCase();
    node.addEventListener(evt, val);
    return;
  }
  if (key === 'value' && 'value' in node) {
    node.value = val;
    return;
  }
  if (key === 'checked' || key === 'disabled' || key === 'selected' || key === 'open') {
    node[key] = Boolean(val);
    if (val === false) node.removeAttribute(key);
    return;
  }
  if (val === true) {
    node.setAttribute(key, '');
    return;
  }
  node.setAttribute(key, String(val));
}

export function el(tag, props, ...children) {
  if (props instanceof Node || Array.isArray(props) || typeof props !== 'object' || props === null) {
    children = [props, ...children];
    props = null;
  }
  const isSvg = typeof tag === 'string' && tag.includes(':');
  const node = isSvg
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) applyProp(node, k, v);
  }
  for (const child of children) appendChild(node, child);
  return node;
}

export function frag(...children) {
  const f = document.createDocumentFragment();
  for (const c of children) appendChild(f, c);
  return f;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(container, ...children) {
  clear(container);
  for (const c of children) appendChild(container, c);
  return container;
}

export function escapeHtml(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'blob:', 'data:image/']);

/**
 * Returns the URL if its scheme is allowed (or it is relative),
 * otherwise an empty string. Guards every href/src we render.
 */
export function safeUrl(url, extraProtocols = []) {
  if (!url) return '';
  const raw = String(url).trim();
  if (!raw) return '';
  if (raw.startsWith('#') || raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) {
    return raw;
  }
  try {
    const parsed = new URL(raw, location.href);
    if (extraProtocols.includes(parsed.protocol)) return parsed.href;
    if (ALLOWED_PROTOCOLS.has(parsed.protocol)) return parsed.href;
    if ([...ALLOWED_PROTOCOLS].some((p) => parsed.protocol.startsWith(p))) return parsed.href;
    return '';
  } catch {
    return '';
  }
}

export function isSafeUrl(url) {
  return safeUrl(url) !== '';
}

/** Image element with graceful fallback; URL is validated first. */
export function img(src, alt = '', props = {}) {
  const url = safeUrl(src);
  const node = el('img', {
    ...props,
    alt,
    loading: props.eager ? 'eager' : 'lazy',
    decoding: 'async',
    referrerpolicy: 'no-referrer',
    src: url || '',
  });
  node.addEventListener('error', () => {
    node.style.display = 'none';
    node.dispatchEvent(new CustomEvent('img-error', { bubbles: true }));
  });
  return node;
}
