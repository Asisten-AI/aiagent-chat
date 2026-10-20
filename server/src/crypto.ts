import crypto from 'node:crypto';
import { env } from './env';

const key = Buffer.from(env.ENCRYPTION_KEY, 'base64');
if (key.length !== 32) throw new Error('ENCRYPTION_KEY harus 32 byte base64 (openssl rand -base64 32)');

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
