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
    await db.collection('users').createIndex({ "subscription.subscriptionId": 1 });
    await db.collection('payment_logs').createIndex({ userId: 1 });
    await db.collection('users').createIndex({ linkedProviderIds: 1 });
    await db.collection('users').createIndex({ email: 1 });

    await db.collection('api_keys').createIndex({ keyHash: 1 }, { unique: true });
    await db.collection('api_keys').createIndex({ wyiUserId: 1 });
    await db.collection('users').createIndex({ apiInboxes: 1 });
    await db.collection('users').createIndex({ scheduledDeletionAt: 1, deletionStatus: 1 });
    await db.collection('deletion_cooldowns').createIndex({ type: 1, value: 1 }, { unique: true });
    await db.collection('deletion_cooldowns').createIndex({ blockedUntil: 1 });

    // Indexes for new features
    await db.collection('users').createIndex({ fingerprints: 1 });         // trial abuse / chargeback lookup
    await db.collection('users').createIndex({ cardFingerprints: 1 });      // chargeback card lookup
    await db.collection('users').createIndex({ banStatus: 1 });             // admin queries
    await db.collection('users').createIndex(                               // trial reminder sweep
      { 'subscription.status': 1, 'subscription.nextBilledAt': 1 },
    );
    await db.collection('users').createIndex(
      { 'apiSubscription.status': 1, 'apiSubscription.nextBilledAt': 1 },
    );

    return { db, gfs };
  } catch (error) {
    console.error('Failed to connect to MongoDB', error);
    process.exit(1);
  }
}

export { db, gfs };

// ─────────────────────────────────────────────────────────────────────────────
//  Interfaces
// ─────────────────────────────────────────────────────────────────────────────

export interface IUserSettings {
  theme?: 'light' | 'dark' | 'system';
  notifications?: boolean;
  sound?: boolean;
  layout?: string;
  smartOtp?: boolean;
  shortcuts?: Record<string, string>;
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

  cancelAtPeriodEnd?: boolean;
  periodEnd?: string;
  canceledAt?: string;

  startTime: string;
  payerEmail?: string;
  payerName?: string;
  lastUpdated: Date;

  customerId?: string;
  nextBilledAt?: string;
  scheduledChange?: any;
  pausedAt?: string;
}

export interface IPaymentLog {
  _id?: any;
  userId: string;
  transactionType: 'subscription_created' | 'subscription_renewed' | 'subscription_cancelled' | 'refund';
  provider: string;
  subscriptionId: string;
  amount?: string;
  currency?: string;
  details: any;
  createdAt: Date;
}

export interface IUser {
  _id?: any;
  wyiUserId: string;
  email: string;
  name: string;
  plan: 'free' | 'pro';
  lastLoginAt?: Date;
  createdAt?: Date;

  settings?: IUserSettings;
  subscription?: ISubscription;

  customDomains: {
    domain: string;
    verified: boolean;
    mxRecord: string;
    txtRecord: string;
  }[];
  mutedSenders: string[];
  inboxes?: string[];
  inboxNotes?: Array<{
    inbox: string;
    note: string;
  }>;

  inboxHistory?: string[];
  hadTrial?: boolean;

  // ── Developer API (v1) ────────────────────────────────────────────────────
  apiPlan?: 'free' | 'developer' | 'startup' | 'growth' | 'enterprise';
  apiCredits?: number;
  apiInboxes?: string[];
  apiSubscription?: ISubscription;
  hadApiTrial?: boolean;
  receivedProBonusCredits?: boolean;
  everReceivedProBonusCredits?: boolean;
  proBonusCredits?: number;
  fcmToken?: string;

  // ── Account deletion ──────────────────────────────────────────────────────
  deletionStatus?: 'none' | 'scheduled' | 'permanent';
  deletionRequestedAt?: Date;
  scheduledDeletionAt?: Date;
  ipAtDeletionRequest?: string;

  // ── Abuse / Fingerprinting ─────────────────────────────────────────────────
  // All device fingerprints ever associated with this account.
  // Used for:
  //   1. Free-trial abuse: new accounts on same fingerprint inherit hadTrial
  //   2. Chargeback detection: cross-reference with cardFingerprints
  fingerprints?: string[];

  // SHA-256 hashes of payment card (last4 + expMonth + expYear).
  // Stored on first subscription activation and checked on every subsequent one.
  cardFingerprints?: string[];

  // ── Ban system ────────────────────────────────────────────────────────────
  banStatus?: 'none' | 'warned' | 'banned';
  banReason?: string;
  banAt?: Date;
  chargebackOffenses?: number; // incremented on each detected chargeback attempt

  // ── Trial reminder flags (dedupe so we never send twice) ──────────────────
  trialReminderSent24h?: boolean;
  trialReminderSent3h?: boolean;
  apiTrialReminderSent24h?: boolean;
  apiTrialReminderSent3h?: boolean;
}

export interface IDeletionCooldown {
  _id?: any;
  type: 'email' | 'ip';
  value: string;
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
  wyiUserId: string;
  keyHash: string;
  keyPrefix: string;
  name: string;
  active: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt?: Date;
}