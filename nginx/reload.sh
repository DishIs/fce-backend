#!/bin/sh
# Wait for initial certs to exist, then signal nginx to reload on cert renewal

echo "MCP nginx reload script started"

# Wait for initial certificates to exist
while [ ! -f /etc/letsencrypt/live/api2.freecustom.email/fullchain.pem ]; do
    echo "Waiting for initial SSL certificates..."
    sleep 5
done

echo "Initial certificates found. Monitoring for renewals..."

# Watch for certificate changes and reload nginx
inotifywait -m -e close_write -r /etc/letsencrypt/ 2>/dev/null || {
    # Fallback: poll every hour
    while true; do
        sleep 3600
        echo "Checking for certificate updates..."
        if [ -f /etc/letsencrypt/live/api2.freecustom.email/fullchain.pem ]; then
            nginx -s reload 2>/dev/null || true
        fi
    done
}