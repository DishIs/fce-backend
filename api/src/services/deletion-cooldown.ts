// api/src/services/deletion-cooldown.ts — cooldown checks only (no dependency on user.ts)
import { db } from '../config/mongo';
import type { IDeletionCooldown } from '../config/mongo';

export async function isEmailInDeletionCooldown(value: string): Promise<boolean> {
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  const doc = await db.collection<IDeletionCooldown>('deletion_cooldowns').findOne({ type: 'email', value: normalized });
  return doc != null && doc.blockedUntil > new Date();
}

export async function isIpInDeletionCooldown(ip: string): Promise<boolean> {
  const normalized = (ip || '').trim();
  if (!normalized) return false;
  const doc = await db.collection<IDeletionCooldown>('deletion_cooldowns').findOne({ type: 'ip', value: normalized });
  return doc != null && doc.blockedUntil > new Date();
}
