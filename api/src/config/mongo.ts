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

    // ── Indexes ────────────────────────────────────────────────────────────────
    // Core user lookups
    await db.collection('users').createIndex({ wyiUserId: 1 }, { unique: true });
    await db.collection('users').createIndex({ email: 1 });
    await db.collection('users').createIndex({ linkedProviderIds: 1 });
    await db.collection('users').createIndex({ "customDomains.domain": 1 });

    // Saved emails
    await db.collection('saved_emails').createIndex({ userId: 1, mailbox: 1 });

    // Paddle subscription lookups (existing)
    await db.collection('users').createIndex({ "subscription.subscriptionId": 1 });
    await db.collection('users').createIndex({ "apiSubscription.subscriptionId": 1 });

    // NOWPayments (crypto) subscription lookups — needed by findUserByNpSubscriptionId
    await db.collection('users').createIndex({ "cryptoSubscription.subscriptionId": 1 });
    await db.collection('users').createIndex({ "apiCryptoSubscription.subscriptionId": 1 });

    // Payment logs
    await db.collection('payment_logs').createIndex({ userId: 1 });

    // API keys
    await db.collection('api_keys').createIndex({ keyHash: 1 }, { unique: true });
    await db.collection('api_keys').createIndex({ wyiUserId: 1 });
    await db.collection('users').createIndex({ apiInboxes: 1 });

    // Account deletion
    await db.collection('users').createIndex({ scheduledDeletionAt: 1, deletionStatus: 1 });
    await db.collection('deletion_cooldowns').createIndex({ type: 1, value: 1 }, { unique: true });
    await db.collection('deletion_cooldowns').createIndex({ blockedUntil: 1 });

    // Abuse / fingerprinting
    await db.collection('users').createIndex({ fingerprints: 1 });
    await db.collection('users').createIndex({ cardFingerprints: 1 });
    await db.collection('users').createIndex({ banStatus: 1 });

    // Trial reminder sweeps (Paddle)
    await db.collection('users').createIndex(
      { 'subscription.status': 1, 'subscription.nextBilledAt': 1 },
    );
    await db.collection('users').createIndex(
      { 'apiSubscription.status': 1, 'apiSubscription.nextBilledAt': 1 },
    );

    // Scheduled downgrade sweeps (both Paddle and NOWPayments write to these fields)
    await db.collection('users').createIndex({ scheduledDowngradeAt: 1 });
    await db.collection('users').createIndex({ apiScheduledDowngradeAt: 1 });

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
  // ── Added 'nowpayments' to support crypto subscription provider field.
  // Note: cryptoSubscription / apiCryptoSubscription are plain objects in the
  // handler (not typed as ISubscription) because they lack some Paddle-specific
  // fields (planId, payerEmail, etc.). This union is here so payment_logs and
  // any generic subscription utilities can accept the provider string.
  provider: 'paypal' | 'paddle' | 'nowpayments' | 'manual';
  subscriptionId: string;
  planId?: string;

  // ── Status ──────────────────────────────────────────────────────────────
  // 'ACTIVE'          — paid and running
  // 'TRIALING'        — in Paddle trial period, not yet charged (Paddle only)
  // 'PENDING_RENEWAL' — crypto sub cancelled pre-upgrade, awaiting new payment
  // 'SUSPENDED'       — payment failed, provider retrying
  // 'CANCELLED'       — set by expiry worker AFTER scheduledDowngradeAt passes
  // 'EXPIRED'         — edge case (manual or PayPal)
  status: 'TRIALING' | 'ACTIVE' | 'PENDING_RENEWAL' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED' | 'APPROVAL_PENDING';

  cancelAtPeriodEnd?: boolean;
  periodEnd?: string;
  canceledAt?: string;

  startTime: string;
  payerEmail?: string;
  payerName?: string;
  lastUpdated: Date;

  // Paddle-specific (not present on crypto subs)
  customerId?: string;
  nextBilledAt?: string;
  scheduledChange?: any;
  pausedAt?: string;
}

export interface IPaymentLog {
  _id?: any;
  userId: string;
  transactionType: 'subscription_created' | 'subscription_renewed' | 'subscription_cancelled' | 'refund';
  provider: string;   // 'paddle' | 'nowpayments' | 'paypal' | 'manual'
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

  // ── Paddle subscriptions (unchanged) ─────────────────────────────────────
  subscription?: ISubscription;      // app Pro via Paddle
  apiSubscription?: ISubscription;   // API plan via Paddle

  // ── NOWPayments (crypto) subscriptions ────────────────────────────────────
  // Stored as plain objects (not ISubscription) because they lack Paddle-specific
  // fields. Separate fields per product type to avoid collisions.
  cryptoSubscription?: {
    provider:          'nowpayments';
    subscriptionId:    string;
    status:            'ACTIVE' | 'SUSPENDED' | 'PENDING_RENEWAL';
    cancelAtPeriodEnd: boolean;
    startTime:         string;
    lastUpdated:       Date;
    canceledAt?:       string;
    periodEnd?:        string;
    nextBilledAt?:     string;
  };
  apiCryptoSubscription?: {
    provider:          'nowpayments';
    subscriptionId:    string;
    status:            'ACTIVE' | 'SUSPENDED' | 'PENDING_RENEWAL';
    cancelAtPeriodEnd: boolean;
    startTime:         string;
    lastUpdated:       Date;
    canceledAt?:       string;
    periodEnd?:        string;
    nextBilledAt?:     string;
  };

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
  hadApiTrial?: boolean;
  receivedProBonusCredits?: boolean;
  everReceivedProBonusCredits?: boolean;
  proBonusCredits?: number;
  fcmToken?: string;

  // Scheduled downgrade timestamps (written by both Paddle and NOWPayments handlers)
  scheduledDowngradeAt?: Date;       // app Pro → free
  apiScheduledDowngradeAt?: Date;    // API plan → lower plan
  apiScheduledDowngradePlan?: string;

  // ── Account deletion ──────────────────────────────────────────────────────
  deletionStatus?: 'none' | 'scheduled' | 'permanent';
  deletionRequestedAt?: Date;
  scheduledDeletionAt?: Date;
  ipAtDeletionRequest?: string;

  // ── Abuse / Fingerprinting ─────────────────────────────────────────────────
  fingerprints?: string[];
  cardFingerprints?: string[];

  // ── Ban system ────────────────────────────────────────────────────────────
  banStatus?: 'banned' | 'warned' | 'none';
  banReason?: string;
  banAt?: Date;
  chargebackOffenses?: number;

  // ── Trial reminder flags ──────────────────────────────────────────────────
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