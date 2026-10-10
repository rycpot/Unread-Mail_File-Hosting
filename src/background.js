// Service worker: opens the app tab, checks accounts on an alarm, keeps the
// IMAP push connection open and keeps the toolbar badge current. Account and
// mail state is in storage; only the push connection lives in memory.

import { providers } from './providers/index.js';
import { getAccounts, getSettings } from './storage.js';
import { notificationClosed, queueNewMail, testNotification } from './notify.js';
import { onNewMail, refreshAccount, refreshAll, refreshDue, updateBadge } from './sync.js';
import { checkForUpdate } from './update.js';
import { schedulePrefetch, sectionsChanged } from './prefetch.js';
import { forgetSectionLists } from './section-lists.js';
import * as cache from './cache-db.js';

onNewMail(queueNewMail);

const ALARM = 'poll';
const UPDATE_ALARM = 'update-check';
const APP_URL = chrome.runtime.getURL('src/app/app.html');

async function schedule() {
  // Every 6 hours; left alone if already set, so changing settings doesn't reset it.
  if (!(await chrome.alarms.get(UPDATE_ALARM))) chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 360 });
  const { pollMinutes } = await getSettings();
  await chrome.alarms.clear(ALARM);
  // 30 seconds is the shortest alarm period Chrome allows.
  await chrome.alarms.create(ALARM, { periodInMinutes: Math.max(0.5, Number(pollMinutes) || 2) });
}

// ---------- push for iCloud / Yahoo / AOL (IMAP IDLE via the helper) ----------
//
// While there are IMAP accounts, a native-messaging port to the helper stays
// open (which also keeps this service worker alive). The helper holds one IDLE
// connection per account and reports changes, which are refreshed at once.

const HOST = 'com.unreadmail.imap';
let pushPort = null;
let pushUnsupported = false; // helper too old for push: fall back to checking
const pushLive = new Set(); // account ids with an established IDLE connection
const pending = new Map(); // account id -> debounce timer
let retryTimer = null;

const imapAccounts = async () =>
  Object.values(await getAccounts()).filter((a) => providers[a.provider]?.kind === 'imap');

async function startPush() {
  clearTimeout(retryTimer);
  const accounts = await imapAccounts();
  if (!accounts.length || pushUnsupported) {
    pushPort?.disconnect();
    pushPort = null;
    pushLive.clear();
    return;
  }
  if (!pushPort) {
    try {
      pushPort = chrome.runtime.connectNative(HOST);
    } catch {
      pushPort = null;
      retryTimer = setTimeout(startPush, 60e3);
      return;
    }
    pushPort.onMessage.addListener(onPushMessage);
    pushPort.onDisconnect.addListener(() => {
      pushPort = null;
      pushLive.clear();
      // Helper not installed, stopped or crashed: try again in a minute;
      // checking on the timer covers the gap.
      if (!pushUnsupported) retryTimer = setTimeout(startPush, 60e3);
    });
  }
  pushPort.postMessage({ cmd: 'watch', accounts: accounts.map((a) => ({ provider: a.provider, email: a.email })) });
}

function onPushMessage(msg) {
  // A helper from before push answers "watch" with an unknown-command error.
  if (msg?.error) {
    pushUnsupported = msg.error.code === 'bad_request';
    return;
  }
  const id = msg?.provider && msg.email ? `${msg.provider}:${msg.email.toLowerCase()}` : null;
  if (!id) return;
  if (msg.event === 'status') {
    msg.state === 'idle' ? pushLive.add(id) : pushLive.delete(id);
  } else if (msg.event === 'changed') {
    // Servers often send several updates for one change; refresh once.
    clearTimeout(pending.get(id));
    pending.set(id, setTimeout(async () => {
      pending.delete(id);
      const account = (await getAccounts())[id];
      if (account) {
        await refreshAccount(account);
        await updateBadge();
      }
    }, 800));
  }
}

// ---------- sending with undo ----------
//
// The app saves the final draft and prepares it (everything that needs the
// app tab, like Proton encryption), then queues it here. It is sent after the
// undo delay from Settings, so switching mailboxes, opening other emails or
// even closing the app tab does not stop it; Undo cancels it and the email
// stays in Drafts. The queue is in chrome.storage.session: if Chrome quits
// during the countdown nothing is sent and the draft stays in Drafts.

const PENDING = 'pendingSends';
const sendTimers = new Map();
let keepAliveTimer = null;

const getPending = async () => (await chrome.storage.session.get(PENDING))[PENDING] ?? [];
const setPending = (list) => chrome.storage.session.set({ [PENDING]: list });

// Serialise read-modify-write of the queue.
let queueLock = Promise.resolve();
function withQueue(fn) {
  const run = queueLock.then(async () => {
    const list = await getPending();
    const result = await fn(list);
    await setPending(list);
    return result;
  });
  queueLock = run.catch(() => {});
  return run;
}

async function queueSend(item) {
  const { undoSendSeconds } = await getSettings();
  const delay = Math.max(0, Number(undoSendSeconds) || 10) * 1000;
  const entry = { ...item, id: crypto.randomUUID(), sendAt: Date.now() + delay, delay, status: 'pending' };
  await withQueue((list) => list.push(entry));
  scheduleSend(entry);
  return entry.id;
}

function scheduleSend(entry) {
  clearTimeout(sendTimers.get(entry.id));
  sendTimers.set(entry.id, setTimeout(() => commitSend(entry.id), Math.max(0, entry.sendAt - Date.now())));
  // A fallback wake-up in case the worker is stopped during the countdown.
  chrome.alarms.create(`send:${entry.id}`, { when: entry.sendAt + 1000 });
  keepAlive();
}

// Extension API calls keep the service worker running while emails wait.
function keepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(async () => {
    const list = await getPending();
    if (!list.some((e) => e.status === 'pending' || e.status === 'sending')) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
      return;
    }
    chrome.runtime.getPlatformInfo();
  }, 20e3);
}

async function commitSend(id) {
  clearTimeout(sendTimers.get(id));
  sendTimers.delete(id);
  chrome.alarms.clear(`send:${id}`);
  const entry = await withQueue((list) => {
    const e = list.find((x) => x.id === id);
    if (!e || e.status !== 'pending') return null;
    e.status = 'sending';
    return { ...e };
  });
  if (!entry) return;
  let status = 'sent';
  let error = null;
  try {
    const account = (await getAccounts())[entry.accountId];
    if (!account) throw new Error('The account was removed');
    await providers[account.provider].commitSend(account, entry.sendable);
  } catch (e) {
    status = 'failed';
    error = e.message;
    console.warn('[send]', e);
  }
  await withQueue((list) => {
    const e = list.find((x) => x.id === id);
    if (e) Object.assign(e, { status, error, sendable: null, doneAt: Date.now() });
  });
  if (status === 'sent') {
    const account = (await getAccounts())[entry.accountId];
    if (account) refreshAccount(account).catch(() => {});
    sectionsChanged(entry.accountId);
    schedulePrefetch(5000);
  }
  // Results stay visible in the app for a little while.
  setTimeout(() => withQueue((list) => {
    const i = list.findIndex((x) => x.id === id && x.status === 'sent');
    if (i !== -1) list.splice(i, 1);
  }), 8000);
}

async function cancelSend(id) {
  const entry = await withQueue((list) => {
    const i = list.findIndex((x) => x.id === id && x.status === 'pending');
    return i === -1 ? null : list.splice(i, 1)[0];
  });
  if (!entry) return { ok: false, error: 'It is already being sent' };
  clearTimeout(sendTimers.get(id));
  sendTimers.delete(id);
  chrome.alarms.clear(`send:${id}`);
  return { ok: true, accountId: entry.accountId, draftRef: entry.draftRef };
}

// On worker start: send what is due, re-arm the rest.
async function resumeSends() {
  for (const e of await getPending()) {
    if (e.status !== 'pending') continue;
    if (e.sendAt <= Date.now()) commitSend(e.id);
    else scheduleSend(e);
  }
}
resumeSends();

// Content scripts only reach pages loaded after the extension was installed
// or updated, so add the Proton session script to mail.proton.me tabs that
// are already open.
async function injectIntoOpenProtonTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://mail.proton.me/*' });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/proton-session.js'] }).catch(() => {});
  }
}

const checkUpdateQuietly = () => checkForUpdate().catch((e) => console.warn('[update]', e.message));

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  schedule();
  refreshAll();
  injectIntoOpenProtonTabs();
  checkUpdateQuietly();
  // Installed from the app's update banner: reopen the app, which says so.
  const { updating, appTab } = await chrome.storage.local.get(['updating', 'appTab']);
  if (reason === 'update' && updating) {
    await chrome.storage.local.remove('updating');
    await chrome.storage.local.set({ justUpdated: chrome.runtime.getManifest().version });
    openApp();
  } else if (reason === 'update' && appTab) {
    // Reloaded (e.g. "Update" in chrome://extensions reloads every unpacked
    // extension), which closed the app tab: bring it back as it was.
    openApp();
  }
});

// The app tab closed by you is forgotten, so a later reload doesn't reopen it. On
// a reload the worker is stopped first, so this doesn't run and the tab comes back.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { appTab } = await chrome.storage.local.get('appTab');
  if (appTab?.id === tabId) await chrome.storage.local.remove('appTab');
});

chrome.runtime.onStartup.addListener(() => {
  // Tab ids don't survive a Chrome restart: note the app tab if Chrome restored it.
  chrome.runtime.getContexts({ contextTypes: ['TAB'] }).then((tabs) => {
    const t = tabs.find((x) => x.documentUrl?.startsWith(APP_URL));
    return t ? chrome.storage.local.set({ appTab: { id: t.tabId } }) : chrome.storage.local.remove('appTab');
  }).catch(() => {});
  schedule();
  refreshAll();
  injectIntoOpenProtonTabs();
  checkUpdateQuietly();
});

// Also runs whenever the service worker starts, e.g. woken by the alarm.
startPush();
schedulePrefetch(10000);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === UPDATE_ALARM) return checkUpdateQuietly();
  if (alarm.name.startsWith('send:')) return commitSend(alarm.name.slice(5));
  if (alarm.name !== ALARM) return;
  if (!pushPort) startPush();
  const { pollMinutes } = await getSettings();
  refreshDue(Math.max(0.5, Number(pollMinutes) || 2), (id) => pushLive.has(id));
});

// Focus the existing app tab or open one; `open` names an email to show.
async function openApp(open) {
  const hash = open ? `#open=${encodeURIComponent(open)}` : '';
  // getContexts finds our own tab without needing the "tabs" permission.
  const tabs = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  const appTab = tabs.find((t) => t.documentUrl?.startsWith(APP_URL));
  if (appTab) {
    await chrome.tabs.update(appTab.tabId, { active: true, ...(hash && { url: APP_URL + hash }) });
    await chrome.windows.update(appTab.windowId, { focused: true });
  } else {
    const win = await chrome.windows.getLastFocused().catch(() => null);
    const { appTabPinned } = await chrome.storage.local.get('appTabPinned');
    await chrome.tabs.create({ url: APP_URL + hash, pinned: Boolean(appTabPinned), ...(win && { windowId: win.id }) });
    if (win) await chrome.windows.update(win.id, { focused: true });
  }
}

// Toolbar click.
chrome.action.onClicked.addListener(() => openApp());

// Notification click: a single email opens in the reader; a group opens the list.
chrome.notifications.onClicked.addListener(async (id) => {
  const { notificationTarget } = await chrome.storage.session.get('notificationTarget');
  await chrome.notifications.clear(id);
  await notificationClosed(id);
  openApp(notificationTarget);
});

// Closed by you (or the system): the next new email alerts afresh.
chrome.notifications.onClosed.addListener((id) => notificationClosed(id));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings && changes.settings.oldValue?.pollMinutes !== changes.settings.newValue?.pollMinutes) {
    schedule();
  }
  if (changes.accounts) {
    pushUnsupported = false; // a reinstalled helper gets another chance
    startPush();
  }
  if (changes.accounts || Object.keys(changes).some((k) => k.startsWith('mail/'))) {
    updateBadge();
    // New mail (or a new account): download what is not cached yet.
    schedulePrefetch();
  }
  if (changes.accounts) {
    // Cached mail of removed accounts goes too.
    const before = Object.keys(changes.accounts.oldValue ?? {});
    const now = new Set(Object.keys(changes.accounts.newValue ?? {}));
    for (const id of before) {
      if (now.has(id)) continue;
      cache.forgetAccount(id);
      forgetSectionLists(id);
    }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.cmd === 'newMail' && sender.id === chrome.runtime.id && Array.isArray(msg.items)) {
    queueNewMail(msg.items);
    return;
  }
  if (msg?.cmd === 'testNotification') {
    testNotification().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.cmd === 'queueSend' && sender.id === chrome.runtime.id && msg.item) {
    queueSend(msg.item).then((id) => sendResponse({ ok: true, id }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.cmd === 'cancelSend' && sender.id === chrome.runtime.id) {
    cancelSend(msg.id).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.cmd === 'dismissSend' && sender.id === chrome.runtime.id) {
    withQueue((list) => {
      const i = list.findIndex((x) => x.id === msg.id && x.status !== 'pending' && x.status !== 'sending');
      if (i !== -1) list.splice(i, 1);
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.cmd === 'prefetchNow' && sender.id === chrome.runtime.id) {
    if (msg.accountId) sectionsChanged(msg.accountId);
    schedulePrefetch(500);
    return;
  }
  if (msg?.cmd === 'checkUpdate') {
    checkForUpdate().then((update) => sendResponse({ ok: true, update }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg?.cmd === 'refresh') {
    refreshAll().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  // Proton's persisted-session entries, from the content script on
  // mail.proton.me (see src/content/proton-session.js). Only accepted from
  // that site; they are stored per session UID.
  if (msg?.cmd === 'protonSessions' && sender.origin === 'https://mail.proton.me' && Array.isArray(msg.items)) {
    chrome.storage.local.get('protonSessions').then(({ protonSessions = {} }) => {
      for (const it of msg.items) {
        if (typeof it?.UID !== 'string' || typeof it.blob !== 'string') continue;
        protonSessions[it.UID] = {
          blob: it.blob,
          payloadVersion: Number(it.payloadVersion) || 1,
          localID: Number(it.localID) || 0,
          at: Date.now(),
        };
      }
      return chrome.storage.local.set({ protonSessions });
    });
  }
});
