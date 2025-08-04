// haraka/plugins/data.blocklist.js
const redis = require('redis');
const { MongoClient } = require('mongodb');

let redisClient;
let mongoClient;
let db;

exports.register = function () {
    this.load_ini();
    this.register_hook('data', 'check_blocklist');
};

exports.load_ini = function () {
    // Same ini loading as rcpt_to_mongo.js
    const plugin = this;
    plugin.cfg = plugin.config.get('data.blocklist.ini', 'ini');
    const redisUrl = plugin.cfg.main.redis_url || 'redis://localhost:6379';
    const mongoUrl = plugin.cfg.main.mongo_url || 'mongodb://localhost:27017';
    if (!redisClient) { /* setup */ }
    if (!mongoClient) { /* setup */ }
};

exports.check_blocklist = async function (next, connection) {
    const plugin = this;
    const sender = connection.transaction.mail_from.address().toLowerCase();
    const recipients = connection.transaction.rcpt_to;

    for (const recipient of recipients) {
        const recipientUser = recipient.user.toLowerCase();
        
        // We need to find the WYI user ID associated with this inbox.
        // Let's assume the frontend API maintains a mapping: `inbox:<inbox_name>` -> `wyiUserId`
        const wyiUserId = await redisClient.get(`inboxmap:${recipientUser}`);

        if (!wyiUserId) continue; // Not a logged-in user's inbox

        const userMuteListKey = `mutelist:${wyiUserId}`;
        
        try {
            const isMuted = await redisClient.sIsMember(userMuteListKey, sender);
            if (isMuted) {
                plugin.logwarn(`Blocking email from ${sender} to ${recipientUser} as per mute list.`);
                return next(DENY, 'Sender is blocked by recipient.');
            }
        } catch (e) {
            plugin.logerror(`Redis error checking mute list: ${e}`);
        }
    }

    next();
};