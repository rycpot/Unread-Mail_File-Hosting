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
    // Graph only allows $orderby together with $filter when the ordered property
    // also appears first in the filter, hence the always-true date clause.
    const filter = enc('receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false');
    const [folder, list] = await Promise.all([
      apiFetch(account, `${API}/mailFolders/inbox?$select=unreadItemCount`),
      apiFetch(
        account,
        `${API}/mailFolders/inbox/messages?$filter=${filter}&$orderby=receivedDateTime%20desc` +
          `&$top=${MAX_MESSAGES_PER_ACCOUNT}&$select=id,subject,from,receivedDateTime,bodyPreview`,
      ),
    ]);
    const messages = (list.value ?? []).map((m) => ({
      id: m.id,
      from: toAddress(m.from),
      subject: m.subject ?? '',
      snippet: m.bodyPreview ?? '',
      date: Date.parse(m.receivedDateTime),
    }));
    return { unreadCount: folder.unreadItemCount ?? messages.length, messages };
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

  // Graph JSON batching, 20 requests per call. Returns the ids that failed.
  async setReadMany(account, ids, read) {
    const failed = [];
    for (let i = 0; i < ids.length; i += 20) {
      const chunk = ids.slice(i, i + 20);
      const res = await apiFetch(account, 'https://graph.microsoft.com/v1.0/$batch', {
        method: 'POST',
        body: {
          requests: chunk.map((id, n) => ({
            id: String(n),
            method: 'PATCH',
            url: `/me/messages/${enc(id)}`,
            headers: { 'Content-Type': 'application/json' },
            body: { isRead: read },
          })),
        },
      });
      const ok = new Set((res.responses ?? []).filter((r) => r.status >= 200 && r.status < 300).map((r) => Number(r.id)));
      chunk.forEach((id, n) => ok.has(n) || failed.push(id));
    }
    return failed;
  },

  // Moves to Deleted Items (recoverable), never a permanent delete.
  async trash(account, id) {
    await apiFetch(account, `${API}/messages/${enc(id)}/move`, {
      method: 'POST',
      body: { destinationId: 'deleteditems' },
    });
  },
};
