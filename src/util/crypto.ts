import {
  createCipheriv, createDecipheriv, createHash, createHmac, randomBytes,
  randomInt, timingSafeEqual,
} from 'node:crypto';

export function randomId(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// Uniformly distributed 8-digit numeric password.
export function randomDigits(n = 8): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String(randomInt(0, 10));
  return s;
}

export function sha256hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function hmacB64(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function aesKey(secret: string): Buffer {
  return createHash('sha256').update('draftbox-enc:' + secret).digest();
}

// AES-256-GCM; output is base64url(iv | tag | ciphertext).
export function encrypt(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

export function decrypt(secret: string, payload: string): string {
  const raw = Buffer.from(payload, 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', aesKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
