#!/bin/bash
set -e

echo "[DITMail] Starting entrypoint..."

HOST="${REDIS_HOST:-127.0.0.1}"
PORT="${REDIS_PORT:-6379}"
LOG="${LOG_LEVEL:-info}"
ALTINBOX_MOD="${ALTINBOX_MOD:-1}"

echo "[DITMail] Configuring Haraka with:"
echo "  Redis Host: $HOST"
echo "  Redis Port: $PORT"
echo "  Log Level:  $LOG"
echo "  AltInbox:   $ALTINBOX_MOD"

# Helper function to safely replace config values
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

# Redis-based plugin configs
set_config_value "src/config/dnsbl.ini"      "stats_redis_host" "$HOST:$PORT"
set_config_value "src/config/greylist.ini"   "host"             "$HOST"
set_config_value "src/config/greylist.ini"   "port"             "$PORT"
set_config_value "src/config/redis.ini"      "host"             "$HOST"
set_config_value "src/config/redis.ini"      "port"             "$PORT"

# Logging level
set_config_value "src/config/log.ini"        "level"            "$LOG"

# AltInbox mode
set_config_value "src/config/altinbox.ini"   "altinbox"         "$ALTINBOX_MOD"

echo "[DITMail] Launching Supervisor..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
