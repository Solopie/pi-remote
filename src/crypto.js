import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');
function context(direction, type) {
  if (!(direction === 'host' && ['state', 'ack'].includes(type)) && !(direction === 'client' && type === 'command')) {
    throw new Error('Invalid encrypted packet type');
  }
  return Buffer.from(`pi-remote/v2/${direction}/${type}`);
}
export function seal(key, value, direction, type) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv);
  cipher.setAAD(context(direction, type));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64url'), data: data.toString('base64url') };
}
export function open(key, envelope, direction, type) {
  if (!envelope || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string') throw new Error('Invalid envelope');
  const iv = Buffer.from(envelope.iv, 'base64url');
  const data = Buffer.from(envelope.data, 'base64url');
  if (iv.length !== 12 || data.length < 16) throw new Error('Invalid envelope');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv);
  decipher.setAAD(context(direction, type));
  decipher.setAuthTag(data.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString());
}
