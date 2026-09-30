// Attachment viewer: PDFs (with password), Word (.docx), Excel (.xlsx), CSV,
// images and text open in a full-window overlay with Download and Print.
//
// Untrusted content is kept inert:
//   * PDFs are drawn onto canvases by PDF.js with its scripting off.
//   * Word and Excel are converted to HTML, sanitised with DOMPurify and shown
//     in a sandboxed iframe that cannot run scripts or load anything remote.

import DOMPurify from '../vendor/purify.es.mjs';

const VENDOR = chrome.runtime.getURL('src/vendor/');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  print: svg('<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  zoomIn: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>'),
  zoomOut: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M8 11h6"/>'),
  lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
};

// Which viewer handles a file, from its type or name; null = download only.
export function viewerKind(filename = '', mimeType = '') {
  const ext = filename.toLowerCase().split('.').pop();
  const type = mimeType.toLowerCase();
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ext === 'docx' || type.includes('wordprocessingml')) return 'docx';
  if (ext === 'xlsx' || type.includes('spreadsheetml')) return 'xlsx';
  if (ext === 'csv' || type === 'text/csv') return 'csv';
  if (/^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/.test(type) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return 'image';
  if (type.startsWith('text/') || ['txt', 'log', 'md', 'json', 'xml', 'ics', 'vcf'].includes(ext)) return 'text';
  return null;
}

let current = null; // { close }

// file: { filename, mimeType, bytes: Uint8Array }; onDownload(): save it.
export async function openViewer(file, { onDownload } = {}) {
  current?.close();
  const kind = viewerKind(file.filename, file.mimeType);
  const overlay = document.createElement('div');
  overlay.className = 'viewer';
  overlay.innerHTML = `
    <div class="viewer-bar">
      <span class="viewer-name" title="${esc(file.filename)}">${esc(file.filename)}</span>
      <span class="viewer-pages"></span>
      <span class="viewer-spacer"></span>
      <span class="viewer-zoom" hidden>
        <button class="viewer-btn" data-v="zoom-out" title="Zoom out">${ICON.zoomOut}</button>
        <button class="viewer-btn" data-v="zoom-in" title="Zoom in">${ICON.zoomIn}</button>
      </span>
      <button class="viewer-btn" data-v="download" title="Download">${ICON.download}</button>
      <button class="viewer-btn" data-v="print" title="Print (⌘P)" disabled>${ICON.print}</button>
      <button class="viewer-btn" data-v="close" title="Close (Esc)">${ICON.close}</button>
    </div>
    <div class="viewer-body"><div class="viewer-status">Opening…</div></div>`;
  document.body.appendChild(overlay);
  const body = overlay.querySelector('.viewer-body');
  const printBtn = overlay.querySelector('[data-v="print"]');
  let printer = null; // () => Promise<void>, set once the file is shown
  let zoomBy = null;
  let cleanup = () => {};

  const close = () => {
    try {
      cleanup();
    } catch (e) {
      console.warn('[viewer] cleanup', e);
    }
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (current?.overlay === overlay) current = null;
  };
  const doPrint = () => printer && printer().catch((e) => showStatus(body, `Couldn't print: ${e.message}`, true));
  function onKey(e) {
    if (e.key === 'Escape' && !e.target.closest?.('.viewer-password')) close();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      doPrint();
    }
  }
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    if (b.dataset.v === 'close') close();
    else if (b.dataset.v === 'download') onDownload?.();
    else if (b.dataset.v === 'print') doPrint();
    else if (b.dataset.v === 'zoom-in') zoomBy?.(1.2);
    else if (b.dataset.v === 'zoom-out') zoomBy?.(1 / 1.2);
  });
  current = { close, overlay };

  const ready = (result) => {
    printer = result.print;
    zoomBy = result.zoom ?? null;
    cleanup = result.cleanup ?? cleanup;
    printBtn.disabled = !printer;
    overlay.querySelector('.viewer-zoom').hidden = !zoomBy;
  };
  try {
    if (kind === 'pdf') await showPdf(file, body, overlay, ready);
    else if (kind === 'docx') ready(await showDocx(file, body));
    else if (kind === 'xlsx') ready(await showXlsx(file, body));
    else if (kind === 'csv') ready(showHtml(body, file.filename, tableHtml(parseCsv(new TextDecoder().decode(file.bytes)))));
    else if (kind === 'image') ready(showImage(file, body));
    else if (kind === 'text') ready(showHtml(body, file.filename, `<pre class="plain">${esc(new TextDecoder().decode(file.bytes))}</pre>`));
    else showStatus(body, 'This file type can’t be previewed. Use Download to open it.');
  } catch (e) {
    console.warn('[viewer]', e);
    showStatus(body, `Couldn't open this file: ${e.message}`, true);
  }
  return { close };
}

function showStatus(body, text, error = false) {
  body.innerHTML = `<div class="viewer-status${error ? ' error' : ''}">${esc(text)}</div>`;
}

// ---------- PDF ----------

let pdfjs = null;
async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = `${VENDOR}pdfjs/pdf.worker.min.mjs`;
  }
  return pdfjs;
}

async function showPdf(file, body, overlay, ready) {
  const lib = await loadPdfJs();
  const task = lib.getDocument({
    data: file.bytes.slice(), // PDF.js takes ownership of the buffer
    standardFontDataUrl: `${VENDOR}pdfjs/standard_fonts/`,
    cMapUrl: `${VENDOR}pdfjs/cmaps/`,
    cMapPacked: true,
    wasmUrl: `${VENDOR}pdfjs/wasm/`,
    iccUrl: `${VENDOR}pdfjs/iccs/`,
    isEvalSupported: false,
    enableScripting: false,
    enableXfa: false,
  });
  // Password-protected PDFs (bank statements): ask in place, retry on a wrong one.
  task.onPassword = (update, reason) => {
    const wrong = reason === lib.PasswordResponses.INCORRECT_PASSWORD;
    body.innerHTML = `<form class="viewer-password">
        <div class="viewer-lock">${ICON.lock}</div>
        <p><strong>This PDF is password-protected.</strong><br>Enter its password to open it.</p>
        <input type="password" autocomplete="off" spellcheck="false" placeholder="Password" aria-label="PDF password">
        ${wrong ? '<p class="viewer-error">That password is incorrect. Try again.</p>' : ''}
        <button type="submit" class="tool-btn primary">Open</button>
      </form>`;
    const form = body.querySelector('form');
    form.querySelector('input').focus();
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const pw = form.querySelector('input').value;
      body.innerHTML = '<div class="viewer-status">Opening…</div>';
      update(pw);
    });
  };
  const pdf = await task.promise;
  const pagesEl = overlay.querySelector('.viewer-pages');
  body.innerHTML = '<div class="pdf-pages"></div>';
  const wrap = body.querySelector('.pdf-pages');
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) pages.push(await pdf.getPage(n));

  // Fit the page width to the viewer by default.
  const firstWidth = pages[0].getViewport({ scale: 1 }).width;
  let scale = Math.min(2, Math.max(0.5, Math.min(body.clientWidth - 48, 900) / firstWidth));
  const rendered = new Map(); // page number -> scale it was drawn at
  const slots = pages.map((page, i) => {
    const slot = document.createElement('div');
    slot.className = 'pdf-page';
    slot.dataset.n = String(i + 1);
    wrap.appendChild(slot);
    return slot;
  });
  const layout = () => {
    pages.forEach((page, i) => {
      const vp = page.getViewport({ scale });
      slots[i].style.width = `${vp.width}px`;
      slots[i].style.height = `${vp.height}px`;
    });
  };
  const draw = async (i) => {
    if (rendered.get(i) === scale) return;
    rendered.set(i, scale);
    const vp = pages[i].getViewport({ scale: scale * devicePixelRatio });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    await pages[i].render({ canvas, viewport: vp }).promise;
    slots[i].replaceChildren(canvas);
  };
  // Draw pages as they scroll into view.
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) draw(Number(en.target.dataset.n) - 1).catch((e) => console.warn('[viewer] page', e));
    const visible = entries.filter((en) => en.isIntersecting).map((en) => Number(en.target.dataset.n));
    if (visible.length) pagesEl.textContent = `Page ${Math.min(...visible)} of ${pdf.numPages}`;
  }, { root: body, rootMargin: '400px 0px' });
  layout();
  slots.forEach((s) => io.observe(s));
  pagesEl.textContent = `${pdf.numPages} page${pdf.numPages > 1 ? 's' : ''}`;

  ready({
    zoom: (factor) => {
      scale = Math.min(4, Math.max(0.3, scale * factor));
      layout();
      rendered.clear();
      slots.forEach((s, i) => {
        const r = s.getBoundingClientRect();
        if (r.bottom > -400 && r.top < innerHeight + 400) draw(i).catch(() => {});
      });
    },
    // Every page at print resolution, then the system print dialog.
    print: async () => {
      const images = [];
      for (const page of pages) {
        const vp = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width;
        canvas.height = vp.height;
        await page.render({ canvas, viewport: vp }).promise;
        const base = page.getViewport({ scale: 1 });
        images.push({ url: canvas.toDataURL('image/png'), w: base.width, h: base.height });
      }
      await printDocument(images.map((im) => `<div class="pg"><img src="${im.url}" style="width:${im.w}pt;height:${im.h}pt"></div>`).join(''),
        '@page { margin: 0; } body { margin: 0; } .pg { page-break-after: always; break-after: page; } .pg:last-child { page-break-after: auto; } img { display: block; }');
    },
    cleanup: () => {
      io.disconnect();
      task.destroy();
    },
  });
}

// ---------- Word ----------

let officeLoaded = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}
function loadOffice() {
  officeLoaded ??= (async () => {
    await loadScript(`${VENDOR}office/jszip.min.js`);
    await loadScript(`${VENDOR}office/docx-preview.min.js`);
    await loadScript(`${VENDOR}office/read-excel-file.min.js`);
  })();
  return officeLoaded;
}

async function showDocx(file, body) {
  await loadOffice();
  // Rendered off-screen, then sanitised and shown in a sandboxed frame.
  const staging = document.createElement('div');
  const styles = document.createElement('div');
  await window.docx.renderAsync(new Blob([file.bytes]), staging, styles, {
    inWrapper: true,
    breakPages: true,
    useBase64URL: true, // images as data: URLs, which the frame allows
    renderHeaders: true,
    renderFooters: true,
    experimental: false,
  });
  const html = styles.innerHTML + staging.innerHTML;
  return showHtml(body, file.filename, html, { page: true });
}

// ---------- Excel / CSV ----------

async function showXlsx(file, body) {
  await loadOffice();
  const blob = new Blob([file.bytes]);
  // read-excel-file 9: every sheet at once, as [{ sheet, data: rows }].
  const tables = (await window.readXlsxFile(blob)).map(({ sheet, data }) => ({ name: sheet, rows: data ?? [] }));
  const tabs = tables.length > 1
    ? `<nav class="tabs">${tables.map((t, i) => `<a href="#s${i}">${esc(t.name)}</a>`).join('')}</nav>` : '';
  const html = tabs + tables.map((t, i) =>
    `<section id="s${i}">${tables.length > 1 ? `<h3>${esc(t.name)}</h3>` : ''}${tableHtml(t.rows)}</section>`).join('');
  return showHtml(body, file.filename, html);
}

const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return isNaN(v) ? '' : v.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 10 });
  return String(v);
};

function tableHtml(rows) {
  if (!rows.length) return '<p class="empty">This sheet is empty.</p>';
  const width = Math.max(...rows.map((r) => r.length));
  const col = (n) => { let s = ''; n++; while (n) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
  return `<table><thead><tr><th></th>${Array.from({ length: width }, (_, i) => `<th>${col(i)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r, i) => `<tr><th>${i + 1}</th>${Array.from({ length: width }, (_, j) => {
      const v = r[j];
      return `<td${typeof v === 'number' ? ' class="num"' : ''}>${esc(cellText(v))}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table>`;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- images ----------

function showImage(file, body) {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType || 'image/png' }));
  body.innerHTML = `<div class="image-wrap"><img alt="${esc(file.filename)}"></div>`;
  const img = body.querySelector('img');
  img.src = url;
  let scale = 1;
  return {
    zoom: (f) => {
      scale = Math.min(8, Math.max(0.1, scale * f));
      img.style.maxWidth = 'none';
      img.style.width = `${img.naturalWidth * scale}px`;
    },
    print: () => printDocument(`<img src="${url}">`, 'img { max-width: 100%; }'),
    cleanup: () => URL.revokeObjectURL(url),
  };
}

// ---------- shared: sanitised HTML in a sandboxed frame ----------

const DOC_STYLE = `
  body { margin: 0; padding: 20px; background: #f1f3f4; color: #202124; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  table { border-collapse: collapse; background: #fff; margin: 0 0 24px; font-size: 12px; }
  th, td { border: 1px solid #dadce0; padding: 3px 8px; white-space: nowrap; text-align: left; vertical-align: top; }
  thead th, tbody th { background: #f8f9fa; color: #5f6368; font-weight: 500; position: sticky; }
  thead th { top: 0; } tbody th { left: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  h3 { margin: 8px 0; font-size: 13px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
  .tabs a { padding: 3px 10px; border-radius: 999px; background: #fff; border: 1px solid #dadce0; color: #202124; text-decoration: none; }
  pre.plain { margin: 0; padding: 16px; background: #fff; white-space: pre-wrap; font: 12px/1.5 ui-monospace, Menlo, monospace; }
  .empty { color: #5f6368; }
  .docx-wrapper { background: transparent !important; padding: 0 !important; }
  .docx-wrapper > section.docx { box-shadow: 0 1px 4px rgba(0,0,0,.2); margin: 0 auto 20px !important; }
  img { max-width: 100%; }
  @media print { body { background: #fff; padding: 0; } .tabs { display: none; } .docx-wrapper > section.docx { box-shadow: none; margin: 0 !important; } }
`;
const FRAME_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:">`;

function sanitize(html) {
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['style'],
    FORCE_BODY: true,
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'base', 'meta', 'link', 'script', 'iframe', 'object', 'embed'],
  });
}

function frameDoc(html) {
  return `<!doctype html><html><head><meta charset="utf-8">${FRAME_CSP}<style>${DOC_STYLE}</style></head><body>${html}</body></html>`;
}

function showHtml(body, title, html) {
  const clean = sanitize(html);
  body.innerHTML = '<iframe class="viewer-frame" sandbox referrerpolicy="no-referrer"></iframe>';
  body.querySelector('iframe').srcdoc = frameDoc(clean);
  body.querySelector('iframe').title = title;
  return { print: () => printDocument(clean, DOC_STYLE) };
}

// Prints HTML through a hidden frame (same origin so it can be printed;
// scripts stay blocked by the extension's CSP and the frame's own CSP).
function printDocument(html, style) {
  return new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(frame);
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">${FRAME_CSP}<style>${style}</style></head><body>${html}</body></html>`;
    frame.onload = () => {
      const imgs = [...frame.contentDocument.images];
      Promise.all(imgs.map((im) => (im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; })))).then(() => {
        frame.contentWindow.focus();
        frame.contentWindow.print();
        // Give the keyboard back to the viewer (Esc, ⌘P again).
        window.focus();
        setTimeout(() => frame.remove(), 1000);
        resolve();
      });
    };
  });
}
