// Service worker: opens the app tab, polls accounts on an alarm and keeps the
// toolbar badge current. It holds no state in memory; everything is in storage.

import { getSettings } from './storage.js';
import { refreshAll, updateBadge } from './sync.js';

const ALARM = 'poll';
const APP_URL = chrome.runtime.getURL('src/app/app.html');

async function schedule() {
  const { pollMinutes } = await getSettings();
  await chrome.alarms.clear(ALARM);
  await chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, Number(pollMinutes) || 2) });
}

chrome.runtime.onInstalled.addListener(() => {
  schedule();
  refreshAll();
});

chrome.runtime.onStartup.addListener(() => {
  schedule();
  refreshAll();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) refreshAll();
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
  if (changes.accounts || Object.keys(changes).some((k) => k.startsWith('mail/'))) updateBadge();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.cmd === 'refresh') {
    refreshAll().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
