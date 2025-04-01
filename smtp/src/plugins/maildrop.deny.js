exports.register = function () {
  const plugin = this;
  plugin.register_hook('rcpt','rcpt');
  plugin.register_hook('rcpt_ok','rcpt');
};

exports.rcpt = function(next, connection, params) {
  const plugin = this;
  // Check if params is defined and has at least one element
  if (!params || params.length === 0) {
    plugin.logwarn('No recipient provided');
    return next(DENY, "No recipient provided");
  }

  const recipient_host = params["original_host"]; // Get the recipient address

  // Allow emails to saleis.live domain
  if (recipient_host && (recipient_host == 'saleis.live' || recipient_host == 'arrangewith.me')) {
    return next(); // Allow this recipient
  }

  plugin.logwarn(`exports.rcpt ${JSON.stringify(params)}`);
  return next(DENY, "NOT ALLOWED");
};
