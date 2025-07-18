// queue.redis.js

const shortid = require('shortid');
const format = require('date-fns').format;
const simpleParser = require('mailparser').simpleParser;

exports.register = function () {
  const plugin = this;
  plugin.load_ini();
  plugin.register_hook('queue', 'save_to_redis');
};

exports.load_ini = function () {
  const plugin = this;
  plugin.cfg = plugin.config.get('queue.redis.ini', () => {
    plugin.load_ini();
  });
};

exports.save_to_redis = function (next, connection) {
  const plugin = this;
  const redis = connection.server.notes.redis;
  // The message_stream is a readable stream for the email
  const stream = connection.transaction.message_stream; [6]
  const recipients = connection.transaction.rcpt_to;

  plugin.cfg = plugin.config.get('queue.redis.ini');

  const mailbox_size = ((plugin.cfg.main || {}).mailbox_size || 10) - 1;
  const mailbox_ttl = ((plugin.cfg.main || {}).mailbox_ttl || 3600);

  if (!redis) {
    plugin.logerror("Redis connection not found!");
    // Tell Haraka to defer the email and try again later
    return next(DENYSOFT, "Backend service is temporarily unavailable.");
  }

  // simpleParser can accept a stream directly. This is more efficient.
  simpleParser(stream, (error, parsed) => {
    if (error) {
      plugin.logerror("Error parsing email:", error);
      // Reject the email permanently if it can't be parsed
      return next(DENY, "Error parsing message body.");
    }

    try {
      recipients.forEach((recipient) => {
        const destination = recipient.user.toLowerCase();
        const key = `mailbox:${destination}`;
        const message = {
          id: shortid.generate(),
          from: parsed.from.text,
          to: destination,
          subject: parsed.subject || '(no subject)',
          date: format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
        };

        const attachments = (parsed.attachments || []).map(att => ({
          filename: att.filename,
          contentType: att.contentType,
          content: att.content.toString('base64'),
          size: att.size,
        }));

        const messageBody = {
          id: message.id,
          from: message.from,
          to: message.to,
          subject: message.subject,
          date: message.date,
          html: parsed.html || parsed.textAsHtml,
          attachments: attachments,
        };
        
        plugin.logwarn("Saving message from " + connection.transaction.mail_from.original + " to " + destination);

        // Use a Redis MULTI/EXEC transaction for atomicity
        redis.multi()
          .lPush(key, JSON.stringify(message))
          .lPush(`${key}:body`, JSON.stringify(messageBody))
          .lTrim(key, 0, mailbox_size)
          .lTrim(`${key}:body`, 0, mailbox_size)
          .expire(key, mailbox_ttl)
          .expire(`${key}:body`, mailbox_ttl)
          .publish(`mailbox:events:${destination}`, JSON.stringify({
            type: 'new_mail',
            mailbox: destination,
            messageId: message.id,
            subject: message.subject,
            from: message.from,
            date: message.date,
          }))
          .exec(); // Don't forget to execute the transaction!
      });

      // Signal to Haraka that the email has been successfully queued. [1]
      next(OK);

    } catch (e) {
      plugin.logerror("Error processing or saving to Redis:", e);
      return next(DENYSOFT, "Error processing message.");
    }
  });
};