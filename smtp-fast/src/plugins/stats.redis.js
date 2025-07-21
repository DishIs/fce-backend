exports.register = function () {
  const plugin = this;
  plugin.register_hook('queue_ok', 'queued');
  plugin.register_hook('deny', 'denied');
};

exports.queued = function (next, connection) {
  const plugin = this;
  const redis = connection.server.notes.redis;

  if (!!redis) {
    redis.incr("stats:queued", (err, amt) => {
      if (!err) {
        plugin.logwarn(`Queued ${amt} messages`);
        redis.publish("pubsub:queued", amt);
      }
    });
  }
  next();
};

exports.denied = function (next, connection, params) {
  const plugin = this;
  const redis = connection.server.notes.redis;

  let rejectionMessage = params[1] || "";
  if (typeof rejectionMessage === "object" && !!rejectionMessage.reply) {
    rejectionMessage = rejectionMessage.reply;
  }

  let sender;
  let recipients;

  if (connection && connection.transaction && connection.transaction.mail_from) {
    sender = connection.transaction.mail_from;
  } else if (params && params.length >= 5 && Array.isArray(params[4]) && params[4].length > 0 && params[4][0].original) {
    sender = params[4][0].original;
  }

  // plugin.logwarn(`exports.denied ${JSON.stringify(params)}`);

  let output = `Denied message from ${sender} ${connection.remote.ip}`;
  if (connection && connection.transaction && connection.transaction.rcpt_to &&
    connection.transaction.rcpt_to.length > 0) {
    output = output + " to " + connection.transaction.rcpt_to.join(',');
  }
  output = output + ` : ${rejectionMessage}`;

  plugin.logwarn(output);

  if (!!redis) {
    redis.incr("stats:denied", (err, amt) => {
      if (!err) {
        plugin.logwarn(`Denied ${amt} messages`);
        redis.publish("pubsub:denied", amt);
      }
    });
  }
  next();
};
