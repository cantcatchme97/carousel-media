#!/bin/bash
# Installs AuDHD Comment Guard on the Mac mini (runs every 10 minutes): hides spam, replies to TREATY.
set -e
D="$HOME/audhd-comment-guard"; LABEL="com.bhuvan.audhd-comment-guard"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$D" "$HOME/.audhd-comment-guard"
curl -fsSL https://raw.githubusercontent.com/cantcatchme97/carousel-media/main/tools/audhd-comment-guard/guard.mjs -o "$D/guard.mjs"
if [ ! -f "$HOME/.threads-connector/token.json" ] && [ ! -f "$HOME/.audhd-comment-guard/token" ]; then
  TOK=$(grep -rhoE 'THAA[A-Za-z0-9_-]{100,}' "$HOME/.claude.json" "$HOME/Library/Application Support/Claude/claude_desktop_config.json" 2>/dev/null | head -1)
  [ -z "$TOK" ] && { echo "❌ Couldn't find your Threads token"; exit 1; }
  printf '%s' "$TOK" > "$HOME/.audhd-comment-guard/token"; chmod 600 "$HOME/.audhd-comment-guard/token"
fi
NODE=$(command -v node || echo /opt/homebrew/bin/node)
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$D/guard.mjs</string></array>
<key>StartInterval</key><integer>600</integer>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>$HOME/.audhd-comment-guard/err.log</string>
</dict></plist>
P
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 8; tail -n 3 "$HOME/.audhd-comment-guard/log.csv" 2>/dev/null || true
echo "✅ AuDHD Comment Guard running every 10 min. Log: ~/.audhd-comment-guard/log.csv"
