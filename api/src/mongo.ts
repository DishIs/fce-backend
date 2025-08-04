// api/src/mongo.ts
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


    return { db, gfs };
  } catch (error) {
    console.error('Failed to connect to MongoDB', error);
    process.exit(1);
  }
}

export { db, gfs };

// Define interfaces for our data structures
export interface IUser {
  _id?: any;
  wyiUserId: string;
  plan: 'free' | 'pro';
  customDomains: {
    domain: string;
    verified: boolean;
    mxRecord: string;
    txtRecord: string;
  }[];
  mutedSenders: string[];
}

export interface ISavedEmail {
    _id?: any;
    userId: string;
    mailbox: string;
    from: string;
    subject: string;
    date: Date;
    // ... other fields from the mail object
}