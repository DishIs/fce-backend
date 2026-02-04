// cleanup-expired-attachments.js
// Run this as a cron job every hour to clean up GridFS files for expired free/anonymous emails

const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const { createClient } = require('redis');

const mongoUrl = process.env.MONGO_URI || 'mongodb://localhost:27017';
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const dbName = 'freecustomemail';

async function cleanupExpiredAttachments() {
    let mongoClient, redisClient, db, gfs;
    
    try {
        // Connect to MongoDB
        mongoClient = new MongoClient(mongoUrl);
        await mongoClient.connect();
        db = mongoClient.db(dbName);
        gfs = new GridFSBucket(db, { bucketName: 'attachments' });
        
        // Connect to Redis
        redisClient = createClient({ url: redisUrl });
        await redisClient.connect();
        
        console.log('Connected to MongoDB and Redis. Starting cleanup...');
        
        // Find all GridFS files for free users (they have TTL and need cleanup)
        const cursor = db.collection('attachments.files').find({
            'metadata.plan': 'free' // Only free users have auto-deletion
        });
        
        let deletedCount = 0;
        let checkedCount = 0;
        
        for await (const file of cursor) {
            checkedCount++;
            
            const { userId, mailbox } = file.metadata;
            
            if (!mailbox) {
                console.log(`Skipping file ${file._id} - no mailbox in metadata`);
                continue;
            }
            
            // Check if the email still exists in Redis
            const dataKey = `maildrop:free:${mailbox}:data`;
            const exists = await redisClient.exists(dataKey);
            
            if (!exists) {
                // The mailbox has expired, delete all its GridFS files
                console.log(`Deleting orphaned GridFS file ${file._id} for expired mailbox ${mailbox}`);
                await gfs.delete(file._id);
                deletedCount++;
            } else {
                // Mailbox exists, but check if this specific email still exists
                // Extract message ID from file metadata if available
                // This is a more granular check - we'd need to enhance metadata to include messageId
                // For now, we'll rely on mailbox-level cleanup
            }
        }
        
        console.log(`Cleanup complete. Checked ${checkedCount} files, deleted ${deletedCount} orphaned attachments.`);
        
    } catch (err) {
        console.error('Error during cleanup:', err);
    } finally {
        if (mongoClient) await mongoClient.close();
        if (redisClient) await redisClient.quit();
    }
}

// Run cleanup
cleanupExpiredAttachments()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });