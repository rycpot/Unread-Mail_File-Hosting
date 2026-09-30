// From github.com/rycpot/Minimal-Spreadsheet-Text-Design-Editor (lib/office-crypto.js),
// the same author's project; used here unchanged apart from this header and the
// globalThis line at the end.
/*
 * office-crypto.js — decrypts password-protected OOXML files (.xlsx/.docx/.pptx)
 * entirely in the browser, using the native Web Crypto API (crypto.subtle).
 *
 * Implements the two encryption schemes defined by MS-OFFCRYPTO / ECMA-376:
 *   - "Agile" encryption   (Excel 2013 and later — the modern default)
 *   - "Standard" encryption (Excel 2007–2010 — AES-128 + SHA-1)
 *
 * The password-protected file is a CFB ("OLE compound file") container
 * holding two streams:
 *   - EncryptionInfo    — describes the algorithm/salts/verifier hashes
 *   - EncryptedPackage  — the actual OOXML (zip) package, encrypted
 *
 * decryptOfficeFile() verifies the password against the stored verifier
 * hash, then decrypts EncryptedPackage and returns the plain OOXML bytes,
 * ready to hand to XLSX.read().
 *
 * No third-party libraries or network access are used — everything here
 * is implemented against the browser's built-in Web Crypto and DOMParser.
 */
'use strict';

const OfficeCrypto = (function () {
  const subtle = crypto.subtle;

  /* ---------------------------------------------------------------- *
   * Small binary helpers
   * ---------------------------------------------------------------- */
  function u8(buf) { return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }

  function concatBytes(...arrs) {
    let len = 0;
    for (const a of arrs) len += a.length;
    const out = new Uint8Array(len);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  }

  function xorBytes(a, b) {
    const out = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i % b.length];
    return out;
  }

  function le32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    return b;
  }

  function utf16leBytes(str) {
    const out = new Uint8Array(str.length * 2);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < str.length; i++) dv.setUint16(i * 2, str.charCodeAt(i), true);
    return out;
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* ---------------------------------------------------------------- *
   * CFB (Compound File Binary) minimal reader
   *
   * Parses just enough of the OLE/CFB container format to locate and
   * read the "EncryptionInfo" and "EncryptedPackage" streams: the
   * header, DIFAT/FAT sector chains, directory entries, and the mini
   * stream (used for small streams like EncryptionInfo).
   * ---------------------------------------------------------------- */
  const ENDOFCHAIN = 0xFFFFFFFE;
  const FREESECT = 0xFFFFFFFF;

  function parseCFB(arrayBuffer) {
    const bytes = u8(arrayBuffer);
    if (bytes.length < 512) throw new Error('NOT_CFB');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (dv.getBigUint64(0, true) !== 0xE11AB1A1E011CFD0n) {
      throw new Error('NOT_CFB');
    }

    const sectorShift = dv.getUint16(30, true);
    const miniSectorShift = dv.getUint16(32, true);
    const firstDirSector = dv.getUint32(48, true);
    const miniStreamCutoff = dv.getUint32(56, true);
    const firstMiniFatSector = dv.getUint32(60, true);
    const numMiniFatSectors = dv.getUint32(64, true);
    const firstDifatSector = dv.getUint32(68, true);
    const numDifatSectors = dv.getUint32(72, true);

    const sectorSize = 1 << sectorShift;
    const miniSectorSize = 1 << miniSectorShift;

    function sectorOffset(sectorIndex) { return 512 + sectorIndex * sectorSize; }
    function readSector(sectorIndex) {
      const off = sectorOffset(sectorIndex);
      return bytes.subarray(off, off + sectorSize);
    }

    // Build the full DIFAT (list of sector indices that hold the FAT).
    const difat = [];
    for (let i = 0; i < 109; i++) {
      const v = dv.getUint32(76 + i * 4, true);
      if (v === FREESECT) break;
      difat.push(v);
    }
    {
      let next = firstDifatSector;
      let remaining = numDifatSectors;
      while (next !== ENDOFCHAIN && next !== FREESECT && remaining > 0) {
        const sec = readSector(next);
        const sdv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
        const entriesPerSector = sectorSize / 4;
        for (let i = 0; i < entriesPerSector - 1; i++) {
          const v = sdv.getUint32(i * 4, true);
          if (v === FREESECT) break;
          difat.push(v);
        }
        next = sdv.getUint32((entriesPerSector - 1) * 4, true);
        remaining--;
      }
    }

    // Build the FAT (sector chain table).
    const entriesPerSector = sectorSize / 4;
    const fat = new Uint32Array(difat.length * entriesPerSector);
    for (let i = 0; i < difat.length; i++) {
      const sec = readSector(difat[i]);
      const sdv = new DataView(sec.buffer, sec.byteOffset, sec.byteLength);
      for (let j = 0; j < entriesPerSector; j++) {
        fat[i * entriesPerSector + j] = sdv.getUint32(j * 4, true);
      }
    }

    function readChain(startSector, knownSize) {
      const chunks = [];
      let cur = startSector;
      let total = 0;
      const seen = new Set();
      while (cur !== ENDOFCHAIN && cur !== FREESECT) {
        if (seen.has(cur)) throw new Error('CFB_LOOP');
        seen.add(cur);
        const sec = readSector(cur);
        chunks.push(sec);
        total += sec.length;
        cur = fat[cur];
        if (knownSize != null && total >= knownSize) break;
      }
      const out = concatBytes(...chunks);
      return knownSize != null ? out.subarray(0, knownSize) : out;
    }

    // Directory entries (128 bytes each). We scan linearly rather than
    // walking the red-black tree — we only need entries by name.
    const dirBytes = readChain(firstDirSector);
    const numDirEntries = Math.floor(dirBytes.length / 128);
    const entries = [];
    let rootEntry = null;
    for (let i = 0; i < numDirEntries; i++) {
      const off = i * 128;
      const nameLen = new DataView(dirBytes.buffer, dirBytes.byteOffset + off + 64, 2).getUint16(0, true);
      let name = '';
      if (nameLen > 0) {
        const nameBytes = dirBytes.subarray(off, off + nameLen - 2); // exclude null terminator
        const ndv = new DataView(nameBytes.buffer, nameBytes.byteOffset, nameBytes.byteLength);
        for (let c = 0; c + 1 < nameBytes.length; c += 2) {
          name += String.fromCharCode(ndv.getUint16(c, true));
        }
      }
      const objType = dirBytes[off + 66];
      const edv = new DataView(dirBytes.buffer, dirBytes.byteOffset + off, 128);
      const startSector = edv.getUint32(116, true);
      const sizeLow = edv.getUint32(120, true);
      const sizeHigh = edv.getUint32(124, true);
      const size = sizeHigh * 4294967296 + sizeLow;
      const entry = { name, objType, startSector, size };
      entries.push(entry);
      if (objType === 5) rootEntry = entry;
    }

    // Mini FAT + mini stream (the root entry's own stream holds every
    // small stream's data, sliced into 64-byte mini-sectors).
    let miniFat = new Uint32Array(0);
    if (numMiniFatSectors > 0) {
      const miniFatBytes = readChain(firstMiniFatSector);
      miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
      const mdv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
      for (let i = 0; i < miniFat.length; i++) miniFat[i] = mdv.getUint32(i * 4, true);
    }
    const miniStreamBytes = (rootEntry && rootEntry.startSector !== ENDOFCHAIN)
      ? readChain(rootEntry.startSector, rootEntry.size)
      : new Uint8Array(0);

    function readMiniChain(startSector, knownSize) {
      const chunks = [];
      let cur = startSector;
      let total = 0;
      const seen = new Set();
      while (cur !== ENDOFCHAIN && cur !== FREESECT) {
        if (seen.has(cur)) throw new Error('MINIFAT_LOOP');
        seen.add(cur);
        const off = cur * miniSectorSize;
        chunks.push(miniStreamBytes.subarray(off, off + miniSectorSize));
        total += miniSectorSize;
        cur = miniFat[cur];
        if (knownSize != null && total >= knownSize) break;
      }
      const out = concatBytes(...chunks);
      return knownSize != null ? out.subarray(0, knownSize) : out;
    }

    function getStream(name) {
      const e = entries.find((x) => x.objType === 2 && x.name === name);
      if (!e) return null;
      if (e.size === 0) return new Uint8Array(0);
      if (e.size < miniStreamCutoff) return readMiniChain(e.startSector, e.size);
      return readChain(e.startSector, e.size);
    }

    return { getStream };
  }

  /* ---------------------------------------------------------------- *
   * Raw AES-CBC / AES-ECB decrypt with NO padding removal.
   *
   * WebCrypto's AES-CBC *decrypt* operation always strips PKCS#7 padding
   * from the final block and throws if it isn't valid — but MS-OFFCRYPTO
   * ciphertexts are block-aligned with no such padding. The fix: append
   * one extra ciphertext block D chosen so that it decrypts to a full,
   * valid padding block (16 bytes of 0x10). CBC decryption of every
   * earlier block only depends on it and the preceding ciphertext block,
   * so appending D never changes their plaintext — only the padding
   * check on the (now-dummy) final block is affected, and that block is
   * discarded. D is computed as RawAESEncrypt(lastCiphertextBlock XOR
   * 0x10101010...), via a single-block AES-CBC *encrypt* with IV=0
   * (whose first output block is exactly the raw block-cipher encryption
   * we need, ignoring the padding block appended after it).
   * ---------------------------------------------------------------- */
  async function importAesCbcKey(rawKey) {
    return subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  }

  async function aesCbcDecryptNoPad(cryptoKey, iv, ciphertext) {
    const ct = u8(ciphertext);
    if (ct.length === 0) return new Uint8Array(0);
    if (ct.length % 16 !== 0) throw new Error('CIPHERTEXT_NOT_BLOCK_ALIGNED');

    const lastBlock = ct.subarray(ct.length - 16);
    const pad16 = new Uint8Array(16).fill(0x10);
    const target = xorBytes(lastBlock, pad16);

    const zeroIv = new Uint8Array(16);
    const encTarget = new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv: zeroIv }, cryptoKey, target));
    const dummyBlock = encTarget.subarray(0, 16);

    const extended = concatBytes(ct, dummyBlock);
    const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, extended));
    return plain; // exactly ct.length bytes; the dummy trailing block is fully stripped
  }

  // Standard encryption uses AES-ECB (no chaining). WebCrypto has no ECB
  // mode, but ECB(block) is equivalent to CBC(block, iv=0) applied one
  // block at a time, which sidesteps the padding trap entirely.
  async function aesEcbDecryptNoPad(cryptoKey, data) {
    const zeroIv = new Uint8Array(16);
    const out = new Uint8Array(data.length);
    for (let off = 0; off < data.length; off += 16) {
      const block = data.subarray(off, off + 16);
      const dec = await aesCbcDecryptNoPad(cryptoKey, zeroIv, block);
      out.set(dec, off);
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * ECMA-376 Agile encryption (Excel 2013+, the modern default)
   * ---------------------------------------------------------------- */
  const BLK_VERIFIER_HASH_INPUT = new Uint8Array([0xFE, 0xA7, 0xD2, 0x76, 0x3B, 0x4B, 0x9E, 0x79]);
  const BLK_VERIFIER_HASH_VALUE = new Uint8Array([0xD7, 0xAA, 0x0F, 0x6D, 0x30, 0x61, 0x34, 0x4E]);
  const BLK_KEY_VALUE = new Uint8Array([0x14, 0x6E, 0x0B, 0xE7, 0xAB, 0xAC, 0xD0, 0xD6]);

  const HASH_NAME_MAP = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' };

  async function digest(hashAlgorithm, ...parts) {
    const algo = HASH_NAME_MAP[hashAlgorithm] || 'SHA-1';
    return new Uint8Array(await subtle.digest(algo, concatBytes(...parts)));
  }

  function parseAgileEncryptionInfoXml(xmlBytes) {
    const xmlText = new TextDecoder('utf-8').decode(xmlBytes);
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');

    const keyDataEl = doc.getElementsByTagName('keyData')[0];
    const encryptorEl = doc.getElementsByTagName('encryptedKey')[0]
      || Array.from(doc.getElementsByTagName('*')).find((n) => n.localName === 'encryptedKey');

    if (!keyDataEl || !encryptorEl) throw new Error('MALFORMED_ENCRYPTION_INFO');

    const attr = (el, name) => el.getAttribute(name);

    const keyData = {
      hashAlgorithm: attr(keyDataEl, 'hashAlgorithm'),
      saltValue: b64ToBytes(attr(keyDataEl, 'saltValue')),
    };

    const encryptedKey = {
      spinCount: parseInt(attr(encryptorEl, 'spinCount'), 10),
      keyBits: parseInt(attr(encryptorEl, 'keyBits'), 10),
      hashAlgorithm: attr(encryptorEl, 'hashAlgorithm'),
      saltValue: b64ToBytes(attr(encryptorEl, 'saltValue')),
      encryptedVerifierHashInput: b64ToBytes(attr(encryptorEl, 'encryptedVerifierHashInput')),
      encryptedVerifierHashValue: b64ToBytes(attr(encryptorEl, 'encryptedVerifierHashValue')),
      encryptedKeyValue: b64ToBytes(attr(encryptorEl, 'encryptedKeyValue')),
    };

    return { keyData, encryptedKey };
  }

  async function deriveIteratedHash(password, saltValue, hashAlgorithm, spinCount) {
    let h = await digest(hashAlgorithm, saltValue, utf16leBytes(password));
    for (let i = 0; i < spinCount; i++) {
      h = await digest(hashAlgorithm, le32(i), h);
    }
    return h;
  }

  async function deriveKey(h, blockKey, hashAlgorithm, keyBits) {
    const hFinal = await digest(hashAlgorithm, h, blockKey);
    return hFinal.subarray(0, keyBits / 8);
  }

  async function agileVerifyAndGetSecretKey(password, encInfo) {
    const { encryptedKey } = encInfo;
    const h = await deriveIteratedHash(password, encryptedKey.saltValue, encryptedKey.hashAlgorithm, encryptedKey.spinCount);

    const key1 = await deriveKey(h, BLK_VERIFIER_HASH_INPUT, encryptedKey.hashAlgorithm, encryptedKey.keyBits);
    const key2 = await deriveKey(h, BLK_VERIFIER_HASH_VALUE, encryptedKey.hashAlgorithm, encryptedKey.keyBits);
    const key3 = await deriveKey(h, BLK_KEY_VALUE, encryptedKey.hashAlgorithm, encryptedKey.keyBits);

    const cryptoKey1 = await importAesCbcKey(key1);
    const cryptoKey2 = await importAesCbcKey(key2);
    const cryptoKey3 = await importAesCbcKey(key3);

    const verifierHashInput = await aesCbcDecryptNoPad(cryptoKey1, encryptedKey.saltValue, encryptedKey.encryptedVerifierHashInput);
    const actualHash = await digest(encryptedKey.hashAlgorithm, verifierHashInput);
    const expectedHash = await aesCbcDecryptNoPad(cryptoKey2, encryptedKey.saltValue, encryptedKey.encryptedVerifierHashValue);

    let match = actualHash.length === expectedHash.length;
    for (let i = 0; match && i < actualHash.length; i++) {
      if (actualHash[i] !== expectedHash[i]) match = false;
    }
    if (!match) return null; // wrong password

    const secretKey = await aesCbcDecryptNoPad(cryptoKey3, encryptedKey.saltValue, encryptedKey.encryptedKeyValue);
    return secretKey.subarray(0, encryptedKey.keyBits / 8);
  }

  async function agileDecryptPackage(secretKey, keyData, encryptedPackageBytes) {
    const dv = new DataView(encryptedPackageBytes.buffer, encryptedPackageBytes.byteOffset, 8);
    const totalSizeLow = dv.getUint32(0, true);
    const totalSizeHigh = dv.getUint32(4, true);
    const totalSize = totalSizeHigh * 4294967296 + totalSizeLow;

    const body = encryptedPackageBytes.subarray(8);
    const SEGMENT = 4096;
    const cryptoKey = await importAesCbcKey(secretKey);

    const out = new Uint8Array(totalSize);
    let outOff = 0;
    let segIndex = 0;
    for (let off = 0; off < body.length; off += SEGMENT) {
      const segment = body.subarray(off, Math.min(off + SEGMENT, body.length));
      const iv = (await digest(keyData.hashAlgorithm, keyData.saltValue, le32(segIndex))).subarray(0, 16);
      const dec = await aesCbcDecryptNoPad(cryptoKey, iv, segment);
      const take = Math.min(dec.length, totalSize - outOff);
      out.set(dec.subarray(0, take), outOff);
      outOff += take;
      segIndex++;
      if (outOff >= totalSize) break;
    }
    return out;
  }

  /* ---------------------------------------------------------------- *
   * ECMA-376 Standard encryption (Excel 2007–2010 default: AES-128 + SHA-1)
   * ---------------------------------------------------------------- */
  function parseStandardEncryptionInfo(bytes) {
    // `bytes` starts right after the common 8-byte VersionMajor/Minor+Flags header.
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = dv.getUint32(0, true);
    let p = 4;
    const headerEnd = p + headerSize;
    const hdv = new DataView(bytes.buffer, bytes.byteOffset + p, headerSize);
    const keySize = hdv.getUint32(16, true) || 128; // KeySize==0 means 40-bit RC4-era default; not expected for AES

    p = headerEnd;
    const saltSize = dv.getUint32(p, true); p += 4;
    const salt = bytes.subarray(p, p + saltSize); p += saltSize;
    const encryptedVerifier = bytes.subarray(p, p + 16); p += 16;
    p += 4; // verifierHashSize field, not needed (Standard encryption is always SHA-1)
    const remaining = bytes.length - p;
    const encryptedVerifierHash = bytes.subarray(p, p + (remaining >= 32 ? 32 : remaining));

    return { keySize, salt, encryptedVerifier, encryptedVerifierHash };
  }

  async function standardDeriveKey(password, salt, keyBits) {
    const ITER = 50000;
    let h = await digest('SHA1', salt, utf16leBytes(password));
    for (let i = 0; i < ITER; i++) {
      h = await digest('SHA1', le32(i), h);
    }
    const hFinal = await digest('SHA1', h, le32(0));

    // Per spec this 0x36/0x5C padded-XOR-then-hash step always runs,
    // regardless of whether keyBits is bigger or smaller than the hash size.
    const buf1 = new Uint8Array(64).fill(0x36);
    for (let i = 0; i < hFinal.length; i++) buf1[i] ^= hFinal[i];
    const x1 = await digest('SHA1', buf1);
    const buf2 = new Uint8Array(64).fill(0x5C);
    for (let i = 0; i < hFinal.length; i++) buf2[i] ^= hFinal[i];
    const x2 = await digest('SHA1', buf2);

    return concatBytes(x1, x2).subarray(0, keyBits / 8);
  }

  async function standardVerifyAndGetKey(password, info) {
    const key = await standardDeriveKey(password, info.salt, info.keySize);
    const cryptoKey = await importAesCbcKey(key);

    const verifier = await aesEcbDecryptNoPad(cryptoKey, info.encryptedVerifier);
    const expectedHash = (await digest('SHA1', verifier)).subarray(0, 20);
    const decryptedHashBuf = await aesEcbDecryptNoPad(cryptoKey, info.encryptedVerifierHash);
    const actualHash = decryptedHashBuf.subarray(0, 20);

    let match = true;
    for (let i = 0; i < 20; i++) if (expectedHash[i] !== actualHash[i]) match = false;
    if (!match) return null;
    return cryptoKey;
  }

  async function standardDecryptPackage(cryptoKey, encryptedPackageBytes) {
    const dv = new DataView(encryptedPackageBytes.buffer, encryptedPackageBytes.byteOffset, 8);
    const totalSize = dv.getUint32(0, true);
    const body = encryptedPackageBytes.subarray(8);
    const dec = await aesEcbDecryptNoPad(cryptoKey, body);
    return dec.subarray(0, totalSize);
  }

  /* ---------------------------------------------------------------- *
   * Public API
   * ---------------------------------------------------------------- */
  function isCFBFile(arrayBuffer) {
    const bytes = u8(arrayBuffer);
    if (bytes.length < 8) return false;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
    return dv.getBigUint64(0, true) === 0xE11AB1A1E011CFD0n;
  }

  /**
   * Decrypts a password-protected OOXML file.
   * @param {ArrayBuffer} arrayBuffer - the raw .xlsx/.docx/.pptx file bytes
   * @param {string} password
   * @returns {Promise<Uint8Array>} the decrypted OOXML (zip) package bytes
   * @throws Error with .code set to 'NOT_ENCRYPTED_OOXML', 'WRONG_PASSWORD',
   *         or 'UNSUPPORTED_ENCRYPTION_VERSION'
   */
  async function decryptOfficeFile(arrayBuffer, password) {
    const cfb = parseCFB(arrayBuffer);
    const encInfoBytes = cfb.getStream('EncryptionInfo');
    const encPackageBytes = cfb.getStream('EncryptedPackage');
    if (!encInfoBytes || !encPackageBytes) {
      const err = new Error('This file is not a password-protected OOXML document.');
      err.code = 'NOT_ENCRYPTED_OOXML';
      throw err;
    }

    const dv = new DataView(encInfoBytes.buffer, encInfoBytes.byteOffset, 8);
    const versionMajor = dv.getUint16(0, true);
    const versionMinor = dv.getUint16(2, true);

    if (versionMajor === 4 && versionMinor === 4) {
      const encInfo = parseAgileEncryptionInfoXml(encInfoBytes.subarray(8));
      const secretKey = await agileVerifyAndGetSecretKey(password, encInfo);
      if (!secretKey) {
        const err = new Error('Incorrect password.');
        err.code = 'WRONG_PASSWORD';
        throw err;
      }
      return agileDecryptPackage(secretKey, encInfo.keyData, encPackageBytes);
    }

    if ((versionMajor === 3 || versionMajor === 4) && versionMinor === 2) {
      const info = parseStandardEncryptionInfo(encInfoBytes.subarray(8));
      const cryptoKey = await standardVerifyAndGetKey(password, info);
      if (!cryptoKey) {
        const err = new Error('Incorrect password.');
        err.code = 'WRONG_PASSWORD';
        throw err;
      }
      return standardDecryptPackage(cryptoKey, encPackageBytes);
    }

    const err = new Error('This file uses an unsupported encryption scheme.');
    err.code = 'UNSUPPORTED_ENCRYPTION_VERSION';
    throw err;
  }

  return { isCFBFile, decryptOfficeFile };
})();

globalThis.OfficeCrypto = OfficeCrypto;
