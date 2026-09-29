// Fetches unread summaries and records them per account. Failures never clear
// the last known messages; they only change the account's status.

import { AuthRequiredError } from './auth.js';
import { providers } from './providers/index.js';
import { getAccounts, getAllMail, patchMail } from './storage.js';

export async function refreshAccount(account) {
  const now = Date.now();
  try {
    const { unreadCount, messages } = await providers[account.provider].fetchSummary(account);
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
