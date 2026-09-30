// Builds an RFC 5322 / MIME message from a draft, for Gmail (raw) and for the
// IMAP helper (SMTP + Drafts/Sent). No DOM APIs, so it also runs in the
// background service worker.
//
// Layout:
//   multipart/mixed                      (only with attachments)
//     multipart/related                  (only with inline images)
//       multipart/alternative
//         text/plain  (quoted-printable)
//         text/html   (quoted-printable)
//       image/* inline parts (Content-ID)
//     attachments (base64)

const CRLF = '\r\n';
const enc = new TextEncoder();

const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

// RFC 2047 encoded word for non-ASCII header text.
function encodeWord(s) {
  if (isAscii(s)) return s;
  return `=?UTF-8?B?${bytesToBase64(enc.encode(s))}?=`;
}

function formatAddress({ name, email }) {
  if (!name) return email;
  const safe = isAscii(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : encodeWord(name);
  return `${safe} <${email}>`;
}

export const formatAddressList = (list) => list.map(formatAddress).join(', ');

export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const wrap76 = (b64) => b64.replace(/.{1,76}/g, (line) => line + CRLF).replace(/\r\n$/, '');

// Quoted-printable (RFC 2045), soft-wrapped at 76 characters.
function quotedPrintable(text) {
  const bytes = enc.encode(text.replace(/\r?\n/g, CRLF));
  const out = [];
  let line = '';
  const push = (chunk) => {
    if (line.length + chunk.length > 75) {
      out.push(line + '=');
      line = '';
    }
    line += chunk;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 13 && bytes[i + 1] === 10) {
      // Trailing space/tab before a line break must be encoded.
      if (/[ \t]$/.test(line)) line = line.slice(0, -1) + (line.endsWith(' ') ? '=20' : '=09');
      out.push(line);
      line = '';
      i++;
    } else if ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9) {
      push(String.fromCharCode(b));
    } else {
      push('=' + b.toString(16).toUpperCase().padStart(2, '0'));
    }
  }
  out.push(line);
  return out.join(CRLF);
}

const boundary = () => `=_um_${crypto.randomUUID().replace(/-/g, '')}`;

function filenameParams(name) {
  if (isAscii(name) && !/["\\]/.test(name)) return `filename="${name}"`;
  return `filename*=UTF-8''${encodeURIComponent(name)}`;
}
function nameParam(name) {
  if (isAscii(name) && !/["\\]/.test(name)) return `name="${name}"`;
  return `name="${encodeWord(name)}"`;
}

function part(headers, body) {
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF + CRLF + body;
}

function multipart(type, parts) {
  const b = boundary();
  return {
    type: `multipart/${type}; boundary="${b}"`,
    body: parts.map((p) => `--${b}${CRLF}${p}`).join(CRLF) + `${CRLF}--${b}--`,
  };
}

export function newMessageId(fromEmail) {
  const domain = (fromEmail.split('@')[1] || 'localhost').toLowerCase();
  return `<${crypto.randomUUID()}@${domain}>`;
}

// draft: { from, to, cc, bcc, subject, html, text, inline: [{ cid, filename,
// mimeType, bytes }], attachments: [{ filename, mimeType, bytes }], messageId,
// inReplyTo, references }. includeBcc keeps the Bcc header (drafts, Gmail
// send); SMTP delivery leaves it out and lists Bcc only as envelope recipients.
export function buildMime(draft, { includeBcc = true, date = new Date() } = {}) {
  const alt = multipart('alternative', [
    part({ 'Content-Type': 'text/plain; charset=UTF-8', 'Content-Transfer-Encoding': 'quoted-printable' }, quotedPrintable(draft.text ?? '')),
    part({ 'Content-Type': 'text/html; charset=UTF-8', 'Content-Transfer-Encoding': 'quoted-printable' }, quotedPrintable(draft.html ?? '')),
  ]);
  let root = alt;
  const inline = draft.inline ?? [];
  if (inline.length) {
    root = multipart('related', [
      `Content-Type: ${alt.type}${CRLF}${CRLF}${alt.body}`,
      ...inline.map((img) => part({
        'Content-Type': `${img.mimeType}; ${nameParam(img.filename)}`,
        'Content-Transfer-Encoding': 'base64',
        'Content-ID': `<${img.cid}>`,
        'Content-Disposition': `inline; ${filenameParams(img.filename)}`,
      }, wrap76(bytesToBase64(img.bytes)))),
    ]);
  }
  const files = draft.attachments ?? [];
  if (files.length) {
    root = multipart('mixed', [
      `Content-Type: ${root.type}${CRLF}${CRLF}${root.body}`,
      ...files.map((f) => part({
        'Content-Type': `${f.mimeType || 'application/octet-stream'}; ${nameParam(f.filename)}`,
        'Content-Transfer-Encoding': 'base64',
        'Content-Disposition': `attachment; ${filenameParams(f.filename)}`,
      }, wrap76(bytesToBase64(f.bytes)))),
    ]);
  }

  const headers = {
    'MIME-Version': '1.0',
    Date: date.toUTCString().replace('GMT', '+0000'),
    'Message-ID': draft.messageId ?? newMessageId(draft.from.email),
    Subject: encodeWord(draft.subject ?? ''),
    From: formatAddress(draft.from),
  };
  if (draft.to?.length) headers.To = formatAddressList(draft.to);
  if (draft.cc?.length) headers.Cc = formatAddressList(draft.cc);
  if (includeBcc && draft.bcc?.length) headers.Bcc = formatAddressList(draft.bcc);
  if (draft.inReplyTo) headers['In-Reply-To'] = draft.inReplyTo;
  if (draft.references) headers.References = draft.references;
  headers['Content-Type'] = root.type;
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(CRLF) + CRLF + CRLF + root.body + CRLF;
}

// The References header of a reply: the original's References plus its
// Message-ID (RFC 5322 §3.6.4).
export function replyReferences(original) {
  const refs = (original.references ?? '').split(/\s+/).filter(Boolean);
  if (original.internetMessageId) refs.push(original.internetMessageId);
  return refs.slice(-20).join(' ');
}
