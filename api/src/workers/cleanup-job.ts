// api/src/workers/cleanup-job.ts
// 
// Run manually:   npx ts-node src/cleanup-job.ts
// Or via cron:    0 3 * * * cd /path/to/api && npx ts-node src/cleanup-job.ts >> /var/log/email-cleanup.log 2>&1
// (Runs daily at 3 AM)
//
// Deletion policy (based on user's lastLoginAt):
//
//  ┌──────────────────────┬────────────────────────────────────────────────────┐
//  │ Last login           │ Action                                             │
//  ├──────────────────────┼────────────────────────────────────────────────────┤
//  │ > 180 days ago       │ Delete ALL emails (user is effectively gone)       │
//  │ 90–180 days ago      │ Delete emails older than 60 days, keep last 50     │
//  │ 30–90 days ago       │ Delete emails older than 120 days, keep last 100   │
//  │ < 30 days (active)   │ Delete emails older than 365 days, keep last 500   │
//  │ No login date        │ Delete ALL emails (orphaned account)               │
//  └──────────────────────┴────────────────────────────────────────────────────┘
//
// Free/anonymous users in saved_emails (shouldn't exist but we clean them up too).
// GridFS attachments are always deleted alongside their parent emails.

import { MongoClient, GridFSBucket, ObjectId } from 'mongodb';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME   = 'freecustomemail';

const NOW = new Date();

function daysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------
// Tiered policy
// ---------------------------------------------------------------
interface CleanupPolicy {
    label: string;
    deleteAllEmails: boolean;         // Wipe everything
    deleteEmailsOlderThan?: Date;     // Cutoff date for partial cleanup
    keepAtLeast: number;              // Always preserve N most recent emails
}

function getPolicyForUser(lastLoginAt: Date | null): CleanupPolicy {
    if (!lastLoginAt) {
        return { label: 'NO_LOGIN - wipe all', deleteAllEmails: true, keepAtLeast: 0 };
    }

    const daysSince = (NOW.getTime() - lastLoginAt.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSince > 180) {
        return {
            label: `INACTIVE_180+ (${Math.floor(daysSince)}d) - wipe all`,
            deleteAllEmails: true,
            keepAtLeast: 0,
        };
    }

    if (daysSince > 90) {
        return {
            label: `INACTIVE_90-180 (${Math.floor(daysSince)}d) - keep 60d / last 50`,
            deleteAllEmails: false,
            deleteEmailsOlderThan: daysAgo(60),
            keepAtLeast: 50,
        };
    }

    if (daysSince > 30) {
        return {
            label: `INACTIVE_30-90 (${Math.floor(daysSince)}d) - keep 120d / last 100`,
            deleteAllEmails: false,
            deleteEmailsOlderThan: daysAgo(120),
            keepAtLeast: 100,
        };
    }

    return {
        label: `ACTIVE (<30d) - keep 365d / last 500`,
        deleteAllEmails: false,
        deleteEmailsOlderThan: daysAgo(365),
        keepAtLeast: 500,
    };
}

// ---------------------------------------------------------------
// GridFS cleanup
// ---------------------------------------------------------------
async function deleteGridFSFiles(gfs: GridFSBucket, gridfsIds: any[]): Promise<number> {
    let deleted = 0;
    await Promise.allSettled(
        gridfsIds.map(async (id) => {
            try {
                const objectId = typeof id === 'string' ? new ObjectId(id) : id;
                await gfs.delete(objectId);
                deleted++;
            } catch (_) {
                // File may already be missing — safe to ignore
            }
        })
    );
    return deleted;
}

// ---------------------------------------------------------------
// Per-user cleanup
// ---------------------------------------------------------------
async function cleanupUserEmails(
    db: any,
    gfs: GridFSBucket,
    userId: ObjectId,
    userEmail: string,
    inboxes: string[],
    policy: CleanupPolicy,
    dryRun: boolean
): Promise<{ emailsDeleted: number; filesDeleted: number }> {

    let totalEmailsDeleted = 0;
    let totalFilesDeleted = 0;

    // ── Case 1: Delete everything ──────────────────────────────────────────
    if (policy.deleteAllEmails) {
        // Collect all GridFS file IDs first
        const allEmails = await db.collection('saved_emails')
            .find({ userId }, { projection: { 'attachments.gridfs_id': 1, 'attachments.gridfsId': 1 } })
            .toArray();

        const gridfsIds = allEmails.flatMap((doc: any) =>
            (doc.attachments || [])
                .map((att: any) => att.gridfs_id || att.gridfsId)
                .filter(Boolean)
        );

        if (!dryRun) {
            if (gridfsIds.length > 0) {
                totalFilesDeleted += await deleteGridFSFiles(gfs, gridfsIds);
            }
            const result = await db.collection('saved_emails').deleteMany({ userId });
            totalEmailsDeleted += result.deletedCount;
        } else {
            totalEmailsDeleted = allEmails.length;
            totalFilesDeleted  = gridfsIds.length;
        }

        return { emailsDeleted: totalEmailsDeleted, filesDeleted: totalFilesDeleted };
    }

    // ── Case 2: Partial cleanup ────────────────────────────────────────────
    // For each inbox, find which email IDs to keep (N most recent),
    // then delete everything older than cutoff that isn't in the keep list.

    const allInboxes = inboxes.length > 0
        ? inboxes
        : (await db.collection('saved_emails').distinct('mailbox', { userId }));

    for (const mailbox of allInboxes) {
        // Get the most recent N email IDs — these are protected from deletion
        const recentEmails = await db.collection('saved_emails')
            .find({ userId, mailbox })
            .sort({ date: -1 })
            .limit(policy.keepAtLeast)
            .project({ _id: 1 })
            .toArray();

        const keepIds = recentEmails.map((e: any) => e._id);

        // Find emails to delete: older than cutoff AND not in the keep set
        const toDeleteQuery: any = {
            userId,
            mailbox,
            date: { $lt: policy.deleteEmailsOlderThan },
        };

        if (keepIds.length > 0) {
            toDeleteQuery._id = { $nin: keepIds };
        }

        const toDelete = await db.collection('saved_emails')
            .find(toDeleteQuery, { projection: { _id: 1, 'attachments.gridfs_id': 1, 'attachments.gridfsId': 1 } })
            .toArray();

        if (toDelete.length === 0) continue;

        const gridfsIds = toDelete.flatMap((doc: any) =>
            (doc.attachments || [])
                .map((att: any) => att.gridfs_id || att.gridfsId)
                .filter(Boolean)
        );

        const deleteDocIds = toDelete.map((doc: any) => doc._id);

        if (!dryRun) {
            if (gridfsIds.length > 0) {
                totalFilesDeleted += await deleteGridFSFiles(gfs, gridfsIds);
            }
            const result = await db.collection('saved_emails').deleteMany({
                _id: { $in: deleteDocIds }
            });
            totalEmailsDeleted += result.deletedCount;
        } else {
            totalEmailsDeleted += toDelete.length;
            totalFilesDeleted  += gridfsIds.length;
        }
    }

    return { emailsDeleted: totalEmailsDeleted, filesDeleted: totalFilesDeleted };
}

// ---------------------------------------------------------------
// Orphan cleanup — emails in saved_emails with no matching user
// ---------------------------------------------------------------
async function cleanupOrphanEmails(db: any, gfs: GridFSBucket, dryRun: boolean) {
    console.log('\n[Orphan Cleanup] Checking for emails with no matching user...');

    const userIds = await db.collection('users')
        .distinct('_id', { plan: 'pro' });

    const userIdStrings = new Set(userIds.map((id: ObjectId) => id.toString()));

    // Find all distinct userIds in saved_emails
    const emailUserIds = await db.collection('saved_emails').distinct('userId');

    const orphanedIds = emailUserIds.filter((id: any) => !userIdStrings.has(id?.toString()));

    if (orphanedIds.length === 0) {
        console.log('[Orphan Cleanup] No orphaned email sets found.');
        return;
    }

    console.log(`[Orphan Cleanup] Found ${orphanedIds.length} orphaned userId(s): ${orphanedIds.join(', ')}`);

    for (const orphanId of orphanedIds) {
        const orphanDocs = await db.collection('saved_emails')
            .find({ userId: orphanId }, { projection: { _id: 1, 'attachments.gridfs_id': 1 } })
            .toArray();

        const gridfsIds = orphanDocs.flatMap((d: any) =>
            (d.attachments || []).map((a: any) => a.gridfs_id).filter(Boolean)
        );

        console.log(`  userId ${orphanId}: ${orphanDocs.length} emails, ${gridfsIds.length} GridFS files`);

        if (!dryRun) {
            if (gridfsIds.length > 0) await deleteGridFSFiles(gfs, gridfsIds);
            await db.collection('saved_emails').deleteMany({ userId: orphanId });
        }
    }
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
async function runCleanup(dryRun = false) {
    console.log('='.repeat(60));
    console.log(`MongoDB Email Cleanup — ${NOW.toISOString()}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (deleting data)'}`);
    console.log('='.repeat(60));

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db  = client.db(DB_NAME);
    const gfs = new GridFSBucket(db, { bucketName: 'attachments' });

    // ── Pre-run stats ──────────────────────────────────────────────────────
    const totalEmailsBefore = await db.collection('saved_emails').countDocuments();
    const totalFilesBefore  = await db.collection('attachments.files').countDocuments();

    console.log(`\nBefore: ${totalEmailsBefore.toLocaleString()} emails, ${totalFilesBefore.toLocaleString()} GridFS files\n`);

    // ── Process each pro user ──────────────────────────────────────────────
    const proUsers = await db.collection('users')
        .find({ plan: 'pro' })
        .project({ _id: 1, email: 1, lastLoginAt: 1, inboxes: 1 })
        .toArray();

    let grandTotalEmails  = 0;
    let grandTotalFiles   = 0;
    const userSummaries: any[] = [];

    for (const user of proUsers) {
        const policy = getPolicyForUser(user.lastLoginAt || null);
        const { emailsDeleted, filesDeleted } = await cleanupUserEmails(
            db, gfs,
            user._id,
            user.email,
            user.inboxes || [],
            policy,
            dryRun
        );

        grandTotalEmails += emailsDeleted;
        grandTotalFiles  += filesDeleted;

        if (emailsDeleted > 0 || filesDeleted > 0) {
            userSummaries.push({
                email: user.email,
                lastLogin: user.lastLoginAt?.toISOString()?.split('T')[0] ?? 'never',
                policy: policy.label,
                emailsDeleted,
                filesDeleted,
            });
        }
    }

    // ── Orphan cleanup ─────────────────────────────────────────────────────
    await cleanupOrphanEmails(db, gfs, dryRun);

    // ── Summary ───────────────────────────────────────────────────────────
    const totalEmailsAfter = dryRun
        ? totalEmailsBefore
        : await db.collection('saved_emails').countDocuments();

    console.log('\n' + '='.repeat(60));
    console.log('Cleanup Summary');
    console.log('='.repeat(60));

    if (userSummaries.length > 0) {
        console.log('\nUsers affected:');
        console.table(userSummaries);
    } else {
        console.log('\nNo emails needed cleanup.');
    }

    console.log(`\nTotal emails ${dryRun ? 'to delete' : 'deleted'}: ${grandTotalEmails.toLocaleString()}`);
    console.log(`Total GridFS files ${dryRun ? 'to delete' : 'deleted'}: ${grandTotalFiles.toLocaleString()}`);
    console.log(`Emails remaining: ${(totalEmailsBefore - (dryRun ? 0 : grandTotalEmails)).toLocaleString()}`);

    await client.close();
}

// ── CLI entry point ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

runCleanup(isDryRun)
    .then(() => {
        console.log('\nDone.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('\nCleanup FAILED:', err);
        process.exit(1);
    });