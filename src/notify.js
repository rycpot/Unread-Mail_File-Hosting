// New-mail notifications and chime (background service worker only).
//
// The route depends on the macOS banner style chosen in Settings (the
// extension cannot detect it):
//
//   Persistent: the first new email shows a notification and chime at once.
//     While that notification stays open, further new emails silently update
//     it to "N new emails" with each provider's icon: no new banner, no sound.
//     Once it is closed (or clicked), the next new email alerts again at once.
//
//   Temporary: banners leave the screen after about 5 s but the notification
//     stays in Notification Center, so "open" says nothing about being seen.
//     Emails within TEMP_MERGE_MS of the last banner are merged into it
//     silently; later ones get a fresh banner. Chimes are at least
//     TEMP_SOUND_GAP_MS apart.
//
// With notifications off but sound on, chimes are at least SOUND_ONLY_GAP_MS
// apart. Emails already notified are remembered, so none alerts twice.

import { providers } from './providers/index.js';
import { getAccounts, getSettings } from './storage.js';

const SOUND_ONLY_GAP_MS = 15000;
const TEMP_MERGE_MS = 8000; // a Temporary banner is on screen for about 5 s
const TEMP_SOUND_GAP_MS = 20000;
const NOTIFICATION_ID = 'new-mail';
const SEEN_KEY = 'notifiedKeys'; // chrome.storage.session: survives worker restarts
const SEEN_MAX = 500;
const ACTIVE_KEY = 'activeNotification'; // emails shown in the open notification

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
  const now = Date.now();
  const { lastSoundAt = 0, lastBannerAt = 0 } = await chrome.storage.session.get(['lastSoundAt', 'lastBannerAt']);
  let shown = null;
  let sound = false;
  if (settings.notifyEnabled) {
    // Is our notification still open (on screen or in Notification Center)?
    const open = Boolean((await chrome.notifications.getAll())[NOTIFICATION_ID]);
    const temporary = settings.bannerStyle !== 'persistent';
    // Persistent: merge while open. Temporary: merge only while the banner is
    // (about to be) on screen.
    const merge = open && (!temporary || now - lastBannerAt < TEMP_MERGE_MS);
    const all = merge ? [...(session[ACTIVE_KEY] ?? []), ...fresh] : fresh;
    shown = await show(all, { update: merge, persistent: !temporary });
    await chrome.storage.session.set({ [ACTIVE_KEY]: all, ...(!shown.updated && { lastBannerAt: now }) });
    sound = settings.soundEnabled && !shown.updated && (!temporary || now - lastSoundAt >= TEMP_SOUND_GAP_MS);
  } else {
    sound = settings.soundEnabled && now - lastSoundAt >= SOUND_ONLY_GAP_MS;
  }
  if (sound) {
    await chrome.storage.session.set({ lastSoundAt: now });
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

async function show(items, { update = false, persistent = false } = {}) {
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
    // Persistent: keep it until you close or click it, so Chrome itself never
    // times it out (which would count as closed).
    requireInteraction: persistent,
  };
  // Update in place while it is open; otherwise (or if it was closed in the
  // meantime) start a new one.
  const updated = update && (await chrome.notifications.update(NOTIFICATION_ID, options));
  if (!updated) {
    // Replacing (not updating) makes macOS show a new banner.
    await chrome.notifications.clear(NOTIFICATION_ID);
    await chrome.notifications.create(NOTIFICATION_ID, options);
  }
  await chrome.storage.session.set({ notificationTarget: single ? keyOf(single) : null });
  return { title: options.title, message: options.message, icons: single ? [single.provider] : providerIds, updated: Boolean(updated) };
}

// The providers' icons as one square image, each as large as the square
// allows: two overlap diagonally, three form a triangle, four or more a grid.
// Each entry is [x, y, size] as a fraction of the square.
const LAYOUTS = {
  2: [[0, 0, 0.64], [0.36, 0.36, 0.64]],
  3: [[0, 0, 0.49], [0.51, 0, 0.49], [0.255, 0.51, 0.49]],
  4: [[0, 0, 0.49], [0.51, 0, 0.49], [0, 0.51, 0.49], [0.51, 0.51, 0.49]],
  5: [[0, 0.17, 0.32], [0.34, 0.17, 0.32], [0.68, 0.17, 0.32], [0.17, 0.51, 0.32], [0.51, 0.51, 0.32]],
  6: [[0, 0.17, 0.32], [0.34, 0.17, 0.32], [0.68, 0.17, 0.32], [0, 0.51, 0.32], [0.34, 0.51, 0.32], [0.68, 0.51, 0.32]],
};

export async function compositeIcon(ids) {
  const size = 256;
  ids = ids.slice(0, 6);
  const layout = LAYOUTS[ids.length] ?? [[0, 0, 1]];
  const canvas = new OffscreenCanvas(size, size);
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  for (const [i, id] of ids.entries()) {
    const blob = await (await fetch(chrome.runtime.getURL(`icons/providers/${id}.png`))).blob();
    const bmp = await createImageBitmap(blob);
    const [x, y, s] = layout[i].map((v) => v * size);
    if (ids.length === 2 && i === 1) {
      // Clear a thin outline around the front icon so the two stay distinct.
      const ring = 10;
      g.globalCompositeOperation = 'destination-out';
      g.drawImage(bmp, x - ring, y - ring, s + 2 * ring, s + 2 * ring);
      g.globalCompositeOperation = 'source-over';
    }
    g.drawImage(bmp, x, y, s, s);
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
