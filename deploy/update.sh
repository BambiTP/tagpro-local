#!/usr/bin/env bash
# Pull the latest code from GitHub and restart:  sudo bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
npm ci --omit=dev
systemctl restart tagpro
echo "updated and restarted"
