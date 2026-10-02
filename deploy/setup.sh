#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 22.04/24.04 server. Run from inside the cloned repo:
#   sudo bash deploy/setup.sh                 # serves on http://<server-ip>
#   sudo DOMAIN=tagpro.example.com bash deploy/setup.sh   # automatic HTTPS for a domain
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "== installing Node.js, git, Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg
# prefer the distro packages (recent Ubuntu ships Node >= 18 and Caddy); fall back to upstream repos
apt-get install -y nodejs npm || true
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  apt-get install -y caddy || {
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y && apt-get install -y caddy
  }
fi
node -v; caddy version | head -1

echo "== installing app dependencies"
cd "$APP_DIR"
npm ci --omit=dev
bash deploy/fetch-music.sh || echo "(music download failed - the game works without it)"

echo "== systemd service"
cat > /etc/systemd/system/tagpro.service <<UNIT
[Unit]
Description=TagPro local server
After=network.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server/index.js
Environment=PORT=3000 NODE_ENV=production
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now tagpro
systemctl restart tagpro

echo "== Caddy (port 80/443 -> 3000, websockets included)"
SITE="${DOMAIN:-:80}"
cat > /etc/caddy/Caddyfile <<CADDY
$SITE {
  encode gzip
  reverse_proxy localhost:3000
}
CADDY
systemctl restart caddy

IP=$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')
echo
echo "Done. Open: ${DOMAIN:+https://$DOMAIN}${DOMAIN:-http://$IP}/groups"
