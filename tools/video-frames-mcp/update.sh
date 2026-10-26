#!/bin/bash
# Runs every 10 minutes: pulls new connector code from GitHub and restarts the service if anything changed.
DIR="$HOME/video-frames-mcp"; RAW="https://raw.githubusercontent.com/cantcatchme97/carousel-media/main/tools/video-frames-mcp"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
cd "$DIR" || exit 0
TMP="$(mktemp -d)"; changed=0
for f in tools.mjs server.mjs server-http.mjs package.json update.sh; do
  curl -fsSL "$RAW/$f?$(date +%s)" -o "$TMP/$f" || { rm -rf "$TMP"; exit 0; }
  cmp -s "$TMP/$f" "$DIR/$f" || { cp "$TMP/$f" "$DIR/$f"; changed=1; [ "$f" = package.json ] && pkg=1; }
done
rm -rf "$TMP"
if [ "$changed" = 1 ]; then
  [ "$pkg" = 1 ] && npm install --no-fund --no-audit --loglevel=error
  launchctl kickstart -k "gui/$(id -u)/com.bhuvan.video-frames"
  echo "$(date) updated and restarted" >> "$DIR/update.log"
fi
