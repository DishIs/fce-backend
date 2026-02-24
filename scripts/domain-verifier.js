// workers/domain-verifier.js — runs every 6 hours, never touches SMTP path

async function reverifyAllDomains() {
    const users = await db.collection('users').find({
        plan: 'pro',
        'customDomains.verified': true
    }).toArray();

    for (const user of users) {
        for (const domainRecord of user.customDomains.filter(d => d.verified)) {
            const domain = domainRecord.domain;
            try {
                const [txtRecords, mxRecords] = await Promise.all([
                    dns.resolveTxt(domain).catch(() => []),
                    dns.resolveMx(domain).catch(() => [])
                ]);

                const txtOk = txtRecords.flat().includes(domainRecord.txtRecord);
                const mxOk  = mxRecords.some(mx =>
                    mx.exchange.toLowerCase().endsWith('.freecustom.email')
                );

                if (!txtOk || !mxOk) {
                    await db.collection('users').updateOne(
                        { _id: user._id, 'customDomains.domain': domain },
                        { $set: { 'customDomains.$.verified': false } }
                    );
                    await redisClient.sRem('verified_custom_domains', domain);
                    console.log(`[verifier] Revoked ${domain} — TXT:${txtOk} MX:${mxOk}`);
                }
            } catch (err) {
                // DNS flap — don't revoke on a single failure, log and move on
                console.warn(`[verifier] DNS error for ${domain}: ${err.message}`);
            }
        }
    }
}