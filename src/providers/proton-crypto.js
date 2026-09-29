// Decrypts Proton emails inside the extension, following Proton's open-source
// web client (github.com/ProtonMail/WebClients):
//
//   1. keyPassword: Proton keeps it for "keep me signed in" in the site's
//      localStorage ("ps-<localID>"), AES-GCM encrypted with a ClientKey that
//      only the server hands out, to the signed-in session
//      (GET auth/v4/sessions/local/key). The content script passes on the
//      encrypted entry; it is unlocked here with that ClientKey.
//   2. User keys are unlocked with keyPassword. Address keys are unlocked with
//      their Token (encrypted to, and signed by, the user key) or, for older
//      accounts, keyPassword itself.
//   3. Message bodies and attachments are OpenPGP-decrypted with the address
//      keys.
//
// Unlocked keys live only in this page's memory (never in storage) and are
// dropped when the app tab closes.

import * as openpgp from '../vendor/openpgp.min.mjs';
import PostalMime from '../vendor/postal-mime/postal-mime.js';

// Same leniency as Proton's own client for older keys.
const PGP_CONFIG = { allowInsecureDecryptionWithSigningKeys: true };

export class ProtonSessionMissing extends Error {
  constructor(captured = 0) {
    super(`Open (or reload) mail.proton.me in this Chrome profile, signed in with "Keep me signed in" on, so the extension can pick up your Proton session, then try again. (Session entries picked up so far: ${captured}.)`);
    this.name = 'ProtonSessionMissing';
  }
}

const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToBinaryString = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
};
const bytesToB64 = (bytes) => btoa(bytesToBinaryString(bytes));

// Blob formats (persistedSessionStorage.ts / sessionBlobCryptoHelper.ts):
//   v1: 16-byte IV, no additional data, binary string
//   v2: 16-byte IV, additional data "session", binary string
//   v3: 12-byte IV, additional data "session", UTF-8
export async function decryptSessionBlob(clientKeyB64, blobB64, payloadVersion = 1) {
  const key = await crypto.subtle.importKey('raw', b64ToBytes(clientKeyB64), 'AES-GCM', false, ['decrypt']);
  const data = b64ToBytes(blobB64);
  const ivLength = payloadVersion === 3 ? 12 : 16;
  const additionalData = payloadVersion >= 2 ? new TextEncoder().encode('session') : undefined;
  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.slice(0, ivLength), ...(additionalData && { additionalData }) },
    key,
    data.slice(ivLength),
  ));
  const text = payloadVersion === 3 ? new TextDecoder().decode(plain) : bytesToBinaryString(plain);
  const parsed = JSON.parse(text);
  if (!parsed.keyPassword) throw new Error('This Proton session has no key password (offline session)');
  return parsed.keyPassword;
}

async function unlock(armoredKey, passphrase) {
  const privateKey = await openpgp.readPrivateKey({ armoredKey });
  return openpgp.decryptKey({ privateKey, passphrase, config: PGP_CONFIG });
}

async function addressKeyPassword(key, userPrivate, userPublic, keyPassword) {
  if (!key.Token) return keyPassword;
  if (!key.Signature) throw new Error('Unsupported address key (organisation-managed)');
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: key.Token }),
    signature: await openpgp.readSignature({ armoredSignature: key.Signature }),
    decryptionKeys: userPrivate,
    verificationKeys: userPublic,
    expectSigned: true, // throws unless the token is signed by the user key
    config: PGP_CONFIG,
  });
  return data;
}

// account id -> Promise<PrivateKey[]> (unlocked address keys), for this page's lifetime.
const keyCache = new Map();

// `api(path, opts)` is the Proton API call for the account (see proton.js).
export function getAddressKeys(account, api) {
  const cacheKey = account.id;
  if (!keyCache.has(cacheKey)) {
    const p = loadAddressKeys(account, api);
    keyCache.set(cacheKey, p);
    p.catch(() => keyCache.delete(cacheKey));
  }
  return keyCache.get(cacheKey);
}

export function forgetKeys(account) {
  keyCache.delete(account.id);
}

async function loadAddressKeys(account, api) {
  // Fetch the ClientKey first: the call may renew the session and update
  // account.uid, which selects the stored session entry.
  const { ClientKey } = await api('auth/v4/sessions/local/key');
  const { protonSessions = {} } = await chrome.storage.local.get('protonSessions');
  const session = protonSessions[account.uid];
  if (!session?.blob) throw new ProtonSessionMissing(Object.keys(protonSessions).length);
  const keyPassword = await decryptSessionBlob(ClientKey, session.blob, session.payloadVersion);

  const [{ User }, { Addresses }] = await Promise.all([api('core/v4/users'), api('core/v4/addresses')]);
  const userPrivate = [];
  for (const k of User?.Keys ?? []) {
    try {
      userPrivate.push(await unlock(k.PrivateKey, keyPassword));
    } catch (e) {
      console.warn('[proton] user key not unlocked', k.ID, e.message);
    }
  }
  if (!userPrivate.length) throw new Error('Could not unlock your Proton keys with this session');
  const userPublic = userPrivate.map((k) => k.toPublic());

  const addressKeys = [];
  for (const address of Addresses ?? []) {
    for (const k of address.Keys ?? []) {
      try {
        const passphrase = await addressKeyPassword(k, userPrivate, userPublic, keyPassword);
        addressKeys.push(await unlock(k.PrivateKey, passphrase));
      } catch (e) {
        console.warn('[proton] address key not unlocked', address.Email, k.ID, e.message);
      }
    }
  }
  if (!addressKeys.length) throw new Error('Could not unlock any Proton address key');
  return addressKeys;
}

const headerValue = (headers, name) => {
  const v = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

// Decrypts a message (as returned by mail/v4/messages/{id}) into the shape the
// reader uses: html/text plus attachment descriptors.
export async function decryptMessage(m, keys) {
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: m.Body }),
    decryptionKeys: keys,
    config: PGP_CONFIG,
  });

  // PGP/MIME (usually from outside senders): the whole MIME message was encrypted.
  if (m.MIMEType === 'multipart/mixed') {
    const parsed = await PostalMime.parse(data);
    return {
      html: parsed.html ?? null,
      text: parsed.html ? null : parsed.text ?? '',
      attachments: (parsed.attachments ?? []).map((a, i) => {
        const bytes = new Uint8Array(a.content);
        const contentId = a.contentId?.replace(/^<|>$/g, '') ?? null;
        return {
          id: `mime-${i}`,
          filename: a.filename || contentId || 'attachment',
          mimeType: a.mimeType,
          size: bytes.length,
          contentId,
          inline: Boolean(contentId) && (a.disposition === 'inline' || parsed.html?.includes(`cid:${contentId}`)),
          data: bytesToB64(bytes),
        };
      }),
    };
  }

  const html = m.MIMEType === 'text/html' ? data : null;
  return {
    html,
    text: html ? null : data,
    attachments: (m.Attachments ?? []).map((a) => {
      const contentId = headerValue(a.Headers, 'content-id')?.replace(/^<|>$/g, '') ?? null;
      const disposition = String(headerValue(a.Headers, 'content-disposition') ?? '').toLowerCase();
      return {
        id: a.ID,
        filename: a.Name || 'attachment',
        mimeType: a.MIMEType,
        size: a.Size ?? 0,
        contentId,
        inline: Boolean(contentId) && (disposition.startsWith('inline') || Boolean(html?.includes(`cid:${contentId}`))),
        keyPackets: a.KeyPackets,
      };
    }),
  };
}

// Attachment data is a symmetrically encrypted packet; its session key is in
// KeyPackets. Together they form a normal OpenPGP message.
export async function decryptAttachment(keyPacketsB64, encrypted, keys) {
  const kp = b64ToBytes(keyPacketsB64);
  const body = new Uint8Array(encrypted);
  const joined = new Uint8Array(kp.length + body.length);
  joined.set(kp);
  joined.set(body, kp.length);
  const { data } = await openpgp.decrypt({
    message: await openpgp.readMessage({ binaryMessage: joined }),
    decryptionKeys: keys,
    format: 'binary',
    config: PGP_CONFIG,
  });
  return data;
}
