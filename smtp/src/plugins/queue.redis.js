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
  const stream = connection.transaction.message_stream;
  const recipients = connection.transaction.rcpt_to;

  plugin.cfg = plugin.config.get('queue.redis.ini');

  const mailbox_size = ((plugin.cfg.main || {}).mailbox_size || 10) - 1;
  const mailbox_ttl = ((plugin.cfg.main || {}).mailbox_ttl || 3600);

  plugin.logdebug(JSON.stringify(recipients));

  if (!!redis) {
    const chunks = [];
    let body = "";
    stream.on("data", (chunk) => {
      chunks.push(chunk);
    });
    stream.on("end", () => {
      body = Buffer.concat(chunks); // Keep body as a Buffer for simpleParser
      simpleParser(body, (error, parsed) => {
        if (error) {
          plugin.logerror("Error parsing email:", error);
          return next(DENY);
        }
        
        recipients.forEach((recipient) => {
          const destination = recipient.user.toLowerCase();
          const key = `mailbox:${destination}`;
          const message = {
            id: shortid.generate(),
            from: parsed.from.text,
            to: destination,
            subject: parsed.subject || '(no subject)', // Handle missing subject
            date: format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
          };

          // --- MODIFICATION START ---
          // Prepare attachments for JSON by encoding content to Base64
          const attachments = parsed.attachments.map(att => ({
            filename: att.filename,
            contentType: att.contentType,
            content: att.content.toString('base64'), // Encode buffer to Base64 string
            size: att.size,
          }));

          const messageBody = {
            id: message.id,
            from: message.from,
            to: message.to,
            subject: message.subject,
            date: message.date,
            html: parsed.html || parsed.textAsHtml,
            // DO NOT store the raw body anymore unless you have a specific need for it
            // body: body.toString(), 
            attachments: attachments, // Add the prepared attachments array
          };
          // --- MODIFICATION END ---
          
          plugin.logwarn("Saving message from " + connection.transaction.mail_from.original + " to " + destination);

          // Save to Redis lists
          redis.lPush(key, JSON.stringify(message));
          redis.lPush(key + ":body", JSON.stringify(messageBody));
          redis.lTrim(key, 0, mailbox_size);
          redis.lTrim(key + ":body", 0, mailbox_size);
          redis.expire(key, mailbox_ttl);
          redis.expire(key + ":body", mailbox_ttl);

          // Publish event for new mail
          redis.publish(`mailbox:events:${destination}`, JSON.stringify({
            type: 'new_mail',
            mailbox: destination,
            messageId: message.id,
            subject: message.subject,
            from: message.from,
            date: message.date,
          }));
        });

        next(OK);
      });
    });
    stream.resume()
  }
};