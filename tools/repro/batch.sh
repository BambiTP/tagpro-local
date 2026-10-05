#!/bin/bash
# batch.sh <out.jsonl> <n> <dir...>: run repro on n random replays from the dirs, in parallel.
# Missing Fortunate Maps logic for the chosen replays is fetched first (one request per second).
out=$1; n=$2; shift 2
here=$(dirname "$0")
list=$(mktemp)
find "$@" -name '*.ndjson.gz' | shuf -n "$n" --random-source=<(yes) > "$list"
xargs -a "$list" node "$here/fetch-fm.js"
xargs -a "$list" -P "$(nproc)" -n 4 node "$here/repro.js" --json $REPRO_ARGS > "$out"
rm -f "$list"
