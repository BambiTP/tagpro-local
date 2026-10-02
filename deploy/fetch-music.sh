#!/usr/bin/env bash
# Downloads the in-game music list (public/music.json) from the TagPro CDN into public/sounds/music.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p public/sounds/music
node -e "for (const m of require('./public/music.json')) console.log(m.url)" | while read -r u; do
  for ext in mp3 ogg; do
    f="public/sounds/music/$u.$ext"
    [ -s "$f" ] && continue
    curl -fsSL "https://static.koalabeast.com/sounds/music/${u// /%20}.$ext" -o "$f" || echo "skip $u.$ext"
  done
done
echo "music: $(ls public/sounds/music | wc -l) files"
