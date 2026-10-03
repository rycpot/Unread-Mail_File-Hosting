// File uploads to Catbox (catbox.moe), x02 (x02.me) and ImgLink (imglink.cc), an independent module
// of the app: the rail icons open a panel in place of the email view; any
// files dropped on it (or chosen) are uploaded one link each, the links are
// shown and copied to the clipboard, and the last 100 per service are kept on
// this computer.
//
// Catbox: POST https://catbox.moe/user/api.php, multipart reqtype=fileupload,
// fileToUpload, and userhash when set (else anonymous); the reply is the URL
// as plain text. 200 MB; .exe .scr .cpl .doc* .jar are refused.
// x02: POST https://up.x02.me/api/upload?format=json with an x-api-key header
// and one "file" field (optional "expiry": 1h 6h 1d 7d 30d); the reply is
// { success, data: { url, … } } or { success: false, error }. 200 MB on the
// Free plan, 512 MB on Pro (the server says which).
// ImgLink: POST https://imglink.cc/api/v1/upload with an x-api-key header (your
// account), or https://imglink.cc/api/upload without one (anonymous); one
// "file" field plus visibility=private, so uploads are never in
// its public gallery. The reply is { success, id, url, … } or { error }.
// Images only, 50 MB. It can't fetch a link itself and has no list of an
// account's uploads; only uploads made with the key can be deleted.

import { fmtDateTime } from './format.js';
import { openViewer } from './viewer.js';

const MB = 1024 * 1024;
const HISTORY_KEY = 'uploadHistory';
const HISTORY_MAX = 100;
const EXPIRY_MS = { '1h': 3600e3, '6h': 6 * 3600e3, '1d': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };

export const UPLOADERS = {
  x02: {
    name: 'x02',
    icon: '/icons/uploads/x02.png',
    maxBytes: 512 * MB,
    rules: 'One link per file. Up to 200 MB (512 MB on Pro).',
    ready: (s) => Boolean(s.x02ApiKey?.trim()),
    hasAccount: (s) => Boolean(s.x02ApiKey?.trim()),
    mode: (s) => (s.x02ApiKey?.trim() ? 'Uploading to your x02 account.' : 'Add your x02 API key to upload.'),
    request(file, s, { expiry }) {
      const form = new FormData();
      form.append('file', file, file.name);
      if (expiry) form.append('expiry', expiry);
      return { url: 'https://up.x02.me/api/upload?format=json', headers: { 'x-api-key': s.x02ApiKey.trim() }, form };
    },
    // The service downloads the file itself (images only, per x02's docs).
    async fromUrl(url, s, { expiry }) {
      const res = await fetch('https://up.x02.me/api/upload/url', {
        method: 'POST',
        headers: { 'x-api-key': s.x02ApiKey.trim(), 'content-type': 'application/json' },
        body: JSON.stringify({ imageUrl: url, ...(expiry ? { expiry } : {}) }),
      });
      const text = await res.text();
      const link = this.parse(res.status, text);
      const data = JSON.parse(text).data ?? {};
      return { url: link, size: data.sizeBytes ?? 0, name: data.originalFilename };
    },
    // The account's latest uploads, including ones made on the x02 website.
    async list(s) {
      // Page by page (the server may return fewer per page than asked).
      const uploads = [];
      for (let page = 1; uploads.length < HISTORY_MAX && page <= 10; page++) {
        const res = await fetch(`https://up.x02.me/api/user/dashboard?page=${page}&limit=${HISTORY_MAX}`, { headers: { 'x-api-key': s.x02ApiKey.trim() } });
        const body = await res.json().catch(() => null);
        if (!res.ok || !body?.success) throw new Error(body?.error || `HTTP ${res.status}`);
        uploads.push(...(body.data?.uploads ?? []));
        if (!body.data?.pagination?.hasNextPage || !body.data?.uploads?.length) break;
      }
      return uploads.slice(0, HISTORY_MAX).map((f) => ({
        url: f.url,
        name: f.originalName || f.filename,
        stored: f.filename,
        size: f.size ?? 0,
        at: Date.parse(f.timestamp) || 0,
      }));
    },
    // The account summary answers 401 to a key x02 doesn't know.
    async verify(key) {
      const res = await fetch('https://up.x02.me/api/user/dashboard?page=1&limit=1', { headers: { 'x-api-key': key } });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.success === false) throw new Error(body?.error || `HTTP ${res.status}`);
    },
    canDelete: (s) => Boolean(s.x02ApiKey?.trim()),
    async remove(entry, s) {
      const name = entry.stored || entry.url.split('/').pop();
      const res = await fetch(`https://up.x02.me/api/user/images/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'x-api-key': s.x02ApiKey.trim() } });
      const body = await res.json().catch(() => null);
      if (!res.ok || body?.success === false) throw new Error(body?.error || `HTTP ${res.status}`);
    },
    parse(status, text) {
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      if (status === 200 && body?.success && body.data?.url) return body.data.url;
      const why = body?.error || text.trim().slice(0, 200) || `HTTP ${status}`;
      if (status === 401 || status === 403) throw new Error(`x02 refused the API key or account: ${why}`);
      if (status === 413) throw new Error('Larger than your x02 plan allows.');
      if (status === 429) throw new Error(`x02 rate limit reached; try again in ${body?.retryAfter ?? 'a few'} seconds.`);
      throw new Error(`x02: ${why}`);
    },
  },
  catbox: {
    name: 'Catbox',
    icon: '/icons/uploads/catbox.png',
    maxBytes: 200 * MB,
    blocked: /\.(exe|scr|cpl|doc\w*|jar)$/i,
    rules: 'Up to 200 MB. Not allowed: .exe, .scr, .cpl, .doc*, .jar.',
    ready: () => true,
    hasAccount: (s) => Boolean(s.catboxUserhash?.trim()),
    mode: (s) => (s.catboxUserhash?.trim() ? 'Uploading to your Catbox account.' : 'Anonymous uploads. Add your userhash to use your account.'),
    request(file, s) {
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      if (s.catboxUserhash?.trim()) form.append('userhash', s.catboxUserhash.trim());
      form.append('fileToUpload', file, file.name);
      return { url: 'https://catbox.moe/user/api.php', headers: {}, form };
    },
    async fromUrl(url, s) {
      const form = new FormData();
      form.append('reqtype', 'urlupload');
      if (s.catboxUserhash?.trim()) form.append('userhash', s.catboxUserhash.trim());
      form.append('url', url);
      const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
      return { url: this.parse(res.status, await res.text()), size: 0 };
    },
    // Catbox can only delete files uploaded with the userhash.
    canDelete: (s, entry) => Boolean(s.catboxUserhash?.trim() && entry.account),
    async remove(entry, s) {
      const form = new FormData();
      form.append('reqtype', 'deletefiles');
      form.append('userhash', s.catboxUserhash.trim());
      form.append('files', entry.url.split('/').pop());
      const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
      const text = (await res.text()).trim();
      if (!res.ok || !/deleted/i.test(text)) throw new Error(text || `HTTP ${res.status}`);
    },
    parse(status, text) {
      const t = text.trim();
      if (status === 200 && /^https?:\/\//i.test(t)) return t;
      throw new Error(`Catbox: ${t.slice(0, 200) || `HTTP ${status}`}`);
    },
  },
  imglink: {
    name: 'ImgLink',
    icon: '/icons/uploads/imglink.png',
    maxBytes: 50 * MB,
    accepts: /\.(jpe?g|png|gif|webp|svg|bmp|ico|tiff?|avif)$/i,
    rules: 'Images only (JPG, PNG, GIF, WebP, SVG, BMP, ICO, TIFF, AVIF), up to 50 MB. Unlisted: only people with the link see them.',
    ready: () => true,
    hasAccount: (s) => Boolean(s.imglinkApiKey?.trim()),
    mode: (s) => (s.imglinkApiKey?.trim() ? 'Uploading to your ImgLink account.' : 'Anonymous uploads. Add your API key to use your account.'),
    request(file, s) {
      const key = s.imglinkApiKey?.trim();
      const form = new FormData();
      form.append('visibility', 'private');
      form.append('file', file, file.name);
      return { url: key ? 'https://imglink.cc/api/v1/upload' : 'https://imglink.cc/api/upload', headers: key ? { 'x-api-key': key } : {}, form };
    },
    // ImgLink can't fetch a link; this hands over to downloading it here.
    async fromUrl() {
      throw new Error("ImgLink can't fetch links itself.");
    },
    // Asks to change an image that doesn't exist: a good key gets "not found",
    // a bad one 401. Nothing is uploaded or changed.
    async verify(key) {
      const res = await fetch('https://imglink.cc/api/v1/image/keyCheck0', {
        method: 'PATCH',
        headers: { 'x-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({ nsfw: false }),
      });
      if (res.ok || res.status === 404) return;
      const body = await res.json().catch(() => null);
      throw new Error(res.status === 401 || res.status === 403 ? 'ImgLink says the key is invalid' : body?.error || `HTTP ${res.status}`);
    },
    // Only uploads made with the API key can be deleted, by anyone.
    canDelete: (s, entry) => Boolean(s.imglinkApiKey?.trim() && entry.account),
    async remove(entry, s) {
      const id = entry.url.split('/').pop().replace(/\.[^.]*$/, ''); // https://imglink.cc/cdn/<id>.<ext>
      const res = await fetch(`https://imglink.cc/api/v1/image/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-api-key': s.imglinkApiKey.trim() } });
      const body = await res.json().catch(() => null);
      if (!res.ok && res.status !== 404) throw new Error(body?.error || `HTTP ${res.status}`); // 404: already gone
    },
    parse(status, text) {
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      const url = body?.url || body?.images?.[0]?.url;
      if (status >= 200 && status < 300 && /^https:\/\//i.test(url ?? '')) return url;
      const why = body?.error || body?.message || text.trim().slice(0, 200) || `HTTP ${status}`;
      if (status === 401 || status === 403) throw new Error(`ImgLink refused the API key: ${why}`);
      if (status === 413) throw new Error('Too large for ImgLink, or your ImgLink storage is full.');
      if (status === 429) throw new Error('ImgLink upload limit reached; try again later.');
      throw new Error(`ImgLink: ${why}`);
    },
  },
};

// Why a file can't go to this service, or null.
export function refuse(service, file) {
  const u = UPLOADERS[service];
  if (u.blocked?.test(file.name) || (u.accepts && !u.accepts.test(file.name))) return `${u.name} doesn't accept this type of file.`;
  if (file.size > u.maxBytes) return `Larger than ${u.name}'s ${Math.round(u.maxBytes / MB)} MB limit.`;
  if (!file.size) return 'The file is empty.';
  return null;
}

// Uploads one file; onProgress(0..1). Resolves to the hosted URL.
export function uploadFile(service, file, settings, options = {}, onProgress = () => {}) {
  const u = UPLOADERS[service];
  const { url, headers, form } = u.request(file, settings, options);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      try {
        resolve(u.parse(xhr.status, xhr.responseText ?? ''));
      } catch (e) {
        reject(e);
      }
    };
    xhr.onerror = () => reject(new Error(`Couldn't reach ${u.name}. Check the connection.`));
    xhr.send(form);
  });
}

async function readHistory() {
  try {
    return (await chrome.storage.local.get(HISTORY_KEY))[HISTORY_KEY] ?? {};
  } catch {
    return {};
  }
}

async function addToHistory(service, entries) {
  const all = await readHistory();
  all[service] = [...entries, ...(all[service] ?? [])].slice(0, HISTORY_MAX);
  await chrome.storage.local.set({ [HISTORY_KEY]: all });
}


const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const formatSize = (n) => (n < 1024 ? `${n} B` : n < MB ? `${Math.round(n / 1024)} KB` : `${(n / MB).toFixed(1)} MB`);
const ICON = {
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/i;
const extOf = (name) => (/\.([a-z0-9]{1,5})$/i.exec(name ?? '')?.[1] ?? 'file').toUpperCase();

// Downloading a file in the app (when Catbox or x02 can't fetch a link, e.g.
// a site with an incomplete certificate chain, which Chrome copes with)
// needs access to all websites, an optional permission asked for once.
const ALL_SITES = { origins: ['<all_urls>'] };
const canDownloadHere = () => chrome.permissions.contains(ALL_SITES).catch(() => false);
const askDownloadHere = () => chrome.permissions.request(ALL_SITES).catch(() => false);

async function downloadHere(address, fallbackName) {
  const res = await fetch(address, { credentials: 'omit' });
  if (!res.ok) throw new Error(`The website refused the download (HTTP ${res.status}).`);
  const blob = await res.blob();
  const disposition = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
  let name = disposition ? decodeURIComponent(disposition) : fallbackName;
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += `.${(blob.type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '')}`;
  return new File([blob], name, { type: blob.type });
}

const isWebUrl = (s) => typeof s === 'string' && /^https?:\/\/\S+$/i.test(s);

// A readable name for a file fetched from a web address.
function nameFromUrl(address) {
  try {
    const last = decodeURIComponent(new URL(address).pathname.split('/').pop() || '');
    if (/\.[a-z0-9]{2,5}$/i.test(last) && last.length <= 120) return last;
  } catch {}
  return 'image-from-link';
}

// Chrome names every pasted picture "image.png"; give it a dated name.
function renamePasted(f) {
  if (f.name && f.name !== 'image.png') return f;
  const now = new Date();
  // e.g. 30-Sep-2026-5-06PM-42s (seconds keep quick pastes apart)
  const stamp = `${fmtDateTime(now).replace(/[\s:]+/g, '-')}-${String(now.getSeconds()).padStart(2, '0')}s`;
  const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
  return new File([f], `pasted-image-${stamp}.${ext}`, { type: f.type || 'image/png' });
}

// A small preview: the image itself, or a file tile with its extension.
// Small thumbnails of uploaded images, kept on this computer so previews show
// at once without downloading full-size files again: made from the local file
// right after an upload, otherwise from one download of the image.
const THUMBS_KEY = 'uploadThumbs';
const THUMBS_MAX = 300;
const THUMB_PX = 112; // a 48 px preview on a 2x screen, with room to spare
let thumbs = null; // url -> data: URL
const thumbFailed = new Set(); // not retried this session
async function loadThumbs() {
  try {
    thumbs ??= (await chrome.storage.local.get(THUMBS_KEY))[THUMBS_KEY] ?? {};
  } catch {
    thumbs ??= {};
  }
  return thumbs;
}
let thumbSaveTimer;
function saveThumbs() {
  clearTimeout(thumbSaveTimer);
  thumbSaveTimer = setTimeout(() => {
    const keys = Object.keys(thumbs);
    for (const k of keys.slice(0, Math.max(0, keys.length - THUMBS_MAX))) delete thumbs[k];
    chrome.storage.local.set({ [THUMBS_KEY]: thumbs }).catch(() => {});
  }, 500);
}
async function makeThumb(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(THUMB_PX, THUMB_PX);
  const k = Math.max(THUMB_PX / bmp.width, THUMB_PX / bmp.height); // fill the square, centred
  const w = bmp.width * k;
  const h = bmp.height * k;
  canvas.getContext('2d').drawImage(bmp, (THUMB_PX - w) / 2, (THUMB_PX - h) / 2, w, h);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(out);
  });
}
async function storeThumb(url, blob) {
  try {
    await loadThumbs();
    thumbs[url] = await makeThumb(blob);
    saveThumbs();
    return thumbs[url];
  } catch {
    thumbFailed.add(url);
    return null;
  }
}

function thumbHtml(name, src) {
  const tile = `<span class="up-tile">${ICON.file}<b>${esc(extOf(name))}</b></span>`;
  return src && IMAGE_EXT.test(name) ? `<span class="up-thumb"><img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">${tile}</span>` : `<span class="up-thumb">${tile}</span>`;
}

// The panel. panel: the (hidden) element it lives in; reader: the email view
// it replaces while open. getSettings() returns the current settings.
export function createUploadPanel({ panel, reader, getSettings, openSettings, toast, onToggle = () => {} }) {
  let service = null;
  const active = Object.fromEntries(Object.keys(UPLOADERS).map((k) => [k, []])); // uploads still running or failed in this tab
  const fresh = new Set(); // links uploaded in this tab (highlighted)
  const remote = { x02: null }; // the account's list as last fetched: { entries } | { error }
  let expiry = '';
  let shown = []; // the Recent uploads list on screen

  const rowActions = (e, canDelete) => `
    <button type="button" class="up-link" data-u="copy" data-url="${esc(e.url)}" title="Click to copy">${esc(e.url)}</button>
    <button type="button" class="up-icon" data-u="copy" data-url="${esc(e.url)}" title="Copy link">${ICON.copy}</button>
    <a class="up-icon" href="${esc(e.url)}" target="_blank" rel="noopener" title="Open in a new tab">${ICON.open}</a>
    ${canDelete ? `<button type="button" class="up-icon danger" data-u="delete" data-url="${esc(e.url)}" title="Delete from ${UPLOADERS[service].name}">${ICON.trash}</button>` : '<span class="up-icon" aria-hidden="true"></span>'}`;

  function activeRowHtml(r) {
    const tail = r.error ? `<span class="up-error">${esc(r.error)}</span>`
      : r.progress == null ? `<span class="up-bar busy"><i></i></span><span class="up-pct">${esc(r.status ?? 'Uploading…')}</span>`
      : `<span class="up-bar"><i style="width:${Math.round(r.progress * 100)}%"></i></span><span class="up-pct">${r.progress >= 1 ? 'Finishing…' : `${Math.round(r.progress * 100)}%`}</span>`;
    return `<li class="up-row${r.error ? ' failed' : ''}" data-row="${r.id}">${thumbHtml(r.name, r.preview)}
      <span class="up-file"><span class="up-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="up-meta">${r.size ? formatSize(r.size) : esc(r.source ?? '')}</span></span>
      <span class="up-result">${tail}${r.retryHere ? `<button type="button" class="up-here" data-u="download-here" data-row="${r.id}" title="Download the file in the app, then upload it">Download it here</button>` : ''}${r.error ? `<button type="button" class="up-icon" data-u="dismiss" data-row="${r.id}" title="Dismiss">${ICON.close}</button>` : ''}</span></li>`;
  }

  const expired = (h) => h.expiry && EXPIRY_MS[h.expiry] && Date.now() > h.at + EXPIRY_MS[h.expiry];
  // Makes missing thumbnails (three at a time) and shows them as they come.
  const thumbQueue = [];
  let thumbWorkers = 0;
  function requestThumb(url) {
    if (thumbFailed.has(url) || thumbQueue.includes(url)) return;
    thumbQueue.push(url);
    while (thumbWorkers < 3 && thumbQueue.length) {
      thumbWorkers++;
      (async () => {
        while (thumbQueue.length) {
          const next = thumbQueue.shift();
          if (thumbs?.[next] || thumbFailed.has(next)) continue;
          let src = null;
          try {
            const res = await fetch(next, { credentials: 'omit' });
            if (res.ok) src = await storeThumb(next, await res.blob());
            else thumbFailed.add(next);
          } catch {
            thumbFailed.add(next);
          }
          if (!src) continue;
          for (const el of panel.querySelectorAll('.up-thumb[data-thumb]')) {
            if (el.dataset.thumb === next && !el.querySelector('img')) el.insertAdjacentHTML('afterbegin', `<img src="${src}" alt="">`);
          }
        }
        thumbWorkers--;
      })();
    }
  }

  function entryRowHtml(e, s) {
    const meta = [e.size ? formatSize(e.size) : '', e.at ? fmtDateTime(e.at) : '', e.expiry ? (expired(e) ? 'expired' : `deletes after ${e.expiry}`) : ''].filter(Boolean).join(' · ');
    // The preview and the name open the file in the app's viewer.
    const view = `data-u="view" data-url="${esc(e.url)}" role="button" tabindex="0"`;
    const thumb = thumbs?.[e.url] ?? null;
    if (!thumb && IMAGE_EXT.test(e.name)) requestThumb(e.url);
    return `<li class="up-row${fresh.has(e.url) ? ' fresh' : ''}${expired(e) ? ' expired' : ''}">${thumbHtml(e.name, thumb).replace('<span class="up-thumb"', `<span class="up-thumb viewable" data-thumb="${esc(e.url)}" ${view} title="Open ${esc(e.name)}"`)}
      <span class="up-file"><span class="up-name viewable" ${view} title="Open ${esc(e.name)}">${esc(e.name)}</span><span class="up-meta">${esc(meta)}</span></span>
      <span class="up-result">${rowActions(e, UPLOADERS[service].canDelete(s, e))}</span></li>`;
  }

  // The list under "Recent uploads": x02's comes from the account (so it
  // includes uploads made elsewhere); Catbox and ImgLink have no such list, so
  // it is the uploads made here.
  async function entries(svc) {
    const local = ((await readHistory())[svc] ?? []).slice(0, HISTORY_MAX);
    if (svc !== 'x02' || !UPLOADERS.x02.ready(getSettings())) return { list: local };
    const r = remote.x02;
    if (!r) return { list: local, loading: true };
    if (r.error) return { list: local, error: r.error };
    // Keep what we know locally (expiry) for the same links, and show this
    // tab's uploads even if the account list doesn't have them yet.
    const byUrl = new Map(local.map((h) => [h.url, h]));
    const listed = new Set(r.entries.map((e) => e.url));
    const pending = local.filter((h) => fresh.has(h.url) && !listed.has(h.url));
    return { list: [...pending, ...r.entries.map((e) => ({ ...byUrl.get(e.url), ...e }))].slice(0, HISTORY_MAX) };
  }

  async function fetchRemote(svc) {
    if (svc !== 'x02' || !UPLOADERS.x02.ready(getSettings())) return;
    try {
      remote.x02 = { entries: await UPLOADERS.x02.list(getSettings()) };
    } catch (e) {
      remote.x02 = { ...(remote.x02 ?? {}), error: e.message };
    }
    if (service === svc) render();
  }

  let renderSeq = 0;
  async function render() {
    if (!service) return;
    const seq = ++renderSeq;
    const svc = service;
    const u = UPLOADERS[svc];
    const s = getSettings();
    await loadThumbs();
    const { list, loading, error } = await entries(svc);
    if (seq !== renderSeq || svc !== service) return;
    shown = list;
    const note = loading ? '<p class="up-empty">Loading your x02 uploads…</p>'
      : error ? `<p class="up-empty error">Couldn't load your x02 uploads (${esc(error)}). Showing the ones made here.</p>` : '';
    const listHtml = list.length ? `<ul class="up-list">${list.map((e) => entryRowHtml(e, s)).join('')}</ul>`
      : loading ? '' : `<p class="up-empty">${svc === 'x02' ? 'No uploads yet.' : 'Links you upload here stay listed (the last 100).'}</p>`;
    panel.innerHTML = `
      <div class="up-panel" data-service="${svc}">
        <header class="up-head">
          <img class="up-logo" src="${u.icon}" alt="">
          <div class="up-titles"><h2>Upload to ${u.name}</h2><p class="up-mode">${esc(u.mode(s))}${u.hasAccount(s) ? '' : ' <button type="button" class="link-btn" data-u="settings">Settings</button>'}</p></div>
          ${svc === 'x02' ? `<label class="up-expiry">Delete after <select data-u="expiry">
            ${[['', 'Never'], ['1h', '1 hour'], ['6h', '6 hours'], ['1d', '1 day'], ['7d', '7 days'], ['30d', '30 days']].map(([v, t]) => `<option value="${v}"${v === expiry ? ' selected' : ''}>${t}</option>`).join('')}
          </select></label>` : ''}
          <button type="button" class="up-close" data-u="close" title="Close (Esc)">${ICON.close}</button>
        </header>
        <div class="up-drop${u.ready(s) ? '' : ' disabled'}" data-u="choose" role="button" tabindex="0">
          ${ICON.upload}
          <p><strong>Drop files anywhere here</strong><br>or click to choose files, or paste a copied image or link (⌘V)</p>
          <p class="up-rules">${esc(u.rules)}</p>
          <input type="file" multiple hidden>
        </div>
        ${active[svc].length ? `<ul class="up-list">${active[svc].map(activeRowHtml).join('')}</ul>` : ''}
        <section class="up-history">
          <h3>Recent uploads
            ${svc === 'x02' && u.ready(s) ? `<button type="button" class="up-icon small" data-u="refresh" title="Reload from x02">${ICON.refresh}</button>`
              : ''}
          </h3>
          ${note}${listHtml}
        </section>
      </div>`;
  }

  // Updates one running upload in place (progress events are frequent).
  function renderRow(svc, r) {
    if (svc !== service) return;
    const li = panel.querySelector(`li[data-row="${r.id}"]`);
    if (li) li.outerHTML = activeRowHtml(r);
    else render();
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
      return true;
    } catch {
      toast("Couldn't copy automatically. Click the link to copy it.", { error: true });
      return false;
    }
  }

  // One upload each: a file, or a web address the service fetches itself
  // (with, for a pasted image, the pasted picture to fall back on).
  const fileJob = (f) => ({
    name: f.name, size: f.size, check: (svc) => refuse(svc, f),
    preview: IMAGE_EXT.test(f.name) && f.size < 50 * MB ? URL.createObjectURL(f) : null,
    run: (svc, s, options, onProgress) => uploadFile(svc, f, s, options, onProgress).then((url) => ({ url, thumbFrom: f })),
  });
  const urlJob = (address, fallback) => {
    const name = nameFromUrl(address);
    return {
      name,
      size: 0,
      source: fallback ? 'Copied image' : 'From a link',
      check: (svc) => (UPLOADERS[svc].blocked?.test(name) ? `${UPLOADERS[svc].name} doesn't accept this type of file.` : null),
      preview: fallback ? URL.createObjectURL(fallback) : IMAGE_EXT.test(name) ? address : null,
      async run(svc, s, options, onProgress, row) {
        row.progress = null;
        row.status = 'Fetching the original…';
        onProgress(null);
        try {
          const got = await UPLOADERS[svc].fromUrl(address, s, options);
          return { url: got.url, size: got.size, name: got.name || name };
        } catch (e) {
          // The service couldn't fetch it: download it here, if allowed.
          if (await canDownloadHere()) {
            try {
              return await downloadThenUpload(svc, s, options, onProgress, row, address, name);
            } catch (e2) {
              if (!fallback) throw e2;
            }
          }
          if (!fallback) {
            e.retryHere = address; // the row offers "Download it here"
            throw e;
          }
          // Upload the pasted picture instead.
          row.name = fallback.name;
          row.size = fallback.size;
          row.progress = 0;
          const url = await uploadFile(svc, fallback, s, options, onProgress);
          return { url, name: fallback.name, size: fallback.size, thumbFrom: fallback };
        }
      },
    };
  };

  async function downloadThenUpload(svc, s, options, onProgress, row, address, name) {
    row.progress = null;
    row.status = 'Downloading from the website…';
    onProgress(null);
    const file = await downloadHere(address, name);
    const refused = refuse(svc, file);
    if (refused) throw new Error(refused);
    row.name = file.name;
    row.size = file.size;
    row.progress = 0;
    const url = await uploadFile(svc, file, s, options, onProgress);
    return { url, name: file.name, size: file.size, thumbFrom: file };
  }
  const hereJob = (address) => ({
    name: nameFromUrl(address), size: 0, source: 'From a link', check: () => null,
    preview: IMAGE_EXT.test(nameFromUrl(address)) ? address : null,
    run: (svc, s, options, onProgress, row) => downloadThenUpload(svc, s, options, onProgress, row, address, nameFromUrl(address)),
  });

  function uploadAll(files) {
    return runJobs([...files].map(fileJob));
  }

  let nextId = 1;
  async function runJobs(jobs) {
    const svc = service;
    const s = getSettings();
    if (!svc || !UPLOADERS[svc].ready(s) || !jobs.length) return;
    const rows = jobs.map((j) => ({ id: nextId++, job: j, name: j.name, size: j.size, source: j.source, preview: j.preview, progress: 0, error: j.check(svc) }));
    active[svc].unshift(...rows); // newest drop first, in the order dropped
    await render();
    const options = { expiry: svc === 'x02' ? expiry : '' };
    const queue = rows.filter((r) => !r.error);
    const done = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (next < queue.length) {
        const r = queue[next++];
        let last = 0;
        const onProgress = (p) => {
          if (p == null) return renderRow(svc, r);
          r.progress = p;
          if (p - last >= 0.02 || p === 1) {
            last = p;
            renderRow(svc, r);
          }
        };
        try {
          const got = await r.job.run(svc, s, options, onProgress, r);
          done.push({ order: r.id, url: got.url, name: got.name ?? r.name, size: got.size ?? r.size, at: Date.now(), ...(options.expiry ? { expiry: options.expiry } : {}), ...(svc !== 'x02' && UPLOADERS[svc].hasAccount(s) ? { account: true } : {}) });
          active[svc] = active[svc].filter((x) => x !== r); // it moves to the list below
          fresh.add(got.url);
          if (got.thumbFrom && IMAGE_EXT.test(got.name ?? r.name)) await storeThumb(got.url, got.thumbFrom);
        } catch (e) {
          r.error = e.message;
          r.retryHere = e.retryHere ?? null;
        }
        r.job = null;
        // (later, so a preview still loading isn't cut off)
        if (r.preview?.startsWith('blob:')) setTimeout(URL.revokeObjectURL, 10000, r.preview);
        r.preview = null;
        renderRow(svc, r);
      }
    }));
    if (!done.length) return;
    // Drop order, in the list and the clipboard (two upload at a time).
    done.sort((a, b) => a.order - b.order);
    await addToHistory(svc, done.map(({ order, ...d }) => d));
    await copy(done.map((d) => d.url).join('\n'), done.length > 1 ? `${done.length} links` : 'Link');
    await fetchRemote(svc);
    await render();
  }

  // Cmd+V while the panel is open: a copied image (the original file from its
  // address when the service can fetch it, else the pasted picture), a
  // screenshot, or a copied link. Pasting into a text field stays a paste.
  function onPaste(e) {
    if (!service || e.target.closest?.('input, textarea, select, [contenteditable="true"], .compose, dialog')) return;
    const data = e.clipboardData;
    if (!data) return;
    e.preventDefault();
    if (!UPLOADERS[service].ready(getSettings())) {
      toast(`Add your ${UPLOADERS[service].name} API key in Settings first.`, { error: true });
      return;
    }
    const files = [...data.files].map(renamePasted);
    const html = data.getData('text/html');
    const src = html ? new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src') : null;
    const text = data.getData('text/plain').trim();
    const jobs = [];
    if (files.length === 1 && isWebUrl(src)) jobs.push(urlJob(src, files[0]));
    else if (files.length) jobs.push(...files.map(fileJob));
    else if (isWebUrl(src)) jobs.push(urlJob(src));
    else if (isWebUrl(text)) jobs.push(urlJob(text));
    if (!jobs.length) {
      toast('Nothing to upload on the clipboard. Copy an image, a link to a file, or a screenshot first.', { error: true });
      return;
    }
    runJobs(jobs);
  }
  document.addEventListener('paste', onPaste);

  async function removeEntry(url) {
    const svc = service;
    const { list } = await entries(svc);
    const entry = list.find((e) => e.url === url);
    if (!entry) return;
    if (!confirm(`Delete ${entry.name} from ${UPLOADERS[svc].name}? The link stops working. This can't be undone.`)) return;
    try {
      await UPLOADERS[svc].remove(entry, getSettings());
    } catch (e) {
      toast(`Couldn't delete: ${e.message}`, { error: true });
      return;
    }
    const all = await readHistory();
    all[svc] = (all[svc] ?? []).filter((h) => h.url !== url);
    await chrome.storage.local.set({ [HISTORY_KEY]: all });
    if (remote[svc]?.entries) remote[svc].entries = remote[svc].entries.filter((e) => e.url !== url);
    if (thumbs?.[url]) {
      delete thumbs[url];
      saveThumbs();
    }
    toast(`Deleted ${entry.name}`);
    render();
  }

  // Opens an upload in the app's viewer; the arrows move through the list.
  function view(url) {
    const index = shown.findIndex((e) => e.url === url);
    if (index === -1) return;
    openViewer(
      shown.map((e) => ({
        filename: e.name,
        mimeType: '',
        size: e.size || 0,
        async load() {
          const res = await fetch(e.url, { credentials: 'omit' });
          if (!res.ok) throw new Error(`${UPLOADERS[service]?.name ?? 'The service'} returned HTTP ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        },
      })),
      {
        index,
        onDownload: (file, bytes) => {
          const href = URL.createObjectURL(new Blob([bytes]));
          Object.assign(document.createElement('a'), { href, download: file.filename }).click();
          setTimeout(() => URL.revokeObjectURL(href), 60000);
        },
      },
    );
  }

  const uploading = () => Object.values(active).flat().some((r) => !r.error);

  panel.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-u]');
    if (!el) return;
    const act = el.dataset.u;
    if (act === 'close') close();
    else if (act === 'settings') {
      e.stopPropagation(); // the page closes menus on outside clicks
      openSettings();
    } else if (act === 'copy') copy(el.dataset.url, 'Link');
    else if (act === 'view') view(el.dataset.url);
    else if (act === 'delete') removeEntry(el.dataset.url);
    else if (act === 'refresh') {
      remote.x02 = null;
      render();
      fetchRemote('x02');
    } else if (act === 'download-here') {
      const row = active[service].find((r) => String(r.id) === el.dataset.row);
      if (!row?.retryHere) return;
      if (!(await askDownloadHere())) {
        toast('Not allowed, so the file can only be uploaded by dragging it here.', { error: true });
        return;
      }
      active[service] = active[service].filter((r) => r !== row);
      runJobs([hereJob(row.retryHere)]);
    } else if (act === 'dismiss') {
      active[service] = active[service].filter((r) => String(r.id) !== el.dataset.row);
      render();
    } else if (act === 'choose' && !el.classList.contains('disabled') && !e.target.closest('input')) {
      el.querySelector('input[type="file"]').click();
    }
  });
  // A preview that can't load (private file, not an image after all) falls
  // back to the file tile.
  panel.addEventListener('error', (e) => {
    if (e.target.matches?.('.up-thumb img')) e.target.remove();
  }, true);
  panel.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.viewable')) {
      e.preventDefault();
      view(e.target.dataset.url);
    } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.up-drop')) {
      e.preventDefault();
      e.target.click();
    }
  });
  panel.addEventListener('change', (e) => {
    if (e.target.matches('select[data-u="expiry"]')) expiry = e.target.value;
    else if (e.target.matches('input[type="file"]') && e.target.files.length) uploadAll(e.target.files);
  });
  // The whole panel is the drop zone.
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  panel.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    panel.classList.add('dragging');
  });
  panel.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = UPLOADERS[service]?.ready(getSettings()) ? 'copy' : 'none';
  });
  panel.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      panel.classList.remove('dragging');
    }
  });
  panel.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    panel.classList.remove('dragging');
    if (e.dataTransfer.files.length) uploadAll(e.dataTransfer.files);
  });
  addEventListener('beforeunload', (e) => {
    if (uploading()) e.preventDefault();
  });

  function open(svc) {
    service = svc;
    reader.hidden = true;
    panel.hidden = false;
    render();
    fetchRemote(svc); // the x02 list may have changed on the website
    onToggle(service);
  }
  function close() {
    if (!service) return;
    service = null;
    panel.hidden = true;
    reader.hidden = false;
    onToggle(null);
  }
  return {
    open,
    close,
    toggle: (svc) => (service === svc ? close() : open(svc)),
    current: () => service,
    refresh: () => {
      if (!service) return;
      remote.x02 = null; // the key may have changed
      render();
      fetchRemote(service);
    },
  };
}
