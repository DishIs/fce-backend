
import crypto from 'crypto';
import { client as redis } from '../config/redis';
import { notifyAnomaly } from './alerts';

/**
 * Verifies the HMAC signature of a request.
 */
export async function verifySignature(
  signature: string,
  timestamp: string,
  method: string,
  path: string,
  body: Buffer | undefined,
  secret: string,
  nonce: string
): Promise<boolean> {
  if (!signature || !timestamp || !method || !path || !nonce) {
    return false;
  }

  const now = Date.now();
  const fiveMinutes = 5 * 60 * 1000;

  // Prevent replay attacks
  if (now - parseInt(timestamp, 10) > fiveMinutes) {
    console.warn(`[Signature] Expired: timestamp ${timestamp} is too old. Current: ${now}`);
    return false;
  }

  const nonceKey = `nonce:${nonce}`;
  
  // Use atomic SET NX to prevent race conditions
  const acquired = await redis.set(nonceKey, '1', { NX: true, EX: 300 });
  if (!acquired) {
    console.warn(`[Signature] Nonce replay detected: ${nonce}`);
    notifyAnomaly('nonce_replay', `Nonce: ${nonce}, Path: ${path}`).catch(() => {});
    return false; // Nonce already exists
  }

  const bodyStr = body ? body.toString() : '';
  const payload = `${timestamp}.${method}.${path}.${bodyStr}`;
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(payload).digest('hex');

  const sigBuffer = Buffer.from(signature || '', 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (sigBuffer.length !== expectedBuffer.length) {
    console.warn(`[Signature] Invalid signature length. Provided: ${sigBuffer.length}, Expected: ${expectedBuffer.length}`);
    return false;
  }

  const isValid = crypto.timingSafeEqual(new Uint8Array(sigBuffer), new Uint8Array(expectedBuffer));
  if (!isValid) {
    console.warn(`[Signature] HMAC mismatch for path: ${path}`);
    notifyAnomaly('hmac_mismatch', `Path: ${path}, Method: ${method}`).catch(() => {});
  }
  return isValid;
}
