// Persistent state, all in chrome.storage.local so it survives restarts and
// sign-outs. Layout:
//   accounts          { [accountId]: Account }
//   auth/<accountId>  { accessToken, expiresAt, refreshToken? }
//   mail/<accountId>  MailState (last known unread list; never wiped on errors)
//   settings          Settings
//   clientIds         { google, microsoft } OAuth client IDs entered in Settings
// Each account's mail and auth live under their own key so the background
// poller and the app tab never overwrite each other's writes.

import { DEFAULT_SETTINGS, GOOGLE_CLIENT_ID, MICROSOFT_CLIENT_ID } from './config.js';

const local = chrome.storage.local;

export const accountId = (provider, email) => `${provider}:${email.toLowerCase()}`;
export const mailKey = (id) => `mail/${id}`;
const authKey = (id) => `auth/${id}`;

export async function getAccounts() {
  return (await local.get('accounts')).accounts ?? {};
}

// Serialise read-modify-write of the shared `accounts` object within one context.
let accountsLock = Promise.resolve();
export function updateAccounts(mutate) {
  const run = accountsLock.then(async () => {
    const accounts = await getAccounts();
    mutate(accounts);
    await local.set({ accounts });
    return accounts;
  });
  accountsLock = run.catch(() => {});
  return run;
}

export async function upsertAccount(account) {
  return updateAccounts((accounts) => {
    const prev = accounts[account.id];
    // Re-adding an existing account keeps its hidden flag and add date.
    accounts[account.id] = { ...account, ...(prev && { hidden: prev.hidden, addedAt: prev.addedAt }) };
  });
}

export async function setAccountHidden(id, hidden) {
  return updateAccounts((accounts) => {
    if (accounts[id]) accounts[id].hidden = hidden;
  });
}

export async function removeAccount(id) {
  await updateAccounts((accounts) => delete accounts[id]);
  await local.remove([authKey(id), mailKey(id)]);
}

export async function getAuth(id) {
  return (await local.get(authKey(id)))[authKey(id)] ?? null;
}

export async function setAuth(id, auth) {
  await local.set({ [authKey(id)]: auth });
}

export async function getMail(id) {
  return (await local.get(mailKey(id)))[mailKey(id)] ?? null;
}

export async function getAllMail(ids) {
  const res = await local.get(ids.map(mailKey));
  return Object.fromEntries(ids.map((id) => [id, res[mailKey(id)] ?? null]));
}

// Merge a patch into an account's mail state (messages are replaced wholesale
// only when the patch contains them).
export async function patchMail(id, patch) {
  const prev = (await getMail(id)) ?? { messages: [], unreadCount: 0 };
  const next = { ...prev, ...patch };
  await local.set({ [mailKey(id)]: next });
  return next;
}

export async function getSettings() {
  return { ...DEFAULT_SETTINGS, ...((await local.get('settings')).settings ?? {}) };
}

export async function saveSettings(patch) {
  const settings = { ...(await getSettings()), ...patch };
  await local.set({ settings });
  return settings;
}

// OAuth client IDs live in storage so that replacing the extension's files on
// update never loses them. Values in config.js are only a fallback.
const configured = (v) => (v && !v.startsWith('PASTE_') ? v : '');

export async function getClientIds() {
  const stored = (await local.get('clientIds')).clientIds ?? {};
  const ids = {
    google: stored.google || configured(GOOGLE_CLIENT_ID),
    microsoft: stored.microsoft || configured(MICROSOFT_CLIENT_ID),
  };
  // Adopt IDs found only in config.js, so a later update that resets the file
  // keeps working.
  if ((ids.google && !stored.google) || (ids.microsoft && !stored.microsoft)) {
    await local.set({ clientIds: ids });
  }
  return ids;
}

export async function saveClientIds({ google, microsoft }) {
  await local.set({ clientIds: { google: google.trim(), microsoft: microsoft.trim() } });
}
