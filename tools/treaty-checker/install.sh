#!/bin/bash
# Installs the TREATY checker on the Mac mini (runs every 10 minutes).
set -e
D="$HOME/treaty-checker"; LABEL="com.bhuvan.treaty-checker"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$D" "$HOME/.treaty-checker"
curl -fsSL https://raw.githubusercontent.com/cantcatchme97/carousel-media/main/tools/treaty-checker/checker.mjs -o "$D/checker.mjs"
if [ ! -f "$HOME/.threads-connector/token.json" ] && [ ! -f "$HOME/.treaty-checker/token" ]; then
  TOK=$(grep -rhoE 'THAA[A-Za-z0-9_-]{100,}' "$HOME/.claude.json" "$HOME/Library/Application Support/Claude/claude_desktop_config.json" 2>/dev/null | head -1)
  [ -z "$TOK" ] && { echo "❌ Couldn't find your Threads token"; exit 1; }
  printf '%s' "$TOK" > "$HOME/.treaty-checker/token"; chmod 600 "$HOME/.treaty-checker/token"
fi
NODE=$(command -v node || echo /opt/homebrew/bin/node)
cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$D/checker.mjs</string></array>
<key>StartInterval</key><integer>600</integer>
<key>RunAtLoad</key><true/>
<key>StandardErrorPath</key><string>$HOME/.treaty-checker/err.log</string>
</dict></plist>
P
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 8; tail -n 3 "$HOME/.treaty-checker/log.csv" 2>/dev/null || true
echo "✅ TREATY checker running every 10 min. Log: ~/.treaty-checker/log.csv"
