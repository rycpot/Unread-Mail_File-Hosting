// Outlook / Hotmail via Microsoft Graph (scope: Mail.ReadWrite).
// https://learn.microsoft.com/graph/api/resources/message

import { MAX_MESSAGES_PER_ACCOUNT } from '../config.js';
import { apiFetch } from '../http.js';
import { base64ToBytes } from '../util.js';

const API = 'https://graph.microsoft.com/v1.0/me';
const enc = encodeURIComponent;

const toAddress = (r) => ({ name: r?.emailAddress?.name ?? '', email: r?.emailAddress?.address ?? '' });

export const outlook = {
  id: 'outlook',
  name: 'Outlook',

  async identify(token) {
    const res = await fetch(`${API}?$select=userPrincipalName,mail`, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
    if (!res.ok) throw new Error(`Could not read the Microsoft profile (${res.status})`);
    const me = await res.json();
    return { email: me.mail || me.userPrincipalName };
  },

  async fetchSummary(account) {
    const [folder, messages] = await Promise.all([
      apiFetch(account, `${API}/mailFolders/inbox?$select=unreadItemCount`),
      listInbox(account, false, MAX_MESSAGES_PER_ACCOUNT),
    ]);
    return { unreadCount: folder.unreadItemCount ?? messages.length, messages };
  },

  // The newest already-read inbox emails, fetched only when asked for.
  async fetchRecentRead(account, limit) {
    return listInbox(account, true, limit);
  },

  async getMessage(account, id) {
    const m = await apiFetch(
      account,
      `${API}/messages/${enc(id)}?$select=subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,isRead,webLink`,
      { headers: { Prefer: 'outlook.body-content-type="html"' } },
    );
    const html = m.body?.contentType === 'html' ? m.body.content : null;
    let attachments = [];
    // hasAttachments is false when a message only has inline images.
    if (m.hasAttachments || html?.includes('cid:')) {
      const list = await apiFetch(
        account,
        `${API}/messages/${enc(id)}/attachments?$select=id,name,contentType,size,isInline`,
      );
      attachments = (list.value ?? [])
        // Only file attachments carry bytes; attached emails/cloud links are skipped.
        .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment')
        .map((a) => ({
          id: a.id,
          filename: a.name || 'attachment',
          mimeType: (a.contentType ?? '').toLowerCase(),
          size: a.size ?? 0,
          contentId: null, // filled in on demand for inline parts, see resolveInline
          inline: Boolean(a.isInline),
        }));
    }
    return {
      id: m.id,
      subject: m.subject ?? '',
      from: toAddress(m.from),
      to: (m.toRecipients ?? []).map(toAddress),
      cc: (m.ccRecipients ?? []).map(toAddress),
      date: Date.parse(m.receivedDateTime),
      isRead: m.isRead,
      html,
      text: html ? null : m.body?.content ?? '',
      attachments,
      webUrl: m.webLink,
    };
  },

  // Graph's attachment list cannot $select contentId, so inline parts are fetched
  // individually to learn their cid.
  async resolveInline(account, messageId, attachment) {
    const a = await apiFetch(account, `${API}/messages/${enc(messageId)}/attachments/${enc(attachment.id)}`);
    return { contentId: a.contentId?.replace(/^<|>$/g, '') ?? null, bytes: base64ToBytes(a.contentBytes ?? '') };
  },

  async getAttachment(account, messageId, attachment) {
    const a = await apiFetch(account, `${API}/messages/${enc(messageId)}/attachments/${enc(attachment.id)}`);
    return base64ToBytes(a.contentBytes ?? '');
  },

  async setRead(account, id, read) {
    await apiFetch(account, `${API}/messages/${enc(id)}`, { method: 'PATCH', body: { isRead: read } });
  },

  // Graph JSON batching, 20 requests per call. Requests throttled with 429
  // are retried after the server's Retry-After. Returns the ids that failed.
  async setReadMany(account, ids, read, onProgress) {
    const failed = [];
    for (let i = 0; i < ids.length; i += 20) {
      let pending = ids.slice(i, i + 20);
      for (let attempt = 0; pending.length && attempt < 4; attempt++) {
        const res = await apiFetch(account, 'https://graph.microsoft.com/v1.0/$batch', {
          method: 'POST',
          body: {
            requests: pending.map((id, n) => ({
              id: String(n),
              method: 'PATCH',
              url: `/me/messages/${enc(id)}`,
              headers: { 'Content-Type': 'application/json' },
              body: { isRead: read },
            })),
          },
        });
        const byId = new Map((res.responses ?? []).map((r) => [Number(r.id), r]));
        const throttled = [];
        let wait = 0;
        pending.forEach((id, n) => {
          const r = byId.get(n);
          if (r && r.status >= 200 && r.status < 300) return;
          if (r?.status === 429 && attempt < 3) {
            throttled.push(id);
            wait = Math.max(wait, Number(r.headers?.['Retry-After'] ?? 2));
          } else failed.push(id);
        });
        pending = throttled;
        if (pending.length) await new Promise((ok) => setTimeout(ok, Math.min(wait, 30) * 1000));
      }
      onProgress?.(Math.min(i + 20, ids.length), ids.length);
    }
    return failed;
  },

  // Every unread inbox message, not just the ones listed in the sidebar. Ids are
  // collected first so marking does not shift the pages being read.
  async markAllRead(account, onProgress) {
    const ids = [];
    let url = `${API}/mailFolders/inbox/messages?$filter=${enc('isRead eq false')}&$select=id&$top=500`;
    while (url) {
      const page = await apiFetch(account, url);
      ids.push(...(page.value ?? []).map((m) => m.id));
      url = page['@odata.nextLink'];
    }
    const failed = await this.setReadMany(account, ids, true, onProgress);
    return { total: ids.length, failed };
  },

  // Moves to Deleted Items (recoverable), never a permanent delete.
  async trash(account, id) {
    await apiFetch(account, `${API}/messages/${enc(id)}/move`, {
      method: 'POST',
      body: { destinationId: 'deleteditems' },
    });
  },
};

// Newest inbox messages that are read (or unread), newest first. Graph only
// allows $orderby with $filter when the ordered property also comes first in
// the filter, hence the always-true date clause.
async function listInbox(account, isRead, top) {
  const filter = enc(`receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq ${isRead}`);
  const list = await apiFetch(
    account,
    `${API}/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime%20desc` +
      `&$top=${top}&$select=id,subject,from,receivedDateTime,bodyPreview`,
  );
  return (list.value ?? []).map((m) => ({
    id: m.id,
    from: toAddress(m.from),
    subject: m.subject ?? '',
    snippet: m.bodyPreview ?? '',
    date: Date.parse(m.receivedDateTime),
  }));
}
