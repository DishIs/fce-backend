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
  status: 'TRIALING' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED' | 'APPROVAL_PENDING';
  startTime: string;
  payerEmail?: string;
  payerName?: string;
  lastUpdated: Date;

  // Paddle-specific fields
  nextBilledAt?: string;
  scheduledChange?: any;
  pausedAt?: string;
  canceledAt?: string;
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