#!/usr/bin/env bash
# Deploys the committed code from this machine to the server and restarts the game:
#   bash deploy/push.sh <server-ip>            (add SETUP=1 to re-run the full setup)
set -euo pipefail
HOST="root@${1:?usage: deploy/push.sh <server-ip>}"
cd "$(dirname "$0")/.."
git archive --format=tar HEAD | ssh "$HOST" 'mkdir -p /opt/tagpro && tar -x -C /opt/tagpro'
if [ "${SETUP:-0}" = "1" ]; then
  ssh "$HOST" 'cd /opt/tagpro && bash deploy/setup.sh'
else
  ssh "$HOST" 'cd /opt/tagpro && npm ci --omit=dev --no-audit --no-fund >/dev/null && chown -R tagpro:tagpro /opt/tagpro && systemctl restart tagpro && echo "deployed and restarted"'
fi
