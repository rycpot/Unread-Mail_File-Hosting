// Background downloader for the offline cache: every email the app lists
// (unread, Recently read, Sent, Drafts, Spam) is fetched with its inline
// images and attachments as soon as it appears, so it opens instantly
// (videos over 50 MB wait until they are opened). With "Always load remote
// images" on, its web images are saved with it too.
// Fetching never marks anything read. Runs in the service worker after each
// check and whenever a list changes; the section lists (Recently read, Sent,
// Drafts, Spam) are re-read at most every 15 minutes per account, and also by
// the app when a section is opened.

import { providers } from './providers/index.js';
import { getAccounts, getMail, getSettings } from './storage.js';
import * as cache from './cache-db.js';
import { completeAndStore } from './message-fetch.js';
import { mediaKind } from './media-types.js';
import { saveRemoteImages } from './remote-images.js';
import { getSectionLists, putSectionList } from './section-lists.js';
import { logDownloadError, noteRun } from './download-log.js';

const SECTIONS_EVERY = 15 * 60e3;
// Videos larger than this download when opened (and are cached then).
const VIDEO_PREFETCH_MAX = 50 * 1024 * 1024;
const SECTION_FETCH = {
  recent: { folder: undefined, fetch: (p, a) => p.fetchRecentRead(a, 10) },
  spam: { folder: 'spam', fetch: (p, a) => p.fetchSpam?.(a, 20) },
  sent: { folder: 'sent', fetch: (p, a) => p.fetchSent?.(a, 5) },
};
const sectionsFetchedAt = new Map(); // account id -> time

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

// A stalled request (the network changed, the computer slept) must not stop
// the downloader for good: each account's step gives up after this long.
const BODIES_TIMEOUT = 3 * 60e3;
const IMAGES_TIMEOUT = 5 * 60e3;
const FILES_TIMEOUT = 15 * 60e3;
const RUN_TIMEOUT = 45 * 60e3;
let runningSince = 0;

function withTimeout(promise, ms, what) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} gave up after ${Math.round(ms / 60e3)} min without finishing`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function run() {
  if (running && Date.now() - runningSince < RUN_TIMEOUT) {
    again = true;
    return;
  }
  running = true;
  const started = (runningSince = Date.now());
  try {
    const accounts = Object.values(await getAccounts()).filter((a) => !a.hidden);
    // Bodies first, all accounts at once, so opening is instant as soon as
    // possible; attachments (which can be large) come after, one account at a time.
    const listed = new Map();
    await Promise.all(accounts.map(async (account) => {
      try {
        listed.set(account.id, await withTimeout(prefetchBodies(account), BODIES_TIMEOUT, 'Downloading emails'));
      } catch (e) {
        logDownloadError(account.id, 'account', e);
      }
    }));
    // Only while "Always load remote images" is on: fetching them tells the
    // sender the email was opened.
    if ((await getSettings()).loadRemoteImages) {
      await Promise.all(accounts.map(async (account) => {
        if (!listed.has(account.id)) return;
        try {
          await withTimeout(prefetchImages(account, listed.get(account.id)), IMAGES_TIMEOUT, 'Downloading web images');
        } catch (e) {
          logDownloadError(account.id, 'account', e);
        }
      }));
    }
    for (const account of accounts) {
      if (!listed.has(account.id)) continue;
      try {
        await withTimeout(prefetchFiles(account, listed.get(account.id)), FILES_TIMEOUT, 'Downloading attachments');
      } catch (e) {
        logDownloadError(account.id, 'account', e);
      }
    }
    await cache.trim(cacheLimitBytes(await getSettings()));
  } finally {
    if (runningSince === started) {
      running = false;
      if (again) {
        again = false;
        schedulePrefetch(1000);
      }
    }
  }
}

// Downloads the bodies (with inline images) of everything the app lists for
// the account. Returns what is listed, for prefetchFiles.
async function prefetchBodies(account) {
  const provider = providers[account.provider];
  // What the app lists for this account.
  const items = []; // { folder, id }
  const mail = await getMail(account.id);
  for (const m of mail?.messages ?? []) items.push({ folder: undefined, id: m.id });

  if (!sectionsFetchedAt.has(account.id) || Date.now() - sectionsFetchedAt.get(account.id) > SECTIONS_EVERY) {
    for (const [kind, s] of Object.entries(SECTION_FETCH)) {
      try {
        // The app shows these lists at once from here.
        await putSectionList(account.id, kind, (await s.fetch(provider, account)) ?? []);
      } catch {}
    }
    try {
      await putSectionList(account.id, 'drafts', (await provider.fetchDrafts?.(account, 3)) ?? []);
    } catch {}
    sectionsFetchedAt.set(account.id, Date.now());
  }
  // The stored lists, not just what was fetched above: the app refreshes them
  // too whenever a section is opened, and those emails are downloaded as well.
  const rows = (await getSectionLists([account.id]))[account.id] ?? {};
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
    if (provider.getMessages) {
      // iCloud / Yahoo / AOL: several per helper session (an older helper
      // without this command gets them one by one below).
      try {
        for (let i = 0; i < ids.length; i += 10) {
          for (const msg of await provider.getMessages(account, ids.slice(i, i + 10), { folder })) {
            messages.push(await completeAndStore(account, msg, folder));
          }
        }
      } catch (e) {
        logDownloadError(account.id, 'email', e);
      }
    }
    // One by one: the rest, and any the helper left out of its answer (so the
    // reason is recorded).
    const rest = ids.filter((id) => !messages.some((m) => m.id === id && m.folder === folder));
    await pool(rest, 3, account.id, 'email', async (id) => {
      const msg = await provider.getMessage(account, id, { folder });
      messages.push(await completeAndStore(account, msg, folder));
    });
  }
  await noteRun(account.id, { listed: items.length, missing: missing.length, fetched: messages.length });

  // Every listed email as cached (or just fetched), for the steps below.
  const listed = [];
  for (let i = 0; i < items.length; i++) {
    const msg = messages.find((m) => m.id === items[i].id && m.folder === items[i].folder) ?? (await cache.getBody(keys[i]));
    if (msg) listed.push({ key: keys[i], msg });
  }
  return { listed, drafts: rows.drafts ?? [] };
}

// Web images, saved with each listed email (see remote-images.js).
async function prefetchImages(account, { listed }) {
  await pool(listed, 3, account.id, 'email', async ({ key, msg }) => {
    if (await saveRemoteImages(msg)) await cache.putBody(key, account.id, msg);
  });
}

// Attachments and drafts of what prefetchBodies listed.
async function prefetchFiles(account, { listed, drafts }) {
  const provider = providers[account.provider];
  // Attachments of every listed email (cached or just fetched).
  for (const { msg } of listed) await prefetchAttachments(account, provider, msg);

  // Drafts, as the composer opens them.
  const draftKeys = [];
  for (const d of drafts) {
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
      logDownloadError(account.id, 'attachment', e);
    }
  }
  await pool(rest, 2, account.id, 'attachment', async (a) => {
    const bytes = await provider.getAttachment(account, msg.id, a, { folder: msg.folder });
    await cache.putAttachment(keyOf(a), account.id, bytes);
  });
}

// Runs fn over items, `limit` at a time; failures are recorded and skipped.
async function pool(items, limit, accountId, what, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        logDownloadError(accountId, what, e);
      }
    }
  }));
}
