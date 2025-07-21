// queue.redis.js

const shortid = require('shortid');
const format = require('date-fns').format;

exports.register = function () {
    const plugin = this;
    plugin.load_ini();
    plugin.register_hook('data', 'parse_message');
    plugin.register_hook('queue', 'save_to_redis');
};

exports.load_ini = function () {
    const plugin = this;
    plugin.cfg = plugin.config.get('queue.redis.ini', () => plugin.load_ini());
};

exports.parse_message = function (next, connection) {
    const plugin = this;
    plugin.cfg = plugin.config.get('queue.redis.ini');
    const txn = connection.transaction;

    // Enable body/attachments parsing
    txn.parse_body = true;
    txn.discard_data = false;

    txn.notes.attachments = [];

    txn.attachment_hooks((ct, filename, body, stream) => {
        connection.loginfo(`Got attachment ${filename}`);
        // collect buffer or body text
        const content = body ? body.toString('base64') : null;
        txn.notes.attachments.push({ filename, contentType: ct, content });
    });

    next();
};

exports.save_to_redis = function (next, connection) {
    const plugin = this;
    const redis = connection.server.notes.redis;
    const txn = connection.transaction;

    plugin.cfg = plugin.config.get('queue.redis.ini');
    const mailbox_size = ((plugin.cfg.main || {}).mailbox_size || 10) - 1;
    const mailbox_ttl = (plugin.cfg.main || {}).mailbox_ttl || 3600;

    if (!redis) {
        plugin.logerror("Redis connection not found!");
        return next(DENYSOFT, "Backend unavailable.");
    }

    try {
        txn.rcpt_to.forEach((recip) => {
            const toUser = recip.user.toLowerCase();
            const key = `mailbox:${toUser}`;
            const attachments = txn.notes.attachments.map(att => ({
                filename: att.filename,
                contentType: att.contentType,
                content: att.content,
            }));

            const summary = {
                id: shortid.generate(),
                from: txn.mail_from.original,
                to: toUser,
                subject: txn.header.get('Subject') || '(no subject)',
                date: format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
            };

            const body = {
                ...summary,
                html: txn.body.html || txn.body.textAsHtml || '',
                attachments,
            };

            plugin.loginfo(`Saving message ${summary.id} to ${toUser}`);

            redis.multi()
                .lPush(key, JSON.stringify(summary))
                .lPush(`${key}:body`, JSON.stringify(body))
                .lTrim(key, 0, mailbox_size)
                .lTrim(`${key}:body`, 0, mailbox_size)
                .expire(key, mailbox_ttl)
                .expire(`${key}:body`, mailbox_ttl)
                .publish(`mailbox:events:${toUser}`, JSON.stringify({
                    type: 'new_mail',
                    mailbox: toUser,
                    messageId: summary.id,
                    subject: summary.subject,
                    from: summary.from,
                    date: summary.date,
                }))
                .exec();
        });

        next(OK);

    } catch (err) {
        plugin.logerror("Error saving to Redis:", err);
        next(DENYSOFT, "Error processing message.");
    }
};
