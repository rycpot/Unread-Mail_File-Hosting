import { providers } from '../providers/index.js';
import { saveToken, signIn } from '../auth.js';
import {
  accountId, getAccounts, getAllMail, getMail, getSettings, patchMail, removeAccount,
  getClientIds, saveClientIds, saveSettings, setAccountHidden, upsertAccount,
} from '../storage.js';
import { refreshAccount } from '../sync.js';
import { buildEmailDocument } from './render-email.js';
import { callHelper } from '../native.js';
import { compareVersions, currentVersion } from '../update.js';
import { openViewer } from './viewer.js';
import { closeWindow, initCompose, isComposeOpen, openCompose } from './compose.js';
import { rememberAddresses } from './contacts.js';
import { uiIcons } from './ui-icons.js';
import { inlineParts } from './inline-images.js';
import { fmtDate, fmtDateTime, fmtTime } from './format.js';
import * as cacheDb from '../cache-db.js';
import { fetchAttachment, fetchFullMessage } from '../message-fetch.js';

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
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  clip: svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
};

// ---------- state ----------

const state = {
  accounts: {},
  mail: {},
  settings: {},
  selected: null, // { accountId, messageId, folder } (folder "spam" or undefined)
  message: null, // full message currently in the reader
  showRemoteImages: false,
  view: null, // { provider, account } filter for the list, set below
  visibleList: [], // messages currently listed, in order
  checked: new Set(), // "<accountId>::<messageId>" keys of ticked emails
  lastPicked: null, // key of the last ticked email, anchor for shift-click ranges
  allUnread: false, // "select all N unread" beyond the listed emails
  progress: null, // "Marking 120 of 812…" while a bulk action runs
  // "Recently read" and "Spam" sections, keyed by account id, or "*" for the
  // combined ones under All accounts: which are expanded, and what they list
  // ({ loading, messages: [{ accountId, id, … }], error }).
  open: { recent: new Set(), sent: new Set(), drafts: new Set(), spam: new Set() },
  sections: { recent: new Map(), sent: new Map(), drafts: new Map(), spam: new Map() },
};

const $ = (id) => document.getElementById(id);
const sidebar = $('sidebar');
const reader = $('reader');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);


// ---------- formatting ----------


function shortTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  // Today: the time; otherwise the date (30 Sep 2026).
  return d.toDateString() === now.toDateString() ? fmtTime(d) : fmtDate(d);
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
    askBannerStyle();
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
  // The icon's red dot means "unread mail"; show it only when there is some.
  const iconFile = `../../icons/icon-${total ? '' : 'plain-'}32.png`;
  if (!$('favicon').href.endsWith(iconFile.slice(5))) $('favicon').href = iconFile;
  $('brandIcon').src = iconFile;
  $('lastChecked').textContent = lastChecked ? `Checked ${ago(lastChecked)}` : '';
  $('pollMinutes').value = String(state.settings.pollMinutes);
  $('markReadOnOpen').checked = state.settings.markReadOnOpen;
  $('notifyEnabled').checked = state.settings.notifyEnabled;
  $('soundEnabled').checked = state.settings.soundEnabled;
  $('bannerStyle').value = state.settings.bannerStyle;
  $('undoSendSeconds').value = String(state.settings.undoSendSeconds ?? 10);
  $('cacheLimitMB').value = String(state.settings.cacheLimitMB ?? 1024);
  if (document.activeElement !== $('senderName')) $('senderName').value = state.settings.senderName ?? '';
  $('loadRemoteImages').checked = state.settings.loadRemoteImages;
  $('showHidden').checked = Boolean(state.settings.showHidden);
}

// ---------- sidebar: provider rail + filtered unified list ----------
//
// The rail on the left filters by provider ("All" or one provider); chips at
// the top of the list narrow it to one account. The list itself is every
// unread email in the current view, newest first, so new mail is always at
// the top whichever account it arrived in.

const PROVIDER_ICON = (id) => `../../icons/providers/${id}.png`;
const pico = (id, cls = 'pico') => `<img class="${cls}" src="${PROVIDER_ICON(id)}" alt="">`;
const keyOf = (accountId, messageId) => `${accountId}::${messageId}`;
const splitKey = (key) => {
  const i = key.indexOf('::');
  return [key.slice(0, i), key.slice(i + 2)];
};

function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem('view') ?? '{}');
    return { provider: v.provider ?? null, account: v.account ?? null };
  } catch {
    return { provider: null, account: null };
  }
}
function saveView() {
  try { localStorage.setItem('view', JSON.stringify(state.view)); } catch {}
}

function setView(provider, account = null) {
  state.view = { provider, account };
  state.checked.clear();
  state.allUnread = false;
  saveView();
  renderSidebar();
  reloadOpenSections();
}

// "New" dots: ids not yet seen when the tab was last left. Everything present
// becomes "seen" whenever the tab is hidden, and an email is seen once opened.
const known = (() => {
  try {
    const raw = localStorage.getItem('knownIds');
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
})();
let knownIds = known;
function allKeys() {
  const keys = [];
  for (const [id, m] of Object.entries(state.mail)) for (const msg of m?.messages ?? []) keys.push(keyOf(id, msg.id));
  return keys;
}
function markAllSeen() {
  knownIds = new Set(allKeys());
  try { localStorage.setItem('knownIds', JSON.stringify([...knownIds])); } catch {}
}
function markSeen(key) {
  if (!knownIds || knownIds.has(key)) return;
  knownIds.add(key);
  try { localStorage.setItem('knownIds', JSON.stringify([...knownIds])); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') markAllSeen();
});

const liveAccounts = () =>
  Object.values(state.accounts).sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0));
const unreadOf = (a) => state.mail[a.id]?.unreadCount ?? 0;
const hasProblem = (a) => ['auth', 'error'].includes(state.mail[a.id]?.status);

// Accounts whose mail is in the current view.
function viewAccounts() {
  const { provider, account } = state.view;
  if (account) return state.accounts[account] ? [state.accounts[account]] : [];
  return liveAccounts().filter(
    (a) => (!provider || a.provider === provider) && (!a.hidden || (provider && state.settings.showHidden)),
  );
}

function viewMessages() {
  const list = [];
  for (const a of viewAccounts()) {
    for (const msg of state.mail[a.id]?.messages ?? []) list.push({ ...msg, accountId: a.id, provider: a.provider, key: keyOf(a.id, msg.id) });
  }
  return list.sort((x, y) => (y.date ?? 0) - (x.date ?? 0));
}

function renderRail() {
  const visible = liveAccounts().filter((a) => !a.hidden);
  const total = visible.reduce((s, a) => s + unreadOf(a), 0);
  const badge = (n) => (n ? `<span class="rail-badge">${n > 999 ? '999+' : n}</span>` : '');
  const active = (p) => (state.view.provider === p && !state.view.account) || (p && state.view.provider === p) ? ' active' : '';
  let html = `<button class="rail-btn all${!state.view.provider && !state.view.account ? ' active' : ''}" data-action="view" data-provider="" title="All accounts · ${total} unread">${pico('all', 'rail-icon all-icon')}${badge(total)}</button>`;
  for (const p of Object.values(providers)) {
    const accounts = visible.filter((a) => a.provider === p.id);
    const n = accounts.reduce((s, a) => s + unreadOf(a), 0);
    const problem = accounts.some(hasProblem);
    const cls = !accounts.length ? ' none' : !n ? ' quiet' : '';
    html += `<button class="rail-btn${cls}${active(p.id)}" data-action="view" data-provider="${p.id}" title="${esc(p.name)}${accounts.length ? ` · ${n} unread` : ' · no accounts'}">
      ${pico(p.id, 'rail-icon')}${badge(n)}${problem ? '<span class="rail-warn"></span>' : ''}</button>`;
  }
  html += `<span class="rail-spacer"></span>
    <div class="menu-wrap"><button class="rail-btn add" data-action="add-menu" title="Add account" aria-label="Add account">${icon.plus}</button></div>`;
  return `<nav class="rail" aria-label="Providers">${html}</nav>`;
}

function renderChips() {
  const { provider, account } = state.view;
  const p = provider ? providers[provider] : null;
  let pool = liveAccounts().filter((a) => (!provider || a.provider === provider) && (!a.hidden || (provider && state.settings.showHidden)));
  // In "All", only accounts with something to see get a chip.
  if (!provider) pool = pool.filter((a) => unreadOf(a) || hasProblem(a) || a.id === account);
  const chip = (a) => {
    const n = unreadOf(a);
    return `<button class="chip${account === a.id ? ' on' : ''}${a.hidden ? ' dim' : ''}" data-action="view-account" data-account="${esc(a.id)}" title="${esc(a.email)}">
      ${pico(a.provider)}<span class="chip-name">${esc(a.email.split('@')[0])}</span>${n ? `<span class="chip-n">${n}</span>` : ''}${hasProblem(a) ? '<span class="chip-warn"></span>' : ''}</button>`;
  };
  const allLabel = p ? `All ${esc(p.name)}` : 'All accounts';
  // "All <provider>" only makes sense with more than one account to combine.
  const showAll = !p || liveAccounts().filter((a) => a.provider === provider).length > 1;
  return `<div class="chips">
    ${showAll ? `<button class="chip${account ? '' : ' on'}" data-action="view" data-provider="${provider ?? ''}">${allLabel}</button>` : ''}
    ${pool.map(chip).join('')}
    ${p ? `<button class="chip add" data-action="add" data-provider="${p.id}">${icon.plus}Add</button>` : ''}
  </div>`;
}

function renderAccountBar(a) {
  const m = state.mail[a.id] ?? {};
  return `<div class="acct-bar">
    ${pico(a.provider)}<span class="acct-email" title="${esc(a.email)}">${esc(a.email)}</span>
    <span class="acct-checked">${m.lastCheckedAt ? `checked ${ago(m.lastCheckedAt)}` : ''}</span>
    <div class="menu-wrap"><button class="icon-btn" data-action="account-menu" data-account="${esc(a.id)}" title="Account options" aria-label="Account options">${icon.more}</button></div>
  </div>`;
}

function renderNotices(accounts) {
  return accounts
    .filter(hasProblem)
    .map((a) => {
      const m = state.mail[a.id];
      const auth = m.status === 'auth';
      return `<div class="notice" title="${esc(m.error ?? '')}">${pico(a.provider)}
        <span><b>${esc(a.email)}</b> · ${auth ? `signed out, showing mail as of ${ago(m.lastSuccessAt)}` : `couldn't refresh: ${esc(m.error)}`}</span>
        <button class="link-btn" data-action="${auth ? 'signin' : 'refresh-account'}" data-account="${esc(a.id)}">${auth ? 'Sign in' : 'Retry'}</button></div>`;
    })
    .join('');
}

function renderSidebar() {
  // An account view whose account is gone (or not loaded yet) falls back to its provider.
  if (state.view.account && !state.accounts[state.view.account]) state.view = { ...state.view, account: null };
  // A provider with a single account opens that account directly.
  if (state.view.provider && !state.view.account) {
    const only = liveAccounts().filter((a) => a.provider === state.view.provider);
    if (only.length === 1) state.view = { ...state.view, account: only[0].id };
  }
  const { provider, account } = state.view;
  const accounts = viewAccounts();
  const messages = viewMessages();
  state.visibleList = messages;
  const present = new Set(messages.map((m) => m.key));
  for (const k of state.checked) if (!present.has(k)) state.checked.delete(k);
  if (!knownIds && Object.keys(state.mail).length) markAllSeen();

  const unreadTotal = accounts.reduce((s, a) => s + unreadOf(a), 0);
  const checked = state.checked;
  const allListed = messages.length > 0 && checked.size === messages.length;
  if (!allListed) state.allUnread = false;
  const selecting = checked.size > 0;

  let head = '';
  if (messages.length) {
    let label;
    if (state.progress) label = esc(state.progress);
    else if (!selecting) label = `${unreadTotal} unread`;
    else if (state.allUnread) label = `All ${unreadTotal} unread selected`;
    else label = `${checked.size} selected${allListed && unreadTotal > messages.length
      ? ` · <button class="link-btn" data-action="select-all-unread">Select all ${unreadTotal}</button>` : ''}`;
    head = `<div class="list-head">
      <input type="checkbox" class="pick pick-all" data-action="pick-all" ${allListed ? 'checked' : ''} aria-label="Select all">
      <span class="list-label">${label}</span>
      ${selecting ? `<button class="tool-btn small" data-action="bulk-read" ${state.progress ? 'disabled' : ''}>${icon.mailOpen}Mark read</button>
        <button class="tool-btn small danger" data-action="bulk-delete" ${state.progress ? 'disabled' : ''}>${icon.trash}Delete</button>
        <button class="link-btn" data-action="bulk-clear" ${state.progress ? 'hidden' : ''}>Clear</button>` : ''}
    </div>`;
  }

  const multi = !account && accounts.length > 1;
  const rows = messages.map((msg) => {
    const sel = state.selected?.accountId === msg.accountId && state.selected?.messageId === msg.id;
    const isNew = knownIds && !knownIds.has(msg.key) && !msg.read;
    const acct = state.accounts[msg.accountId];
    return `<li class="msg-row${sel ? ' selected' : ''}${checked.has(msg.key) ? ' checked' : ''}${msg.read ? ' read' : ''}">
      <span class="lead">${pico(msg.provider)}<input type="checkbox" class="pick" data-action="pick" data-key="${esc(msg.key)}" ${checked.has(msg.key) ? 'checked' : ''} aria-label="Select email"></span>
      <button class="msg" data-action="open" data-account="${esc(msg.accountId)}" data-message="${esc(msg.id)}">
        <span class="msg-from">${esc(displayName(msg.from))}${isNew ? '<span class="new-dot" title="New"></span>' : ''}</span><span class="msg-time">${shortTime(msg.date)}</span>
        <span class="msg-subject">${esc(msg.subject || '(no subject)')}</span>
        ${multi ? `<span class="msg-acct">${esc(acct?.email ?? '')}</span>` : ''}
      </button></li>`;
  }).join('');

  const listed = accounts.reduce((s, a) => s + (state.mail[a.id]?.messages?.length ?? 0), 0);
  const more = unreadTotal > listed && listed
    ? `<div class="list-note">Showing the newest ${listed} of ${unreadTotal} unread${multi ? ' (up to 30 per account)' : ''}.</div>` : '';

  let empty = '';
  if (!messages.length) {
    const p = provider ? providers[provider] : null;
    if (p && !liveAccounts().some((a) => a.provider === p.id)) {
      empty = `<div class="empty">No ${esc(p.name)} accounts yet.<br><button class="tool-btn" data-action="add" data-provider="${p.id}">${icon.plus}Add ${esc(p.name)} account</button></div>`;
    } else if (!Object.keys(state.accounts).length) {
      empty = `<div class="empty">No accounts yet. Use <b>+</b> in the left rail to add one.</div>`;
    } else {
      empty = `<div class="empty">${icon.mail}<div>All caught up</div></div>`;
    }
  }

  const hiddenCount = Object.values(state.accounts).filter((a) => a.hidden).length;
  const footer = hiddenCount && !provider && !account
    ? `<div class="list-note">${hiddenCount} hidden account${hiddenCount > 1 ? 's' : ''} not shown · <button class="link-btn" data-action="show-hidden">Show in provider views</button></div>` : '';

  // Scroll positions survive the re-render (the list and each open section).
  const scrolls = [...sidebar.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollTop]);
  const key = sectionKey();
  const dock = key ? KINDS.map((kind) => renderSection(kind, key)).join('') : '';
  sidebar.innerHTML = `${renderRail()}
    <div class="pane-col">
      <div class="pane${selecting ? ' selecting' : ''}" data-scroll="pane">
        ${renderChips()}
        ${account ? renderAccountBar(state.accounts[account]) : ''}
        ${renderNotices(accounts)}
        ${head}
        ${rows ? `<ul class="messages">${rows}</ul>` : ''}
        ${more}${empty}
        ${footer}
      </div>
      ${dock ? `<div class="dock">${dock}</div>` : ''}
    </div>`;
  for (const [name, top] of scrolls) {
    const el = sidebar.querySelector(`[data-scroll="${name}"]`);
    if (el) el.scrollTop = top;
  }
  saveSectionCache();
  const all = sidebar.querySelector('.pick-all');
  if (all) all.indeterminate = selecting && !allListed;
}

// "Recently read" (the last few read inbox emails) and "Spam" (unread spam
// only) sections, collapsed by default and fetched only when opened. They are
// shown for one account in its view, and combined in the "All" views: for all
// visible accounts (key "*") or all of one provider's (key "p:<provider>").
// The spam count comes from the regular checks.
const RECENT_LIMIT = 10;
const SPAM_LIMIT = 20;
const SENT_LIMIT = 5;
const DRAFTS_LIMIT = 3;
const SECTION = {
  recent: { title: 'Recently read', empty: 'No read emails in the inbox.', fetch: (p, a) => p.fetchRecentRead(a, RECENT_LIMIT), limit: RECENT_LIMIT },
  sent: { title: 'Sent', empty: 'Nothing sent yet.', fetch: (p, a) => p.fetchSent(a, SENT_LIMIT), limit: SENT_LIMIT, folder: 'sent', toLine: true },
  drafts: { title: 'Drafts', empty: 'No drafts.', fetch: (p, a) => p.fetchDrafts(a, DRAFTS_LIMIT), limit: DRAFTS_LIMIT, folder: 'drafts', toLine: true },
  spam: { title: 'Spam', empty: 'No unread spam.', fetch: (p, a) => p.fetchSpam(a, SPAM_LIMIT), folder: 'spam' },
};
const KINDS = ['recent', 'sent', 'drafts', 'spam'];

// The section key for the current view.
const sectionKey = () => state.view.account ?? (state.view.provider ? `p:${state.view.provider}` : '*');
const isCombined = (key) => key === '*' || key.startsWith('p:');
function sectionAccounts(key) {
  if (key === '*') return liveAccounts().filter((a) => !a.hidden);
  if (key.startsWith('p:')) return liveAccounts().filter((a) => !a.hidden && a.provider === key.slice(2));
  return [state.accounts[key]].filter(Boolean);
}

const isSelected = (accountId, messageId, folder) =>
  state.selected?.accountId === accountId && state.selected?.messageId === messageId && state.selected?.folder === folder;

function sectionRows(kind, key) {
  const r = state.sections[kind].get(key);
  const { folder, empty, toLine } = SECTION[kind];
  if (!r || r.loading) return '<li class="recent-note">Loading…</li>';
  const notes = (r.errors ?? []).map((e) => `<li class="recent-note error">${esc(e)}</li>`).join('');
  if (!r.messages.length) return notes || `<li class="recent-note">${empty}</li>`;
  const combined = isCombined(key);
  return r.messages.map((msg) => {
    const acct = state.accounts[msg.accountId];
    return `<li class="msg-row recent${msg.read === false ? '' : ' read'}${isSelected(msg.accountId, msg.id, folder) ? ' selected' : ''}">
      <span class="lead">${combined ? pico(acct?.provider) : ''}</span>
      <button class="msg" data-action="${kind === 'drafts' ? 'open-draft' : 'open'}" data-account="${esc(msg.accountId)}" data-message="${esc(msg.id)}" data-list="${esc(key)}"${folder ? ` data-folder="${folder}"` : ''}${kind === 'drafts' ? ` data-version="${esc(cacheDb.draftVersion(msg))}"` : ''}>
        <span class="msg-from">${toLine ? `${kind === 'drafts' ? '<span class="draft-tag">Draft</span>' : ''}${esc(msg.to?.length ? `To: ${msg.to.map(displayName).join(', ')}` : '(no recipients)')}` : esc(displayName(msg.from))}</span><span class="msg-time">${shortTime(msg.date)}</span>
        <span class="msg-subject">${esc(msg.subject || '(no subject)')}</span>
        ${combined ? `<span class="msg-acct">${esc(acct?.email ?? '')}</span>` : ''}
      </button></li>`;
  }).join('') + notes;
}

function renderSection(kind, key) {
  const accounts = sectionAccounts(key);
  if (!accounts.length) return '';
  const open = state.open[kind].has(key);
  const count = kind === 'spam' ? accounts.reduce((n, a) => n + (state.mail[a.id]?.spamUnread ?? 0), 0) : 0;
  // Pinned to the bottom of the list column; the emails open above the title.
  return `<div class="recent-block">
    ${open ? `<ul class="messages recent-list" data-scroll="${kind}">${sectionRows(kind, key)}</ul>` : ''}
    <button class="recent-toggle" data-action="toggle-section" data-kind="${kind}" data-key="${esc(key)}" aria-expanded="${open}">
      ${icon.chevron.replace('<svg', '<svg class="chevron"')}${SECTION[kind].title}${count ? `<span class="spam-count" title="${count} unread in spam">${count}</span>` : ''}
    </button>
  </div>`;
}

// Shows the last list at once (if there is one) and refreshes it from the
// servers behind it; only a section never loaded before shows "Loading…".
const sectionSeq = new Map(); // "<kind>/<key>" -> latest load, so older ones are dropped

async function loadSection(kind, key) {
  const accounts = sectionAccounts(key);
  const id = `${kind}/${key}`;
  const seq = (sectionSeq.get(id) ?? 0) + 1;
  sectionSeq.set(id, seq);
  const cached = state.sections[kind].get(key);
  if (!cached || cached.loading) state.sections[kind].set(key, { loading: true, messages: [] });
  renderSidebar();
  const results = await Promise.allSettled(accounts.map(async (a) =>
    (await SECTION[kind].fetch(providers[a.provider], a)).map((m) => ({ ...m, accountId: a.id }))));
  if (sectionSeq.get(id) !== seq) return;
  const messages = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((x, y) => y.date - x.date);
  const errors = results.flatMap((r, i) => {
    if (r.status === 'fulfilled') return [];
    const why = r.reason?.name === 'AuthRequiredError' ? 'sign in again' : r.reason?.message;
    return [accounts.length > 1 ? `${accounts[i].email}: ${why}` : why];
  });
  state.sections[kind].set(key, { messages: SECTION[kind].limit ? messages.slice(0, SECTION[kind].limit) : messages, errors });
  renderSidebar();
}

// The section lists are kept in chrome.storage.session (memory only, cleared
// when Chrome quits), so they also show at once after the tab is reopened.
let cacheTimer;
function saveSectionCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    const plain = (map) => Object.fromEntries([...map].filter(([, r]) => !r.loading).map(([k, r]) => [k, { messages: r.messages }]));
    chrome.storage.session.set({ sectionCache: { recent: plain(state.sections.recent), spam: plain(state.sections.spam) } }).catch(() => {});
  }, 500);
}

async function restoreSectionCache() {
  try {
    const { sectionCache } = await chrome.storage.session.get('sectionCache');
    for (const kind of KINDS) {
      for (const [key, r] of Object.entries(sectionCache?.[kind] ?? {})) state.sections[kind].set(key, r);
    }
  } catch {
    // no cache: sections load when opened
  }
}

function reloadOpenSections() {
  const key = sectionKey();
  if (!key) return;
  for (const kind of KINDS) if (state.open[kind].has(key)) loadSection(kind, key);
}

// Every listed copy of an email in the sections of one kind (it can be in an
// account's section and the combined one).
function sectionItems(kind, accountId, messageId) {
  return [...state.sections[kind].values()].flatMap((r) => r.messages ?? [])
    .filter((m) => m.accountId === accountId && m.id === messageId);
}

function dropFromSections(kind, accountId, messageId) {
  for (const r of state.sections[kind].values()) {
    if (r.messages) r.messages = r.messages.filter((m) => !(m.accountId === accountId && m.id === messageId));
  }
}

// The email after (or before) this one in the section list it was opened from.
function sectionNeighbour(kind, accountId, messageId) {
  const list = state.sections[kind].get(state.selected?.list ?? accountId)?.messages ?? [];
  const idx = list.findIndex((m) => m.accountId === accountId && m.id === messageId);
  return idx === -1 ? null : list[idx + 1] ?? list[idx - 1] ?? null;
}

// Keeps the Spam count in step after reading, deleting or rescuing a spam email.
async function adjustSpamUnread(id, delta) {
  const m = await getMail(id);
  if (m && delta) await patchMail(id, { spamUnread: Math.max(0, (m.spamUnread ?? 0) + delta) });
}

function toggleChecked(key, on, { range = false } = {}) {
  const list = state.visibleList.map((m) => m.key);
  const idx = list.indexOf(key);
  const anchor = state.lastPicked ? list.indexOf(state.lastPicked) : -1;
  // Shift-click selects the whole range from the previously clicked email.
  const keys = range && anchor !== -1 && idx !== -1 ? list.slice(Math.min(anchor, idx), Math.max(anchor, idx) + 1) : [key];
  for (const k of keys) on ? state.checked.add(k) : state.checked.delete(k);
  state.lastPicked = key;
}

// Marks the selection read, one request per account. With "select all N
// unread", accounts with more unread mail than listed are marked in full.
async function bulkMarkRead() {
  const byAccount = new Map();
  for (const key of state.checked) {
    const [id, mid] = splitKey(key);
    if (!byAccount.has(id)) byAccount.set(id, []);
    byAccount.get(id).push(mid);
  }
  const accountIds = state.allUnread ? viewAccounts().filter((a) => unreadOf(a)).map((a) => a.id) : [...byAccount.keys()];
  const setProgress = (text) => {
    state.progress = text;
    renderSidebar();
  };
  let done = 0;
  let failedTotal = 0;
  try {
    for (const [n, id] of accountIds.entries()) {
      const a = state.accounts[id];
      const ids = byAccount.get(id) ?? [];
      const step = accountIds.length > 1 ? ` (account ${n + 1} of ${accountIds.length})` : '';
      if (state.allUnread && unreadOf(a) > (state.mail[id]?.messages?.length ?? 0)) {
        setProgress(`Finding unread emails…${step}`);
        const { total, failed } = await providers[a.provider].markAllRead(a, (d, t) => setProgress(`Marking ${d} of ${t}…${step}`));
        done += total - failed.length;
        failedTotal += failed.length;
        await refreshOne(id);
        continue;
      }
      setProgress(`Marking ${ids.length}…${step}`);
      const failed = new Set(await providers[a.provider].setReadMany(a, ids, true));
      const ok = new Set(ids.filter((x) => !failed.has(x)));
      done += ok.size;
      failedTotal += failed.size;
      const m = await getMail(id);
      if (m) {
        const dropped = (m.messages ?? []).filter((x) => ok.has(x.id));
        await patchMail(id, {
          messages: (m.messages ?? []).filter((x) => !ok.has(x.id)),
          unreadCount: Math.max(0, (m.unreadCount ?? 0) - dropped.filter((x) => !x.read).length),
        });
      }
      for (const mid of ok) state.checked.delete(keyOf(id, mid));
      if (state.message?.accountId === id && ok.has(state.message.id)) {
        state.message.isRead = true;
        renderReaderToolbar();
      }
    }
  } finally {
    state.allUnread = false;
    setProgress(null);
  }
  if (failedTotal) toast(`${failedTotal} couldn't be marked as read. They are still selected.`, { error: true });
  else {
    state.checked.clear();
    toast(`Marked ${done} as read`);
  }
  renderSidebar();
}

// Moves the ticked emails to Trash after a confirmation. Only listed emails
// are deleted, even with "select all N unread" (unlisted ones are never
// touched without being seen).
async function bulkDelete() {
  const byAccount = new Map();
  for (const key of state.checked) {
    const [id, mid] = splitKey(key);
    if (!state.accounts[id]) continue;
    if (!byAccount.has(id)) byAccount.set(id, []);
    byAccount.get(id).push(mid);
  }
  const total = [...byAccount.values()].reduce((n, ids) => n + ids.length, 0);
  if (!total || !(await confirmDelete(byAccount, total))) return;

  const setProgress = (text) => {
    state.progress = text;
    renderSidebar();
  };
  let done = 0;
  let failedTotal = 0;
  try {
    for (const [id, ids] of byAccount) {
      const a = state.accounts[id];
      setProgress(`Deleting ${done + 1}–${done + ids.length} of ${total}…`);
      const failed = new Set(await providers[a.provider].trashMany(a, ids));
      const ok = new Set(ids.filter((x) => !failed.has(x)));
      done += ok.size;
      failedTotal += failed.size;
      const m = await getMail(id);
      if (m) {
        const dropped = (m.messages ?? []).filter((x) => ok.has(x.id));
        await patchMail(id, {
          messages: (m.messages ?? []).filter((x) => !ok.has(x.id)),
          unreadCount: Math.max(0, (m.unreadCount ?? 0) - dropped.filter((x) => !x.read).length),
        });
      }
      for (const mid of ok) {
        state.checked.delete(keyOf(id, mid));
        forgetBody(id, mid);
      }
      if (state.selected?.accountId === id && !state.selected.folder && ok.has(state.selected.messageId)) closeReader();
    }
  } finally {
    state.allUnread = false;
    setProgress(null);
  }
  if (failedTotal) toast(`${failedTotal} couldn't be deleted. They are still selected.`, { error: true });
  else {
    state.checked.clear();
    toast(`Moved ${done} to Trash`);
  }
  renderSidebar();
}

// Resolves true only when Delete is clicked; Cancel is focused by default.
function confirmDelete(byAccount, total) {
  const dialog = $('deleteDialog');
  $('deleteTitle').textContent = `Move ${total} email${total > 1 ? 's' : ''} to Trash?`;
  const lines = [...byAccount].map(([id, ids]) => {
    const a = state.accounts[id];
    const where = a.provider === 'outlook' ? 'Deleted Items' : 'Trash';
    return `<li>${pico(a.provider)}<span><b>${ids.length}</b> from ${esc(a.email)} → ${where}</span></li>`;
  });
  const unlisted = state.allUnread
    ? viewAccounts().reduce((n, a) => n + unreadOf(a), 0) - total : 0;
  $('deleteDetails').innerHTML = `<ul class="delete-list">${lines.join('')}</ul>
    ${unlisted > 0 ? `<p class="dialog-note">Only the listed emails are deleted; the other ${unlisted} unread stay in the inbox.</p>` : ''}
    <p class="dialog-note">They can be restored from there for about 30 days.</p>`;
  dialog.returnValue = ''; // Escape keeps the previous value otherwise
  dialog.showModal();
  $('deleteCancel').focus();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true });
  });
}

function openAddMenu(button) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'menu add-menu';
  menu.dataset.floating = '1';
  menu.innerHTML = Object.values(providers)
    .map((p) => `<button class="menu-item" data-action="add" data-provider="${p.id}">${pico(p.id)}${esc(p.name)}</button>`)
    .join('');
  button.parentElement.appendChild(menu);
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
  closeHelpTips();
}

// ---------- actions ----------

async function addAccount(providerId, loginHint) {
  const provider = providers[providerId];
  if (provider.kind === 'imap') return openImapDialog(provider, loginHint);
  if (provider.kind === 'session') return connectSession(provider, loginHint);
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
    await load();
    setView(providerId, id);
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
    await load();
    setView(provider.id, id);
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

// ---------- session accounts (Proton) ----------

let sessionTarget = null;

// Adds every account signed in on the provider's website in this Chrome
// profile, or (with an email) reconnects that one account.
async function connectSession(provider, email) {
  sessionTarget = { provider, email };
  let found;
  try {
    found = await provider.discover();
  } catch (e) {
    toast(e.message, { error: true });
    return;
  }
  const known = (f) => Boolean(state.accounts[accountId(provider.id, f.email)]);
  // "Add" is about accounts not connected yet; "Sign in" reconnects one.
  const wanted = email ? found.filter((f) => f.email === email.toLowerCase()) : found.filter((f) => !known(f));
  // Keep already-connected accounts pointed at their current session.
  for (const f of found.filter(known)) {
    const id = accountId(provider.id, f.email);
    if (state.accounts[id].uid !== f.uid) await upsertAccount({ ...state.accounts[id], uid: f.uid });
  }
  if (!wanted.length) {
    const onlyKnown = !email && found.length > 0;
    $('sessionTitle').textContent = onlyKnown ? `Add another ${provider.name} account` : `Sign in to ${provider.name}`;
    $('sessionText').textContent = email
      ? `${email} is not signed in to ${provider.name} in this Chrome profile. Sign in at mail.proton.me (keep "Keep me signed in" on), then come back and click "I've signed in".`
      : onlyKnown
        ? `No new ${provider.name} account found: ${found.map((f) => f.email).join(', ')} ${found.length > 1 ? 'are' : 'is'} already connected. To add another, open mail.proton.me, choose your account name → Add account and sign in, then come back and click "I've signed in".`
        : `No ${provider.name} account is signed in in this Chrome profile. Sign in at mail.proton.me (keep "Keep me signed in" on), then come back and click "I've signed in".`;
    if (!$('sessionDialog').open) $('sessionDialog').showModal();
    return;
  }
  if ($('sessionDialog').open) $('sessionDialog').close();
  let last;
  for (const f of wanted) {
    last = accountId(provider.id, f.email);
    await upsertAccount({ id: last, provider: provider.id, email: f.email, uid: f.uid, hidden: false, addedAt: Date.now() });
  }
  toast(`${wanted.map((f) => f.email).join(', ')} connected`);
  await load();
  setView(provider.id, wanted.length === 1 ? last : null);
  for (const f of wanted) await refreshOne(accountId(provider.id, f.email));
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
    await load();
    renderSidebar();
    renderTopbar();
    // A manual refresh also closes an email that is no longer in the list
    // (read or deleted elsewhere); automatic checks never do.
    const sel = state.selected;
    const kind = sel?.folder === 'spam' ? 'spam' : 'recent';
    const listed = sel && (state.visibleList.some((m) => m.accountId === sel.accountId && m.id === sel.messageId)
      || (sel.list === sectionKey() && state.open[kind].has(sel.list)
        && sectionItems(kind, sel.accountId, sel.messageId).length > 0));
    if (sel && !listed) {
      openSeq++; // drop any load still in flight for it
      state.selected = null;
      state.message = null;
      renderReaderEmpty();
      renderSidebar();
    }
    reloadOpenSections();
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

async function setRead(id, messageId, read, folder) {
  const a = state.accounts[id];
  await providers[a.provider].setRead(a, messageId, read, { folder });
  const cached = bodies.get(bodyKey(id, messageId, folder));
  if (cached) cached.isRead = read;
  if (folder === 'spam') {
    const items = sectionItems('spam', id, messageId);
    if (items.length && items[0].read !== read) await adjustSpamUnread(id, read ? -1 : 1);
    for (const item of items) item.read = read;
    if (state.message?.id === messageId) {
      state.message.isRead = read;
      renderReaderToolbar();
    }
    renderSidebar();
    return;
  }
  await updateCachedMessage(id, messageId, (msg) => ({
    message: { ...msg, read },
    unreadDelta: Boolean(msg.read) === read ? 0 : read ? -1 : 1,
  }));
  if (state.message?.id === messageId) {
    state.message.isRead = read;
    renderReaderToolbar();
  }
  // A "Recently read" email marked unread moves back to the unread list.
  if (!read && sectionItems('recent', id, messageId).length) {
    dropFromSections('recent', id, messageId);
    renderSidebar();
    refreshOne(id);
  }
}

async function trashMessage(id, messageId, folder) {
  const a = state.accounts[id];
  forgetBody(id, messageId, folder);
  if (folder) {
    await providers[a.provider].trash(a, messageId, { folder });
    await leaveSectionMessage(folder === 'spam' ? 'spam' : 'sent', id, messageId);
    toast(a.provider === 'outlook' ? 'Moved to Deleted Items' : 'Moved to Trash');
    return;
  }
  // The email may be in the unread list, in "Recently read", or both (an
  // unread email that was just opened). Move on to its neighbour in the list
  // it was opened from.
  const key = keyOf(id, messageId);
  let next;
  if (state.selected?.list === undefined || state.visibleList.some((m) => m.key === key)) {
    const idx = state.visibleList.findIndex((m) => m.key === key);
    next = idx === -1 ? null : state.visibleList[idx + 1] ?? state.visibleList[idx - 1];
  } else next = sectionNeighbour('recent', id, messageId);
  const list = state.selected?.list;
  await providers[a.provider].trash(a, messageId);
  dropFromSections('recent', id, messageId);
  await updateCachedMessage(id, messageId, (msg) => ({ message: null, unreadDelta: msg.read ? 0 : -1 }));
  toast(a.provider === 'outlook' ? 'Moved to Deleted Items' : 'Moved to Trash');
  if (next) openMessage(next.accountId, next.id, { list: state.visibleList.includes(next) ? undefined : list });
  else closeReader();
}

function closeReader() {
  state.selected = null;
  state.message = null;
  renderReaderEmpty();
  renderSidebar();
}

// A spam email left the Spam folder (deleted or not spam): drop it from the
// list, fix the count and open its neighbour.
async function leaveSectionMessage(kind, id, messageId) {
  const gone = sectionItems(kind, id, messageId)[0];
  const next = sectionNeighbour(kind, id, messageId);
  const list = state.selected?.list;
  dropFromSections(kind, id, messageId);
  // Opened emails were marked read already, so only unread ones change the count.
  if (kind === 'spam' && gone && gone.read === false) await adjustSpamUnread(id, -1);
  if (next) openMessage(next.accountId, next.id, { folder: SECTION[kind].folder, list });
  else closeReader();
}

async function notSpam(id, messageId) {
  const a = state.accounts[id];
  forgetBody(id, messageId, 'spam');
  const failed = await providers[a.provider].notSpam(a, [messageId]);
  if (failed.length) throw new Error("Couldn't move it to the inbox. Try again.");
  await leaveSectionMessage('spam', id, messageId);
  toast('Moved to Inbox');
  refreshOne(id);
}

// ---------- reader ----------

function renderReaderEmpty() {
  reader.innerHTML = `<div class="reader-empty"><div>${icon.mail}<div>Select an email to read it here</div></div></div>`;
}

let openSeq = 0;

// list: the section key when opened from "Recently read" / "Spam".
// ---------- email body cache ----------
//
// Emails come from the offline cache (IndexedDB, filled in the background by
// src/prefetch.js) when they are there, else from the server (then cached).
// The last few opened are also kept in memory. Hovering an email fetches it
// ahead of the click; nothing is marked read by fetching.

const MEMORY_LIMIT = 30;
const bodies = new Map(); // cache key -> message, oldest first
const bodyLoads = new Map(); // same key -> fetch in progress
const bodyKey = (id, messageId, folder) => cacheDb.bodyKey(id, folder, messageId);

function rememberBody(key, msg) {
  bodies.delete(key);
  bodies.set(key, msg);
  while (bodies.size > MEMORY_LIMIT) bodies.delete(bodies.keys().next().value);
}

function forgetBody(id, messageId, folder) {
  const key = bodyKey(id, messageId, folder);
  bodies.delete(key);
  cacheDb.remove('bodies', key);
}

function forgetAccountBodies(id) {
  for (const key of [...bodies.keys()]) if (key.startsWith(`${id}|`)) bodies.delete(key);
  cacheDb.forgetAccount(id);
}

function fetchBody(id, messageId, folder) {
  const key = bodyKey(id, messageId, folder);
  if (bodies.has(key)) {
    const msg = bodies.get(key);
    rememberBody(key, msg);
    return Promise.resolve(msg);
  }
  if (bodyLoads.has(key)) return bodyLoads.get(key);
  const load = fetchFullMessage(state.accounts[id], messageId, folder)
    .then((msg) => {
      if (!msg.encrypted && state.accounts[id]) rememberBody(key, msg);
      return msg;
    })
    .finally(() => bodyLoads.delete(key));
  bodyLoads.set(key, load);
  return load;
}

// Read or unread as the lists show it now (a cached copy may be older).
function listedReadState(id, messageId, folder) {
  if (!folder) {
    const row = state.mail[id]?.messages?.find((m) => m.id === messageId);
    if (row) return Boolean(row.read);
  }
  for (const kind of KINDS) {
    if (SECTION[kind].folder !== folder) continue;
    const item = sectionItems(kind, id, messageId)[0];
    if (item && item.read !== undefined) return item.read !== false;
  }
  return undefined;
}

let hoverTimer;
function prefetchOnHover(button) {
  clearTimeout(hoverTimer);
  const { account: id, message: messageId, folder } = button.dataset;
  if (!state.accounts[id] || bodies.has(bodyKey(id, messageId, folder))) return;
  hoverTimer = setTimeout(() => fetchBody(id, messageId, folder).catch(() => {}), 250);
}

async function openMessage(id, messageId, { folder, list } = {}) {
  const seq = ++openSeq;
  state.selected = { accountId: id, messageId, folder, list };
  state.message = null;
  state.showRemoteImages = false;
  markSeen(keyOf(id, messageId));
  renderSidebar();
  if (!bodies.has(bodyKey(id, messageId, folder))) reader.innerHTML = `<div class="reader-status">Loading…</div>`;

  try {
    const msg = await fetchBody(id, messageId, folder);
    if (seq !== openSeq) return;
    const listed = listedReadState(id, messageId, folder);
    if (listed !== undefined) msg.isRead = listed;
    state.message = msg;
    rememberAddresses([msg.from, ...(msg.to ?? []), ...(msg.cc ?? [])], 1);
    renderReader();
    // An encrypted body that could not be shown does not count as read.
    if (state.settings.markReadOnOpen && !msg.isRead && !msg.encrypted) {
      setRead(id, messageId, true, folder).catch((e) => toast(`Couldn't mark as read: ${e.message}`, { error: true }));
    }
  } catch (e) {
    if (seq !== openSeq) return;
    const gone = e.status === 404;
    reader.innerHTML = `<div class="reader-status error">${gone ? 'This email no longer exists. It may have been deleted elsewhere.' : esc(e.message)}</div>`;
    if (gone) forgetBody(id, messageId, folder);
    if (gone && !folder) updateCachedMessage(id, messageId, (m) => ({ message: null, unreadDelta: m.read ? 0 : -1 }));
  }
}


function renderReader() {
  const msg = state.message;
  const allowRemote = state.settings.loadRemoteImages || state.showRemoteImages;
  const { srcdoc, remoteImages } = msg.encrypted
    ? { srcdoc: '', remoteImages: 0 }
    : buildEmailDocument(msg, { allowRemoteImages: allowRemote, inlineParts: inlineParts(msg) });
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
        <div class="meta-date">${msg.date ? fmtDateTime(msg.date) : ''}</div>
      </div>
    </div>
    ${remoteImages && !allowRemote ? `<div class="banner"><span>Remote images are blocked so the sender can't tell you opened this email.</span>
      <button class="link-btn" data-action="show-images">Show images</button>
      <button class="link-btn" data-action="always-images">Always show</button></div>` : ''}
    ${files.length ? `<div class="attachments">${files.map((f) => `<button class="attachment" data-action="download" data-index="${msg.attachments.indexOf(f)}" title="${esc(f.filename)}">${icon.clip}<span class="name">${esc(f.filename)}</span><span class="size">${formatSize(f.size)}</span></button>`).join('')}</div>` : ''}
    ${msg.encrypted
      ? `<div class="encrypted-note">${icon.lock}
          <p><strong>This email is end-to-end encrypted by Proton.</strong><br>
          ${esc(msg.readError ?? 'Its content could not be decrypted.')}</p>
          <button class="tool-btn primary" data-action="open-web">${icon.external}Open in Proton</button></div>`
      : '<iframe class="body-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" title="Email body"></iframe>'}`;
  if (!msg.encrypted) reader.querySelector('iframe').srcdoc = srcdoc;
  renderReaderToolbar();
}

function renderReaderToolbar() {
  const bar = $('readerToolbar');
  const msg = state.message;
  if (!bar || !msg) return;
  const providerName = providers[state.accounts[msg.accountId]?.provider]?.name ?? '';
  const btn = (action, iconHtml, label, extra = '') => `<button class="tool-btn icon-only${extra}" data-action="${action}" title="${label}" aria-label="${label}">${iconHtml}</button>`;
  const replyAll = [...(msg.to ?? []), ...(msg.cc ?? [])].length > 1;
  bar.innerHTML = `
    <span class="tb-group">
      ${btn('reply', uiIcons.reply, 'Reply')}
      ${replyAll ? btn('reply-all', uiIcons['reply-all'], 'Reply all') : ''}
      ${btn('forward', uiIcons.forward, 'Forward')}
    </span>
    <span class="tb-group">
      ${msg.isRead ? btn('mark-unread', uiIcons['mark-unread'], 'Mark as unread') : btn('mark-read', icon.mailOpen, 'Mark as read')}
      ${msg.folder === 'spam' ? `<button class="tool-btn" data-action="not-spam">${icon.inbox}Not spam</button>` : ''}
      ${btn('trash', uiIcons.delete, 'Delete', ' danger')}
    </span>
    <span class="spacer"></span>
    ${msg.webUrl ? `<span class="open-web">${pico(state.accounts[msg.accountId]?.provider, 'open-web-icon')}<button class="tool-btn" data-action="open-web">${icon.external}Open in ${esc(providerName)}</button></span>` : ''}
    ${btn('close-reader', icon.close, 'Close (Esc)', ' close-reader')}`;
}

// Attachment bytes from the offline cache (downloaded in the background),
// else from the server; concurrent requests share one download.
const attachmentLoads = new Map();
function attachmentBytes(msg, att) {
  const key = cacheDb.attachmentKey(msg.accountId, msg.folder, msg.id, att);
  if (!attachmentLoads.has(key)) {
    const p = fetchAttachment(state.accounts[msg.accountId], msg, att).finally(() => attachmentLoads.delete(key));
    attachmentLoads.set(key, p);
  }
  return attachmentLoads.get(key);
}

function saveBytes(bytes, att) {
  const url = URL.createObjectURL(new Blob([bytes], { type: att.mimeType || 'application/octet-stream' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: att.filename });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Every attachment opens in the viewer (files without a preview offer a
// Download button there); the arrows move through the email's attachments.
function openAttachment(index) {
  const msg = state.message;
  const files = msg.attachments.filter((x) => !x.inline);
  const start = Math.max(0, files.indexOf(msg.attachments[index]));
  openViewer(
    files.map((att) => ({ filename: att.filename, mimeType: att.mimeType, size: att.size, load: () => attachmentBytes(msg, att) })),
    { index: start, onDownload: (file, bytes) => saveBytes(bytes, file) },
  );
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

sidebar.addEventListener('mouseover', (e) => {
  const button = e.target.closest('.msg[data-action="open"]');
  if (button && !button.contains(e.relatedTarget)) prefetchOnHover(button);
});
sidebar.addEventListener('mouseout', (e) => {
  if (e.target.closest('.msg[data-action="open"]') && !e.target.closest('.msg').contains(e.relatedTarget)) clearTimeout(hoverTimer);
});

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
    case 'add-menu':
      e.stopPropagation();
      return openAddMenu(el);
    case 'view':
      return setView(el.dataset.provider || null);
    case 'view-account':
      return setView(state.view.provider, id);
    case 'toggle-section': {
      const { kind, key } = el.dataset;
      if (state.open[kind].has(key)) {
        state.open[kind].delete(key);
        return renderSidebar();
      }
      state.open[kind].add(key);
      return loadSection(kind, key);
    }
    case 'pick':
      toggleChecked(el.dataset.key, el.checked, { range: e.shiftKey });
      return renderSidebar();
    case 'pick-all':
      state.checked = new Set(el.checked ? state.visibleList.map((m) => m.key) : []);
      return renderSidebar();
    case 'select-all-unread':
      state.allUnread = true;
      return renderSidebar();
    case 'bulk-clear':
      state.checked.clear();
      state.allUnread = false;
      return renderSidebar();
    case 'bulk-read':
      return withBusy(el, bulkMarkRead);
    case 'bulk-delete':
      return withBusy(el, bulkDelete);
    case 'account-menu':
      e.stopPropagation();
      return openAccountMenu(el, id);
    case 'open':
      return openMessage(id, messageId, { folder: el.dataset.folder, list: el.dataset.list });
    case 'open-draft':
      return openCompose({ mode: 'draft', accountId: id, draftRef: messageId, version: el.dataset.version });
    case 'compose':
      return openCompose({ mode: 'new' });
    case 'reply':
    case 'reply-all':
    case 'forward':
      return openCompose({
        mode: { reply: 'reply', 'reply-all': 'replyAll', forward: 'forward' }[action],
        accountId: state.message.accountId,
        original: state.message,
      });
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
        forgetAccountBodies(id);
        await providers[a.provider].forgetAccount?.(a).catch(() => {});
        await removeAccount(id);
      }
      return;
    case 'show-hidden':
      return saveSettings({ showHidden: true });
    case 'mark-read':
    case 'mark-unread':
      return withBusy(el, () => setRead(state.message.accountId, state.message.id, action === 'mark-read', state.message.folder));
    case 'trash':
      return withBusy(el, () => trashMessage(state.message.accountId, state.message.id, state.message.folder));
    case 'not-spam':
      return withBusy(el, () => notSpam(state.message.accountId, state.message.id));
    case 'close-reader':
      openSeq++;
      return closeReader();
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
      return openAttachment(Number(el.dataset.index));
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
  if (open) {
    fillClientIds();
    showCacheUsage();
  }
});
$('settingsMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  // A ? tip shows on hover; a click keeps it open until the next click.
  if (e.target.closest('.help-pop')) return;
  const tip = e.target.closest('.help-tip');
  const wasOpen = tip?.classList.contains('open');
  closeHelpTips();
  if (tip && !wasOpen) tip.classList.add('open');
});
function closeHelpTips() {
  document.querySelectorAll('.help-tip.open').forEach((t) => t.classList.remove('open'));
}
$('pollMinutes').addEventListener('change', (e) => saveSettings({ pollMinutes: Number(e.target.value) }));
$('markReadOnOpen').addEventListener('change', (e) => saveSettings({ markReadOnOpen: e.target.checked }));
$('loadRemoteImages').addEventListener('change', (e) => saveSettings({ loadRemoteImages: e.target.checked }));
$('notifyEnabled').addEventListener('change', (e) => saveSettings({ notifyEnabled: e.target.checked }));
$('soundEnabled').addEventListener('change', (e) => saveSettings({ soundEnabled: e.target.checked }));
$('bannerStyle').addEventListener('change', (e) => saveSettings({ bannerStyle: e.target.value, bannerStyleChosen: true }));
$('testNotify').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ cmd: 'testNotification' });
  if (!state.settings.notifyEnabled && !state.settings.soundEnabled) toast('Notifications and sound are both off.');
  else if (res && !res.ok) toast(res.error, { error: true });
});
$('showHidden').addEventListener('change', (e) => saveSettings({ showHidden: e.target.checked }));
$('undoSendSeconds').addEventListener('change', (e) => saveSettings({ undoSendSeconds: Number(e.target.value) }));
$('cacheLimitMB').addEventListener('change', async (e) => {
  await saveSettings({ cacheLimitMB: Number(e.target.value) });
  const mb = Number(e.target.value);
  if (mb) await cacheDb.trim(mb * 1024 * 1024);
  showCacheUsage();
});
$('clearCache').addEventListener('click', async () => {
  if (!confirm('Delete all downloaded emails and attachments from this computer? They download again in the background.')) return;
  await cacheDb.clearAll();
  showCacheUsage();
  toast('Offline cache cleared');
  chrome.runtime.sendMessage({ cmd: 'prefetchNow' });
});
async function showCacheUsage() {
  const s = await cacheDb.stats();
  const mb = s.total / 1048576;
  const size = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : mb > 0 && mb < 0.1 ? '<0.1 MB' : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const emails = s.bodies?.count ?? 0;
  const files = s.attachments?.count ?? 0;
  $('cacheUsage').textContent = `${size} used · ${emails} ${emails === 1 ? 'email' : 'emails'}, ${files} ${files === 1 ? 'file' : 'files'}`;
}
$('senderName').addEventListener('change', (e) => saveSettings({ senderName: e.target.value.trim() }));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const menuOpen = document.querySelector('.menu:not([hidden])');
  closeMenus();
  // Esc also closes the open email, unless a menu, dialog, the composer or
  // the attachment viewer has the keyboard.
  if (!menuOpen && state.message && !document.querySelector('dialog[open], .viewer') && !e.target.closest?.('.compose, input, textarea, select')) {
    openSeq++;
    closeReader();
  }
});

$('redirectUri').textContent = chrome.identity.getRedirectURL();
async function fillClientIds() {
  const ids = await getClientIds();
  $('googleClientId').value = ids.google;
  $('microsoftClientId').value = ids.microsoft;
}
$('imapForm').addEventListener('submit', submitImapDialog);
$('sessionCancel').addEventListener('click', () => $('sessionDialog').close());
$('sessionOpen').addEventListener('click', () => chrome.tabs.create({ url: sessionTarget.provider.signInUrl }));
$('sessionRetry').addEventListener('click', () => connectSession(sessionTarget.provider, sessionTarget.email));
$('imapCancel').addEventListener('click', () => $('imapDialog').close());
$('clientIdsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await saveClientIds({ google: $('googleClientId').value, microsoft: $('microsoftClientId').value });
  toast('Client IDs saved');
  refreshAllFromUi();
});

// Keep "Checked N min ago" current.
setInterval(renderTopbar, 30000);

state.view = loadView();
await restoreSectionCache();
await load();
// Seed address suggestions with the senders of listed mail (lightly weighted).
rememberAddresses(Object.values(state.mail).flatMap((m) => (m?.messages ?? []).map((x) => x.from)), 0.2);
await fillClientIds();
renderTopbar();
renderSidebar();
renderReaderEmpty();

// Banner style is a required choice, asked once as soon as there is an
// account (the extension cannot detect it from macOS). Escape cannot skip it.
function askBannerStyle() {
  if (state.settings.bannerStyleChosen || !Object.keys(state.accounts).length || $('bannerDialog').open) return;
  $('bannerDialog').showModal();
}
$('bannerDialog').addEventListener('cancel', (e) => e.preventDefault());
for (const btn of document.querySelectorAll('#bannerDialog [data-banner]')) {
  btn.addEventListener('click', async () => {
    await saveSettings({ bannerStyle: btn.dataset.banner, bannerStyleChosen: true });
    $('bannerDialog').close();
    toast(`Notification banners: ${btn.dataset.banner}. You can change this in Settings.`);
  });
}
askBannerStyle();

// ---------- compose and sending ----------

// The account a new email starts from: the one being viewed, else the one the
// open email belongs to, else the last one used.
function defaultFromAccount() {
  const live = liveAccounts().filter((a) => !a.hidden);
  if (state.view.account && state.accounts[state.view.account]) return state.view.account;
  if (state.message?.accountId && state.accounts[state.message.accountId]) return state.message.accountId;
  if (state.view.provider) {
    const first = live.find((a) => a.provider === state.view.provider);
    if (first) return first.id;
  }
  let last = null;
  try {
    last = localStorage.getItem('lastFrom');
  } catch {}
  return state.accounts[last] ? last : live[0]?.id ?? Object.keys(state.accounts)[0] ?? null;
}

const senderNames = new Map();
initCompose({
  accounts: () => state.accounts,
  toast,
  defaultAccountId: defaultFromAccount,
  attachmentBytes,
  senderName: async (account) => {
    const p = providers[account.provider];
    if (p.senderName) {
      if (!senderNames.has(account.id)) senderNames.set(account.id, p.senderName(account).catch(() => ''));
      const name = await senderNames.get(account.id);
      if (name) return name;
    }
    return state.settings.senderName ?? '';
  },
  onDraftsChanged: (accountId) => {
    for (const [key, r] of state.sections.drafts) {
      if (state.open.drafts.has(key) && sectionAccounts(key).some((a) => a.id === accountId)) loadSection('drafts', key);
      else if (r) state.sections.drafts.delete(key);
    }
  },
  onSending: (accountId) => {
    try {
      localStorage.setItem('lastFrom', accountId);
    } catch {}
  },
});

// Emails waiting to be sent (undo), sending, sent or failed. The queue lives
// in the background (chrome.storage.session), so this bar is the same in every
// view and survives reopening the tab.
let sendTick = null;
async function renderSendBar() {
  const { pendingSends = [] } = await chrome.storage.session.get('pendingSends');
  const bar = $('sendBar');
  const now = Date.now();
  bar.innerHTML = pendingSends.map((e) => {
    const to = `${(e.summary?.to ?? []).join(', ')}${e.summary?.more ? ` +${e.summary.more}` : ''}`;
    if (e.status === 'pending') {
      const left = Math.max(0, Math.ceil((e.sendAt - now) / 1000));
      const pct = e.delay ? Math.max(0, Math.min(100, ((e.sendAt - now) / e.delay) * 100)) : 0;
      return `<div class="send-item"><span class="send-text">Sending to ${esc(to)}…</span>
        <button class="send-undo" data-send-undo="${esc(e.id)}">Undo</button><span class="send-left">${left}s</span>
        <span class="send-progress" style="width:${pct}%"></span></div>`;
    }
    if (e.status === 'sending') return `<div class="send-item"><span class="send-text">Sending to ${esc(to)}…</span></div>`;
    if (e.status === 'sent') return `<div class="send-item ok"><span class="send-text">Sent to ${esc(to)}</span></div>`;
    return `<div class="send-item failed"><span class="send-text" title="${esc(e.error ?? '')}">Couldn't send: ${esc(e.error ?? 'unknown error')}. It is still in Drafts.</span>
      ${e.draftRef ? `<button class="send-undo" data-send-open="${esc(e.id)}">Open draft</button>` : ''}
      <button class="send-x" data-send-dismiss="${esc(e.id)}" aria-label="Dismiss">×</button></div>`;
  }).join('');
  const pending = pendingSends.some((e) => e.status === 'pending');
  if (pending && !sendTick) sendTick = setInterval(renderSendBar, 250);
  if (!pending && sendTick) {
    clearInterval(sendTick);
    sendTick = null;
  }
}
$('sendBar').addEventListener('click', async (e) => {
  const undo = e.target.closest('[data-send-undo]');
  const open = e.target.closest('[data-send-open]');
  const dismiss = e.target.closest('[data-send-dismiss]');
  if (undo) {
    const res = await chrome.runtime.sendMessage({ cmd: 'cancelSend', id: undo.dataset.sendUndo });
    if (!res?.ok) return toast(res?.error ?? 'Too late to undo', { error: true });
    toast('Sending undone');
    openCompose({ mode: 'draft', accountId: res.accountId, draftRef: res.draftRef });
  } else if (open) {
    const { pendingSends = [] } = await chrome.storage.session.get('pendingSends');
    const item = pendingSends.find((x) => x.id === open.dataset.sendOpen);
    await chrome.runtime.sendMessage({ cmd: 'dismissSend', id: open.dataset.sendOpen });
    if (item) openCompose({ mode: 'draft', accountId: item.accountId, draftRef: item.draftRef });
  } else if (dismiss) {
    await chrome.runtime.sendMessage({ cmd: 'dismissSend', id: dismiss.dataset.sendDismiss });
  }
});
let lastSent = new Set();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.pendingSends) return;
  renderSendBar();
  // Fresh Sent / Drafts lists once something was sent.
  const sent = new Set((changes.pendingSends.newValue ?? []).filter((e) => e.status === 'sent').map((e) => e.id));
  if ([...sent].some((id) => !lastSent.has(id))) {
    for (const kind of ['sent', 'drafts']) for (const key of state.sections[kind].keys()) state.sections[kind].delete(key);
    reloadOpenSections();
  }
  lastSent = sent;
});
renderSendBar();

// ---------- update banner ----------
//
// The service worker checks GitHub every 6 hours and stores the result under
// "update". "Install update" asks the IMAP helper to download the new version
// into the extension folder (keeping src/config.js), then reloads the
// extension. Accounts, settings and sign-ins are in Chrome's storage for this
// extension, so they are untouched.

async function renderUpdateBar() {
  const { update, dismissedUpdate } = await chrome.storage.local.get(['update', 'dismissedUpdate']);
  const show = update && compareVersions(update.version, currentVersion()) > 0 && update.version !== dismissedUpdate;
  $('updateBar').hidden = !show;
  if (!show) return;
  $('updateTitle').textContent = `Version ${update.version} is available.`;
  const notes = update.notes.map((n) => n.text);
  $('updateNotes').textContent = notes.join(' · ');
  $('updateNotes').title = update.notes.map((n) => `${n.version}: ${n.text}`).join('\n');
}

async function installUpdate() {
  const { update } = await chrome.storage.local.get('update');
  const btn = $('updateInstall');
  btn.disabled = true;
  btn.textContent = 'Installing…';
  try {
    const res = await callHelper({ cmd: 'selfUpdate', version: update?.version }, {
      onProgress: (done, total) => (btn.textContent = `Installing… ${Math.round((done / total) * 100)}%`),
    });
    await chrome.storage.local.set({ updating: { from: currentVersion(), to: res.version } });
    // The reloaded extension reopens this tab (see background.js).
    chrome.runtime.reload();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Install update';
    const msg = ['bad_request', 'not_configured', 'not_installed'].includes(e.code)
      ? 'One-click updates need the helper: run the install command from the README once in Terminal, then reload the extension.'
      : e.message;
    toast(msg, { error: true });
  }
}

$('updateInstall').addEventListener('click', installUpdate);
$('updateLater').addEventListener('click', async () => {
  const { update } = await chrome.storage.local.get('update');
  await chrome.storage.local.set({ dismissedUpdate: update?.version });
});
$('versionText').textContent = `Version ${currentVersion()}`;
$('checkUpdate').addEventListener('click', async () => {
  $('checkUpdate').disabled = true;
  const res = await chrome.runtime.sendMessage({ cmd: 'checkUpdate' });
  $('checkUpdate').disabled = false;
  if (!res?.ok) return toast(`Couldn't check for updates: ${res?.error ?? 'no answer'}`, { error: true });
  if (compareVersions(res.update.version, currentVersion()) > 0) {
    await chrome.storage.local.remove('dismissedUpdate'); // show it again even if put off
    closeMenus();
  } else {
    toast(`You're up to date (${currentVersion()}).`);
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.update || changes.dismissedUpdate)) renderUpdateBar();
});
renderUpdateBar();
{
  const { justUpdated } = await chrome.storage.local.get('justUpdated');
  if (justUpdated) {
    await chrome.storage.local.remove('justUpdated');
    toast(`Updated to version ${justUpdated}. Accounts and settings are unchanged.`);
  }
}

// "#open=<accountId>::<messageId>" (from a notification click) opens that email.
function openFromHash() {
  const m = location.hash.match(/^#open=(.+)$/);
  if (!m) return;
  const [id, messageId] = splitKey(decodeURIComponent(m[1]));
  history.replaceState(null, '', location.pathname);
  if (state.accounts[id]) {
    setView(null);
    openMessage(id, messageId);
  }
}
addEventListener('hashchange', openFromHash);
openFromHash();
// First run: open Settings so the client IDs can be entered.
const ids = await getClientIds();
if (!ids.google && !ids.microsoft) {
  $('clientIdsDetails').open = true;
  $('settingsMenu').hidden = false;
  showCacheUsage();
}
