#!/usr/bin/env bash
# Restarts the local TagPro server in the background (logs to server.log).
cd "$(dirname "$0")"
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then kill "$(cat server.pid)"; sleep 0.5; fi
for p in $(pgrep -f "node server/index.js"); do [ "$p" != "$$" ] && kill "$p" 2>/dev/null; done
nohup node server/index.js > server.log 2>&1 &
echo $! > server.pid
sleep 1.5
head -5 server.log
