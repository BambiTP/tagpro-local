#!/usr/bin/env bash
# Deploys the committed code from this machine to the server and restarts the game:
#   bash deploy/push.sh <server-ip>            (add SETUP=1 to re-run the full setup)
# Only changed files are sent (rsync of the files git tracks); npm only reinstalls when
# package-lock.json changed.
set -euo pipefail
HOST="root@${1:?usage: deploy/push.sh <server-ip>}"
cd "$(dirname "$0")/.."
LOCK_BEFORE=$(ssh "$HOST" 'md5sum /opt/tagpro/package-lock.json 2>/dev/null | cut -d" " -f1' || true)
git ls-files -z | rsync -az --from0 --files-from=- ./ "$HOST:/opt/tagpro/"
if [ "${SETUP:-0}" = "1" ]; then
  ssh "$HOST" 'cd /opt/tagpro && bash deploy/setup.sh'
else
  LOCK_AFTER=$(md5sum package-lock.json | cut -d" " -f1)
  ssh "$HOST" "cd /opt/tagpro && { [ '$LOCK_BEFORE' = '$LOCK_AFTER' ] || npm ci --omit=dev --no-audit --no-fund >/dev/null; } && chown -R tagpro:tagpro /opt/tagpro && systemctl restart tagpro && echo 'deployed and restarted'"
fi
