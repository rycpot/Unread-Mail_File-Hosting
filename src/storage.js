// Persistent state, all in chrome.storage.local so it survives restarts and
// sign-outs. Layout:
//   accounts          { [accountId]: Account }
//   auth/<accountId>  { accessToken, expiresAt, refreshToken? }
//   mail/<accountId>  MailState (last known unread list; never wiped on errors)
//   settings          Settings
// Each account's mail and auth live under their own key so the background
// poller and the app tab never overwrite each other's writes.

import { DEFAULT_SETTINGS } from './config.js';

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
