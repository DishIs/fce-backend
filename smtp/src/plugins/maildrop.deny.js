exports.register = function () {
  const plugin = this;
  plugin.register_hook('rcpt', 'rcpt');
  plugin.register_hook('rcpt_ok', 'rcpt');
};

exports.rcpt = function (next, connection, params) {
  const plugin = this;
  // Check if params is defined and has at least one element
  if (!params || params.length === 0) {
    plugin.logwarn('No recipient provided');
    return next(DENY, "No recipient provided");
  }

  const recipient_host = params["original_host"]; // Get the recipient address
  // Check if recipient_host is defined in me plugin
  const allowed_rcpt = [
    "saleis.live",
    "arrangewith.me",
    "areueally.info",
    "ditapi.info",
    "ditcloud.info",
    "ditdrive.info",
    "ditgame.info",
    "ditlearn.info",
    "ditpay.info",
    "ditplay.info",
    "ditube.info",
    "junkstopper.info",
    "whatsyour.info"
  ]


  // Allow emails to only these domains
  if (recipient_host && allowed_rcpt.includes(recipient_host)) {
    return next();
  }

  plugin.logwarn(`exports.rcpt ${JSON.stringify(params)}`);
  return next(DENY, "NOT ALLOWED");
};
