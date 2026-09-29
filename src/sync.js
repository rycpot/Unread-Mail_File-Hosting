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
    const { fresh, mark } = newArrivals(account, prev, messages);
    await patchMail(account.id, { status: 'ok', error: null, unreadCount, messages, mark, lastCheckedAt: now, lastSuccessAt: now });
    if (fresh.length) {
      reportNewMail(fresh.map((m) => ({ accountId: account.id, provider: account.provider, id: m.id, from: m.from, subject: m.subject })));
    }
  } catch (e) {
    const status = e instanceof AuthRequiredError ? 'auth' : 'error';
    console.warn(`[sync] ${account.id} failed:`, e);
    await patchMail(account.id, { status, error: e.message, lastCheckedAt: now });
  }
}

// ---------- new-mail detection (for notifications) ----------
//
// An email is "new" only if it was not listed before AND arrived after the
// newest email already seen for the account (the "mark"). This ignores older
// unread emails that slide into the 30-item list when one is marked read, and
// emails marked unread again. For IMAP, arrival order is the server's UID
// (always increasing), not the sender-controlled Date header; for the others
// it is the server's receipt time. An account's first sync never notifies.

function arrivalOf(account, msg) {
  if (providers[account.provider]?.kind === 'imap') {
    const [epoch, uid] = String(msg.id).split('-'); // "<uidvalidity>-<uid>"
    return { epoch, value: Number(uid) || 0 };
  }
  return { epoch: '', value: Number(msg.date) || 0 };
}

function newArrivals(account, prev, messages) {
  const arrivals = messages.map((m) => ({ m, a: arrivalOf(account, m) }));
  const top = (list) => list.reduce((best, x) => (!best || x.a.value > best.value ? x.a : best), null);
  const current = top(arrivals);
  let mark = prev?.mark ?? top((prev?.messages ?? []).map((m) => ({ a: arrivalOf(account, m) })));
  // First sync, or the mailbox was rebuilt (new UIDVALIDITY): just set the mark.
  if (!prev?.lastSuccessAt || !mark || (current && current.epoch !== mark.epoch)) {
    return { fresh: [], mark: current ?? mark ?? null };
  }
  const listed = new Set((prev.messages ?? []).map((m) => m.id));
  const fresh = arrivals.filter(({ m, a }) => !listed.has(m.id) && a.value > mark.value).map(({ m }) => m);
  if (current && current.value > mark.value) mark = current;
  return { fresh, mark };
}

// Notifications are handled by the background service worker; a refresh run
// from the app tab hands its new emails over to it.
let newMailHandler = null;
export function onNewMail(handler) {
  newMailHandler = handler;
}
function reportNewMail(items) {
  if (newMailHandler) newMailHandler(items);
  else chrome.runtime.sendMessage({ cmd: 'newMail', items }).catch(() => {});
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
  // Toolbar icon with its red dot only while there is unread mail.
  const variant = total ? '' : 'plain-';
  await chrome.action.setIcon({ path: Object.fromEntries([16, 32, 48, 128].map((n) => [n, `/icons/icon-${variant}${n}.png`])) });
  await chrome.action.setBadgeBackgroundColor({ color: needsAttention && total === 0 ? '#d97706' : '#d93025' });
  await chrome.action.setBadgeText({ text: total > 0 ? (total > 999 ? '999+' : String(total)) : needsAttention ? '!' : '' });
  await chrome.action.setTitle({ title: lines.join('\n') });
}
