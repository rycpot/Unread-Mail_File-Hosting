// New-mail notifications and chime (background service worker only).
//
// The first new email shows a notification and plays the chime at once. While
// that notification stays open (Chrome's "Persistent" style keeps it until you
// close it), further new emails silently update it to "N new emails" with each
// provider's icon: no new banner, no sound. Once it is closed (or clicked), the
// next new email alerts again straight away. With notifications off but sound
// on, chimes are at least SOUND_ONLY_GAP_MS apart. Emails already notified are
// remembered, so the same email never alerts twice.

import { providers } from './providers/index.js';
import { getAccounts, getSettings } from './storage.js';

const SOUND_ONLY_GAP_MS = 15000;
const NOTIFICATION_ID = 'new-mail';
const SEEN_KEY = 'notifiedKeys'; // chrome.storage.session: survives worker restarts
const SEEN_MAX = 500;
const ACTIVE_KEY = 'activeNotification'; // emails shown in the open notification

let lastSoundAt = 0;
let queue = Promise.resolve(); // handle arrivals one batch at a time

const keyOf = (it) => `${it.accountId}::${it.id}`;

// items: [{ accountId, provider, id, from, subject }]
export function queueNewMail(items) {
  queue = queue.then(() => handle(items)).catch((e) => console.warn('[notify]', e));
  return queue;
}

async function handle(items) {
  const session = await chrome.storage.session.get([SEEN_KEY, ACTIVE_KEY]);
  const seen = new Set(session[SEEN_KEY] ?? []);
  const accounts = await getAccounts();
  // Hidden accounts never alert.
  const fresh = items.filter((it) => !seen.has(keyOf(it)) && accounts[it.accountId] && !accounts[it.accountId].hidden);
  if (!fresh.length) return;
  await chrome.storage.session.set({ [SEEN_KEY]: [...seen, ...fresh.map(keyOf)].slice(-SEEN_MAX) });

  const settings = await getSettings();
  let shown = null;
  let sound = false;
  if (settings.notifyEnabled) {
    // Is our notification still open (on screen or in Notification Center)?
    const open = Boolean((await chrome.notifications.getAll())[NOTIFICATION_ID]);
    const active = open ? session[ACTIVE_KEY] ?? [] : [];
    const all = [...active, ...fresh];
    shown = await show(all, { update: open });
    await chrome.storage.session.set({ [ACTIVE_KEY]: all });
    sound = settings.soundEnabled && !shown.updated;
  } else {
    sound = settings.soundEnabled && Date.now() - lastSoundAt >= SOUND_ONLY_GAP_MS;
  }
  if (sound) {
    lastSoundAt = Date.now();
    await playChime();
  }
  await log({ emails: fresh.length, shown, sound });
}

// The notification was closed (by you, by clicking it, or by the system): the
// next new email starts a fresh one, with sound.
export async function notificationClosed(id) {
  if (id === NOTIFICATION_ID) await chrome.storage.session.remove([ACTIVE_KEY, 'notificationTarget']);
}

// A short record of recent alerts (session storage, cleared when Chrome quits),
// useful when checking why a notification did or did not appear.
async function log(entry) {
  const { notifyLog = [] } = await chrome.storage.session.get('notifyLog');
  notifyLog.push({ at: Date.now(), ...entry });
  await chrome.storage.session.set({ notifyLog: notifyLog.slice(-20) });
}

async function show(items, { update = false } = {}) {
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
  // Update in place while it is open; otherwise (or if it was closed in the
  // meantime) start a new one.
  const updated = update && (await chrome.notifications.update(NOTIFICATION_ID, options));
  if (!updated) await chrome.notifications.create(NOTIFICATION_ID, options);
  await chrome.storage.session.set({ notificationTarget: single ? keyOf(single) : null });
  return { title: options.title, message: options.message, icons: single ? [single.provider] : providerIds, updated: Boolean(updated) };
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
    await chrome.notifications.clear(NOTIFICATION_ID);
    await notificationClosed(NOTIFICATION_ID);
    await show([{ accountId: 'test', provider: 'gmail', id: 'test', from: { name: 'Unread Mail' }, subject: 'This is how new mail will look' }]);
  }
  if (settings.soundEnabled) await playChime();
}
