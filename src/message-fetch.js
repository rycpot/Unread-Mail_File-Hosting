// Fetching a full email (body plus its inline images) and its attachments,
// through the offline cache. Used by the app and by the background
// downloader; no DOM APIs.

import { providers } from './providers/index.js';
import * as cache from './cache-db.js';

export function bytesToDataUrl(bytes, mimeType) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mimeType || 'application/octet-stream'};base64,${btoa(bin)}`;
}

// Inline images as a Map of content id -> data: URL.
export async function loadInlineImages(provider, account, msg) {
  const map = new Map();
  if (!msg.html || !msg.attachments.some((x) => x.inline || x.contentId)) return map;
  const inline = msg.attachments.filter((x) => x.inline || x.contentId);
  await Promise.all(
    inline.map(async (att) => {
      try {
        let cid = att.contentId;
        let bytes;
        if (provider.resolveInline) ({ contentId: cid, bytes } = await provider.resolveInline(account, msg.id, att));
        else bytes = await provider.getAttachment(account, msg.id, att, { folder: msg.folder });
        if (cid) {
          att.contentId = cid; // Outlook only tells it here
          map.set(cid, bytesToDataUrl(bytes, att.mimeType));
        }
      } catch (e) {
        console.warn('inline image failed', e);
      }
    }),
  );
  return map;
}

// Completes a message from the provider (adds account, folder and inline
// images) and stores it, unless it could not be read (a Proton email that
// could not be decrypted is tried again next time).
export async function completeAndStore(account, msg, folder) {
  const provider = providers[account.provider];
  msg.accountId = account.id;
  msg.folder = folder;
  msg.inlineImages = await loadInlineImages(provider, account, msg);
  if (!msg.encrypted) await cache.putBody(cache.bodyKey(account.id, folder, msg.id), account.id, msg).catch(() => {});
  return msg;
}

// The full email: from the cache, else from the provider (then cached).
export async function fetchFullMessage(account, messageId, folder) {
  const cached = await cache.getBody(cache.bodyKey(account.id, folder, messageId));
  if (cached) return cached;
  const msg = await providers[account.provider].getMessage(account, messageId, { folder });
  return completeAndStore(account, msg, folder);
}

// An attachment's bytes: from the cache, else from the provider (then cached).
export async function fetchAttachment(account, msg, att) {
  const key = cache.attachmentKey(account.id, msg.folder, msg.id, att);
  const cached = await cache.getAttachment(key);
  if (cached) return cached;
  const bytes = await providers[account.provider].getAttachment(account, msg.id, att, { folder: msg.folder });
  await cache.putAttachment(key, account.id, bytes).catch(() => {});
  return bytes;
}
