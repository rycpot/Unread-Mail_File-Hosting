// Fetches unread summaries and records them per account. Failures never clear
// the last known messages; they only change the account's status.

import { AuthRequiredError } from './auth.js';
import { providers } from './providers/index.js';
import { getAccounts, getAllMail, getMail, patchMail } from './storage.js';

// One refresh per account at a time: a push event and a timer tick arriving
// together share the same request.
const inflight = new Map();

export function refreshAccount(account) {
  if (!inflight.has(account.id)) {
    inflight.set(account.id, doRefresh(account).finally(() => inflight.delete(account.id)));
  }
  return inflight.get(account.id);
}

async function doRefresh(account) {
  const now = Date.now();
  try {
    // The previous list lets providers skip re-fetching emails they already have.
    const prev = await getMail(account.id);
    const { unreadCount, messages } = await providers[account.provider].fetchSummary(account, prev);
    await patchMail(account.id, { status: 'ok', error: null, unreadCount, messages, lastCheckedAt: now, lastSuccessAt: now });
  } catch (e) {
    const status = e instanceof AuthRequiredError ? 'auth' : 'error';
    console.warn(`[sync] ${account.id} failed:`, e);
    await patchMail(account.id, { status, error: e.message, lastCheckedAt: now });
  }
}

export async function refreshAll() {
  const accounts = Object.values(await getAccounts());
  await Promise.all(accounts.map(refreshAccount));
  await updateBadge();
}

// IMAP accounts with a live push connection only need a rare safety check;
// without push they are checked at least 2 minutes apart, since each check is
// a fresh sign-in.
const PUSH_SAFETY_MS = 10 * 60e3;
const IMAP_MIN_MS = 2 * 60e3;

// Timer tick: refreshes the accounts that are due. `hasPush(id)` says whether
// an account's push connection is live.
export async function refreshDue(pollMinutes, hasPush) {
  const accounts = Object.values(await getAccounts());
  const mail = await getAllMail(accounts.map((a) => a.id));
  const now = Date.now();
  const due = accounts.filter((a) => {
    if (providers[a.provider]?.kind !== 'imap') return true;
    const interval = hasPush(a.id) ? PUSH_SAFETY_MS : Math.max(pollMinutes * 60e3, IMAP_MIN_MS);
    // A few seconds' slack so a check is not skipped for arriving just early.
    return now - (mail[a.id]?.lastCheckedAt ?? 0) >= interval - 5e3;
  });
  await Promise.all(due.map(refreshAccount));
  await updateBadge();
}

export async function updateBadge() {
  const accounts = Object.values(await getAccounts()).filter((a) => !a.hidden);
  const mail = await getAllMail(accounts.map((a) => a.id));
  let total = 0;
  const lines = ['Unread Mail'];
  let needsAttention = false;
  for (const a of accounts) {
    const m = mail[a.id];
    total += m?.unreadCount ?? 0;
    if (m?.status === 'auth') needsAttention = true;
    const suffix = m?.status === 'auth' ? ' (sign-in needed)' : m?.status === 'error' ? ' (error)' : '';
    lines.push(`${a.email}: ${m?.unreadCount ?? 0}${suffix}`);
  }
  await chrome.action.setBadgeBackgroundColor({ color: needsAttention && total === 0 ? '#d97706' : '#d93025' });
  await chrome.action.setBadgeText({ text: total > 0 ? (total > 999 ? '999+' : String(total)) : needsAttention ? '!' : '' });
  await chrome.action.setTitle({ title: lines.join('\n') });
}
