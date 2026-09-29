// Gmail via the Gmail REST API (scope: gmail.modify).
// https://developers.google.com/gmail/api/reference/rest

import { MAX_MESSAGES_PER_ACCOUNT } from '../config.js';
import { apiFetch } from '../http.js';
import { base64ToBytes, decodeEntities, decodeText, mapLimit, parseAddress, parseAddressList } from '../util.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const gmail = {
  id: 'gmail',
  name: 'Gmail',

  async identify(token) {
    const res = await fetch(`${API}/profile`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!res.ok) throw new Error(`Could not read the Gmail profile (${res.status})`);
    return { email: (await res.json()).emailAddress };
  },

  async fetchSummary(account) {
    const [label, list] = await Promise.all([
      apiFetch(account, `${API}/labels/INBOX`),
      apiFetch(account, `${API}/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=${MAX_MESSAGES_PER_ACCOUNT}`),
    ]);
    return { unreadCount: label.messagesUnread ?? 0, messages: await headers(account, list.messages ?? []) };
  },

  // The newest already-read inbox emails, fetched only when asked for.
  async fetchRecentRead(account, limit) {
    const list = await apiFetch(account, `${API}/messages?labelIds=INBOX&q=${encodeURIComponent('is:read')}&maxResults=${limit}`);
    return headers(account, list.messages ?? []);
  },

  async getMessage(account, id) {
    const m = await apiFetch(account, `${API}/messages/${id}?format=full`);
    const h = headerMap(m.payload?.headers);
    const parts = { html: null, text: null, attachments: [] };
    walkParts(m.payload, parts);
    return {
      id: m.id,
      subject: h.subject ?? '',
      from: parseAddress(h.from),
      to: parseAddressList(h.to),
      cc: parseAddressList(h.cc),
      date: Number(m.internalDate),
      isRead: !(m.labelIds ?? []).includes('UNREAD'),
      html: parts.html,
      text: parts.text,
      attachments: parts.attachments,
      webUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#all/${m.threadId}`,
    };
  },

  // Returns the attachment bytes. Small inline parts carry their data directly.
  async getAttachment(account, messageId, attachment) {
    if (attachment.data) return base64ToBytes(attachment.data);
    const res = await apiFetch(account, `${API}/messages/${messageId}/attachments/${attachment.id}`);
    return base64ToBytes(res.data);
  },

  async setRead(account, id, read) {
    await apiFetch(account, `${API}/messages/${id}/modify`, {
      method: 'POST',
      body: read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] },
    });
  },

  // One request per 1000 messages; batchModify is all-or-nothing, so there are
  // no per-message failures to report (errors throw).
  async setReadMany(account, ids, read, onProgress) {
    for (let i = 0; i < ids.length; i += 1000) {
      await apiFetch(account, `${API}/messages/batchModify`, {
        method: 'POST',
        body: { ids: ids.slice(i, i + 1000), ...(read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }) },
      });
      onProgress?.(Math.min(i + 1000, ids.length), ids.length);
    }
    return [];
  },

  // Every unread inbox message, not just the ones listed in the sidebar.
  async markAllRead(account, onProgress) {
    const ids = [];
    let pageToken = '';
    do {
      const page = await apiFetch(
        account,
        `${API}/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ''}`,
      );
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    const failed = await this.setReadMany(account, ids, true, onProgress);
    return { total: ids.length, failed };
  },

  // Moves to Trash (recoverable for 30 days), never a permanent delete.
  async trash(account, id) {
    await apiFetch(account, `${API}/messages/${id}/trash`, { method: 'POST' });
  },
};

function headerMap(headers = []) {
  const map = {};
  for (const { name, value } of headers) map[name.toLowerCase()] ??= value;
  return map;
}

function walkParts(part, out) {
  if (!part) return;
  const h = headerMap(part.headers);
  const mime = (part.mimeType ?? '').toLowerCase();
  const disposition = (h['content-disposition'] ?? '').toLowerCase();
  const contentId = h['content-id']?.replace(/^<|>$/g, '');
  const isAttachment = Boolean(part.filename) || disposition.startsWith('attachment');

  if (part.parts?.length) {
    for (const p of part.parts) walkParts(p, out);
    return;
  }
  if (!isAttachment && (mime === 'text/html' || mime === 'text/plain') && part.body?.data) {
    const charset = h['content-type']?.match(/charset="?([^";]+)"?/i)?.[1];
    const text = decodeText(base64ToBytes(part.body.data), charset);
    // Keep the first of each; later ones are usually forwarded/quoted copies.
    if (mime === 'text/html') out.html ??= text;
    else out.text ??= text;
    return;
  }
  if (part.body?.attachmentId || part.body?.data) {
    out.attachments.push({
      id: part.body.attachmentId ?? null,
      data: part.body.attachmentId ? undefined : part.body.data,
      filename: part.filename || contentId || 'attachment',
      mimeType: mime,
      size: part.body.size ?? 0,
      contentId: contentId ?? null,
      inline: Boolean(contentId) && !disposition.startsWith('attachment'),
    });
  }
}

// From/Subject/snippet/date for a list of message refs, newest first.
async function headers(account, refs) {
  const metas = await mapLimit(refs, 8, (m) =>
    apiFetch(account, `${API}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`),
  );
  const messages = metas.map((m) => {
    const h = headerMap(m.payload?.headers);
    return {
      id: m.id,
      threadId: m.threadId,
      from: parseAddress(h.from),
      subject: h.subject ?? '',
      snippet: decodeEntities(m.snippet),
      date: Number(m.internalDate),
    };
  });
  return messages.sort((a, b) => b.date - a.date);
}
