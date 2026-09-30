// The compose window: new email, reply, reply all, forward and saved drafts.
//
// A floating window at the bottom right that can be expanded to fill the
// app. The editor is an iframe of its own, so the app's styles and a quoted
// email's styles cannot affect each other. Emails go out without a font of
// their own (each reader's mail app shows them in its default font); only
// formatting you add is sent.
//
// Drafts save to the account's Drafts folder about two seconds after you stop
// typing (every 30 s while large attachments are attached) and when the
// window closes. Send saves a last time, prepares the email, and hands it to
// the background, which sends it after the undo delay (see background.js).

import DOMPurify from '../vendor/purify.es.mjs';
import { providers } from '../providers/index.js';
import { signIn, saveToken } from '../auth.js';
import { newMessageId, replyReferences } from '../compose/mime.js';
import { parseAddressList } from '../util.js';
import { rememberAddresses, suggest } from './contacts.js';
import { uiIcons } from './ui-icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  expand: svg('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>'),
  shrink: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
  minimize: svg('<path d="M5 12h14"/>'),
  bold: svg('<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>'),
  italic: svg('<path d="M19 4h-9M14 20H5M15 4 9 20"/>'),
  alignLeft: svg('<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'),
  alignCenter: svg('<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'),
  alignRight: svg('<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>'),
  bullets: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>'),
  numbers: svg('<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 4.5h1.5V9M3.5 9h3M3.5 13.5a1.5 1.5 0 1 1 2.6 1L3.5 18h3" stroke-width="1.5"/>'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
};

const MAX_ATTACHMENTS = 25 * 1024 * 1024;
const IMAGE_MAX_EDGE = 1920; // inline images are scaled down to this
const IMAGE_SHOW_WIDTH = 600; // and shown at most this wide
const SAVE_DELAY = 2000;
const SAVE_DELAY_LARGE = 30000;

// { accounts(), toast(msg, opts), defaultAccountId(), onDraftsChanged(accountId),
//   attachmentBytes(message, attachment), senderName(account) }
let env = null;
let win = null; // the open compose window's state

export function initCompose(options) {
  env = options;
}

export const isComposeOpen = () => Boolean(win);

const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const longDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const display = (a) => (a.name && a.name !== a.email ? a.name : a.email);
const validEmail = (e) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(e ?? '');
const sameAddress = (a, b) => a?.toLowerCase() === b?.toLowerCase();

// ---------- opening ----------

// opts: { mode: 'new' | 'reply' | 'replyAll' | 'forward' | 'draft',
//         accountId, original (full message, for reply/forward), draftRef }
export async function openCompose(opts) {
  if (win) await closeWindow({ save: true });
  const accounts = env.accounts();
  const accountId = opts.accountId && accounts[opts.accountId] ? opts.accountId : env.defaultAccountId();
  if (!accountId) {
    env.toast('Add an account first.', { error: true });
    return;
  }
  const state = {
    mode: opts.mode,
    accountId,
    ref: null,
    messageId: null,
    reply: null, // { id, folder, threadId, internetMessageId, references, accountId }
    to: [], cc: [], bcc: [],
    attachments: [], // { key, filename, mimeType, size, bytes, serverId?, keyPackets? }
    inline: new Map(), // cid -> { cid, filename, mimeType, bytes, serverId? }
    dirty: false,
    saveChain: Promise.resolve(),
    saveTimer: null,
    full: false,
    showCc: false,
  };
  win = state;
  render(state);
  resolveSenderName(state);

  try {
    if (opts.mode === 'draft') await loadDraft(state, opts.draftRef);
    else if (opts.original) await prefill(state, opts.mode, opts.original);
  } catch (e) {
    env.toast(`Couldn't open the draft: ${e.message}`, { error: true });
  }
  renderRecipients(state);
  state.el.querySelector('.cmp-subject').value = state.subject ?? '';
  setStatus(state, '');
  focusStart(state);
}

async function prefill(state, mode, m) {
  const account = env.accounts()[state.accountId];
  const me = account.email;
  state.reply = {
    id: m.id,
    folder: m.folder,
    threadId: m.threadId,
    internetMessageId: m.internetMessageId,
    references: replyReferences(m),
    accountId: m.accountId,
  };
  const subject = m.subject ?? '';
  if (mode === 'forward') {
    state.subject = /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`;
  } else {
    state.subject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
    // Replying to your own sent email goes to its recipients.
    const mine = sameAddress(m.from?.email, me);
    const primary = mine ? m.to : (m.replyTo?.length ? m.replyTo : [m.from]);
    state.to = dedupe(primary, [me]);
    if (mode === 'replyAll') {
      const others = mine ? [] : (m.to ?? []);
      state.to = dedupe([...state.to, ...others], [me]);
      state.cc = dedupe(m.cc ?? [], [me, ...state.to.map((a) => a.email)]);
      state.showCc = state.cc.length > 0;
    }
  }
  const quoted = quoteHtml(state, m, mode);
  setEditorHtml(state, `<div><br></div><div><br></div>${quoted}`);
  if (mode === 'forward') {
    // The original's attachments come along.
    for (const a of m.attachments.filter((x) => !x.inline)) {
      try {
        const bytes = await env.attachmentBytes(m, a);
        addAttachment(state, { filename: a.filename, mimeType: a.mimeType, bytes });
      } catch (e) {
        env.toast(`Couldn't include ${a.filename}: ${e.message}`, { error: true });
      }
    }
  }
}

function dedupe(list, excludeEmails = []) {
  const seen = new Set(excludeEmails.map((e) => e?.toLowerCase()));
  const out = [];
  for (const a of list ?? []) {
    const e = a?.email?.toLowerCase();
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push({ name: a.name ?? '', email: a.email });
  }
  return out;
}

function quoteHtml(state, m, mode) {
  const body = sanitizeForEditor(m.html ?? `<pre style="white-space:pre-wrap">${esc(m.text ?? '')}</pre>`, state, m.inlineImages);
  const who = m.from?.name ? `${esc(m.from.name)} &lt;${esc(m.from.email)}&gt;` : esc(m.from?.email ?? '');
  const when = m.date ? longDate.format(new Date(m.date)) : '';
  if (mode === 'forward') {
    const list = (xs) => (xs ?? []).map((a) => (a.name ? `${esc(a.name)} &lt;${esc(a.email)}&gt;` : esc(a.email))).join(', ');
    return `<div>---------- Forwarded message ---------<br>From: ${who}<br>Date: ${esc(when)}<br>Subject: ${esc(m.subject ?? '')}<br>To: ${list(m.to)}${m.cc?.length ? `<br>Cc: ${list(m.cc)}` : ''}<br><br></div>${body}`;
  }
  return `<div>On ${esc(when)}, ${who} wrote:<br></div><blockquote style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex">${body}</blockquote>`;
}

// Email HTML made safe to edit: no scripts, forms or styles that could leak;
// embedded (cid:) images become editable data: images.
function sanitizeForEditor(html, state, inlineImages = new Map()) {
  const doc = DOMPurify.sanitize(html, {
    RETURN_DOM: true,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'base', 'meta', 'link', 'title'],
    FORBID_ATTR: ['action', 'formaction', 'contenteditable'],
  });
  for (const img of doc.querySelectorAll('img[src^="cid:" i]')) {
    const cid = decodeURIComponent(img.getAttribute('src').slice(4));
    const url = inlineImages.get(cid);
    if (!url) {
      img.remove();
      continue;
    }
    const newCid = makeCid();
    const { bytes, mimeType } = dataUrlToBytes(url);
    state.inline.set(newCid, { cid: newCid, filename: `image-${state.inline.size + 1}.${mimeType.split('/')[1] || 'png'}`, mimeType, bytes });
    img.setAttribute('src', url);
    img.setAttribute('data-cid', newCid);
  }
  return doc.innerHTML;
}

async function loadDraft(state, ref) {
  const account = env.accounts()[state.accountId];
  setStatus(state, 'Opening draft…');
  const d = await providers[account.provider].loadDraft(account, ref);
  state.ref = ref;
  state.mode = 'draft';
  state.messageId = d.messageId ?? d.internetMessageId ?? null;
  state.subject = d.subject ?? '';
  state.to = dedupe(d.to);
  state.cc = dedupe(d.cc);
  state.bcc = dedupe(d.bcc);
  state.showCc = state.cc.length > 0 || state.bcc.length > 0;
  state.reply = {
    threadId: d.threadId,
    internetMessageId: d.inReplyTo ?? null,
    references: d.references ?? null,
    parentId: d.parentId ?? null,
    accountId: state.accountId,
  };
  // Inline images back into the editor; other files as attachments.
  const inlineUrls = new Map();
  for (const a of d.attachments) {
    if (a.inline && a.contentId) {
      state.inline.set(a.contentId, { cid: a.contentId, filename: a.filename, mimeType: a.mimeType, bytes: a.bytes, serverId: a.serverId, keyPackets: a.keyPackets });
      inlineUrls.set(a.contentId, bytesToDataUrl(a.bytes, a.mimeType));
    } else {
      addAttachment(state, { filename: a.filename, mimeType: a.mimeType, bytes: a.bytes, serverId: a.serverId, keyPackets: a.keyPackets }, { dirty: false });
    }
  }
  let html = DOMPurify.sanitize(d.html ?? `<div>${esc(d.text ?? '').replace(/\n/g, '<br>')}</div>`, {
    RETURN_DOM: true,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'base', 'meta', 'link', 'title'],
  });
  for (const img of html.querySelectorAll('img[src^="cid:" i]')) {
    const cid = decodeURIComponent(img.getAttribute('src').slice(4));
    if (inlineUrls.has(cid)) {
      img.setAttribute('src', inlineUrls.get(cid));
      img.setAttribute('data-cid', cid);
    }
  }
  setEditorHtml(state, html.innerHTML);
  state.dirty = false;
}

// The name recipients see next to your address.
async function resolveSenderName(state) {
  const account = env.accounts()[state.accountId];
  try {
    state.senderName = (await env.senderName(account)) ?? '';
  } catch {
    state.senderName = '';
  }
}

// ---------- window ----------

function accountOptions(selectedId) {
  return Object.values(env.accounts())
    .sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0))
    .map((a) => `<option value="${esc(a.id)}"${a.id === selectedId ? ' selected' : ''}>${esc(a.email)} · ${esc(providers[a.provider]?.name ?? '')}</option>`)
    .join('');
}

function title(state) {
  if (state.mode === 'reply' || state.mode === 'replyAll') return 'Reply';
  if (state.mode === 'forward') return 'Forward';
  if (state.mode === 'draft') return 'Draft';
  return 'New message';
}

function render(state) {
  const el = document.createElement('section');
  el.className = 'compose';
  el.setAttribute('aria-label', 'Compose email');
  el.innerHTML = `
    <header class="cmp-head">
      <span class="cmp-title">${title(state)}</span>
      <span class="cmp-spacer"></span>
      <button class="cmp-icon" data-c="minimize" title="Minimise">${ICON.minimize}</button>
      <button class="cmp-icon" data-c="full" title="Full window">${ICON.expand}</button>
      <button class="cmp-icon" data-c="close" title="Save and close">${ICON.close}</button>
    </header>
    <div class="cmp-body">
      <label class="cmp-row cmp-from"><span>From</span><select class="cmp-from-select">${accountOptions(state.accountId)}</select></label>
      <div class="cmp-row" data-field="to"><span>To</span><div class="cmp-recips" data-list="to"></div>
        <button class="cmp-link" data-c="show-cc">Cc Bcc</button></div>
      <div class="cmp-row" data-field="cc" hidden><span>Cc</span><div class="cmp-recips" data-list="cc"></div></div>
      <div class="cmp-row" data-field="bcc" hidden><span>Bcc</span><div class="cmp-recips" data-list="bcc"></div></div>
      <div class="cmp-row"><input class="cmp-subject" placeholder="Subject" aria-label="Subject" spellcheck="true"></div>
      <div class="cmp-editor-wrap"><iframe class="cmp-editor" title="Message"></iframe></div>
      <div class="cmp-dropzone" hidden>
        <div>Drop files here to attach<br><button class="cmp-link" data-c="browse">or choose files</button></div>
        <input type="file" multiple hidden>
      </div>
      <ul class="cmp-files"></ul>
    </div>
    <footer class="cmp-foot">
      <button class="tool-btn primary cmp-send" data-c="send" title="Send (⌘↩)">Send</button>
      <div class="cmp-tools" role="toolbar" aria-label="Formatting">
        <span class="cmp-group">
          <button class="cmp-tool" data-cmd="bold" title="Bold (⌘B)">${ICON.bold}</button>
          <button class="cmp-tool" data-cmd="italic" title="Italic (⌘I)">${ICON.italic}</button>
        </span>
        <span class="cmp-group cmp-align-wrap">
          <button class="cmp-tool" data-c="align" title="Alignment">${ICON.alignLeft}</button>
          <span class="cmp-pop cmp-align" hidden>
            <button class="cmp-tool" data-cmd="justifyLeft" title="Align left">${ICON.alignLeft}</button>
            <button class="cmp-tool" data-cmd="justifyCenter" title="Centre">${ICON.alignCenter}</button>
            <button class="cmp-tool" data-cmd="justifyRight" title="Align right">${ICON.alignRight}</button>
          </span>
        </span>
        <span class="cmp-group">
          <button class="cmp-tool" data-cmd="insertUnorderedList" title="Bulleted list">${ICON.bullets}</button>
          <button class="cmp-tool" data-cmd="insertOrderedList" title="Numbered list">${ICON.numbers}</button>
        </span>
        <span class="cmp-group cmp-link-wrap">
          <button class="cmp-tool" data-c="link" title="Link (⌘K)">${ICON.link}</button>
          <form class="cmp-pop cmp-linkform" hidden>
            <input type="text" class="cmp-link-text" placeholder="Text to show">
            <input type="url" class="cmp-link-url" placeholder="https://" required>
            <button class="tool-btn small primary" type="submit">Apply</button>
          </form>
        </span>
        <span class="cmp-group">
          <button class="cmp-tool" data-c="attach" title="Attach files">${uiIcons['attach-files']}</button>
        </span>
        <span class="cmp-group">
          <button class="cmp-tool" data-cmd="undo" title="Undo (⌘Z)">${uiIcons.undo}</button>
          <button class="cmp-tool" data-cmd="redo" title="Redo (⇧⌘Z)">${uiIcons.redo}</button>
        </span>
      </div>
      <span class="cmp-status" aria-live="polite"></span>
      <button class="cmp-icon cmp-discard" data-c="discard" title="Discard draft">${uiIcons.delete}</button>
    </footer>`;
  document.body.appendChild(el);
  state.el = el;
  setupEditor(state);
  wire(state);
}

function setupEditor(state) {
  const frame = state.el.querySelector('.cmp-editor');
  // Same-origin, no scripts (extension CSP); remote images blocked like the reader.
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'">
    <style>
      html { height: 100%; }
      body { margin: 0; padding: 12px 16px; min-height: calc(100% - 24px); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #202124; word-wrap: break-word; outline: none; }
      img { max-width: 100%; height: auto; }
      blockquote { margin: 0 0 0 0.8ex; border-left: 1px solid #ccc; padding-left: 1ex; }
      p { margin: 0; }
      a { color: #1a73e8; }
      ul, ol { margin: 0 0 0 1.5em; padding: 0; }
    </style></head><body></body></html>`;
  state.editorReady = new Promise((resolve) => {
    frame.addEventListener('load', () => {
      const doc = frame.contentDocument;
      doc.body.contentEditable = 'true';
      doc.body.spellcheck = true;
      doc.execCommand('defaultParagraphSeparator', false, 'div');
      doc.execCommand('styleWithCSS', false, false);
      state.doc = doc;
      wireEditor(state, doc);
      if (state.pendingHtml != null) {
        doc.body.innerHTML = state.pendingHtml;
        state.pendingHtml = null;
      }
      resolve(doc);
    }, { once: true });
  });
}

function setEditorHtml(state, html) {
  if (state.doc) state.doc.body.innerHTML = html;
  else state.pendingHtml = html;
}

async function focusStart(state) {
  const doc = await state.editorReady;
  if (!state.to.length && state.mode !== 'draft') {
    state.el.querySelector('[data-list="to"] input')?.focus();
    return;
  }
  doc.body.focus();
  const range = doc.createRange();
  range.setStart(doc.body, 0);
  range.collapse(true);
  const sel = doc.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function setStatus(state, text, error = false) {
  const s = state.el?.querySelector('.cmp-status');
  if (!s) return;
  s.textContent = text;
  s.classList.toggle('error', error);
  s.title = error ? text : '';
}

// ---------- recipients ----------

function renderRecipients(state) {
  for (const field of ['to', 'cc', 'bcc']) {
    const box = state.el.querySelector(`[data-list="${field}"]`);
    const list = state[field];
    box.innerHTML = list.map((a, i) => `<span class="chip-r${validEmail(a.email) ? '' : ' invalid'}" title="${esc(a.email)}">${esc(display(a))}<button data-remove="${i}" aria-label="Remove ${esc(a.email)}">×</button></span>`).join('') +
      `<input type="text" autocomplete="off" spellcheck="false" aria-label="${field}"><ul class="cmp-suggest" hidden></ul>`;
    wireRecipientInput(state, field, box);
  }
  state.el.querySelector('[data-field="cc"]').hidden = !state.showCc;
  state.el.querySelector('[data-field="bcc"]').hidden = !state.showCc;
  state.el.querySelector('[data-c="show-cc"]').hidden = state.showCc;
}

function commitText(state, field, text) {
  const parsed = parseAddressList(text.replace(/;/g, ',')).filter((a) => a.email);
  if (!parsed.length) return false;
  state[field] = dedupe([...state[field], ...parsed]);
  markDirty(state);
  return true;
}

function wireRecipientInput(state, field, box) {
  const input = box.querySelector('input');
  const list = box.querySelector('.cmp-suggest');
  let items = [];
  let active = -1;
  const refocus = () => box.querySelector('input')?.focus();
  const commit = () => {
    if (commitText(state, field, input.value)) {
      renderRecipients(state);
      refocus();
    }
  };
  const showSuggestions = async () => {
    const exclude = new Set([...state.to, ...state.cc, ...state.bcc].map((a) => a.email.toLowerCase()));
    items = await suggest(input.value, { exclude });
    active = items.length ? 0 : -1;
    list.innerHTML = items.map((s, i) => `<li data-i="${i}" class="${i === active ? 'active' : ''}"><strong>${esc(s.name || s.email)}</strong>${s.name ? `<span>${esc(s.email)}</span>` : ''}</li>`).join('');
    list.hidden = !items.length;
  };
  const pick = (i) => {
    const s = items[i];
    if (!s) return;
    state[field] = dedupe([...state[field], { name: s.name ?? '', email: s.email }]);
    markDirty(state);
    renderRecipients(state);
    refocus();
  };
  input.addEventListener('input', () => {
    if (/[,;]\s*$/.test(input.value)) return commit();
    showSuggestions();
  });
  input.addEventListener('keydown', (e) => {
    if (!list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (!list.hidden && active >= 0) {
        e.preventDefault();
        return pick(active);
      }
      if (input.value.trim()) {
        e.preventDefault();
        return commit();
      }
    }
    if (e.key === 'Escape' && !list.hidden) {
      e.stopPropagation();
      list.hidden = true;
    }
    if (e.key === 'Backspace' && !input.value && state[field].length) {
      state[field].pop();
      markDirty(state);
      renderRecipients(state);
      refocus();
    }
  });
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text/plain');
    if (/[,;\n]/.test(text)) {
      e.preventDefault();
      commitText(state, field, text.replace(/\n/g, ','));
      renderRecipients(state);
      refocus();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => {
    list.hidden = true;
    if (input.isConnected && input.value.trim()) {
      commitText(state, field, input.value);
      renderRecipients(state);
    }
  }, 150));
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li');
    if (li) {
      e.preventDefault();
      pick(Number(li.dataset.i));
    }
  });
  box.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      state[field].splice(Number(rm.dataset.remove), 1);
      markDirty(state);
      renderRecipients(state);
      return;
    }
    if (e.target === box) input.focus();
  });
}

// ---------- editor behaviour ----------

function wireEditor(state, doc) {
  const body = doc.body;
  body.addEventListener('input', () => markDirty(state));
  // Anything pasted becomes plain text; pasted images go in inline.
  body.addEventListener('paste', (e) => {
    e.preventDefault();
    const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (images.length) return insertImages(state, images);
    const text = e.clipboardData.getData('text/plain');
    if (text) doc.execCommand('insertText', false, text);
  });
  body.addEventListener('dragover', (e) => e.preventDefault());
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) {
      const pos = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (pos) {
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(pos);
      }
      const images = files.filter((f) => /^image\/(png|jpe?g|gif|webp|bmp)$/.test(f.type));
      const others = files.filter((f) => !images.includes(f));
      if (images.length) insertImages(state, images);
      if (others.length) addFiles(state, others);
      return;
    }
    const text = e.dataTransfer.getData('text/plain');
    if (text) {
      const pos = doc.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (pos) {
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(pos);
      }
      doc.execCommand('insertText', false, text);
    }
  });
  doc.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      send(state);
    } else if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openLinkForm(state);
    } else if (mod && e.key.toLowerCase() === 'u') {
      e.preventDefault(); // no underline: not in this editor's set
    } else if (e.key === 'Escape') {
      closePops(state);
    }
  });
  doc.addEventListener('selectionchange', () => updateToolState(state));
}

function updateToolState(state) {
  const doc = state.doc;
  if (!doc) return;
  for (const b of state.el.querySelectorAll('.cmp-tool[data-cmd]')) {
    const cmd = b.dataset.cmd;
    if (cmd === 'undo' || cmd === 'redo') continue;
    let on = false;
    try {
      on = doc.queryCommandState(cmd);
    } catch {}
    b.classList.toggle('on', on);
  }
}

function exec(state, cmd, value = null) {
  const doc = state.doc;
  if (!doc) return;
  doc.body.focus();
  doc.execCommand(cmd, false, value);
  markDirty(state);
  updateToolState(state);
}

function closePops(state) {
  for (const p of state.el.querySelectorAll('.cmp-pop')) p.hidden = true;
}

function openLinkForm(state) {
  const form = state.el.querySelector('.cmp-linkform');
  const sel = state.doc.getSelection();
  state.linkRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const text = state.linkRange?.toString() ?? '';
  form.querySelector('.cmp-link-text').value = text;
  form.querySelector('.cmp-link-text').hidden = Boolean(text);
  const existing = sel.anchorNode?.parentElement?.closest?.('a');
  form.querySelector('.cmp-link-url').value = existing?.getAttribute('href') ?? '';
  closePops(state);
  form.hidden = false;
  form.querySelector('.cmp-link-url').focus();
}

function applyLink(state) {
  const form = state.el.querySelector('.cmp-linkform');
  let url = form.querySelector('.cmp-link-url').value.trim();
  if (!url) return;
  if (!/^(https?:|mailto:)/i.test(url)) url = /@/.test(url) && !/\//.test(url) ? `mailto:${url}` : `https://${url}`;
  const doc = state.doc;
  doc.body.focus();
  const sel = doc.getSelection();
  if (state.linkRange) {
    sel.removeAllRanges();
    sel.addRange(state.linkRange);
  }
  if (sel.isCollapsed) {
    const text = form.querySelector('.cmp-link-text').value.trim() || url;
    doc.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(text)}</a>`);
  } else {
    doc.execCommand('createLink', false, url);
  }
  form.hidden = true;
  markDirty(state);
}

// ---------- images and attachments ----------

const makeCid = () => `${crypto.randomUUID()}@unread-mail`;

function dataUrlToBytes(url) {
  const [head, data] = url.split(',');
  const mimeType = head.match(/^data:([^;]+)/)?.[1] ?? 'application/octet-stream';
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, mimeType };
}

function bytesToDataUrl(bytes, mimeType) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mimeType || 'application/octet-stream'};base64,${btoa(bin)}`;
}

// Large photos are scaled down (longest side 1920 px) before they go inline;
// GIFs stay as they are so animations keep working.
async function prepareImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.type === 'image/gif') {
    const bmp = await createImageBitmap(file).catch(() => null);
    return { bytes, mimeType: file.type, width: bmp?.width ?? IMAGE_SHOW_WIDTH };
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && bytes.length < 1.5e6) return { bytes, mimeType: file.type || 'image/png', width: bmp.width };
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  // PNGs (screenshots, transparency) stay PNG unless that is very large.
  let blob = file.type === 'image/png' ? await canvas.convertToBlob({ type: 'image/png' }) : null;
  if (!blob || blob.size > 2.5e6) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType: blob.type, width: w };
}

async function insertImages(state, files) {
  for (const file of files) {
    try {
      const img = await prepareImage(file);
      const cid = makeCid();
      const ext = img.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      const name = (file.name && file.name !== 'image.png' ? file.name.replace(/\.[^.]+$/, '') : `image-${state.inline.size + 1}`) + `.${ext}`;
      state.inline.set(cid, { cid, filename: name, mimeType: img.mimeType, bytes: img.bytes });
      const shown = Math.min(img.width, IMAGE_SHOW_WIDTH);
      state.doc.body.focus();
      state.doc.execCommand('insertHTML', false, `<img src="${bytesToDataUrl(img.bytes, img.mimeType)}" data-cid="${cid}" width="${shown}" alt="${esc(name)}" style="max-width:100%">`);
      markDirty(state);
    } catch (e) {
      env.toast(`Couldn't add ${file.name || 'the image'}: ${e.message}`, { error: true });
    }
  }
}

function totalSize(state) {
  return state.attachments.reduce((n, a) => n + a.size, 0) + [...state.inline.values()].reduce((n, a) => n + a.bytes.length, 0);
}

function addAttachment(state, file, { dirty = true } = {}) {
  state.attachments.push({ key: crypto.randomUUID(), size: file.bytes.length, ...file });
  renderFiles(state);
  if (dirty) markDirty(state);
}

async function addFiles(state, files) {
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (totalSize(state) + bytes.length > MAX_ATTACHMENTS) {
      env.toast(`${f.name} would make this email larger than 25 MB, which most mail servers refuse.`, { error: true });
      continue;
    }
    addAttachment(state, { filename: f.name, mimeType: f.type || 'application/octet-stream', bytes });
  }
  state.el.querySelector('.cmp-dropzone').hidden = true;
}

function renderFiles(state) {
  const ul = state.el.querySelector('.cmp-files');
  ul.innerHTML = state.attachments.map((a) => `<li>${ICON.file}<span class="name" title="${esc(a.filename)}">${esc(a.filename)}</span><span class="size">${formatSize(a.size)}</span><button data-remove-file="${a.key}" title="Remove">×</button></li>`).join('');
  ul.hidden = !state.attachments.length;
}

// ---------- building the draft ----------

// Plain-text version of the HTML, for mail apps that show text only.
function htmlToText(root) {
  let out = '';
  const walk = (node, quote) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) {
        out += n.nodeValue.replace(/\s+/g, ' ');
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') out += '\n';
      else if (tag === 'IMG') out += n.alt ? `[${n.alt}]` : '';
      else if (tag === 'LI') {
        out += (n.parentElement?.tagName === 'OL' ? `${[...n.parentElement.children].indexOf(n) + 1}. ` : '- ');
        walk(n, quote);
        out += '\n';
      } else if (tag === 'BLOCKQUOTE') {
        const start = out.length;
        out += '\n';
        walk(n, quote + 1);
        const inner = out.slice(start);
        out = out.slice(0, start) + inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n') + '\n';
      } else if (tag === 'A') {
        const before = out.length;
        walk(n, quote);
        const text = out.slice(before).trim();
        const href = n.getAttribute('href') ?? '';
        if (href && href !== text && !href.startsWith('mailto:')) out += ` <${href}>`;
      } else {
        const block = /^(DIV|P|H[1-6]|UL|OL|TABLE|TR|PRE)$/.test(tag);
        if (block && out && !out.endsWith('\n')) out += '\n';
        walk(n, quote);
        if (block && !out.endsWith('\n')) out += '\n';
      }
    }
  };
  walk(root, 0);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function collect(state) {
  const accounts = env.accounts();
  const account = accounts[state.accountId];
  // An inert copy: rewriting image sources there loads nothing.
  const clone = document.implementation.createHTMLDocument('').importNode(state.doc.body, true);
  const inline = [];
  for (const img of clone.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (src.startsWith('data:')) {
      let cid = img.getAttribute('data-cid');
      if (!cid || !state.inline.has(cid)) {
        cid = makeCid();
        const { bytes, mimeType } = dataUrlToBytes(src);
        state.inline.set(cid, { cid, filename: `image-${state.inline.size + 1}.${mimeType.split('/')[1] || 'png'}`, mimeType, bytes });
      }
      if (!inline.includes(state.inline.get(cid))) inline.push(state.inline.get(cid));
      img.setAttribute('src', `cid:${cid}`);
    }
    img.removeAttribute('data-cid');
  }
  const html = DOMPurify.sanitize(clone.innerHTML, {
    FORBID_TAGS: ['script', 'style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|cid|tel):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
  const text = htmlToText(clone);
  // A reply keeps its thread only on the account it came from.
  const reply = state.reply && (!state.reply.accountId || state.reply.accountId === state.accountId) ? state.reply : null;
  state.messageId ??= newMessageId(account.email);
  return {
    mode: state.mode,
    ref: state.ref,
    messageId: state.messageId,
    from: { name: state.senderName ?? '', email: account.email },
    to: state.to, cc: state.cc, bcc: state.bcc,
    subject: state.el.querySelector('.cmp-subject').value,
    html,
    text,
    inline,
    attachments: state.attachments,
    reply,
    inReplyTo: state.reply?.internetMessageId ?? null,
    references: state.reply?.references ?? null,
  };
}

const isEmpty = (state) => !state.to.length && !state.cc.length && !state.bcc.length && !state.attachments.length &&
  !state.el.querySelector('.cmp-subject').value.trim() && !(state.doc?.body.textContent.trim()) && !state.doc?.body.querySelector('img');

function markDirty(state) {
  if (state !== win) return;
  state.dirty = true;
  clearTimeout(state.saveTimer);
  const delay = totalSize(state) > 2e6 ? SAVE_DELAY_LARGE : SAVE_DELAY;
  state.saveTimer = setTimeout(() => save(state).catch(() => {}), delay);
}

// Saves are queued so two never overlap.
function save(state) {
  clearTimeout(state.saveTimer);
  state.saveChain = state.saveChain.then(async () => {
    if (!state.dirty || !state.doc) return;
    if (!state.ref && isEmpty(state)) return;
    state.dirty = false;
    const account = env.accounts()[state.accountId];
    if (!account) return;
    setStatus(state, 'Saving…');
    try {
      const draft = collect(state);
      state.ref = await providers[account.provider].saveDraft(account, draft);
      setStatus(state, 'Saved');
      env.onDraftsChanged?.(state.accountId);
    } catch (e) {
      state.dirty = true;
      setStatus(state, `Couldn't save: ${e.message}`, true);
      throw e;
    }
  });
  return state.saveChain;
}

// ---------- actions ----------

async function changeFrom(state, newId) {
  if (newId === state.accountId) return;
  const oldId = state.accountId;
  const oldRef = state.ref;
  await state.saveChain.catch(() => {});
  state.accountId = newId;
  state.ref = null;
  resolveSenderName(state);
  state.messageId = null;
  // Server copies belong to the old account.
  for (const a of state.attachments) {
    a.serverId = null;
    a.keyPackets = null;
    a.sessionKey = null;
  }
  for (const a of state.inline.values()) {
    a.serverId = null;
    a.keyPackets = null;
    a.sessionKey = null;
  }
  if (oldRef) {
    const old = env.accounts()[oldId];
    providers[old.provider].deleteDraft(old, oldRef).catch(() => {});
    env.onDraftsChanged?.(oldId);
  }
  markDirty(state);
}

async function send(state) {
  if (state.sending) return;
  for (const field of ['to', 'cc', 'bcc']) {
    const input = state.el.querySelector(`[data-list="${field}"] input`);
    if (input?.value.trim()) commitText(state, field, input.value);
  }
  renderRecipients(state);
  const all = [...state.to, ...state.cc, ...state.bcc];
  if (!all.length) {
    setStatus(state, 'Add at least one recipient.', true);
    state.el.querySelector('[data-list="to"] input')?.focus();
    return;
  }
  const bad = all.filter((a) => !validEmail(a.email));
  if (bad.length) {
    setStatus(state, `Check ${bad.map((a) => a.email).join(', ')}`, true);
    return;
  }
  if (!state.el.querySelector('.cmp-subject').value.trim() && !confirm('Send this email without a subject?')) return;

  const account = env.accounts()[state.accountId];
  const provider = providers[account.provider];
  state.sending = true;
  state.el.querySelector('.cmp-send').disabled = true;
  setStatus(state, 'Preparing…');
  try {
    state.dirty = true; // always save the final version
    await save(state);
    const draft = collect(state);
    let sendable;
    try {
      sendable = await provider.prepareSend(account, draft);
    } catch (e) {
      if (e.name !== 'SendPermissionError') throw e;
      // Outlook accounts connected before sending existed approve it once.
      if (!confirm(`${account.email} needs your permission to send email. Sign in to Microsoft to approve it?`)) throw new Error('Sending was not approved');
      const token = await signIn('outlook', account.email);
      await saveToken(account.id, token);
      sendable = await provider.prepareSend(account, draft);
    }
    const summary = { to: all.map(display).slice(0, 3), more: Math.max(0, all.length - 3), subject: draft.subject };
    const res = await chrome.runtime.sendMessage({
      cmd: 'queueSend',
      item: { accountId: account.id, provider: account.provider, sendable, draftRef: state.ref, summary },
    });
    if (!res?.ok) throw new Error(res?.error ?? 'The extension could not queue the email');
    rememberAddresses(all, 5);
    env.onSending?.(account.id);
    await closeWindow({ save: false });
  } catch (e) {
    setStatus(state, `Couldn't send: ${e.message}`, true);
    state.el.querySelector('.cmp-send').disabled = false;
  } finally {
    state.sending = false;
  }
}

async function discard(state) {
  const account = env.accounts()[state.accountId];
  clearTimeout(state.saveTimer);
  await state.saveChain.catch(() => {});
  const ref = state.ref;
  await closeWindow({ save: false });
  if (ref && account) {
    try {
      await providers[account.provider].deleteDraft(account, ref);
      env.onDraftsChanged?.(account.id);
    } catch (e) {
      env.toast(`Couldn't delete the draft: ${e.message}`, { error: true });
      return;
    }
  }
  env.toast('Draft discarded');
}

export async function closeWindow({ save: doSave = true } = {}) {
  const state = win;
  if (!state) return;
  win = null;
  clearTimeout(state.saveTimer);
  if (doSave && state.doc && (state.dirty || state.ref)) {
    try {
      state.dirty = state.dirty || false;
      await (state.dirty ? saveNow(state) : state.saveChain);
      if (state.ref) env.toast('Saved to Drafts');
    } catch (e) {
      env.toast(`The draft could not be saved: ${e.message}`, { error: true });
    }
  }
  state.el.remove();
}

// Save even though the window is closing (win is already cleared).
function saveNow(state) {
  const prev = win;
  win = state;
  const p = save(state);
  win = prev;
  return p;
}

function wire(state) {
  const el = state.el;
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c], [data-cmd], [data-remove-file]');
    if (!b) {
      if (!e.target.closest('.cmp-pop')) closePops(state);
      return;
    }
    if (b.dataset.removeFile) {
      state.attachments = state.attachments.filter((a) => a.key !== b.dataset.removeFile);
      renderFiles(state);
      markDirty(state);
      return;
    }
    if (b.dataset.cmd) {
      closePops(state);
      return exec(state, b.dataset.cmd);
    }
    switch (b.dataset.c) {
      case 'close':
        return closeWindow({ save: true });
      case 'minimize':
        el.classList.toggle('min');
        return;
      case 'full':
        state.full = !state.full;
        el.classList.toggle('full', state.full);
        b.innerHTML = state.full ? ICON.shrink : ICON.expand;
        b.title = state.full ? 'Back to a small window' : 'Full window';
        return;
      case 'show-cc':
        state.showCc = true;
        renderRecipients(state);
        el.querySelector('[data-list="cc"] input').focus();
        return;
      case 'align': {
        const pop = el.querySelector('.cmp-align');
        const open = pop.hidden;
        closePops(state);
        pop.hidden = !open;
        return;
      }
      case 'link':
        return openLinkForm(state);
      case 'attach': {
        const zone = el.querySelector('.cmp-dropzone');
        zone.hidden = !zone.hidden;
        return;
      }
      case 'browse':
        return el.querySelector('.cmp-dropzone input[type=file]').click();
      case 'send':
        return send(state);
      case 'discard':
        return discard(state);
    }
  });
  el.querySelector('.cmp-head').addEventListener('dblclick', () => el.classList.remove('min'));
  el.querySelector('.cmp-from-select').addEventListener('change', (e) => changeFrom(state, e.target.value));
  el.querySelector('.cmp-subject').addEventListener('input', () => markDirty(state));
  el.querySelector('.cmp-linkform').addEventListener('submit', (e) => {
    e.preventDefault();
    applyLink(state);
  });
  const fileInput = el.querySelector('.cmp-dropzone input[type=file]');
  fileInput.addEventListener('change', () => {
    addFiles(state, [...fileInput.files]);
    fileInput.value = '';
  });
  // Files dropped anywhere on the window (outside the text) are attached.
  el.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes('Files')) {
      e.preventDefault();
      el.querySelector('.cmp-dropzone').hidden = false;
      el.classList.add('dragging');
    }
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('dragging');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) addFiles(state, files);
  });
  el.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      send(state);
    }
    if (e.key === 'Escape' && state.full && !e.target.closest('.cmp-recips')) {
      state.full = false;
      el.classList.remove('full');
    }
  });
}
