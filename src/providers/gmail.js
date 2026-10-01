// Gmail via the Gmail REST API (scope: gmail.modify).
// https://developers.google.com/gmail/api/reference/rest

import { MAX_MESSAGES_PER_ACCOUNT } from '../config.js';
import { buildMime } from '../compose/mime.js';
import { apiFetch } from '../http.js';
import { base64ToBytes, decodeEntities, decodeText, mapLimit, parseAddress, parseAddressList } from '../util.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

export const gmail = {
  id: 'gmail',
  name: 'Gmail',
  // The account's inbox in Gmail (authuser picks the right signed-in account).
  inboxUrl: (account) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#inbox`,

  async identify(token) {
    const res = await fetch(`${API}/profile`, { headers: { Authorization: `Bearer ${token.accessToken}` } });
    if (!res.ok) throw new Error(`Could not read the Gmail profile (${res.status})`);
    return { email: (await res.json()).emailAddress };
  },

  async fetchSummary(account, prev) {
    const [label, list, spam] = await Promise.all([
      apiFetch(account, `${API}/labels/INBOX`),
      apiFetch(account, `${API}/messages?labelIds=INBOX&labelIds=UNREAD&maxResults=${MAX_MESSAGES_PER_ACCOUNT}`),
      apiFetch(account, `${API}/labels/SPAM`).catch(() => null),
    ]);
    // Headers of emails already listed last time are reused, so a check with
    // no new mail costs three requests (with the spam count).
    const known = new Map((prev?.messages ?? []).map((m) => [m.id, m]));
    const refs = list.messages ?? [];
    const fresh = await headers(account, refs.filter((r) => !known.has(r.id)));
    const byId = new Map(fresh.map((m) => [m.id, m]));
    const messages = refs
      .map((r) => byId.get(r.id) ?? { ...known.get(r.id), read: false })
      .sort((a, b) => b.date - a.date);
    return { unreadCount: label.messagesUnread ?? 0, spamUnread: spam?.messagesUnread ?? 0, messages };
  },

  // The newest unread emails in Spam, fetched only when asked for.
  async fetchSpam(account, limit) {
    const list = await apiFetch(account, `${API}/messages?labelIds=SPAM&labelIds=UNREAD&maxResults=${limit}`);
    return headers(account, list.messages ?? []);
  },

  // Back to the inbox; Gmail also learns it was not spam.
  async notSpam(account, ids) {
    await apiFetch(account, `${API}/messages/batchModify`, {
      method: 'POST',
      body: { ids, addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] },
    });
    return [];
  },

  // The newest already-read inbox emails, fetched only when asked for.
  async fetchRecentRead(account, limit) {
    const list = await apiFetch(account, `${API}/messages?labelIds=INBOX&q=${encodeURIComponent('is:read')}&maxResults=${limit}`);
    return headers(account, list.messages ?? []);
  },

  async getMessage(account, id) {
    return toFullMessage(account, await apiFetch(account, `${API}/messages/${id}?format=full`));
  },

  // ---------- Sent, Drafts, sending ----------

  // Your display name as Gmail shows it to recipients.
  async senderName(account) {
    const res = await apiFetch(account, `${API}/settings/sendAs`);
    const primary = (res.sendAs ?? []).find((x) => x.isPrimary) ?? res.sendAs?.[0];
    return primary?.displayName ?? '';
  },

  async fetchSent(account, limit) {
    const list = await apiFetch(account, `${API}/messages?labelIds=SENT&maxResults=${limit}`);
    return headers(account, list.messages ?? []);
  },

  // Draft rows: id is the draft id (what the composer reopens).
  async fetchDrafts(account, limit) {
    const list = await apiFetch(account, `${API}/drafts?maxResults=${limit}`);
    const drafts = list.drafts ?? [];
    const rows = await headers(account, drafts.map((d) => d.message));
    const byMessage = new Map(drafts.map((d) => [d.message.id, d.id]));
    return rows.map((r) => ({ ...r, messageId: r.id, id: byMessage.get(r.id), read: true }));
  },

  // A saved draft with its attachments' bytes, for the composer.
  async loadDraft(account, ref) {
    const d = await apiFetch(account, `${API}/drafts/${ref}?format=full`);
    const msg = toFullMessage(account, d.message);
    msg.attachments = await Promise.all(msg.attachments.map(async (a) => ({ ...a, bytes: await this.getAttachment(account, msg.id, a) })));
    return { ...msg, ref };
  },

  // Creates or updates the draft (media upload, so attachments up to 35 MB
  // fit); the thread id keeps replies in their conversation.
  async saveDraft(account, draft) {
    const mime = buildMime(draft, { includeBcc: true });
    const meta = { message: draft.reply?.threadId ? { threadId: draft.reply.threadId } : {} };
    const b = `um_${crypto.randomUUID()}`;
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
      `--${b}\r\nContent-Type: message/rfc822\r\n\r\n${mime}\r\n--${b}--`;
    const url = draft.ref ? `${UPLOAD}/drafts/${draft.ref}?uploadType=multipart` : `${UPLOAD}/drafts?uploadType=multipart`;
    const res = await apiFetch(account, url, {
      method: draft.ref ? 'PUT' : 'POST',
      rawBody: body,
      headers: { 'Content-Type': `multipart/related; boundary=${b}` },
    });
    return res.id;
  },

  async deleteDraft(account, ref) {
    await apiFetch(account, `${API}/drafts/${ref}`, { method: 'DELETE' });
  },

  // Called in the app once the final version is saved; commitSend runs in the
  // background after the undo delay.
  async prepareSend(account, draft) {
    return { draftId: draft.ref };
  },

  async commitSend(account, sendable) {
    await apiFetch(account, `${API}/drafts/send`, { method: 'POST', body: { id: sendable.draftId } });
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

  // Several at once; returns the ids that could not be moved.
  async trashMany(account, ids, onProgress) {
    const failed = [];
    let done = 0;
    await mapLimit(ids, 5, async (id) => {
      try {
        await this.trash(account, id);
      } catch (e) {
        if (e.name === 'AuthRequiredError') throw e;
        failed.push(id);
      }
      onProgress?.(++done, ids.length);
    });
    return failed;
  },
};

function toFullMessage(account, m) {
  const h = headerMap(m.payload?.headers);
  const parts = { html: null, text: null, attachments: [] };
  walkParts(m.payload, parts);
  return {
    id: m.id,
    threadId: m.threadId,
    subject: h.subject ?? '',
    from: parseAddress(h.from),
    to: parseAddressList(h.to),
    cc: parseAddressList(h.cc),
    bcc: parseAddressList(h.bcc),
    replyTo: parseAddressList(h['reply-to']),
    internetMessageId: h['message-id'] ?? null,
    references: h.references ?? null,
    inReplyTo: h['in-reply-to'] ?? null,
    date: Number(m.internalDate),
    isRead: !(m.labelIds ?? []).includes('UNREAD'),
    html: parts.html,
    text: parts.text,
    attachments: parts.attachments,
    webUrl: `https://mail.google.com/mail/?authuser=${encodeURIComponent(account.email)}#all/${m.threadId}`,
  };
}

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
    apiFetch(account, `${API}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`),
  );
  const messages = metas.map((m) => {
    const h = headerMap(m.payload?.headers);
    return {
      id: m.id,
      threadId: m.threadId,
      from: parseAddress(h.from),
      to: parseAddressList(h.to),
      subject: h.subject ?? '',
      snippet: decodeEntities(m.snippet),
      date: Number(m.internalDate),
      read: !(m.labelIds ?? []).includes('UNREAD'),
    };
  });
  return messages.sort((a, b) => b.date - a.date);
}
