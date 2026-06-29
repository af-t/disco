import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { encrypt, decrypt, PREFERRED_MODES } from '../../../src/client/voice/crypto.js';

describe('voice crypto', () => {
  describe('PREFERRED_MODES', () => {
    it('lists AES-GCM first then xsalsa20 fallbacks', () => {
      assert.deepEqual(PREFERRED_MODES, [
        'aead_aes256_gcm_rtpsize',
        'xsalsa20_poly1305_lite',
        'xsalsa20_poly1305_suffix',
        'xsalsa20_poly1305',
      ]);
    });
  });

  describe('aead_aes256_gcm_rtpsize', () => {
    const mode = 'aead_aes256_gcm_rtpsize';

    it('round-trips a frame', () => {
      const key = randomBytes(32);
      const header = Buffer.from([0x80, 0x78, 0x00, 0x01, 0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x12, 0x34]);
      const frame = Buffer.from('hello voice channel');
      const blob = encrypt(mode, key, header, frame, 1);
      const packet = Buffer.concat([header, blob]);
      const out = decrypt(mode, key, packet, header.length);
      assert.deepEqual(out, frame);
    });

    it('returns null when AAD is tampered', () => {
      const key = randomBytes(32);
      const header = Buffer.from([0x80, 0x78, 0x00, 0x01, 0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x12, 0x34]);
      const frame = Buffer.from('payload');
      const blob = encrypt(mode, key, header, frame, 2);
      const packet = Buffer.concat([header, blob]);
      packet[0] = 0x00;
      assert.equal(decrypt(mode, key, packet, header.length), null);
    });

    it('returns null on wrong key', () => {
      const k1 = randomBytes(32);
      const k2 = randomBytes(32);
      const header = Buffer.alloc(12);
      const frame = Buffer.from('x');
      const blob = encrypt(mode, k1, header, frame, 3);
      const packet = Buffer.concat([header, blob]);
      assert.equal(decrypt(mode, k2, packet, header.length), null);
    });

    it('returns null on truncated packet', () => {
      const key = randomBytes(32);
      const header = Buffer.alloc(12);
      assert.equal(decrypt(mode, key, header, header.length), null);
    });

    it('produces distinct ciphertext for incrementing nonce counter', () => {
      const key = randomBytes(32);
      const header = Buffer.alloc(12);
      const frame = Buffer.from('same input');
      const a = encrypt(mode, key, header, frame, 10);
      const b = encrypt(mode, key, header, frame, 11);
      assert.notDeepEqual(a, b);
    });
  });

  describe('xsalsa20_poly1305_lite (legacy)', () => {
    const mode = 'xsalsa20_poly1305_lite';

    it('round-trips a frame', () => {
      const key = randomBytes(32);
      const header = Buffer.from([0x80, 0x78, 0x00, 0x01, 0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x12, 0x34]);
      const frame = Buffer.from('legacy lite');
      const blob = encrypt(mode, key, header, frame, 42);
      const packet = Buffer.concat([header, blob]);
      const out = decrypt(mode, key, packet, header.length);
      assert.deepEqual(out, frame);
    });
  });

  function runDecryptFailureTests(buildFn, mode) {
    it('returns null on wrong key', () => {
      const k1 = randomBytes(32);
      const k2 = randomBytes(32);
      const header = Buffer.alloc(12);
      const frame = Buffer.from('x');
      const packet = buildFn(k1, header, frame);
      assert.equal(decrypt(mode, k2, packet, header.length), null);
    });

    it('returns null on truncated packet', () => {
      const key = randomBytes(32);
      const header = Buffer.alloc(12);
      assert.equal(decrypt(mode, key, header, header.length), null);
    });
  }

  describe('xsalsa20_poly1305_suffix (decrypt only)', () => {
    const mode = 'xsalsa20_poly1305_suffix';

    function buildPacket(key, prefix, frame) {
      const nonce = randomBytes(24);
      const sealed = Buffer.from(nacl.secretbox(frame, nonce, key));
      return { packet: Buffer.concat([prefix, sealed, nonce]), nonce };
    }

    it('decrypts a valid packet', () => {
      const key = randomBytes(32);
      const header = Buffer.from([0x80, 0x78, 0x00, 0x01, 0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x12, 0x34]);
      const frame = Buffer.from('suffix test');
      const { packet } = buildPacket(key, header, frame);
      const out = decrypt(mode, key, packet, header.length);
      assert.deepEqual(out, frame);
    });

    runDecryptFailureTests((k, h, f) => buildPacket(k, h, f).packet, mode);
  });

  describe('xsalsa20_poly1305 (decrypt only)', () => {
    const mode = 'xsalsa20_poly1305';

    function buildPacket(key, header, frame) {
      const nonce = Buffer.alloc(24);
      header.copy(nonce, 0, 0, 12);
      const sealed = Buffer.from(nacl.secretbox(frame, nonce, key));
      return Buffer.concat([header, sealed]);
    }

    it('decrypts a valid packet', () => {
      const key = randomBytes(32);
      const header = Buffer.from([0x80, 0x78, 0x00, 0x01, 0x00, 0x00, 0x03, 0xe8, 0x00, 0x00, 0x12, 0x34]);
      const frame = Buffer.from('full test');
      const packet = buildPacket(key, header, frame);
      const out = decrypt(mode, key, packet, header.length);
      assert.deepEqual(out, frame);
    });

    runDecryptFailureTests(buildPacket, mode);
  });
});
