#!/bin/bash
set -e

echo "[DITMail] Starting entrypoint..."

HOST="${REDIS_HOST:-127.0.0.1}"
PORT="${REDIS_PORT:-6379}"
LOG="${LOG_LEVEL:-info}"
ALTINBOX_MOD="${ALTINBOX_MOD:-1}"

# Auto-generate REDIS_URL if not set
if [[ -z "$REDIS_URL" ]]; then
  export REDIS_URL="redis://${HOST}:${PORT}"
  echo "[DITMail] REDIS_URL not provided, using default: $REDIS_URL"
else
  echo "[DITMail] Using provided REDIS_URL: $REDIS_URL"
fi

echo "[DITMail] Configuring Haraka with:"
echo "  Redis Host: $HOST"
echo "  Redis Port: $PORT"
echo "  Redis URL:  $REDIS_URL"
echo "  Log Level:  $LOG"
echo "  AltInbox:   $ALTINBOX_MOD"

set_config_value() {
  local file=$1
  local key=$2
  local value=$3

  if [[ -f "$file" ]]; then
    sed -i "s|^$key=.*|$key=$value|" "$file"
  else
    echo "[WARN] File $file not found for setting $key"
  fi
}

# Redis configs
set_config_value "src/config/redis.ini" "host" "$HOST"
set_config_value "src/config/redis.ini" "port" "$PORT"
set_config_value "src/config/redis.ini" "url"  "$REDIS_URL"

# Logging level
set_config_value "src/config/log.ini" "level" "$LOG"

# AltInbox mode
set_config_value "src/config/altinbox.ini" "altinbox" "$ALTINBOX_MOD"

# ====================================================================
# --- NEW DEBUG STEP: VERIFY PLUGIN CONTENT ---
echo "[DITMail] >>> Verifying content of rcpt_to_mongo.js START <<<"
cat /maildrop/src/plugins/rcpt_to_mongo.js || echo "[DITMail] ERROR: Could not cat the plugin file at that path."
echo "[DITMail] >>> Verifying content of rcpt_to_mongo.js END <<<"
# --- END OF DEBUG STEP ---
# ====================================================================

echo "[DITMail] Launching Supervisor..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf