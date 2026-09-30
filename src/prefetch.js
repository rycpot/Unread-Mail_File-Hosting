// Background downloader for the offline cache: every email the app lists
// (unread, Recently read, Sent, Drafts, Spam) is fetched with its inline
// images and attachments as soon as it appears, so it opens instantly
// (videos over 50 MB wait until they are opened).
// Fetching never marks anything read. Runs in the service worker after each
// check; the section lists (Recently read, Sent, Drafts, Spam) are re-read at
// most every 15 minutes per account.

import { providers } from './providers/index.js';
import { getAccounts, getMail, getSettings } from './storage.js';
import * as cache from './cache-db.js';
import { completeAndStore } from './message-fetch.js';
import { mediaKind } from './media-types.js';

const SECTIONS_EVERY = 15 * 60e3;
// Videos larger than this download when opened (and are cached then).
const VIDEO_PREFETCH_MAX = 50 * 1024 * 1024;
const SECTION_FETCH = {
  recent: { folder: undefined, fetch: (p, a) => p.fetchRecentRead(a, 10) },
  spam: { folder: 'spam', fetch: (p, a) => p.fetchSpam?.(a, 20) },
  sent: { folder: 'sent', fetch: (p, a) => p.fetchSent?.(a, 5) },
};
const sectionsFetchedAt = new Map(); // account id -> time
const sectionRows = new Map(); // account id -> { recent, spam, sent, drafts }

let timer = null;
let running = false;
let again = false;

// After sending: Sent and Drafts change, so re-read them on the next run.
export function sectionsChanged(accountId) {
  sectionsFetchedAt.delete(accountId);
}

export function schedulePrefetch(delay = 3000) {
  clearTimeout(timer);
  timer = setTimeout(run, delay);
}

export const cacheLimitBytes = (settings) => (Number(settings.cacheLimitMB) || 0) * 1024 * 1024;

async function run() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const accounts = Object.values(await getAccounts()).filter((a) => !a.hidden);
    for (const account of accounts) {
      try {
        await prefetchAccount(account);
      } catch (e) {
        console.debug('[prefetch]', account.id, e.message);
      }
    }
    await cache.trim(cacheLimitBytes(await getSettings()));
  } finally {
    running = false;
    if (again) {
      again = false;
      schedulePrefetch(1000);
    }
  }
}

async function prefetchAccount(account) {
  const provider = providers[account.provider];
  // What the app lists for this account.
  const items = []; // { folder, id }
  const mail = await getMail(account.id);
  for (const m of mail?.messages ?? []) items.push({ folder: undefined, id: m.id });

  if (!sectionsFetchedAt.has(account.id) || Date.now() - sectionsFetchedAt.get(account.id) > SECTIONS_EVERY) {
    const rows = {};
    for (const [kind, s] of Object.entries(SECTION_FETCH)) {
      try {
        rows[kind] = (await s.fetch(provider, account)) ?? [];
      } catch {
        rows[kind] = sectionRows.get(account.id)?.[kind] ?? [];
      }
    }
    try {
      rows.drafts = (await provider.fetchDrafts?.(account, 3)) ?? [];
    } catch {
      rows.drafts = sectionRows.get(account.id)?.drafts ?? [];
    }
    sectionRows.set(account.id, rows);
    sectionsFetchedAt.set(account.id, Date.now());
  }
  const rows = sectionRows.get(account.id) ?? {};
  for (const [kind, s] of Object.entries(SECTION_FETCH)) {
    for (const m of rows[kind] ?? []) items.push({ folder: s.folder, id: m.id });
  }

  // Bodies not cached yet.
  const keys = items.map((it) => cache.bodyKey(account.id, it.folder, it.id));
  await cache.markSeen('bodies', keys);
  const missing = [];
  for (let i = 0; i < items.length; i++) if (!(await cache.hasBody(keys[i]))) missing.push(items[i]);

  const byFolder = new Map();
  for (const it of missing) {
    if (!byFolder.has(it.folder)) byFolder.set(it.folder, []);
    byFolder.get(it.folder).push(it.id);
  }
  const messages = [];
  for (const [folder, ids] of byFolder) {
    let rest = ids;
    if (provider.getMessages) {
      // iCloud / Yahoo / AOL: several per helper session (an older helper
      // without this command gets them one by one below).
      try {
        for (let i = 0; i < ids.length; i += 10) {
          for (const msg of await provider.getMessages(account, ids.slice(i, i + 10), { folder })) {
            messages.push(await completeAndStore(account, msg, folder));
          }
        }
        rest = [];
      } catch (e) {
        console.debug('[prefetch]', e.message);
        rest = ids.filter((id) => !messages.some((m) => m.id === id));
      }
    }
    await pool(rest, 3, async (id) => {
      const msg = await provider.getMessage(account, id, { folder });
      messages.push(await completeAndStore(account, msg, folder));
    });
  }

  // Attachments of every listed email (cached or just fetched).
  for (let i = 0; i < items.length; i++) {
    const msg = messages.find((m) => m.id === items[i].id && m.folder === items[i].folder) ?? (await cache.getBody(keys[i]));
    if (msg) await prefetchAttachments(account, provider, msg);
  }

  // Drafts, as the composer opens them.
  const draftKeys = [];
  for (const d of rows.drafts ?? []) {
    const key = cache.draftKey(account.id, d.id);
    draftKeys.push(key);
    const version = cache.draftVersion(d);
    if (await cache.getDraft(key, version)) continue;
    try {
      await cache.putDraft(key, account.id, version, await provider.loadDraft(account, d.id));
    } catch {}
  }
  await cache.markSeen('drafts', draftKeys);
}


async function prefetchAttachments(account, provider, msg) {
  const files = (msg.attachments ?? []).filter((a) => !a.inline);
  if (!files.length) return;
  const keyOf = (a) => cache.attachmentKey(account.id, msg.folder, msg.id, a);
  await cache.markSeen('attachments', files.map(keyOf));
  const bigVideo = (a) => mediaKind(a.filename, a.mimeType) === 'video' && (a.size ?? 0) > VIDEO_PREFETCH_MAX;
  const missing = [];
  for (const a of files) if (!bigVideo(a) && !(await cache.hasAttachment(keyOf(a)))) missing.push(a);
  if (!missing.length) return;
  let rest = missing;
  if (provider.getAttachments) {
    try {
      const got = await provider.getAttachments(account, msg.id, missing, { folder: msg.folder });
      for (const a of missing) if (got[a.id]) await cache.putAttachment(keyOf(a), account.id, got[a.id]);
      rest = missing.filter((a) => !got[a.id]);
    } catch (e) {
      console.debug('[prefetch]', e.message);
    }
  }
  await pool(rest, 2, async (a) => {
    const bytes = await provider.getAttachment(account, msg.id, a, { folder: msg.folder });
    await cache.putAttachment(keyOf(a), account.id, bytes);
  });
}

// Runs fn over items, `limit` at a time; failures are skipped.
async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        console.debug('[prefetch]', e.message);
      }
    }
  }));
}
