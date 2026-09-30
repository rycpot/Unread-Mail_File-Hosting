// Turns an untrusted email body into a srcdoc for a sandboxed iframe.
// Three layers of protection:
//   1. DOMPurify strips scripts, event handlers, forms and other active content.
//   2. The iframe is sandboxed without allow-scripts / allow-same-origin, so even
//      a sanitizer bypass cannot run code or reach the extension's tokens.
//   3. A CSP <meta> blocks every network load except (optionally) images, which
//      also blocks tracking pixels until the user chooses to load them.

import DOMPurify from '../vendor/purify.es.mjs';
import { linkInlineImages } from './inline-images.js';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const REMOTE_URL = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*['"]?\s*(https?:)?\/\//i;

const BASE_STYLE = `
  html { background: #fff; }
  body { margin: 16px 20px; color: #202124; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; word-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  pre.plain { white-space: pre-wrap; font: inherit; margin: 0; }
  blockquote { margin: 0 0 0 8px; padding-left: 10px; border-left: 2px solid #dadce0; }
`;

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function textToHtml(text) {
  const linked = escapeHtml(text ?? '').replace(
    /\bhttps?:\/\/[^\s<>"']+/g,
    (url) => `<a href="${url}">${url}</a>`,
  );
  return `<pre class="plain">${linked}</pre>`;
}

// inlineParts: [{ contentId, filename, url (data:) }] of the email's inline images.
export function buildEmailDocument({ html, text }, { allowRemoteImages, inlineParts = [] }) {
  const doc = DOMPurify.sanitize(html ?? textToHtml(text), {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea', 'base', 'meta', 'link'],
    FORBID_ATTR: ['action', 'formaction'],
  }).ownerDocument;

  let remoteImages = 0;
  linkInlineImages(doc, inlineParts);
  for (const img of doc.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^(cid:|data:)/i.test(src)) {
      // resolved above, or an embedded image that is missing
    } else if (REMOTE_URL.test(src)) {
      remoteImages++;
    } else if (!/^data:/i.test(src)) {
      // Relative URLs would resolve against the extension's own origin.
      img.removeAttribute('src');
    }
  }
  for (const el of doc.querySelectorAll('[style], [background]')) {
    if (CSS_REMOTE_URL.test(el.getAttribute('style') ?? '') || REMOTE_URL.test(el.getAttribute('background') ?? '')) {
      remoteImages++;
    }
  }
  for (const style of doc.querySelectorAll('style')) {
    if (CSS_REMOTE_URL.test(style.textContent)) remoteImages++;
  }

  const imgSrc = allowRemoteImages ? 'data: https: http:' : 'data:';
  const head = doc.head ?? doc.documentElement.insertBefore(doc.createElement('head'), doc.body);
  head.insertAdjacentHTML(
    'afterbegin',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'; font-src data:">` +
      `<meta charset="utf-8"><style>${BASE_STYLE}</style>`,
  );

  return { srcdoc: '<!doctype html>' + doc.documentElement.outerHTML, remoteImages };
}

export function bytesToDataUrl(bytes, mimeType) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mimeType || 'application/octet-stream'};base64,${btoa(bin)}`;
}
