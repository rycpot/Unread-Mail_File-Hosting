// File uploads to Catbox (catbox.moe) and x02 (x02.me), an independent module
// of the app: the rail icons open a panel in place of the email view; any
// files dropped on it (or chosen) are uploaded one link each, the links are
// shown and copied to the clipboard, and the last 20 per service are kept on
// this computer.
//
// Catbox: POST https://catbox.moe/user/api.php, multipart reqtype=fileupload,
// fileToUpload, and userhash when set (else anonymous); the reply is the URL
// as plain text. 200 MB; .exe .scr .cpl .doc* .jar are refused.
// x02: POST https://up.x02.me/api/upload?format=json with an x-api-key header
// and one "file" field (optional "expiry": 1h 6h 1d 7d 30d); the reply is
// { success, data: { url, … } } or { success: false, error }. 200 MB on the
// Free plan, 512 MB on Pro (the server says which).

import { fmtDateTime } from './format.js';

const MB = 1024 * 1024;
const HISTORY_KEY = 'uploadHistory';
const HISTORY_MAX = 20;
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
    parse(status, text) {
      const t = text.trim();
      if (status === 200 && /^https?:\/\//i.test(t)) return t;
      throw new Error(`Catbox: ${t.slice(0, 200) || `HTTP ${status}`}`);
    },
  },
};

// Why a file can't go to this service, or null.
export function refuse(service, file) {
  const u = UPLOADERS[service];
  if (u.blocked?.test(file.name)) return `${u.name} doesn't accept this type of file.`;
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

async function clearHistory(service) {
  const all = await readHistory();
  delete all[service];
  await chrome.storage.local.set({ [HISTORY_KEY]: all });
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const formatSize = (n) => (n < 1024 ? `${n} B` : n < MB ? `${Math.round(n / 1024)} KB` : `${(n / MB).toFixed(1)} MB`);
const ICON = {
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

// The panel. panel: the (hidden) element it lives in; reader: the email view
// it replaces while open. getSettings() returns the current settings.
export function createUploadPanel({ panel, reader, getSettings, openSettings, toast, onToggle = () => {} }) {
  let service = null;
  const batches = { x02: [], catbox: [] }; // this tab's uploads, newest first
  let expiry = '';

  const linkHtml = (url) => `<button type="button" class="up-link" data-u="copy" data-url="${esc(url)}" title="Click to copy">${esc(url)}</button>
    <a class="up-open" href="${esc(url)}" target="_blank" rel="noopener" title="Open in a new tab">${ICON.open}</a>`;

  function rowHtml(r) {
    const tail = r.url ? linkHtml(r.url)
      : r.error ? `<span class="up-error">${esc(r.error)}</span>`
      : `<span class="up-bar"><i style="width:${Math.round(r.progress * 100)}%"></i></span><span class="up-pct">${r.progress >= 1 ? 'Finishing…' : `${Math.round(r.progress * 100)}%`}</span>`;
    return `<li class="up-row${r.error ? ' failed' : ''}" data-row="${r.id}"><span class="up-file"><span class="up-name" title="${esc(r.name)}">${esc(r.name)}</span><span class="up-size">${formatSize(r.size)}</span></span><span class="up-result">${tail}</span></li>`;
  }

  async function render() {
    if (!service) return;
    const u = UPLOADERS[service];
    const s = getSettings();
    const history = (await readHistory())[service] ?? [];
    const shownNow = new Set(batches[service].map((r) => r.url).filter(Boolean));
    const past = history.filter((h) => !shownNow.has(h.url));
    const expired = (h) => h.expiry && EXPIRY_MS[h.expiry] && Date.now() > h.at + EXPIRY_MS[h.expiry];
    panel.innerHTML = `
      <div class="up-panel" data-service="${service}">
        <header class="up-head">
          <img class="up-logo" src="${u.icon}" alt="">
          <div class="up-titles"><h2>Upload to ${u.name}</h2><p class="up-mode">${esc(u.mode(s))}${u.hasAccount(s) ? '' : ' <button type="button" class="link-btn" data-u="settings">Settings</button>'}</p></div>
          ${service === 'x02' ? `<label class="up-expiry">Delete after <select data-u="expiry">
            ${[['', 'Never'], ['1h', '1 hour'], ['6h', '6 hours'], ['1d', '1 day'], ['7d', '7 days'], ['30d', '30 days']].map(([v, t]) => `<option value="${v}"${v === expiry ? ' selected' : ''}>${t}</option>`).join('')}
          </select></label>` : ''}
          <button type="button" class="up-close" data-u="close" title="Close (Esc)">${ICON.close}</button>
        </header>
        <div class="up-drop${u.ready(s) ? '' : ' disabled'}" data-u="choose" role="button" tabindex="0">
          ${ICON.upload}
          <p><strong>Drop files anywhere here</strong><br>or click to choose files</p>
          <p class="up-rules">${esc(u.rules)}</p>
          <input type="file" multiple hidden>
        </div>
        ${batches[service].length ? `<ul class="up-list">${batches[service].map(rowHtml).join('')}</ul>` : ''}
        <section class="up-history">
          <h3>Recent uploads${past.length ? ' <button type="button" class="link-btn" data-u="clear">Clear</button>' : ''}</h3>
          ${past.length ? `<ul class="up-list">${past.map((h) => `<li class="up-row${expired(h) ? ' expired' : ''}"><span class="up-file"><span class="up-name" title="${esc(h.name)}">${esc(h.name)}</span><span class="up-size">${formatSize(h.size)} · ${fmtDateTime(h.at)}${h.expiry ? ` · ${expired(h) ? 'expired' : `deletes after ${h.expiry}`}` : ''}</span></span><span class="up-result">${linkHtml(h.url)}</span></li>`).join('')}</ul>`
            : '<p class="up-empty">Links you upload here stay listed (the last 20).</p>'}
        </section>
      </div>`;
  }

  // Updates one row in place (progress events are frequent).
  function renderRow(svc, r) {
    if (svc !== service) return;
    const li = panel.querySelector(`[data-row="${r.id}"]`);
    if (li) li.outerHTML = rowHtml(r);
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

  let nextId = 1;
  async function uploadAll(files) {
    const svc = service;
    const s = getSettings();
    if (!svc || !UPLOADERS[svc].ready(s)) return;
    const rows = [...files].map((f) => ({ id: nextId++, file: f, name: f.name, size: f.size, progress: 0, url: null, error: refuse(svc, f) }));
    batches[svc].unshift(...rows); // newest drop first, in the order dropped
    await render();
    const options = { expiry: svc === 'x02' ? expiry : '' };
    const queue = rows.filter((r) => !r.error);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (next < queue.length) {
        const r = queue[next++];
        let last = 0;
        try {
          r.url = await uploadFile(svc, r.file, s, options, (p) => {
            r.progress = p;
            if (p - last >= 0.02 || p === 1) {
              last = p;
              renderRow(svc, r);
            }
          });
        } catch (e) {
          r.error = e.message;
        }
        r.file = null;
        renderRow(svc, r);
      }
    }));
    const done = rows.filter((r) => r.url);
    if (!done.length) return;
    await addToHistory(svc, done.map((r) => ({ url: r.url, name: r.name, size: r.size, at: Date.now(), ...(options.expiry ? { expiry: options.expiry } : {}) })));
    await copy(done.map((r) => r.url).join('\n'), done.length > 1 ? `${done.length} links` : 'Link');
    await render();
  }

  const uploading = () => Object.values(batches).flat().some((r) => !r.url && !r.error);

  panel.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-u]');
    if (!el) return;
    const act = el.dataset.u;
    if (act === 'close') close();
    else if (act === 'settings') {
      e.stopPropagation(); // the page closes menus on outside clicks
      openSettings();
    }
    else if (act === 'copy') copy(el.dataset.url, 'Link');
    else if (act === 'clear') {
      await clearHistory(service);
      render();
    } else if (act === 'choose' && !el.classList.contains('disabled') && !e.target.closest('input')) {
      el.querySelector('input[type="file"]').click();
    }
  });
  panel.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.up-drop')) {
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
    refresh: () => render(),
  };
}
