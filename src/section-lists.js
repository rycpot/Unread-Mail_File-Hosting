// The Recently read, Sent, Drafts and Spam lists of each account, kept in
// chrome.storage.local (one key per account and list, so the app and the
// background never overwrite each other). The background refresh fills them
// and the app shows them at once, then refreshes them itself when opened.

export const LIST_KINDS = ['recent', 'sent', 'drafts', 'spam'];
const keyOf = (accountId, kind) => `list/${accountId}/${kind}`;

// { [accountId]: { [kind]: rows } } for the given accounts (missing = never fetched).
export async function getSectionLists(accountIds) {
  const keys = accountIds.flatMap((id) => LIST_KINDS.map((kind) => keyOf(id, kind)));
  const stored = keys.length ? await chrome.storage.local.get(keys) : {};
  const out = {};
  for (const id of accountIds) {
    out[id] = {};
    for (const kind of LIST_KINDS) if (stored[keyOf(id, kind)]) out[id][kind] = stored[keyOf(id, kind)].rows;
  }
  return out;
}

export async function putSectionList(accountId, kind, rows) {
  await chrome.storage.local.set({ [keyOf(accountId, kind)]: { rows, at: Date.now() } });
}

// Removes one email from an account's stored list (deleted, moved, sent …).
export async function dropFromSectionList(accountId, kind, messageId) {
  const key = keyOf(accountId, kind);
  const rec = (await chrome.storage.local.get(key))[key];
  if (rec?.rows.some((m) => m.id === messageId)) await putSectionList(accountId, kind, rec.rows.filter((m) => m.id !== messageId));
}

export async function forgetSectionLists(accountId) {
  await chrome.storage.local.remove(LIST_KINDS.map((kind) => keyOf(accountId, kind)));
}

// Storage change keys that belong to these lists.
export const isSectionListKey = (key) => key.startsWith('list/');
