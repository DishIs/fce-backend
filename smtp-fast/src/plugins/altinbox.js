const bigInt = require('big-integer');

exports.register = function () {
  const plugin = this;
  plugin.load_ini();
  plugin.register_hook('data', 'altinbox');
};

exports.load_ini = function () {
  const plugin = this;
  plugin.cfg = plugin.config.get('altinbox.ini', () => {
    plugin.load_ini();
  });
};

exports.getInbox = function (altinbox, ALTINBOX_MOD) {
  // - Strip prefix
  // - Convert the alt inbox to a long
  // - Subtract the private modifier
  // - Remove the 1 prefix and reverse the digits
  // - Convert back to base36
  const num = bigInt(altinbox.toLowerCase().replace('d-', ''), 36).minus(ALTINBOX_MOD);
  return bigInt(num.toString().substring(1).split("").reverse().join("")).toString(36);
};

exports.altinbox = function (next, connection) {
  const plugin = this;
  plugin.cfg = plugin.config.get('altinbox.ini');
  const ALTINBOX_MOD = ((plugin.cfg.main || {}).altinbox || 10);

  plugin.logdebug("transaction.rcpt_to", JSON.stringify(connection.transaction.rcpt_to));
  connection.transaction.rcpt_to = connection.transaction.rcpt_to.map((recipient) => {
    if (recipient.user.toLowerCase().startsWith("d-")) {
      const regularInbox = plugin.getInbox(recipient.user, ALTINBOX_MOD);
      plugin.logwarn(`AltInbox translate from ${recipient.user} to ${regularInbox}`);
      return {
        "original": `<${regularInbox}@${recipient.host}>`,
        "original_host": `${recipient.original_host}`,
        "host": `${recipient.host}`,
        "user": `${regularInbox}`
      };
    } else {
      return recipient;
    }
  });
  plugin.logdebug("transaction.rcpt_to", JSON.stringify(connection.transaction.rcpt_to));

  next();
};
