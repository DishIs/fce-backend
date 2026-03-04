import { MongoClient, Db, GridFSBucket } from 'mongodb';
import { config } from 'dotenv';

config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = 'freecustomemail';

let client: MongoClient;
let db: Db;
let gfs: GridFSBucket;

export async function connectToMongo() {
  if (db) {
    return { db, gfs };
  }
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    gfs = new GridFSBucket(db, { bucketName: 'attachments' });
    console.log('Successfully connected to MongoDB.');

    // Create necessary indexes for performance
    await db.collection('users').createIndex({ wyiUserId: 1 }, { unique: true });
    await db.collection('users').createIndex({ "customDomains.domain": 1 });
    await db.collection('saved_emails').createIndex({ userId: 1, mailbox: 1 });
    // Index for subscription lookups
    await db.collection('users').createIndex({ "subscription.subscriptionId": 1 });
    await db.collection('payment_logs').createIndex({ userId: 1 });
    await db.collection('users').createIndex({ linkedProviderIds: 1 });
    await db.collection('users').createIndex({ email: 1 });    // for email lookup

    await db.collection('api_keys').createIndex({ keyHash: 1 }, { unique: true });
    await db.collection('api_keys').createIndex({ wyiUserId: 1 });
    await db.collection('users').createIndex({ apiInboxes: 1 });
    await db.collection('users').createIndex({ scheduledDeletionAt: 1, deletionStatus: 1 });
    await db.collection('deletion_cooldowns').createIndex({ type: 1, value: 1 }, { unique: true });
    await db.collection('deletion_cooldowns').createIndex({ blockedUntil: 1 });

    return { db, gfs };
  } catch (error) {
    console.error('Failed to connect to MongoDB', error);
    process.exit(1);
  }
}

export { db, gfs };

// --- Interfaces ---

export interface IUserSettings {
  theme?: 'light' | 'dark' | 'system';
  notifications?: boolean;
  sound?: boolean;
  layout?: string;
  smartOtp?: boolean;
  shortcuts?: Record<string, string>;
  // Allow flexibility for future frontend settings
  [key: string]: any;
}

export interface ISubscription {
  provider: 'paypal' | 'paddle' | 'manual';
  subscriptionId: string;
  planId?: string;

  // ── Status ──────────────────────────────────────────────────────────────
  // 'ACTIVE'   — paid and running (including trials)
  // 'TRIALING' — in trial period, not yet charged
  // 'SUSPENDED'— payment failed, Paddle retrying
  // 'CANCELLED'— set by expiry worker AFTER scheduledDowngradeAt passes
  // 'EXPIRED'  — edge case (manual or PayPal)
  status: 'TRIALING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED' | 'APPROVAL_PENDING';

  // ── Cancellation state ──────────────────────────────────────────────────
  // cancelAtPeriodEnd: true while the sub is cancelled but still within the
  // paid period. UI shows "Cancels on <periodEnd>" instead of a CANCELLED badge.
  // The expiry worker sets status → CANCELLED once periodEnd has passed.
  cancelAtPeriodEnd?: boolean;
  periodEnd?: string;   // ISO — when current paid period ends
  canceledAt?: string;   // ISO — when user clicked cancel

  // ── Common fields ────────────────────────────────────────────────────────
  startTime: string;
  payerEmail?: string;
  payerName?: string;
  lastUpdated: Date;

  // ── Paddle-specific ──────────────────────────────────────────────────────
  customerId?: string;   // ctm_xxx — needed for portal sessions
  nextBilledAt?: string;
  scheduledChange?: any;
  pausedAt?: string;
}

export interface IPaymentLog {
  _id?: any;
  userId: string; // wyiUserId
  transactionType: 'subscription_created' | 'subscription_renewed' | 'subscription_cancelled' | 'refund';
  provider: string;
  subscriptionId: string;
  amount?: string;
  currency?: string;
  details: any; // Full payload from provider
  createdAt: Date;
}

export interface IUser {
  _id?: any;
  wyiUserId: string; // Used as the primary lookup ID (Legacy/Auth ID)
  email: string;
  name: string;
  plan: 'free' | 'pro';
  lastLoginAt?: Date;
  createdAt?: Date;

  // Settings
  settings?: IUserSettings;

  // Billing (Local source of truth)
  subscription?: ISubscription;

  // Features
  customDomains: {
    domain: string;
    verified: boolean;
    mxRecord: string;
    txtRecord: string;
  }[];
  mutedSenders: string[];
  inboxes?: string[];
  inboxHistory?: string[];
  hadTrial?: boolean

  // ── Developer API (v1) — NEW ──────────────────────────────────────────────
  apiPlan?: 'free' | 'developer' | 'startup' | 'growth' | 'enterprise';
  apiCredits?: number;   // never-expiring request credits
  apiInboxes?: string[]; // inboxes registered via POST /v1/inboxes
  fcmToken?: string;

  // ── Account deletion (soft delete → permanent by worker) ────────────────────
  deletionStatus?: 'none' | 'scheduled' | 'permanent';
  deletionRequestedAt?: Date;
  scheduledDeletionAt?: Date;   // cooldown end: after this, worker deletes permanently
  ipAtDeletionRequest?: string; // for 24h IP cooldown after permanent delete
}

/** Cooldown after account deletion: email cannot re-register for 7–14 days, IP for 24h */
export interface IDeletionCooldown {
  _id?: any;
  type: 'email' | 'ip';
  value: string;        // normalized email or IP
  blockedUntil: Date;
  createdAt?: Date;
}

export interface ISavedEmail {
  _id?: any;
  userId: string;
  mailbox: string;
  from: string;
  subject: string;
  date: Date;
  attachments?: any[];
}

export interface IApiKey {
  _id?: any;
  wyiUserId: string;           // owner (canonical wyiUserId)
  keyHash: string;           // SHA-256 of the raw key — NEVER store raw
  keyPrefix: string;           // first 12 chars (e.g. "fce_a1b2c3d4") — safe to display
  name: string;           // user-assigned label
  active: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt?: Date;
}
