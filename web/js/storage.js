/*
 * Persistent stores.
 *
 * localStorage keys (all namespaced, all versioned):
 *   moviebox.settings.v1   — user settings (theme, proxy, providers, player)
 *   moviebox.favorites.v1  — favorite items
 *   moviebox.history.v1    — watch history entries
 *   moviebox.watchProgress.v1 — resume points
 *   moviebox.playlists.v1  — M3U playlist definitions
 *   moviebox.addons.v1     — installed addon manifests (data only, never code)
 *   moviebox.providerState.v1 — last known provider capabilities/status
 *
 * IndexedDB: response caches with TTL (search/details/streams).
 * If anything is unavailable (private mode, quota), we degrade gracefully.
 */

export const STORAGE_KEYS = {
  settings: 'moviebox.settings.v1',
  favorites: 'moviebox.favorites.v1',
  history: 'moviebox.history.v1',
  progress: 'moviebox.watchProgress.v1',
  playlists: 'moviebox.playlists.v1',
  addons: 'moviebox.addons.v1',
  providerState: 'moviebox.providerState.v1',
};

const SCHEMA_VERSION = 1;

let memoryFallback = new Map();

function storageAvailable() {
  try {
    const k = '__mb_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

const HAS_LOCAL = storageAvailable();

function readRaw(key) {
  if (HAS_LOCAL) {
    try {
      return localStorage.getItem(key);
    } catch {
      /* fall through */
    }
  }
  return memoryFallback.get(key) ?? null;
}

function writeRaw(key, value) {
  if (HAS_LOCAL) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      /* quota / private mode — fall through */
    }
  }
  memoryFallback.set(key, value);
  return false;
}

function removeRaw(key) {
  if (HAS_LOCAL) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  memoryFallback.delete(key);
}

export function loadJSON(key, fallback) {
  const raw = readRaw(key);
  if (raw === null || raw === undefined) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.schemaVersion && parsed.schemaVersion > SCHEMA_VERSION) {
      // Written by a newer version of the app: keep it untouched, use fallback for now.
      return fallback;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'data' in parsed) {
      return parsed.data;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

export function saveJSON(key, data) {
  const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, data });
  const ok = writeRaw(key, payload);
  return ok;
}

export function removeKey(key) {
  removeRaw(key);
}

export function storageMode() {
  if (HAS_LOCAL) return 'local';
  for (const value of memoryFallback.values()) if (value) return 'memory';
  return 'local';
}

/* ---------------- Generic collection helpers ---------------- */

export function loadList(key) {
  const data = loadJSON(key, []);
  return Array.isArray(data) ? data : [];
}

export function saveList(key, list) {
  return saveJSON(key, Array.isArray(list) ? list : []);
}

/* ---------------- IndexedDB response cache ---------------- */

const DB_NAME = 'moviebox-cache';
const DB_VERSION = 1;
const STORE = 'responses';
let dbPromise = null;

function openDB() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('expires', 'expires');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export async function cacheGet(key, ttlMs = 10 * 60 * 1000) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const row = req.result;
        if (!row) return resolve(null);
        if (row.expires && row.expires < Date.now()) {
          resolve(null);
          return;
        }
        resolve(row.value);
      };
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function cacheSet(key, value, ttlMs = 10 * 60 * 1000) {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({
        key,
        value,
        expires: ttlMs > 0 ? Date.now() + ttlMs : 0,
        storedAt: Date.now(),
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function cacheClear() {
  const db = await openDB();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

/** Delete expired entries (call occasionally on startup). */
export async function cacheSweep() {
  const db = await openDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const idx = store.index('expires');
    const now = Date.now();
    const req = idx.openCursor(IDBKeyRange.upperBound(now));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  } catch {
    /* ignore */
  }
}
