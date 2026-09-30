// Encryption for Proton drafts and sending, following Proton's open-source web
// client (github.com/ProtonMail/WebClients):
//
//   * A draft's body is stored encrypted to, and signed by, the sender's
//     address key. Attachments are uploaded as a key packet (the attachment's
//     session key, encrypted to the address key), the encrypted data packet
//     and a detached signature.
//   * Sending hands Proton one "package": the body encrypted with a fresh
//     session key. Proton recipients get that session key (and each
//     attachment's) encrypted to their public key, so only they can read the
//     email (end-to-end). Other recipients are sent a normal email: the
//     session keys go to Proton's server, which decrypts and delivers it, as
//     the web app does for non-Proton addresses.

import * as openpgp from '../vendor/openpgp.min.mjs';

const b64 = (bytes) => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Recipient types (Proton's SEND_TYPES).
const SEND_PM = 1;
const SEND_CLEAR = 4;

// Splits an encrypted binary message into its key packets and data packet,
// at the byte where the first encrypted-data packet starts (RFC 9580 §4.2
// packet headers; key packets come first and have definite lengths).
const DATA_TAGS = new Set([9, 18, 20]); // SED, SEIPD, AEAD
function splitMessage(bytes) {
  let pos = 0;
  while (pos < bytes.length) {
    const head = bytes[pos];
    if (!(head & 0x80)) throw new Error('Not an OpenPGP message');
    let tag;
    let len;
    let hdr;
    if (head & 0x40) {
      tag = head & 0x3f;
      const o = bytes[pos + 1];
      if (o < 192) { len = o; hdr = 2; }
      else if (o < 224) { len = ((o - 192) << 8) + bytes[pos + 2] + 192; hdr = 3; }
      else if (o === 255) { len = ((bytes[pos + 2] << 24) | (bytes[pos + 3] << 16) | (bytes[pos + 4] << 8) | bytes[pos + 5]) >>> 0; hdr = 6; }
      else { len = null; hdr = 1; } // partial length: only data packets use it
    } else {
      tag = (head >> 2) & 0x0f;
      const lt = head & 3;
      if (lt === 0) { len = bytes[pos + 1]; hdr = 2; }
      else if (lt === 1) { len = (bytes[pos + 1] << 8) | bytes[pos + 2]; hdr = 3; }
      else if (lt === 2) { len = ((bytes[pos + 1] << 24) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 8) | bytes[pos + 4]) >>> 0; hdr = 5; }
      else { len = null; hdr = 1; }
    }
    if (DATA_TAGS.has(tag)) return { keyPackets: bytes.slice(0, pos), dataPacket: bytes.slice(pos) };
    if (len == null) throw new Error('Unexpected packet layout');
    pos += hdr + len;
  }
  throw new Error('No encrypted data packet found');
}

// Armored body for a draft: readable by the sender (and Proton's web app).
export async function encryptDraftBody(html, address) {
  return openpgp.encrypt({
    message: await openpgp.createMessage({ text: html }),
    encryptionKeys: address.primary.toPublic(),
    signingKeys: address.primary,
  });
}

// An attachment as Proton stores it, plus its session key (kept for sending).
export async function encryptAttachment(bytes, filename, address) {
  const publicKey = address.primary.toPublic();
  const sessionKey = await openpgp.generateSessionKey({ encryptionKeys: publicKey });
  const encrypted = await openpgp.encrypt({
    message: await openpgp.createMessage({ binary: bytes, filename, format: 'binary' }),
    encryptionKeys: publicKey,
    sessionKey,
    format: 'binary',
  });
  const { keyPackets, dataPacket } = splitMessage(encrypted);
  const signature = await openpgp.sign({
    message: await openpgp.createMessage({ binary: bytes }),
    signingKeys: address.primary,
    detached: true,
    format: 'binary',
  });
  return { keyPackets, dataPacket, signature, sessionKey: { data: b64(sessionKey.data), algorithm: sessionKey.algorithm } };
}

// The session key of an attachment already on the server (from its key packets).
export async function attachmentSessionKey(keyPacketsB64, keys) {
  const [sk] = await openpgp.decryptSessionKeys({
    message: await openpgp.readMessage({ binaryMessage: fromB64(keyPacketsB64) }),
    decryptionKeys: keys,
  });
  return { data: b64(sk.data), algorithm: sk.algorithm };
}

// Public key of a Proton address, or null for anyone else.
async function recipientKey(api, email) {
  let info;
  try {
    info = await api(`core/v4/keys?Email=${encodeURIComponent(email)}`);
  } catch {
    return null; // not a Proton address (e.g. an external domain)
  }
  if (info?.RecipientType !== 1) return null;
  const k = (info.Keys ?? []).find((x) => x.Flags == null || (x.Flags & 2)) ?? info.Keys?.[0];
  return k ? openpgp.readKey({ armoredKey: k.PublicKey }) : null;
}

// Packages for POST mail/v4/messages/{id}. attachments: [{ id, sessionKey }].
export async function buildPackages({ html, address, recipients, attachments, api }) {
  const publicKey = address.primary.toPublic();
  const sessionKey = await openpgp.generateSessionKey({ encryptionKeys: publicKey });
  const encrypted = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: html }),
    encryptionKeys: publicKey,
    sessionKey,
    signingKeys: address.primary,
    format: 'binary',
  });
  const { dataPacket } = splitMessage(encrypted);
  const pkg = { Addresses: {}, MIMEType: 'text/html', Type: 0, Body: b64(dataPacket) };
  for (const email of [...new Set(recipients.map((r) => r.toLowerCase()))]) {
    const key = await recipientKey(api, email);
    if (key) {
      const wrap = async (sk) => b64(await openpgp.encryptSessionKey({ data: fromB64(sk.data), algorithm: sk.algorithm, encryptionKeys: key, format: 'binary' }));
      const AttachmentKeyPackets = {};
      for (const a of attachments) AttachmentKeyPackets[a.id] = await wrap(a.sessionKey);
      pkg.Addresses[email] = {
        Type: SEND_PM,
        Signature: 1,
        BodyKeyPacket: await wrap({ data: b64(sessionKey.data), algorithm: sessionKey.algorithm }),
        AttachmentKeyPackets,
      };
      pkg.Type |= SEND_PM;
    } else {
      pkg.Addresses[email] = { Type: SEND_CLEAR, Signature: 0 };
      pkg.Type |= SEND_CLEAR;
      pkg.BodyKey = { Key: b64(sessionKey.data), Algorithm: sessionKey.algorithm };
      pkg.AttachmentKeys = Object.fromEntries(attachments.map((a) => [a.id, { Key: a.sessionKey.data, Algorithm: a.sessionKey.algorithm }]));
    }
  }
  return [pkg];
}
