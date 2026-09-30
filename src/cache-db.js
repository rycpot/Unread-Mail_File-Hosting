// Offline cache of email bodies and attachments, in IndexedDB (on disk, in
// this Chrome profile; "unlimitedStorage" keeps Chrome from clearing it).
// Shared by the background worker, which downloads everything the app lists,
// and the app, which reads from it first.
//
// Stores:
//   bodies       key "<accountId>|<folder>|<messageId>" -> { key, accountId, msg, size, lastUsed, lastSeen }
//   attachments  key "<accountId>|<folder>|<messageId>|<attachmentId>|<filename>" -> { key, accountId, bytes, size, lastUsed, lastSeen }
//   drafts       key "<accountId>|<ref>" -> { key, accountId, version, draft, size, lastUsed, lastSeen }
//
// lastUsed orders eviction when the cache is over its size limit (oldest
// first); lastSeen is when the email was last listed in the app, and entries
// not listed for 14 days are removed.

const DB_NAME = 'unread-mail-cache';
const STORES = ['bodies', 'attachments', 'drafts'];
const FORGET_AFTER = 14 * 86400e3;

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        const store = req.result.createObjectStore(name, { keyPath: 'key' });
        store.createIndex('accountId', 'accountId');
        store.createIndex('lastUsed', 'lastUsed');
      }
    };
    req.onsuccess = () => {
      const d = req.result;
      // Let another context delete or upgrade the database (e.g. Clear).
      d.onversionchange = () => {
        d.close();
        dbPromise = null;
      };
      resolve(d);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => (result = r));
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2p = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export const bodyKey = (accountId, folder, messageId) => `${accountId}|${folder || 'inbox'}|${messageId}`;
export const attachmentKey = (accountId, folder, messageId, att) =>
  `${accountId}|${folder || 'inbox'}|${messageId}|${att.id ?? ''}|${att.filename ?? ''}`;
export const draftKey = (accountId, ref) => `${accountId}|${ref}`;

// Rough size of a stored message (text, attachment list and inline images).
function sizeOf(value) {
  let n = 0;
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') n += v.length;
    else if (v instanceof Uint8Array) n += v.length;
    else if (v instanceof Map) v.forEach((x, k) => { walk(k); walk(x); });
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
    else n += 8;
  };
  walk(value);
  return n;
}

async function get(store, key, { touch = true } = {}) {
  try {
    const rec = await tx(store, 'readonly', (s) => req2p(s.get(key)));
    if (rec && touch) tx(store, 'readwrite', (s) => s.put({ ...rec, lastUsed: Date.now() })).catch(() => {});
    return rec ?? null;
  } catch {
    return null;
  }
}

async function put(store, rec) {
  const now = Date.now();
  await tx(store, 'readwrite', (s) => s.put({ lastUsed: now, lastSeen: now, ...rec, key: rec.key }));
}

export async function getBody(key) {
  return (await get('bodies', key))?.msg ?? null;
}
export async function putBody(key, accountId, msg) {
  await put('bodies', { key, accountId, msg, size: sizeOf(msg) });
}
export async function hasBody(key) {
  return Boolean(await get('bodies', key, { touch: false }));
}

export async function getAttachment(key) {
  return (await get('attachments', key))?.bytes ?? null;
}
export async function putAttachment(key, accountId, bytes) {
  await put('attachments', { key, accountId, bytes, size: bytes.length });
}
export async function hasAttachment(key) {
  return Boolean(await get('attachments', key, { touch: false }));
}

// A draft as the composer loads it; version is what the Drafts list shows for
// it (it changes whenever the draft is saved, here or in the webmail).
export const draftVersion = (row) => `${row.date ?? ''}|${row.messageId ?? ''}`;

export async function getDraft(key, version) {
  const rec = await get('drafts', key);
  return rec && rec.version === version ? rec.draft : null;
}
export async function putDraft(key, accountId, version, draft) {
  await put('drafts', { key, accountId, version, draft, size: sizeOf(draft) });
}

export async function remove(store, key) {
  await tx(store, 'readwrite', (s) => s.delete(key)).catch(() => {});
}

// Marks entries as still listed in the app (keeps them from the 14-day sweep).
export async function markSeen(store, keys) {
  if (!keys.length) return;
  const now = Date.now();
  await tx(store, 'readwrite', async (s) => {
    for (const key of keys) {
      const rec = await req2p(s.get(key));
      if (rec) s.put({ ...rec, lastSeen: now });
    }
  }).catch(() => {});
}

// Removes an account's entries (account removed).
export async function forgetAccount(accountId) {
  for (const store of STORES) {
    await tx(store, 'readwrite', (s) => new Promise((resolve) => {
      const r = s.index('accountId').openCursor(IDBKeyRange.only(accountId));
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        c.delete();
        c.continue();
      };
      r.onerror = () => resolve();
    })).catch(() => {});
  }
}

// Total size, and per store.
export async function stats() {
  const out = { total: 0, count: 0 };
  for (const store of STORES) {
    const { size, count } = await tx(store, 'readonly', (s) => new Promise((resolve) => {
      let size = 0;
      let count = 0;
      const r = s.openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve({ size, count });
        size += c.value.size ?? 0;
        count++;
        c.continue();
      };
      r.onerror = () => resolve({ size, count });
    })).catch(() => ({ size: 0, count: 0 }));
    out[store] = { size, count };
    out.total += size;
    out.count += count;
  }
  return out;
}

// Drops entries not listed for 14 days, then the least recently used until
// the cache fits in maxBytes (0 = no limit).
export async function trim(maxBytes) {
  const cutoff = Date.now() - FORGET_AFTER;
  const all = [];
  for (const store of STORES) {
    await tx(store, 'readwrite', (s) => new Promise((resolve) => {
      const r = s.openCursor();
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        if ((c.value.lastSeen ?? 0) < cutoff) c.delete();
        else all.push({ store, key: c.value.key, size: c.value.size ?? 0, lastUsed: c.value.lastUsed ?? 0 });
        c.continue();
      };
      r.onerror = () => resolve();
    })).catch(() => {});
  }
  if (!maxBytes) return;
  let total = all.reduce((n, x) => n + x.size, 0);
  all.sort((a, b) => a.lastUsed - b.lastUsed);
  for (const x of all) {
    if (total <= maxBytes) break;
    await remove(x.store, x.key);
    total -= x.size;
  }
}

export async function clearAll() {
  for (const store of STORES) await tx(store, 'readwrite', (s) => s.clear()).catch(() => {});
}
