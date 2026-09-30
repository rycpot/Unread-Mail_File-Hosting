// Outlook / Hotmail via Microsoft Graph (scope: Mail.ReadWrite).
// https://learn.microsoft.com/graph/api/resources/message

import { MAX_MESSAGES_PER_ACCOUNT } from '../config.js';
import { apiFetch } from '../http.js';
import { hasOutlookSendPermission, SendPermissionError } from '../auth.js';
import { bytesToBase64 } from '../compose/mime.js';
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
    const [folder, messages, junk] = await Promise.all([
      apiFetch(account, `${API}/mailFolders/inbox?$select=unreadItemCount`),
      listInbox(account, false, MAX_MESSAGES_PER_ACCOUNT),
      apiFetch(account, `${API}/mailFolders/junkemail?$select=unreadItemCount`).catch(() => null),
    ]);
    return { unreadCount: folder.unreadItemCount ?? messages.length, spamUnread: junk?.unreadItemCount ?? 0, messages };
  },

  // The newest unread emails in Junk Email, fetched only when asked for. (The
  // date clause lets Graph combine $orderby with the filter, see listInbox.)
  async fetchSpam(account, limit) {
    const filter = enc('receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false');
    const list = await apiFetch(
      account,
      `${API}/mailFolders/junkemail/messages?$filter=${filter}&$orderby=receivedDateTime%20desc&$top=${limit}` +
        '&$select=id,subject,from,receivedDateTime,bodyPreview,isRead',
    );
    return (list.value ?? []).map((m) => ({ ...toSummary(m), read: m.isRead }));
  },

  // Back to the inbox.
  async notSpam(account, ids) {
    return batch(account, ids, (id) => ({ method: 'POST', url: `/me/messages/${enc(id)}/move`, body: { destinationId: 'inbox' } }));
  },

  // The newest already-read inbox emails, fetched only when asked for.
  async fetchRecentRead(account, limit) {
    return listInbox(account, true, limit);
  },

  async getMessage(account, id) {
    const m = await apiFetch(
      account,
      `${API}/messages/${enc(id)}?$select=subject,from,toRecipients,ccRecipients,bccRecipients,replyTo,receivedDateTime,body,hasAttachments,isRead,webLink,internetMessageId,conversationId`,
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
      bcc: (m.bccRecipients ?? []).map(toAddress),
      replyTo: (m.replyTo ?? []).map(toAddress),
      internetMessageId: m.internetMessageId ?? null,
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

  async setReadMany(account, ids, read, onProgress) {
    return batch(account, ids, (id) => ({ method: 'PATCH', url: `/me/messages/${enc(id)}`, body: { isRead: read } }), onProgress);
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

  // ---------- Sent, Drafts, sending ----------

  async fetchSent(account, limit) {
    const list = await apiFetch(account, `${API}/mailFolders/sentitems/messages?$orderby=sentDateTime%20desc&$top=${limit}` +
      '&$select=id,subject,from,toRecipients,sentDateTime,bodyPreview');
    return (list.value ?? []).map((m) => ({ ...toSummary({ ...m, receivedDateTime: m.sentDateTime }), to: (m.toRecipients ?? []).map(toAddress), read: true }));
  },

  async fetchDrafts(account, limit) {
    const list = await apiFetch(account, `${API}/mailFolders/drafts/messages?$orderby=lastModifiedDateTime%20desc&$top=${limit}` +
      '&$select=id,subject,from,toRecipients,lastModifiedDateTime,bodyPreview');
    return (list.value ?? []).map((m) => ({ ...toSummary({ ...m, receivedDateTime: m.lastModifiedDateTime }), to: (m.toRecipients ?? []).map(toAddress), read: true }));
  },

  async loadDraft(account, ref) {
    const msg = await this.getMessage(account, ref);
    const list = await apiFetch(account, `${API}/messages/${enc(ref)}/attachments`);
    msg.attachments = (list.value ?? [])
      .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment')
      .map((a) => ({
        serverId: a.id,
        filename: a.name || 'attachment',
        mimeType: (a.contentType ?? '').toLowerCase(),
        size: a.size ?? 0,
        contentId: a.contentId?.replace(/^<|>$/g, '') ?? null,
        inline: Boolean(a.isInline),
        bytes: base64ToBytes(a.contentBytes ?? ''),
      }));
    return { ...msg, ref };
  },

  // Replies and forwards start from Graph's createReply / createReplyAll /
  // createForward, which set the threading headers (and, for a forward, copy
  // the original attachments); our recipients, subject and body then replace
  // theirs. Attachments are kept in step with the draft's: each one we
  // upload is remembered by its serverId, and server copies we no longer
  // have are removed. Returns the draft id.
  async saveDraft(account, draft) {
    let ref = draft.ref;
    if (!ref) {
      const action = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' }[draft.mode];
      const created = action && draft.reply?.id
        ? await apiFetch(account, `${API}/messages/${enc(draft.reply.id)}/${action}`, { method: 'POST', body: {} })
        : await apiFetch(account, `${API}/messages`, { method: 'POST', body: { subject: draft.subject ?? '' } });
      ref = created.id;
    }
    const recipients = (list) => (list ?? []).map((a) => ({ emailAddress: { address: a.email, name: a.name || a.email } }));
    await apiFetch(account, `${API}/messages/${enc(ref)}`, {
      method: 'PATCH',
      body: {
        subject: draft.subject ?? '',
        body: { contentType: 'HTML', content: draft.html ?? '' },
        toRecipients: recipients(draft.to),
        ccRecipients: recipients(draft.cc),
        bccRecipients: recipients(draft.bcc),
      },
    });

    // Attachments: claim server copies (e.g. a forward's originals) by name
    // and size, upload the rest, remove leftovers.
    const server = ((await apiFetch(account, `${API}/messages/${enc(ref)}/attachments?$select=id,name,size,isInline,contentId`)).value ?? []);
    const wanted = [
      ...(draft.attachments ?? []).map((a) => ({ item: a, inline: false })),
      ...(draft.inline ?? []).map((a) => ({ item: a, inline: true })),
    ];
    const claimed = new Set();
    for (const { item } of wanted) {
      if (item.serverId && server.some((x) => x.id === item.serverId)) {
        claimed.add(item.serverId);
        continue;
      }
      const match = server.find((x) => !claimed.has(x.id) && x.name === item.filename && Math.abs((x.size ?? 0) - (item.bytes?.length ?? 0)) < 2048);
      if (match) {
        item.serverId = match.id;
        claimed.add(match.id);
      } else item.serverId = null;
    }
    for (const x of server) {
      if (!claimed.has(x.id)) await apiFetch(account, `${API}/messages/${enc(ref)}/attachments/${enc(x.id)}`, { method: 'DELETE' });
    }
    for (const { item, inline } of wanted) {
      if (!item.serverId) item.serverId = await uploadAttachment(account, ref, item, inline);
    }
    return ref;
  },

  async deleteDraft(account, ref) {
    await apiFetch(account, `${API}/messages/${enc(ref)}`, { method: 'DELETE' });
  },

  async prepareSend(account, draft) {
    if (!(await hasOutlookSendPermission(account))) throw new SendPermissionError(account);
    return { id: draft.ref };
  },

  async commitSend(account, sendable) {
    await apiFetch(account, `${API}/messages/${enc(sendable.id)}/send`, { method: 'POST' });
  },

  async trashMany(account, ids, onProgress) {
    return batch(account, ids, (id) => ({ method: 'POST', url: `/me/messages/${enc(id)}/move`, body: { destinationId: 'deleteditems' } }), onProgress);
  },
};

// Graph JSON batching, 20 requests per call; request(id) gives method, url and
// body. Requests throttled with 429 are retried after the server's Retry-After.
// Returns the ids that failed.
async function batch(account, ids, request, onProgress) {
  const failed = [];
  for (let i = 0; i < ids.length; i += 20) {
    let pending = ids.slice(i, i + 20);
    for (let attempt = 0; pending.length && attempt < 4; attempt++) {
      const res = await apiFetch(account, 'https://graph.microsoft.com/v1.0/$batch', {
        method: 'POST',
        body: {
          requests: pending.map((id, n) => ({
            id: String(n),
            headers: { 'Content-Type': 'application/json' },
            ...request(id),
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
}

// Up to 3 MB in one request; larger files through an upload session in 4 MB
// chunks (up to 150 MB). Returns the attachment id when Graph gives one.
async function uploadAttachment(account, ref, item, inline) {
  const bytes = item.bytes;
  const base = { name: item.filename, contentType: item.mimeType || 'application/octet-stream', isInline: inline, ...(inline && { contentId: item.cid ?? item.contentId }) };
  if (bytes.length <= 3 * 1024 * 1024) {
    const res = await apiFetch(account, `${API}/messages/${enc(ref)}/attachments`, {
      method: 'POST',
      body: { '@odata.type': '#microsoft.graph.fileAttachment', ...base, contentBytes: bytesToBase64(bytes) },
    });
    return res.id;
  }
  const session = await apiFetch(account, `${API}/messages/${enc(ref)}/attachments/createUploadSession`, {
    method: 'POST',
    body: { AttachmentItem: { attachmentType: 'file', name: base.name, size: bytes.length, contentType: base.contentType, isInline: inline, ...(inline && { contentId: base.contentId }) } },
  });
  const CHUNK = 4 * 1024 * 1024;
  let last = null;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    // The upload URL carries its own authorisation; no bearer token.
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${i}-${i + chunk.length - 1}/${bytes.length}` },
      body: chunk,
    });
    if (!res.ok) throw new Error(`Attachment upload failed (${res.status})`);
    last = res;
  }
  const location = last?.headers.get('Location') ?? '';
  return location.match(/Attachments\('([^']+)'\)/i)?.[1] ?? null;
}

const toSummary = (m) => ({
  id: m.id,
  from: toAddress(m.from),
  subject: m.subject ?? '',
  snippet: m.bodyPreview ?? '',
  date: Date.parse(m.receivedDateTime),
});

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
  return (list.value ?? []).map((m) => ({ ...toSummary(m), read: isRead }));
}
