// api/src/redis-cleanup.ts
//
// Runs as a standalone Docker worker.
// Periodically scans for stale / orphaned maildrop:* Redis keys and
// deletes or fixes them. Safe to run continuously alongside production.
//
// Run manually:  npx ts-node src/redis-cleanup.ts [--once] [--dry-run]
//   --once       Single pass then exit
//   --dry-run    Report only, no deletes

import { createClient } from 'redis';
import dotenv from 'dotenv';
dotenv.config();

const REDIS_URL   = process.env.REDIS_URL || 'redis://localhost:6379';
const INTERVAL_MS = parseInt(process.env.REDIS_CLEANUP_INTERVAL_MS || '', 10)
                    || 6 * 60 * 60 * 1000; // default 6h

const MAX_TTL: Record<string, number> = {
    anon: 10 * 60 * 60, // 10h
    free: 24 * 60 * 60, // 24h
};

interface SweepCounts {
    deleted: number;
    orphan:  number;
    skipped: number;
    error:   number;
}

// ── Core sweep ───────────────────────────────────────────────────────────────

async function runSweep(
    redis:  ReturnType<typeof createClient>,
    dryRun: boolean,
): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log(`Redis Key Cleanup — ${new Date().toISOString()}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN (no deletes)' : 'LIVE'}`);
    console.log('='.repeat(60));

    const seen: Set<string>  = new Set();
    const counts: SweepCounts = { deleted: 0, orphan: 0, skipped: 0, error: 0 };

    for await (const key of redis.scanIterator({ MATCH: 'maildrop:*', COUNT: 500 })) {
        if (seen.has(key)) continue;
        seen.add(key);

        try {
            // Expected format: maildrop:{plan}:{email}:{index|data}
            const parts   = key.split(':');
            const plan    = parts[1];
            const keyType = parts[parts.length - 1];

            // Pro keys are permanent by design — never touch them
            if (plan === 'pro') {
                counts.skipped++;
                continue;
            }

            if (!['anon', 'free'].includes(plan)) {
                console.warn(`Unknown plan '${plan}': ${key} — skipping`);
                counts.skipped++;
                continue;
            }

            // ── Orphan check: every index must have a data sibling ────────────
            const base       = key.replace(/:(?:index|data)$/, '');
            const siblingKey = keyType === 'index' ? `${base}:data` : `${base}:index`;

            if (!seen.has(siblingKey)) {
                const siblingExists = await redis.exists(siblingKey);
                if (!siblingExists) {
                    console.log(`[orphan]  ${key}`);
                    if (!dryRun) await redis.del(key);
                    counts.orphan++;
                    continue;
                }
            }

            // ── TTL check ─────────────────────────────────────────────────────
            const ttl    = await redis.ttl(key); // -1 = no TTL, -2 = gone
            const maxTtl = MAX_TTL[plan];

            if (ttl === -2) continue; // evaporated between scan and TTL check

            if (ttl === -1 || ttl > maxTtl) {
                const reason = ttl === -1 ? 'no TTL' : `TTL ${ttl}s > max ${maxTtl}s`;
                console.log(`[stale]   ${key}  (${reason})`);
                if (!dryRun) await redis.del(key);
                counts.deleted++;
            } else {
                counts.skipped++;
            }

        } catch (err: any) {
            console.error(`Error processing key "${key}": ${err.message}`);
            counts.error++;
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '-'.repeat(60));
    console.log(`Scanned:          ${seen.size.toLocaleString()} keys`);
    console.log(`Deleted (stale):  ${counts.deleted.toLocaleString()}`);
    console.log(`Deleted (orphan): ${counts.orphan.toLocaleString()}`);
    console.log(`Skipped (ok/pro): ${counts.skipped.toLocaleString()}`);
    console.log(`Errors:           ${counts.error}`);
    console.log('='.repeat(60) + '\n');
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const args   = process.argv.slice(2);
    const once   = args.includes('--once');
    const dryRun = args.includes('--dry-run');

    const redis = createClient({ url: REDIS_URL });
    redis.on('error', (err: Error) => console.error('Redis error:', err));
    await redis.connect();

    console.log('Redis cleanup worker connected.');

    try {
        if (once) {
            await runSweep(redis, dryRun);
        } else {
            while (true) {
                await runSweep(redis, dryRun);
                console.log(`Sleeping ${INTERVAL_MS / 1000 / 60} min until next sweep...`);
                await new Promise(r => setTimeout(r, INTERVAL_MS));
            }
        }
    } finally {
        await redis.quit();
    }
}

main().catch(err => {
    console.error('Redis cleanup FAILED:', err);
    process.exit(1);
});