// /home/dit/maildrop/smtp-fast/src/plugins/stats.redis.js
const { createClient } = require('redis');

let redisClient;

exports.register = function () {
  const plugin = this;
  plugin.load_ini();
  plugin.register_hook('queue_ok', 'queued');
  plugin.register_hook('deny', 'denied');
};

exports.load_ini = function () {
  const plugin = this;
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

  if (!redisClient) {
    redisClient = createClient({ url: redisUrl });
    
    redisClient.on('error', (err) => {
      plugin.logerror(`Stats Redis Client Error: ${err}`);
    });

    redisClient.connect()
      .then(() => plugin.loginfo('Stats Redis client connected.'))
      .catch(err => plugin.logerror(`Stats Redis connect failed: ${err}`));
  }
};

exports.shutdown = async function () {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
  }
};

exports.queued = async function (next, connection) {
  const plugin = this;

  if (redisClient && redisClient.isOpen) {
    try {
      // Increment the counter
      const amt = await redisClient.incr("stats:queued");
      plugin.logdebug(`Queued count updated: ${amt}`);
      
      // Publish event for real-time websockets
      await redisClient.publish("mailbox:events:stats", JSON.stringify({ type: 'stats_update', metric: 'queued', value: amt }));
    } catch (err) {
      plugin.logerror(`Error updating queued stats: ${err}`);
    }
  } else {
    plugin.logerror("Redis not ready for queued stats.");
  }
  
  next();
};

exports.denied = async function (next, connection, params) {
  const plugin = this;

  let rejectionMessage = params[1] || "";
  if (typeof rejectionMessage === "object" && !!rejectionMessage.reply) {
    rejectionMessage = rejectionMessage.reply;
  }

  let sender = "unknown";
  if (connection && connection.transaction && connection.transaction.mail_from) {
    sender = connection.transaction.mail_from;
  } else if (params && params.length >= 5 && Array.isArray(params[4]) && params[4].length > 0 && params[4][0].original) {
    sender = params[4][0].original;
  }

  let output = `Denied message from ${sender} ${connection.remote.ip}`;
  if (connection && connection.transaction && connection.transaction.rcpt_to &&
    connection.transaction.rcpt_to.length > 0) {
    output = output + " to " + connection.transaction.rcpt_to.join(',');
  }
  output = output + ` : ${rejectionMessage}`;

  plugin.logwarn(output);

  if (redisClient && redisClient.isOpen) {
    try {
      // Increment the counter
      const amt = await redisClient.incr("stats:denied");
      plugin.logdebug(`Denied count updated: ${amt}`);

      // Publish event for real-time websockets
      await redisClient.publish("mailbox:events:stats", JSON.stringify({ type: 'stats_update', metric: 'denied', value: amt }));
    } catch (err) {
      plugin.logerror(`Error updating denied stats: ${err}`);
    }
  } else {
    plugin.logerror("Redis not ready for denied stats.");
  }

  next();
};