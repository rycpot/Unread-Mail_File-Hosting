// iCloud, Yahoo and AOL over IMAP, through the local helper. Passwords are
// app-specific passwords held in the macOS Keychain by the helper; the
// extension never stores them.

import { MAX_MESSAGES_PER_ACCOUNT } from '../config.js';
import { callHelper } from '../native.js';
import { base64ToBytes } from '../util.js';

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

    async getMessage(account, messageId) {
      const m = await call(account, 'getMessage', { id: messageId });
      return { ...m, webUrl };
    },

    async getAttachment(account, messageId, attachment) {
      if (attachment.data) return base64ToBytes(attachment.data);
      const res = await call(account, 'getAttachment', { id: messageId, attachmentId: attachment.id });
      return base64ToBytes(res.data);
    },

    async setRead(account, messageId, read) {
      await call(account, 'setRead', { ids: [messageId], read });
    },

    async setReadMany(account, ids, read) {
      return (await call(account, 'setRead', { ids, read })).failed;
    },

    async markAllRead(account, onProgress) {
      return call(account, 'markAllRead', {}, { onProgress });
    },

    async trash(account, messageId) {
      await call(account, 'trash', { ids: [messageId] });
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
