// Proton Mail (free plan) through the session of mail.proton.me signed in in
// this Chrome profile. Proton has no public API or IMAP on the free plan, so
// this uses the same private endpoints as the Proton web app:
//
//   * the session is identified by the AUTH-<UID> cookie; requests carry the
//     x-pm-uid header and are sent with the browser's cookies;
//   * a declarativeNetRequest rule gives the extension's requests the Origin
//     and Referer of mail.proton.me, as the web app's own requests have;
//   * x-pm-appversion must name a current web-mail release; it is read from
//     mail.proton.me/assets/version.json (and refreshed when Proton rejects it).
//
// Message metadata (sender, subject, time, read state, labels) is readable
// directly. Bodies are end-to-end encrypted: they are read from a Proton Mail
// tab after Proton has decrypted them (see proton-tab.js), so no keys are ever
// handled here. If that fails, the reader falls back to "Open in Proton".

import { AuthRequiredError } from '../auth.js';
import { ApiError } from '../http.js';
import { readInProtonTab } from './proton-tab.js';

const ORIGIN = 'https://mail.proton.me';
const API = `${ORIGIN}/api`;
const INBOX = '0';
const TRASH = '3';
const RULE_ID = 1001;
const VERSION_KEY = 'protonAppVersion';
// Used only if version.json cannot be read and nothing is cached yet.
const FALLBACK_VERSION = '5.0.200.0';

// ---------- request plumbing ----------

let ruleReady = null;
export function ensureProtonHeaderRule() {
  ruleReady ??= chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [{
      id: RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'origin', operation: 'set', value: ORIGIN },
          { header: 'referer', operation: 'set', value: `${ORIGIN}/` },
        ],
      },
      condition: {
        initiatorDomains: [chrome.runtime.id],
        urlFilter: '||mail.proton.me/api/',
        resourceTypes: ['xmlhttprequest'],
      },
    }],
  }).catch((e) => {
    ruleReady = null;
    throw e;
  });
  return ruleReady;
}

async function appVersion({ refresh = false } = {}) {
  const cached = (await chrome.storage.local.get(VERSION_KEY))[VERSION_KEY];
  if (!refresh && cached && Date.now() - cached.at < 24 * 3600e3) return cached.version;
  try {
    const res = await fetch(`${ORIGIN}/assets/version.json`, { cache: 'no-store' });
    const json = await res.json();
    const version = json.version ?? json.Version;
    if (version) {
      await chrome.storage.local.set({ [VERSION_KEY]: { version, at: Date.now() } });
      return version;
    }
  } catch (e) {
    console.warn('[proton] could not read version.json', e);
  }
  return cached?.version ?? FALLBACK_VERSION;
}

// UIDs of every Proton session signed in on mail.proton.me in this profile.
async function sessionUids() {
  const cookies = await chrome.cookies.getAll({ domain: 'mail.proton.me' });
  return [...new Set(cookies.filter((c) => c.name.startsWith('AUTH-')).map((c) => c.name.slice(5)))];
}

async function rawCall(uid, path, { method = 'GET', body, retry = true } = {}) {
  await ensureProtonHeaderRule();
  const res = await fetch(`${API}/${path}`, {
    method,
    credentials: 'include',
    headers: {
      'x-pm-uid': uid,
      'x-pm-appversion': `web-mail@${await appVersion()}`,
      Accept: 'application/vnd.protonmail.v1+json',
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  // 5003/5005: this app version is no longer accepted; fetch the current one.
  if ((json.Code === 5003 || json.Code === 5005) && retry) {
    await appVersion({ refresh: true });
    return rawCall(uid, path, { method, body, retry: false });
  }
  if (res.status === 401) throw new AuthRequiredError('Proton session expired');
  if (!res.ok || (json.Code && json.Code !== 1000 && json.Code !== 1001)) {
    throw new ApiError(json.Error || `Proton request failed (${res.status})`, res.status);
  }
  return json;
}

// The web app renews its access cookie with the refresh cookie; do the same
// once when a request is rejected.
async function refreshSession(uid) {
  await ensureProtonHeaderRule();
  for (const path of ['auth/refresh', 'auth/v4/refresh']) {
    const res = await fetch(`${API}/${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'x-pm-uid': uid,
        'x-pm-appversion': `web-mail@${await appVersion()}`,
        Accept: 'application/vnd.protonmail.v1+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ UID: uid, ResponseType: 'token', GrantType: 'refresh_token', RefreshToken: '', RedirectURI: 'https://protonmail.com' }),
    });
    if (res.ok) return true;
  }
  return false;
}

async function whoAmI(uid) {
  const json = await rawCall(uid, 'core/v4/users');
  return (json.User?.Email || json.User?.Name || '').toLowerCase();
}

// Calls the API for an account, renewing the session or finding its new UID
// (after signing out and in again) when the stored one stops working.
async function call(account, path, opts) {
  const uid = account.uid;
  try {
    if (!uid) throw new AuthRequiredError('No Proton session');
    return await rawCall(uid, path, opts);
  } catch (e) {
    if (!(e instanceof AuthRequiredError)) throw e;
    if (uid && (await refreshSession(uid))) return rawCall(uid, path, opts);
    for (const other of await sessionUids()) {
      if (other === uid) continue;
      try {
        if ((await whoAmI(other)) === account.email.toLowerCase()) {
          await updateUid(account, other);
          return rawCall(other, path, opts);
        }
      } catch {}
    }
    throw new AuthRequiredError('Signed out of Proton. Sign in at mail.proton.me, then click Sign in here.');
  }
}

async function updateUid(account, uid) {
  account.uid = uid;
  const { accounts = {} } = await chrome.storage.local.get('accounts');
  if (accounts[account.id]) {
    accounts[account.id].uid = uid;
    await chrome.storage.local.set({ accounts });
  }
}

// ---------- mapping ----------

const addr = (a) => ({ name: a?.Name ?? '', email: a?.Address ?? '' });

function toSummary(m) {
  return {
    id: m.ID,
    from: addr(m.Sender),
    subject: m.Subject ?? '',
    date: (m.Time ?? 0) * 1000,
    read: !m.Unread,
  };
}

async function listInbox(account, unread, pageSize, page = 0) {
  const q = new URLSearchParams({ LabelID: INBOX, Unread: unread ? '1' : '0', Page: String(page), PageSize: String(pageSize), Sort: 'Time', Desc: '1' });
  return call(account, `mail/v4/messages?${q}`);
}

// ---------- provider ----------

export const proton = {
  id: 'proton',
  name: 'Proton',
  kind: 'session',
  signInUrl: `${ORIGIN}/inbox`,

  // Every Proton account signed in on mail.proton.me in this Chrome profile.
  async discover() {
    const found = [];
    for (const uid of await sessionUids()) {
      try {
        const email = await whoAmI(uid);
        if (email) found.push({ email, uid });
      } catch (e) {
        console.warn('[proton] session', uid, 'unusable:', e.message);
      }
    }
    return found;
  },

  async fetchSummary(account) {
    const [counts, list] = await Promise.all([
      call(account, 'mail/v4/messages/count'),
      listInbox(account, true, 30),
    ]);
    const inbox = (counts.Counts ?? []).find((c) => c.LabelID === INBOX);
    return { unreadCount: inbox?.Unread ?? list.Total ?? 0, messages: (list.Messages ?? []).map(toSummary) };
  },

  async fetchRecentRead(account, limit) {
    return ((await listInbox(account, false, limit)).Messages ?? []).map(toSummary);
  },

  async getMessage(account, id) {
    const { Message: m } = await call(account, `mail/v4/messages/${encodeURIComponent(id)}`);
    const base = {
      id: m.ID,
      subject: m.Subject ?? '',
      from: addr(m.Sender),
      to: (m.ToList ?? []).map(addr),
      cc: (m.CCList ?? []).map(addr),
      date: (m.Time ?? 0) * 1000,
      isRead: !m.Unread,
      attachments: [],
      numAttachments: m.NumAttachments ?? 0,
      webUrl: `${ORIGIN}/u/0/inbox/${encodeURIComponent(m.ID)}`,
    };
    try {
      const shown = await readInProtonTab(m.ID);
      // Proton marks an email read when it opens it; the app restores the
      // unread state if "Mark as read when opened" is off.
      return { ...base, html: shown.html, text: null, openedInProton: true, externalAttachments: shown.attachments ?? [] };
    } catch (e) {
      console.warn('[proton] reading from the Proton tab failed:', e);
      return { ...base, encrypted: true, html: null, text: null, readError: e.message };
    }
  },

  async setRead(account, id, read) {
    await call(account, `mail/v4/messages/${read ? 'read' : 'unread'}`, { method: 'PUT', body: { IDs: [id] } });
  },

  async setReadMany(account, ids, read) {
    for (let i = 0; i < ids.length; i += 100) {
      await call(account, `mail/v4/messages/${read ? 'read' : 'unread'}`, { method: 'PUT', body: { IDs: ids.slice(i, i + 100) } });
    }
    return [];
  },

  // Every unread inbox message. IDs are collected first, then marked.
  async markAllRead(account, onProgress) {
    const ids = [];
    for (let page = 0; ; page++) {
      const list = await listInbox(account, true, 150, page);
      const batch = (list.Messages ?? []).map((m) => m.ID);
      ids.push(...batch);
      if (batch.length < 150) break;
    }
    for (let i = 0; i < ids.length; i += 100) {
      await call(account, 'mail/v4/messages/read', { method: 'PUT', body: { IDs: ids.slice(i, i + 100) } });
      onProgress?.(Math.min(i + 100, ids.length), ids.length);
    }
    return { total: ids.length, failed: [] };
  },

  // Moves to Trash (label 3), as the web app's Delete button does.
  async trash(account, id) {
    await call(account, 'mail/v4/messages/label', { method: 'PUT', body: { LabelID: TRASH, IDs: [id] } });
  },
};
