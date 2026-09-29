// Service worker: opens the app tab, checks accounts on an alarm, keeps the
// IMAP push connection open and keeps the toolbar badge current. Account and
// mail state is in storage; only the push connection lives in memory.

import { providers } from './providers/index.js';
import { getAccounts, getSettings } from './storage.js';
import { refreshAccount, refreshAll, refreshDue, updateBadge } from './sync.js';

const ALARM = 'poll';
const APP_URL = chrome.runtime.getURL('src/app/app.html');

async function schedule() {
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

// Content scripts only reach pages loaded after the extension was installed
// or updated, so add the Proton session script to mail.proton.me tabs that
// are already open.
async function injectIntoOpenProtonTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://mail.proton.me/*' });
  for (const tab of tabs) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/proton-session.js'] }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => {
  schedule();
  refreshAll();
  injectIntoOpenProtonTabs();
});

chrome.runtime.onStartup.addListener(() => {
  schedule();
  refreshAll();
  injectIntoOpenProtonTabs();
});

// Also runs whenever the service worker starts, e.g. woken by the alarm.
startPush();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  if (!pushPort) startPush();
  const { pollMinutes } = await getSettings();
  refreshDue(Math.max(0.5, Number(pollMinutes) || 2), (id) => pushLive.has(id));
});

// Toolbar click: focus the existing app tab or open one.
chrome.action.onClicked.addListener(async () => {
  // getContexts finds our own tab without needing the "tabs" permission.
  const [tab] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [APP_URL] });
  if (tab) {
    await chrome.tabs.update(tab.tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings && changes.settings.oldValue?.pollMinutes !== changes.settings.newValue?.pollMinutes) {
    schedule();
  }
  if (changes.accounts) {
    pushUnsupported = false; // a reinstalled helper gets another chance
    startPush();
  }
  if (changes.accounts || Object.keys(changes).some((k) => k.startsWith('mail/'))) updateBadge();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
