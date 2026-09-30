// iCloud, Yahoo and AOL over IMAP, through the local helper. Passwords are
// app-specific passwords held in the macOS Keychain by the helper; the
// extension never stores them.

import { MAX_MESSAGES_PER_ACCOUNT } from '../config.js';
import { callHelper } from '../native.js';
import { base64ToBytes } from '../util.js';
import { buildMime, bytesToBase64, newMessageId } from '../compose/mime.js';

function imapProvider({ id, name, webUrl, passwordHelp }) {
  const call = (account, cmd, extra = {}, opts) =>
    callHelper({ cmd, provider: id, email: account.email, ...extra }, opts);

  return {
    id,
    name,
    kind: 'imap',
    passwordHelp,

    // Checks the password by logging in; the helper then saves it to Keychain.
    async saveAccount(email, password) {
      await callHelper({ cmd: 'saveAccount', provider: id, email, password });
      return { email };
    },

    async forgetAccount(account) {
      await call(account, 'removeAccount');
    },

    async fetchSummary(account) {
      return call(account, 'summary', { limit: MAX_MESSAGES_PER_ACCOUNT });
    },

    async fetchRecentRead(account, limit) {
      return (await call(account, 'recentRead', { limit })).messages;
    },

    // opts.folder is "spam" for emails opened from the Spam list; message ids
    // are only unique within a folder.
    async getMessage(account, messageId, { folder } = {}) {
      const m = await call(account, 'getMessage', { id: messageId, folder });
      return { ...m, webUrl };
    },

    // Several emails / attachments per helper session, for the offline cache.
    async getMessages(account, ids, { folder } = {}) {
      const res = await call(account, 'getMessages', { ids, folder });
      return res.messages.map((m) => ({ ...m, webUrl }));
    },

    async getAttachments(account, messageId, attachments, { folder } = {}) {
      const res = await call(account, 'getAttachments', {
        id: messageId,
        folder,
        parts: attachments.map((a) => ({ attachmentId: a.id, section: a.section, size: a.size })),
      });
      return Object.fromEntries(Object.entries(res.attachments).map(([k, v]) => [k, base64ToBytes(v)]));
    },

    async getAttachment(account, messageId, attachment, { folder } = {}) {
      if (attachment.data) return base64ToBytes(attachment.data);
      // section + size let the helper fetch just this part (see the helper).
      const res = await call(account, 'getAttachment', { id: messageId, attachmentId: attachment.id, section: attachment.section, size: attachment.size, folder });
      return base64ToBytes(res.data);
    },

    async setRead(account, messageId, read, { folder } = {}) {
      await call(account, 'setRead', { ids: [messageId], read, folder });
    },

    async setReadMany(account, ids, read) {
      return (await call(account, 'setRead', { ids, read })).failed;
    },

    async markAllRead(account, onProgress) {
      return call(account, 'markAllRead', {}, { onProgress });
    },

    async trash(account, messageId, { folder } = {}) {
      await call(account, 'trash', { ids: [messageId], folder });
    },

    async trashMany(account, ids) {
      return (await call(account, 'trash', { ids })).failed ?? [];
    },

    async fetchSpam(account, limit) {
      return (await call(account, 'spamList', { limit })).messages;
    },

    async notSpam(account, ids) {
      return (await call(account, 'notSpam', { ids })).failed ?? [];
    },

    // ---------- Sent, Drafts, sending ----------

    async fetchSent(account, limit) {
      return (await call(account, 'folderList', { folder: 'sent', limit })).messages;
    },

    async fetchDrafts(account, limit) {
      return (await call(account, 'folderList', { folder: 'drafts', limit })).messages.map((m) => ({ ...m, read: true }));
    },

    async loadDraft(account, ref) {
      const msg = await this.getMessage(account, ref, { folder: 'drafts' });
      msg.attachments = await Promise.all(msg.attachments.map(async (a) => ({
        ...a, bytes: await this.getAttachment(account, ref, a, { folder: 'drafts' }),
      })));
      return { ...msg, ref, messageId: msg.internetMessageId };
    },

    // The whole message is stored again on each save (IMAP drafts cannot be
    // edited in place); the helper removes the previous copy. Returns its id.
    async saveDraft(account, draft) {
      draft.messageId ??= newMessageId(draft.from.email);
      const raw = bytesToBase64(new TextEncoder().encode(buildMime(draft, { includeBcc: true })));
      const res = await call(account, 'saveDraft', { raw, messageId: draft.messageId, replaceId: draft.ref ?? undefined });
      return res.id;
    },

    async deleteDraft(account, ref) {
      await call(account, 'deleteDraft', { id: ref });
    },

    // The message as delivered: no Bcc header; every recipient on the envelope.
    async prepareSend(account, draft) {
      const raw = bytesToBase64(new TextEncoder().encode(buildMime(draft, { includeBcc: false })));
      const rcpts = [...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])].map((a) => a.email);
      return { raw, rcpts, draftId: draft.ref };
    },

    async commitSend(account, sendable) {
      const res = await call(account, 'send', sendable);
      if (res.warning) console.warn('[send]', res.warning);
      return res;
    },
  };
}

export const icloud = imapProvider({
  id: 'icloud',
  name: 'iCloud',
  webUrl: 'https://www.icloud.com/mail/',
  passwordHelp: {
    text: 'Use your @icloud.com address and an app-specific password from account.apple.com → Sign-In and Security → App-Specific Passwords.',
    url: 'https://account.apple.com/account/manage',
  },
});

export const yahoo = imapProvider({
  id: 'yahoo',
  name: 'Yahoo',
  webUrl: 'https://mail.yahoo.com/',
  passwordHelp: {
    text: 'Use an app password from Yahoo Account Security → Generate app password.',
    url: 'https://login.yahoo.com/account/security',
  },
});

export const aol = imapProvider({
  id: 'aol',
  name: 'AOL',
  webUrl: 'https://mail.aol.com/',
  passwordHelp: {
    text: 'Use an app password from AOL Account Security → Generate app password.',
    url: 'https://login.aol.com/account/security',
  },
});
