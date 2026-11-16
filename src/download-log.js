// The last few failures of the background downloader (src/prefetch.js) and of
// saving to the offline cache, and what its last run did per account, kept so the app can say why an email was not
// cached when it was opened (Settings → Show timing when opening an email).

const KEY = 'downloadErrors';
const KEEP = 20;

let queue = Promise.resolve();

// what: 'account' | 'email' | 'attachment' | 'cache'.
export function logDownloadError(accountId, what, error) {
  const message = String(error?.message ?? error);
  console.debug('[prefetch]', accountId, what, message);
  queue = queue.then(async () => {
    const list = (await chrome.storage.local.get(KEY))[KEY] ?? [];
    const same = list.findIndex((e) => e.accountId === accountId && e.what === what && e.message === message);
    const count = same === -1 ? 1 : list.splice(same, 1)[0].count + 1;
    list.unshift({ accountId, what, message, count, at: Date.now() });
    await chrome.storage.local.set({ [KEY]: list.slice(0, KEEP) });
  }).catch(() => {});
  return queue;
}

// The newest failure recorded for an account, or null.
export async function lastDownloadError(accountId) {
  const list = (await chrome.storage.local.get(KEY))[KEY] ?? [];
  return list.find((e) => e.accountId === accountId) ?? null;
}

// What the last run did per account, for the app's open timing:
// { at, listed, missing, fetched }, one key per account.
const stateKey = (accountId) => `prefetchState/${accountId}`;
export async function noteRun(accountId, entry) {
  await chrome.storage.local.set({ [stateKey(accountId)]: { at: Date.now(), ...entry } }).catch(() => {});
}
export async function lastRun(accountId) {
  return (await chrome.storage.local.get(stateKey(accountId)))[stateKey(accountId)] ?? null;
}
