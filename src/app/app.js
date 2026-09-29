import { providers } from '../providers/index.js';
import { saveToken, signIn } from '../auth.js';
import {
  accountId, getAccounts, getAllMail, getMail, getSettings, patchMail, removeAccount,
  getClientIds, saveClientIds, saveSettings, setAccountHidden, upsertAccount,
} from '../storage.js';
import { refreshAccount } from '../sync.js';
import { buildEmailDocument, bytesToDataUrl } from './render-email.js';

// ---------- icons ----------

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const icon = {
  refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>'),
  more: svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  mailOpen: svg('<path d="M3 9l9-6 9 6v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m3 9 9 6 9-6"/>'),
  mail: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'),
  external: svg('<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>'),
  eyeOff: svg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>'),
  eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  login: svg('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/>'),
  remove: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  clip: svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
};

// ---------- state ----------

const state = {
  accounts: {},
  mail: {},
  settings: {},
  selected: null, // { accountId, messageId }
  message: null, // full message currently in the reader
  showRemoteImages: false,
  refreshing: new Set(),
  checked: new Map(), // accountId -> Set of checked message ids
  lastPicked: null, // { accountId, messageId } anchor for shift-click ranges
  allUnread: new Set(), // accounts where "all unread", beyond those listed, is selected
  progress: new Map(), // accountId -> "Marking 120 of 812…" while a bulk action runs
  recentOpen: new Set(), // accounts whose "Recently read" section is expanded
  recent: new Map(), // accountId -> { loading, messages, error }
};

const $ = (id) => document.getElementById(id);
const sidebar = $('sidebar');
const reader = $('reader');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Collapsed accounts are a per-browser view preference.
function loadCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem('collapsed') ?? '[]')); } catch { return new Set(); }
}
const collapsed = loadCollapsed();
function saveCollapsed() {
  try { localStorage.setItem('collapsed', JSON.stringify([...collapsed])); } catch {}
}

// ---------- formatting ----------

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullDateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const longFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function shortTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  if (d.getFullYear() === now.getFullYear()) return dayFmt.format(d);
  return fullDateFmt.format(d);
}

function ago(ms) {
  if (!ms) return 'never';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const displayName = (a) => a?.name || a?.email || 'Unknown sender';

// ---------- toast ----------

let toastTimer;
function toast(text, { error = false } = {}) {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast${error ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 7000 : 3500);
}

// ---------- data loading ----------

async function load() {
  state.accounts = await getAccounts();
  state.mail = await getAllMail(Object.keys(state.accounts));
  state.settings = await getSettings();
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((k) => k === 'accounts' || k === 'settings' || k.startsWith('mail/'))) {
    await load();
    renderSidebar();
    renderTopbar();
  }
});

// ---------- top bar ----------

function visibleAccounts() {
  return Object.values(state.accounts)
    .filter((a) => state.settings.showHidden || !a.hidden)
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
}

function renderTopbar() {
  let total = 0;
  let lastChecked = 0;
  for (const a of Object.values(state.accounts)) {
    const m = state.mail[a.id];
    if (!a.hidden) total += m?.unreadCount ?? 0;
    lastChecked = Math.max(lastChecked, m?.lastCheckedAt ?? 0);
  }
  $('total').hidden = total === 0;
  $('total').textContent = total > 999 ? '999+' : total;
  document.title = total ? `(${total}) Unread Mail` : 'Unread Mail';
  $('lastChecked').textContent = lastChecked ? `Checked ${ago(lastChecked)}` : '';
  $('pollMinutes').value = String(state.settings.pollMinutes);
  $('markReadOnOpen').checked = state.settings.markReadOnOpen;
  $('loadRemoteImages').checked = state.settings.loadRemoteImages;
  $('showHidden').checked = Boolean(state.settings.showHidden);
}

// ---------- sidebar ----------

function renderSidebar() {
  const accounts = visibleAccounts();
  const hiddenCount = Object.values(state.accounts).filter((a) => a.hidden).length;
  let html = '';
  for (const p of Object.values(providers)) {
    const list = accounts.filter((a) => a.provider === p.id);
    html += `<section class="provider">
      <div class="provider-head">
        <span class="provider-pill ${p.id}"><span class="provider-mark">${p.name[0]}</span>${esc(p.name)}</span>
        <span class="spacer"></span>
        <button class="add-btn" data-action="add" data-provider="${p.id}">${icon.plus}Add account</button>
      </div>
      ${list.length ? list.map(renderAccount).join('') : `<div class="provider-empty">No ${esc(p.name)} accounts connected.</div>`}
    </section>`;
  }
  if (hiddenCount && !state.settings.showHidden) {
    html += `<div class="sidebar-footer">${hiddenCount} hidden account${hiddenCount > 1 ? 's' : ''} · <button class="link-btn" data-action="show-hidden">Show</button></div>`;
  }
  const scroll = sidebar.scrollTop;
  sidebar.innerHTML = html;
  sidebar.scrollTop = scroll;
  // "indeterminate" is a property only, it cannot be set from markup.
  for (const box of sidebar.querySelectorAll('.pick-all[data-partial="true"]')) box.indeterminate = true;
}

function renderAccount(a) {
  const m = state.mail[a.id] ?? { messages: [], unreadCount: 0 };
  const isCollapsed = collapsed.has(a.id);
  const status = m.status ?? 'pending';
  const count = m.unreadCount ?? 0;

  let notice = '';
  if (status === 'auth') {
    notice = `<div class="account-notice"><span>Signed out. Showing mail as of ${ago(m.lastSuccessAt)}.</span>
      <button class="link-btn" data-action="signin" data-account="${esc(a.id)}">Sign in</button></div>`;
  } else if (status === 'error') {
    notice = `<div class="account-notice" title="${esc(m.error)}"><span>Couldn't refresh: ${esc(m.error)}</span>
      <button class="link-btn" data-action="refresh-account" data-account="${esc(a.id)}">Retry</button></div>`;
  }

  const messages = m.messages ?? [];
  const checked = checkedFor(a.id, messages);
  const aid = esc(a.id);
  const msgs = messages
    .map((msg) => {
      const sel = state.selected?.accountId === a.id && state.selected?.messageId === msg.id;
      const isChecked = checked.has(msg.id);
      return `<li class="msg-row${sel ? ' selected' : ''}${isChecked ? ' checked' : ''}${msg.read ? ' read' : ''}">
        <input type="checkbox" class="pick" data-action="pick" data-account="${aid}" data-message="${esc(msg.id)}" ${isChecked ? 'checked' : ''} aria-label="Select email">
        <button class="msg" data-action="open" data-account="${aid}" data-message="${esc(msg.id)}">
          <span class="msg-from">${esc(displayName(msg.from))}</span><span class="msg-time">${shortTime(msg.date)}</span>
          <span class="msg-subject">${esc(msg.subject || '(no subject)')}</span>
        </button></li>`;
    })
    .join('');
  const more = count > messages.length && messages.length
    ? `<li class="stale-note">Showing the newest ${messages.length} of ${count} unread.</li>` : '';
  const allChecked = messages.length > 0 && checked.size === messages.length;
  if (!allChecked) state.allUnread.delete(a.id);
  const all = state.allUnread.has(a.id);
  const progress = state.progress.get(a.id);
  // Gmail-style: once every listed email is ticked, offer to extend the
  // selection to all unread mail in the inbox, including unlisted ones.
  const label = progress
    ? esc(progress)
    : all ? `All ${count} unread selected`
    : `${checked.size} selected${allChecked && count > messages.length
      ? ` · <button class="link-btn" data-action="select-all-unread" data-account="${aid}">Select all ${count} unread</button>` : ''}`;
  const bulkBar = checked.size
    ? `<div class="bulk-bar"><span>${label}</span>
        <button class="tool-btn small" data-action="bulk-read" data-account="${aid}" ${progress ? 'disabled' : ''}>${icon.mailOpen}Mark read</button>
        <button class="link-btn" data-action="bulk-clear" data-account="${aid}" ${progress ? 'hidden' : ''}>Clear</button></div>`
    : '';

  return `<div class="account${isCollapsed ? ' collapsed' : ''}${a.hidden ? ' is-hidden' : ''}">
    <div class="account-head">
      <input type="checkbox" class="pick pick-all${messages.length ? '' : ' invisible'}" data-action="pick-all" data-account="${aid}"
        ${allChecked ? 'checked' : ''} data-partial="${checked.size > 0 && !allChecked}" title="Select all" aria-label="Select all emails in ${esc(a.email)}">
      <button class="account-toggle" data-action="toggle" data-account="${esc(a.id)}" aria-expanded="${!isCollapsed}">
        ${icon.chevron.replace('<svg', '<svg class="chevron"')}
        <span class="account-email" style="--h: ${accountHue(a)}" title="${esc(a.email)}">${esc(a.email)}</span>
        ${status === 'auth' || status === 'error' ? `<span class="status-dot ${status}" title="${status === 'auth' ? 'Sign-in needed' : 'Refresh failed'}"></span>` : ''}
        <span class="count${count ? '' : ' zero'}">${count}</span>
      </button>
      <div class="menu-wrap">
        <button class="icon-btn" data-action="account-menu" data-account="${esc(a.id)}" title="Account options" aria-label="Account options">${icon.more}</button>
      </div>
    </div>
    ${notice}
    ${bulkBar}
    ${msgs ? `<ul class="messages">${msgs}${more}</ul>` : ''}
    ${renderRecent(a)}
  </div>`;
}

// "Recently read": the last few read inbox emails, collapsed by default and
// fetched only when opened.
const RECENT_LIMIT = 10;

function renderRecent(a) {
  const aid = esc(a.id);
  const open = state.recentOpen.has(a.id);
  const r = state.recent.get(a.id);
  let body = '';
  if (open) {
    if (!r || r.loading) body = '<li class="recent-note">Loading…</li>';
    else if (r.error) body = `<li class="recent-note error">${esc(r.error)}</li>`;
    else if (!r.messages.length) body = '<li class="recent-note">No read emails in the inbox.</li>';
    else {
      body = r.messages.map((msg) => {
        const sel = state.selected?.accountId === a.id && state.selected?.messageId === msg.id;
        return `<li class="msg-row read recent${sel ? ' selected' : ''}">
          <button class="msg" data-action="open" data-account="${aid}" data-message="${esc(msg.id)}" data-recent="1">
            <span class="msg-from">${esc(displayName(msg.from))}</span><span class="msg-time">${shortTime(msg.date)}</span>
            <span class="msg-subject">${esc(msg.subject || '(no subject)')}</span>
          </button></li>`;
      }).join('');
    }
  }
  return `<div class="recent-block">
    <button class="recent-toggle" data-action="toggle-recent" data-account="${aid}" aria-expanded="${open}">
      ${icon.chevron.replace('<svg', '<svg class="chevron"')}Recently read
    </button>
    ${open ? `<ul class="messages recent-list">${body}</ul>` : ''}
  </div>`;
}

async function loadRecent(id) {
  const a = state.accounts[id];
  state.recent.set(id, { loading: true, messages: [] });
  renderSidebar();
  try {
    const messages = await providers[a.provider].fetchRecentRead(a, RECENT_LIMIT);
    state.recent.set(id, { messages });
  } catch (e) {
    state.recent.set(id, { messages: [], error: e.name === 'AuthRequiredError' ? 'Sign in again to load read emails.' : e.message });
  }
  renderSidebar();
}

// Checked (multi-select) emails per account. Ids that no longer exist in the
// list, e.g. after a refresh, are dropped.
function checkedFor(id, messages) {
  const set = state.checked.get(id);
  if (!set) return new Set();
  const present = new Set(messages.map((x) => x.id));
  for (const mid of set) if (!present.has(mid)) set.delete(mid);
  return set;
}

function toggleChecked(id, messageId, on, { range = false } = {}) {
  const messages = state.mail[id]?.messages ?? [];
  const set = state.checked.get(id) ?? new Set();
  state.checked.set(id, set);
  const idx = messages.findIndex((x) => x.id === messageId);
  const anchor = state.lastPicked?.accountId === id ? messages.findIndex((x) => x.id === state.lastPicked.messageId) : -1;
  // Shift-click selects the whole range from the previously clicked email.
  const ids = range && anchor !== -1 && idx !== -1
    ? messages.slice(Math.min(anchor, idx), Math.max(anchor, idx) + 1).map((x) => x.id)
    : [messageId];
  for (const mid of ids) on ? set.add(mid) : set.delete(mid);
  state.lastPicked = { accountId: id, messageId };
}

// Distinct pill colours per account, assigned in the order accounts were added
// so each keeps its colour. Red and blue are left to the Gmail/Outlook pills.
const ACCOUNT_HUES = [174, 262, 36, 330, 145, 20, 290, 55, 195, 0];
function accountHue(a) {
  const order = Object.values(state.accounts).sort((x, y) => (x.addedAt ?? 0) - (y.addedAt ?? 0));
  return ACCOUNT_HUES[Math.max(0, order.findIndex((x) => x.id === a.id)) % ACCOUNT_HUES.length];
}

async function markAllUnreadRead(id) {
  const a = state.accounts[id];
  const setProgress = (text) => {
    text ? state.progress.set(id, text) : state.progress.delete(id);
    renderSidebar();
  };
  setProgress('Finding unread emails…');
  try {
    const { total, failed } = await providers[a.provider].markAllRead(a, (done, n) => setProgress(`Marking ${done} of ${n}…`));
    state.allUnread.delete(id);
    state.checked.delete(id);
    if (state.message?.accountId === id && !failed.includes(state.message.id)) {
      state.message.isRead = true;
      renderReaderToolbar();
    }
    if (failed.length) toast(`${failed.length} of ${total} couldn't be marked as read.`, { error: true });
    else toast(`Marked all ${total} as read`);
  } finally {
    setProgress(null);
    await refreshOne(id);
  }
}

async function bulkMarkRead(id) {
  if (state.allUnread.has(id)) return markAllUnreadRead(id);
  const a = state.accounts[id];
  const ids = [...(state.checked.get(id) ?? [])];
  if (!ids.length) return;
  const failed = new Set(await providers[a.provider].setReadMany(a, ids, true));
  const done = new Set(ids.filter((x) => !failed.has(x)));
  const m = await getMail(id);
  if (m) {
    const dropped = (m.messages ?? []).filter((x) => done.has(x.id));
    await patchMail(id, {
      messages: (m.messages ?? []).filter((x) => !done.has(x.id)),
      unreadCount: Math.max(0, (m.unreadCount ?? 0) - dropped.filter((x) => !x.read).length),
    });
  }
  state.checked.set(id, failed);
  if (state.message && done.has(state.message.id)) {
    state.message.isRead = true;
    renderReaderToolbar();
  }
  if (failed.size) toast(`${failed.size} of ${ids.length} couldn't be marked as read. They are still selected.`, { error: true });
  else toast(`Marked ${done.size} as read`);
}

function openAccountMenu(button, id) {
  closeMenus();
  const a = state.accounts[id];
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.dataset.floating = '1';
  menu.innerHTML = `
    <button class="menu-item" data-action="refresh-account" data-account="${esc(id)}">${icon.refresh}Refresh</button>
    <button class="menu-item" data-action="signin" data-account="${esc(id)}">${icon.login}Sign in again</button>
    <button class="menu-item" data-action="${a.hidden ? 'unhide' : 'hide'}" data-account="${esc(id)}">${a.hidden ? icon.eye + 'Unhide' : icon.eyeOff + 'Hide'}</button>
    <button class="menu-item danger" data-action="remove" data-account="${esc(id)}">${icon.remove}Remove account</button>`;
  button.parentElement.appendChild(menu);
}

function closeMenus() {
  document.querySelectorAll('.menu[data-floating]').forEach((m) => m.remove());
  $('settingsMenu').hidden = true;
}

// ---------- actions ----------

async function addAccount(providerId, loginHint) {
  const provider = providers[providerId];
  if (provider.kind === 'imap') return openImapDialog(provider, loginHint);
  try {
    const token = await signIn(providerId, loginHint);
    const { email } = await provider.identify(token);
    const id = accountId(providerId, email);
    await saveToken(id, token);
    await upsertAccount({ id, provider: providerId, email, hidden: false, addedAt: Date.now() });
    if (loginHint && loginHint.toLowerCase() !== email.toLowerCase()) {
      toast(`Signed in as ${email}, not ${loginHint}. Added it as a separate account.`);
    } else {
      toast(`${email} connected`);
    }
    collapsed.delete(id);
    saveCollapsed();
    await refreshOne(id);
  } catch (e) {
    if (/did not approve|canceled|cancelled|user closed/i.test(e.message)) return;
    toast(e.message, { error: true });
  }
}

// ---------- IMAP account dialog (iCloud, Yahoo, AOL) ----------

let dialogProvider = null;

function openImapDialog(provider, email) {
  dialogProvider = provider;
  $('imapTitle').textContent = email ? `Sign in to ${email}` : `Add ${provider.name} account`;
  $('imapHelp').textContent = provider.passwordHelp.text;
  $('imapHelpLink').href = provider.passwordHelp.url;
  $('imapEmail').value = email ?? '';
  $('imapEmail').readOnly = Boolean(email);
  $('imapPassword').value = '';
  $('imapError').hidden = true;
  $('imapDialog').showModal();
  (email ? $('imapPassword') : $('imapEmail')).focus();
}

async function submitImapDialog(e) {
  e.preventDefault();
  const provider = dialogProvider;
  const email = $('imapEmail').value.trim();
  const password = $('imapPassword').value.replace(/\s+/g, '');
  const button = $('imapSubmit');
  button.disabled = true;
  button.textContent = 'Checking…';
  $('imapError').hidden = true;
  try {
    await provider.saveAccount(email, password);
    const id = accountId(provider.id, email);
    await upsertAccount({ id, provider: provider.id, email, hidden: false, addedAt: Date.now() });
    $('imapDialog').close();
    toast(`${email} connected`);
    collapsed.delete(id);
    saveCollapsed();
    await refreshOne(id);
  } catch (err) {
    $('imapError').textContent = err.name === 'AuthRequiredError'
      ? `${provider.name} rejected the email or app password. ${err.message}`
      : err.message;
    $('imapError').hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = 'Connect';
  }
}

async function refreshOne(id) {
  const a = state.accounts[id] ?? (await getAccounts())[id];
  if (!a) return;
  await refreshAccount(a);
}

async function refreshAllFromUi() {
  const btn = $('refreshAll');
  btn.classList.add('spinning');
  try {
    const res = await chrome.runtime.sendMessage({ cmd: 'refresh' });
    if (res && !res.ok) toast(res.error, { error: true });
    for (const id of state.recentOpen) loadRecent(id);
  } finally {
    btn.classList.remove('spinning');
  }
}

// Updates the cached list after a read/unread/delete so the sidebar reflects it
// immediately; the next poll reconciles with the server.
async function updateCachedMessage(id, messageId, fn) {
  const m = await getMail(id);
  if (!m) return;
  const messages = [...(m.messages ?? [])];
  const i = messages.findIndex((x) => x.id === messageId);
  if (i === -1) return;
  const { message, unreadDelta } = fn(messages[i]);
  if (message) messages[i] = message;
  else messages.splice(i, 1);
  await patchMail(id, { messages, unreadCount: Math.max(0, (m.unreadCount ?? 0) + unreadDelta) });
}

async function setRead(id, messageId, read) {
  const a = state.accounts[id];
  await providers[a.provider].setRead(a, messageId, read);
  await updateCachedMessage(id, messageId, (msg) => ({
    message: { ...msg, read },
    unreadDelta: Boolean(msg.read) === read ? 0 : read ? -1 : 1,
  }));
  if (state.message?.id === messageId) {
    state.message.isRead = read;
    renderReaderToolbar();
  }
  // A "Recently read" email marked unread moves back to the unread list.
  const recent = state.recent.get(id);
  if (!read && recent?.messages?.some((m) => m.id === messageId)) {
    recent.messages = recent.messages.filter((m) => m.id !== messageId);
    renderSidebar();
    refreshOne(id);
  }
}

async function trashMessage(id, messageId) {
  const a = state.accounts[id];
  // The email may be in the unread list, in "Recently read", or both (an
  // unread email that was just opened). Move on to its neighbour in the list
  // it was opened from.
  const recent = state.recent.get(id);
  const unreadList = state.mail[id]?.messages ?? [];
  const list = unreadList.some((m) => m.id === messageId) ? unreadList : recent?.messages ?? [];
  const idx = list.findIndex((m) => m.id === messageId);
  const next = idx === -1 ? null : list[idx + 1] ?? list[idx - 1];
  await providers[a.provider].trash(a, messageId);
  if (recent) recent.messages = recent.messages.filter((m) => m.id !== messageId);
  await updateCachedMessage(id, messageId, (msg) => ({ message: null, unreadDelta: msg.read ? 0 : -1 }));
  toast(a.provider === 'outlook' ? 'Moved to Deleted Items' : 'Moved to Trash');
  if (next) openMessage(id, next.id);
  else {
    state.selected = null;
    state.message = null;
    renderReaderEmpty();
    renderSidebar();
  }
}

// ---------- reader ----------

function renderReaderEmpty() {
  reader.innerHTML = `<div class="reader-empty"><div>${icon.mail}<div>Select an email to read it here</div></div></div>`;
}

let openSeq = 0;

async function openMessage(id, messageId) {
  const seq = ++openSeq;
  state.selected = { accountId: id, messageId };
  state.message = null;
  state.showRemoteImages = false;
  renderSidebar();
  reader.innerHTML = `<div class="reader-status">Loading…</div>`;

  const a = state.accounts[id];
  const provider = providers[a.provider];
  try {
    const msg = await provider.getMessage(a, messageId);
    if (seq !== openSeq) return;
    msg.accountId = id;
    msg.inlineImages = await loadInlineImages(provider, a, msg);
    if (seq !== openSeq) return;
    state.message = msg;
    renderReader();
    if (state.settings.markReadOnOpen && !msg.isRead) {
      setRead(id, messageId, true).catch((e) => toast(`Couldn't mark as read: ${e.message}`, { error: true }));
    }
  } catch (e) {
    if (seq !== openSeq) return;
    const gone = e.status === 404;
    reader.innerHTML = `<div class="reader-status error">${gone ? 'This email no longer exists. It may have been deleted elsewhere.' : esc(e.message)}</div>`;
    if (gone) updateCachedMessage(id, messageId, (m) => ({ message: null, unreadDelta: m.read ? 0 : -1 }));
  }
}

async function loadInlineImages(provider, account, msg) {
  const map = new Map();
  if (!msg.html?.includes('cid:')) return map;
  const inline = msg.attachments.filter((x) => x.inline || x.contentId);
  await Promise.all(
    inline.map(async (att) => {
      try {
        let cid = att.contentId;
        let bytes;
        if (provider.resolveInline) ({ contentId: cid, bytes } = await provider.resolveInline(account, msg.id, att));
        else bytes = await provider.getAttachment(account, msg.id, att);
        if (cid) map.set(cid, bytesToDataUrl(bytes, att.mimeType));
      } catch (e) {
        console.warn('inline image failed', e);
      }
    }),
  );
  return map;
}

function renderReader() {
  const msg = state.message;
  const allowRemote = state.settings.loadRemoteImages || state.showRemoteImages;
  const { srcdoc, remoteImages } = buildEmailDocument(msg, { allowRemoteImages: allowRemote, inlineImages: msg.inlineImages });
  const files = msg.attachments.filter((x) => !x.inline);
  const rcpt = (label, list) =>
    list.length ? `<div class="meta-rcpt" title="${esc(list.map((r) => r.email).join(', '))}">${label} ${esc(list.map(displayName).join(', '))}</div>` : '';

  reader.innerHTML = `
    <div class="reader-toolbar" id="readerToolbar"></div>
    <div class="reader-head">
      <h1 class="reader-subject">${esc(msg.subject || '(no subject)')}</h1>
      <div class="reader-meta">
        <div class="avatar">${esc(displayName(msg.from).trim()[0]?.toUpperCase() ?? '?')}</div>
        <div class="meta-lines">
          <div class="meta-from"><strong>${esc(displayName(msg.from))}</strong> <span class="addr">&lt;${esc(msg.from.email)}&gt;</span></div>
          ${rcpt('To:', msg.to)}${rcpt('Cc:', msg.cc)}
        </div>
        <div class="meta-date">${msg.date ? longFmt.format(new Date(msg.date)) : ''}</div>
      </div>
    </div>
    ${remoteImages && !allowRemote ? `<div class="banner"><span>Remote images are blocked so the sender can't tell you opened this email.</span>
      <button class="link-btn" data-action="show-images">Show images</button>
      <button class="link-btn" data-action="always-images">Always show</button></div>` : ''}
    ${files.length ? `<div class="attachments">${files.map((f) => `<button class="attachment" data-action="download" data-index="${msg.attachments.indexOf(f)}" title="${esc(f.filename)}">${icon.clip}<span class="name">${esc(f.filename)}</span><span class="size">${formatSize(f.size)}</span></button>`).join('')}</div>` : ''}
    <iframe class="body-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="Email body"></iframe>`;
  reader.querySelector('iframe').srcdoc = srcdoc;
  renderReaderToolbar();
}

function renderReaderToolbar() {
  const bar = $('readerToolbar');
  const msg = state.message;
  if (!bar || !msg) return;
  const providerName = providers[state.accounts[msg.accountId]?.provider]?.name ?? '';
  bar.innerHTML = `
    <button class="tool-btn" data-action="${msg.isRead ? 'mark-unread' : 'mark-read'}">${msg.isRead ? icon.mail + 'Mark unread' : icon.mailOpen + 'Mark read'}</button>
    <button class="tool-btn danger" data-action="trash">${icon.trash}Delete</button>
    <span class="spacer"></span>
    ${msg.webUrl ? `<button class="tool-btn" data-action="open-web">${icon.external}Open in ${esc(providerName)}</button>` : ''}`;
}

async function downloadAttachment(index) {
  const msg = state.message;
  const att = msg.attachments[index];
  const a = state.accounts[msg.accountId];
  try {
    const bytes = await providers[a.provider].getAttachment(a, msg.id, att);
    const url = URL.createObjectURL(new Blob([bytes], { type: att.mimeType || 'application/octet-stream' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: att.filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    toast(`Download failed: ${e.message}`, { error: true });
  }
}

// ---------- event wiring ----------

async function withBusy(el, fn) {
  if (el) el.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    if (el) el.disabled = false;
  }
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) {
    if (!e.target.closest('.menu')) closeMenus();
    return;
  }
  const { action, account: id, message: messageId } = el.dataset;
  if (action !== 'account-menu') closeMenus();

  switch (action) {
    case 'add':
      return addAccount(el.dataset.provider);
    case 'toggle':
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      saveCollapsed();
      return renderSidebar();
    case 'toggle-recent':
      if (state.recentOpen.has(id)) {
        state.recentOpen.delete(id);
        return renderSidebar();
      }
      state.recentOpen.add(id);
      return loadRecent(id);
    case 'pick':
      toggleChecked(id, messageId, el.checked, { range: e.shiftKey });
      return renderSidebar();
    case 'pick-all': {
      const ids = (state.mail[id]?.messages ?? []).map((x) => x.id);
      state.checked.set(id, new Set(el.checked ? ids : []));
      return renderSidebar();
    }
    case 'select-all-unread':
      state.allUnread.add(id);
      return renderSidebar();
    case 'bulk-clear':
      state.checked.delete(id);
      state.allUnread.delete(id);
      return renderSidebar();
    case 'bulk-read':
      await withBusy(el, () => bulkMarkRead(id));
      return renderSidebar();
    case 'account-menu':
      e.stopPropagation();
      return openAccountMenu(el, id);
    case 'open':
      return openMessage(id, messageId);
    case 'signin':
      return addAccount(state.accounts[id].provider, state.accounts[id].email);
    case 'refresh-account':
      return withBusy(el, () => refreshOne(id));
    case 'hide':
      return setAccountHidden(id, true);
    case 'unhide':
      return setAccountHidden(id, false);
    case 'remove':
      if (confirm(`Remove ${state.accounts[id].email}? Its cached mail and sign-in will be deleted from this extension. Nothing is deleted from the mailbox.`)) {
        if (state.selected?.accountId === id) {
          state.selected = null;
          state.message = null;
          renderReaderEmpty();
        }
        const a = state.accounts[id];
        await providers[a.provider].forgetAccount?.(a).catch(() => {});
        await removeAccount(id);
      }
      return;
    case 'show-hidden':
      return saveSettings({ showHidden: true });
    case 'mark-read':
    case 'mark-unread':
      return withBusy(el, () => setRead(state.message.accountId, state.message.id, action === 'mark-read'));
    case 'trash':
      return withBusy(el, () => trashMessage(state.message.accountId, state.message.id));
    case 'open-web':
      return chrome.tabs.create({ url: state.message.webUrl });
    case 'show-images':
      state.showRemoteImages = true;
      return renderReader();
    case 'always-images':
      await saveSettings({ loadRemoteImages: true });
      state.settings.loadRemoteImages = true;
      return renderReader();
    case 'download':
      return withBusy(el, () => downloadAttachment(Number(el.dataset.index)));
  }
});

$('refreshAll').innerHTML = icon.refresh;
$('settingsBtn').innerHTML = icon.gear;
$('refreshAll').addEventListener('click', refreshAllFromUi);
$('settingsBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = $('settingsMenu');
  const open = menu.hidden;
  closeMenus();
  menu.hidden = !open;
  if (open) fillClientIds();
});
$('settingsMenu').addEventListener('click', (e) => e.stopPropagation());
$('pollMinutes').addEventListener('change', (e) => saveSettings({ pollMinutes: Number(e.target.value) }));
$('markReadOnOpen').addEventListener('change', (e) => saveSettings({ markReadOnOpen: e.target.checked }));
$('loadRemoteImages').addEventListener('change', (e) => saveSettings({ loadRemoteImages: e.target.checked }));
$('showHidden').addEventListener('change', (e) => saveSettings({ showHidden: e.target.checked }));
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenus());

$('redirectUri').textContent = chrome.identity.getRedirectURL();
async function fillClientIds() {
  const ids = await getClientIds();
  $('googleClientId').value = ids.google;
  $('microsoftClientId').value = ids.microsoft;
}
$('imapForm').addEventListener('submit', submitImapDialog);
$('imapCancel').addEventListener('click', () => $('imapDialog').close());
$('clientIdsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveClientIds({ google: $('googleClientId').value, microsoft: $('microsoftClientId').value });
  toast('Client IDs saved');
  refreshAllFromUi();
});

// Keep "Checked N min ago" current.
setInterval(renderTopbar, 30000);

await load();
await fillClientIds();
renderTopbar();
renderSidebar();
renderReaderEmpty();
// First run: open Settings so the client IDs can be entered.
const ids = await getClientIds();
if (!ids.google && !ids.microsoft) $('settingsMenu').hidden = false;
