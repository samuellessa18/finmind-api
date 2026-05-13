'use strict';

const crypto = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const IV_BYTES   = 12;  // 96-bit IV recommended for GCM
const TAG_BYTES  = 16;
const KEY_BYTES  = 32;

function getKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY não definida');

  let keyBuf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    keyBuf = Buffer.from(raw, 'hex');
  } else {
    keyBuf = Buffer.from(raw);
  }

  if (keyBuf.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY deve ter ${KEY_BYTES} bytes (64 hex chars)`);
  }
  return keyBuf;
}

/**
 * Encrypts plaintext with AES-256-GCM.
 * Returns a base64 string: iv(12) + tag(16) + ciphertext
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv  = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypts a base64 string produced by encrypt().
 */
function decrypt(encoded) {
  if (!encoded) return null;
  const key = getKey();
  const buf = Buffer.from(encoded, 'base64');

  const iv         = buf.subarray(0, IV_BYTES);
  const tag        = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Deterministic HMAC-SHA256 for indexed lookup fields.
 * Use this when you need to find a record by an encrypted value.
 * NOT reversible — pair with encrypt() for the actual stored value.
 */
function hmac(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  return crypto
    .createHmac('sha256', key)
    .update(plaintext, 'utf8')
    .digest('base64');
}

module.exports = { encrypt, decrypt, hmac };
