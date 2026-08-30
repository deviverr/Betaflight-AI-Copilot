#!/bin/sh
# Optional HTTPS with a self-signed certificate.
#
# Web Serial requires a secure context. http://localhost already qualifies, so
# this is only needed to reach the app from another machine on the network,
# where plain HTTP does not. Browsers will warn about the certificate; that is
# expected for a self-signed one, and the warning has to be accepted once.
set -e

[ "${COPILOT_TLS:-off}" = "on" ] || exit 0

CERT_DIR=/etc/nginx/certs
CERT="$CERT_DIR/copilot.crt"
KEY="$CERT_DIR/copilot.key"
HOST="${COPILOT_TLS_HOST:-localhost}"

mkdir -p "$CERT_DIR"

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    echo "copilot: generating a self-signed certificate for $HOST"
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
        -keyout "$KEY" -out "$CERT" \
        -subj "/CN=$HOST" \
        -addext "subjectAltName=DNS:$HOST,DNS:localhost,IP:127.0.0.1" \
        2>/dev/null
fi

cat > /etc/nginx/conf.d/tls.conf <<NGINX
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name _;

    ssl_certificate     $CERT;
    ssl_certificate_key $KEY;
    ssl_protocols       TLSv1.2 TLSv1.3;

    root /usr/share/nginx/html;
    index index.html;

    location /assets/ {
        add_header Cache-Control "public, max-age=31536000, immutable";
        try_files \$uri =404;
    }
    location = /index.html { add_header Cache-Control "no-cache, no-store, must-revalidate"; }
    location = /sw.js      { add_header Cache-Control "no-cache, no-store, must-revalidate"; }
    location / { try_files \$uri \$uri/ /index.html; }
}
NGINX
