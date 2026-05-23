import { createCipheriv, createDecipheriv } from 'node:crypto';
import nacl from 'tweetnacl';

export const PREFERRED_MODES = [
  'aead_aes256_gcm_rtpsize',
  'xsalsa20_poly1305_lite',
  'xsalsa20_poly1305_suffix',
  'xsalsa20_poly1305',
];

const AEAD_TAG_LEN = 16;
const AEAD_SUFFIX_LEN = 4;
const NACL_NONCE_LEN = 24;

function aeadNonce(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeUInt32BE(counter, 0);
  return nonce;
}

function encryptAesGcm(secretKey, aadPrefix, frame, counter) {
  const nonce = aeadNonce(counter);
  const cipher = createCipheriv('aes-256-gcm', secretKey, nonce);
  cipher.setAAD(aadPrefix);
  const ct = Buffer.concat([cipher.update(frame), cipher.final()]);
  const tag = cipher.getAuthTag();
  const suffix = Buffer.alloc(AEAD_SUFFIX_LEN);
  suffix.writeUInt32BE(counter, 0);
  return Buffer.concat([ct, tag, suffix]);
}

function decryptAesGcm(secretKey, packet, headerLen) {
  const minSize = headerLen + AEAD_TAG_LEN + AEAD_SUFFIX_LEN;
  if (packet.length < minSize) return null;

  const aad = packet.subarray(0, headerLen);
  const suffix = packet.subarray(packet.length - AEAD_SUFFIX_LEN);
  const counter = suffix.readUInt32BE(0);
  const tagStart = packet.length - AEAD_SUFFIX_LEN - AEAD_TAG_LEN;
  const tag = packet.subarray(tagStart, packet.length - AEAD_SUFFIX_LEN);
  const ct = packet.subarray(headerLen, tagStart);

  try {
    const decipher = createDecipheriv('aes-256-gcm', secretKey, aeadNonce(counter));
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return null;
  }
}

function encryptXsalsaLite(secretKey, frame, counter) {
  const nonce = Buffer.alloc(NACL_NONCE_LEN);
  nonce.writeUInt32BE(counter, 0);
  const sealed = nacl.secretbox(frame, nonce, secretKey);
  if (!sealed) return null;
  const suffix = Buffer.alloc(AEAD_SUFFIX_LEN);
  suffix.writeUInt32BE(counter, 0);
  return Buffer.concat([suffix, Buffer.from(sealed)]);
}

function decryptXsalsaLite(secretKey, packet, headerLen) {
  if (packet.length < headerLen + AEAD_SUFFIX_LEN + 16) return null;
  const nonce = Buffer.alloc(NACL_NONCE_LEN);
  packet.copy(nonce, 0, headerLen, headerLen + AEAD_SUFFIX_LEN);
  const sealed = packet.subarray(headerLen + AEAD_SUFFIX_LEN);
  const opened = nacl.secretbox.open(sealed, nonce, secretKey);
  return opened ? Buffer.from(opened) : null;
}

function decryptXsalsaSuffix(secretKey, packet, headerLen) {
  if (packet.length < headerLen + NACL_NONCE_LEN + 16) return null;
  const nonce = Buffer.alloc(NACL_NONCE_LEN);
  packet.copy(nonce, 0, packet.length - NACL_NONCE_LEN);
  const sealed = packet.subarray(headerLen, packet.length - NACL_NONCE_LEN);
  const opened = nacl.secretbox.open(sealed, nonce, secretKey);
  return opened ? Buffer.from(opened) : null;
}

function decryptXsalsaFull(secretKey, packet, headerLen) {
  const sealed = packet.subarray(headerLen);
  if (sealed.length < 16) return null;
  const nonce = Buffer.alloc(NACL_NONCE_LEN);
  packet.copy(nonce, 0, 0, 12);
  const opened = nacl.secretbox.open(sealed, nonce, secretKey);
  return opened ? Buffer.from(opened) : null;
}

export function encrypt(mode, secretKey, aadPrefix, frame, nonceCounter) {
  if (mode === 'aead_aes256_gcm_rtpsize') return encryptAesGcm(secretKey, aadPrefix, frame, nonceCounter);
  if (mode === 'xsalsa20_poly1305_lite') return encryptXsalsaLite(secretKey, frame, nonceCounter);
  throw new Error(`encrypt: unsupported mode for send path: ${mode}`);
}

export function decrypt(mode, secretKey, packet, headerLen) {
  if (mode === 'aead_aes256_gcm_rtpsize') return decryptAesGcm(secretKey, packet, headerLen);
  if (mode === 'xsalsa20_poly1305_lite') return decryptXsalsaLite(secretKey, packet, headerLen);
  if (mode === 'xsalsa20_poly1305_suffix') return decryptXsalsaSuffix(secretKey, packet, headerLen);
  if (mode === 'xsalsa20_poly1305') return decryptXsalsaFull(secretKey, packet, headerLen);
  return null;
}
