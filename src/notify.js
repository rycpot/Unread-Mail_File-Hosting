// New-mail notifications and chime (background service worker only).
//
// New emails from any account are collected for a short window and shown as
// ONE notification with ONE chime, so push updates, several accounts finishing
// a refresh at once, or a burst of arrivals never produce a string of sounds.
// The chime also has a cooldown, and emails already notified are remembered.

import { providers } from './providers/index.js';
import { getAccounts, getSettings } from './storage.js';

const WINDOW_MS = 2500; // wait this long after the latest new email...
const MAX_WAIT_MS = 6000; // ...but never longer than this after the first
const SOUND_COOLDOWN_MS = 10000;
const NOTIFICATION_ID = 'new-mail';
const SEEN_KEY = 'notifiedKeys'; // chrome.storage.session: survives worker restarts
const SEEN_MAX = 500;

let batch = [];
let flushTimer = null;
let firstAt = 0;
let lastSoundAt = 0;

async function alreadyNotified() {
  return new Set((await chrome.storage.session.get(SEEN_KEY))[SEEN_KEY] ?? []);
}

// items: [{ accountId, provider, id, from, subject }]
export async function queueNewMail(items) {
  const seen = await alreadyNotified();
  const fresh = items.filter((it) => {
    const key = `${it.accountId}::${it.id}`;
    return !seen.has(key) && !batch.some((b) => `${b.accountId}::${b.id}` === key);
  });
  if (!fresh.length) return;
  batch.push(...fresh);
  firstAt ||= Date.now();
  clearTimeout(flushTimer);
  const wait = Math.max(0, Math.min(WINDOW_MS, firstAt + MAX_WAIT_MS - Date.now()));
  flushTimer = setTimeout(flush, wait);
}

async function flush() {
  const items = batch;
  batch = [];
  firstAt = 0;
  flushTimer = null;
  if (!items.length) return;

  const seen = [...(await alreadyNotified()), ...items.map((it) => `${it.accountId}::${it.id}`)];
  await chrome.storage.session.set({ [SEEN_KEY]: seen.slice(-SEEN_MAX) });

  const settings = await getSettings();
  // Hidden accounts never alert.
  const accounts = await getAccounts();
  const visible = items.filter((it) => accounts[it.accountId] && !accounts[it.accountId].hidden);
  if (!visible.length) return;

  const shown = settings.notifyEnabled ? await show(visible) : null;
  let sound = false;
  if (settings.soundEnabled && Date.now() - lastSoundAt >= SOUND_COOLDOWN_MS) {
    lastSoundAt = Date.now();
    sound = true;
    await playChime();
  }
  await log({ emails: visible.length, shown, sound });
}

// A short record of recent alerts (session storage, cleared when Chrome quits),
// useful when checking why a notification did or did not appear.
async function log(entry) {
  const { notifyLog = [] } = await chrome.storage.session.get('notifyLog');
  notifyLog.push({ at: Date.now(), ...entry });
  await chrome.storage.session.set({ notifyLog: notifyLog.slice(-20) });
}

async function show(items) {
  const single = items.length === 1 ? items[0] : null;
  const order = Object.keys(providers);
  const providerIds = [...new Set(items.map((it) => it.provider))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const options = {
    type: 'basic',
    iconUrl: single ? chrome.runtime.getURL(`icons/providers/${single.provider}.png`) : await compositeIcon(providerIds),
    title: single ? (single.from?.name || single.from?.email || 'New email') : `${items.length} new emails`,
    message: single ? (single.subject || '(no subject)') : '',
    silent: true, // the extension plays its own chime (or none)
    priority: 0,
  };
  // One notification at a time: a newer batch replaces the previous one.
  await chrome.notifications.clear(NOTIFICATION_ID);
  await chrome.notifications.create(NOTIFICATION_ID, options);
  await chrome.storage.session.set({ notificationTarget: single ? `${single.accountId}::${single.id}` : null });
  return { title: options.title, message: options.message, icons: single ? [single.provider] : providerIds };
}

// The providers' icons side by side (or in a grid), as one image.
export async function compositeIcon(ids) {
  const size = 256;
  const cols = ids.length <= 2 ? ids.length : ids.length <= 4 ? 2 : 3;
  const rows = Math.ceil(ids.length / cols);
  const cell = Math.floor(size / Math.max(cols, rows));
  const pad = Math.round(cell * 0.08);
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d');
  const offX = (size - cols * cell) / 2;
  const offY = (size - rows * cell) / 2;
  for (const [i, id] of ids.entries()) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/providers/${id}.png`))).blob();
    const bmp = await createImageBitmap(blob);
    g.drawImage(bmp, offX + (i % cols) * cell + pad, offY + Math.floor(i / cols) * cell + pad, cell - 2 * pad, cell - 2 * pad);
  }
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

let creatingOffscreen = null;
export async function playChime() {
  const url = chrome.runtime.getURL('src/offscreen/chime.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (!existing.length) {
    creatingOffscreen ??= chrome.offscreen
      .createDocument({ url, reasons: ['AUDIO_PLAYBACK'], justification: 'Play the new-mail chime' })
      .finally(() => (creatingOffscreen = null));
    await creatingOffscreen;
  }
  await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'chime' });
}

// A sample notification for the Settings "Test" button.
export async function testNotification() {
  const settings = await getSettings();
  if (settings.notifyEnabled) {
    await show([{ accountId: 'test', provider: 'gmail', id: 'test', from: { name: 'Unread Mail' }, subject: 'This is how new mail will look' }]);
  }
  if (settings.soundEnabled) await playChime();
}
