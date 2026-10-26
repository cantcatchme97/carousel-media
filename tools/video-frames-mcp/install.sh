#!/bin/bash
# Installs video-frames as an always-on service on this Mac and prints the connector URL for claude.ai.
set -e
DIR="$HOME/video-frames-mcp"; RAW="https://raw.githubusercontent.com/cantcatchme97/carousel-media/main/tools/video-frames-mcp"
PORT=3459; LABEL="com.bhuvan.video-frames"; PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$DIR" && cd "$DIR"
for f in tools.mjs server.mjs server-http.mjs package.json; do curl -fsSL "$RAW/$f?$(date +%s)" -o "$f"; done
npm install --silent --no-fund --no-audit
[ -f .token ] || openssl rand -hex 16 > .token
TOKEN="$(cat .token)"; NODE="$(command -v node)"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>$LABEL</string>
 <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server-http.mjs</string></array>
 <key>EnvironmentVariables</key><dict>
  <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  <key>MCP_TOKEN</key><string>$TOKEN</string>
  <key>PORT</key><string>$PORT</string>
  <key>YTDLP_COOKIES_FILE</key><string>$HOME/youtube-cookies.txt</string>
 </dict>
 <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
 <key>StandardOutPath</key><string>$DIR/server.log</string><key>StandardErrorPath</key><string>$DIR/server.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 2
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null && echo "✅ video-frames service running (starts automatically after reboot)"
# remove the desktop-only copy so tools don't show twice
python3 - <<'PY'
import json, os
p = os.path.expanduser('~/Library/Application Support/Claude/claude_desktop_config.json')
if os.path.exists(p):
    c = json.load(open(p)); c.get('mcpServers', {}).pop('video-frames', None); json.dump(c, open(p, 'w'), indent=2)
PY
# public HTTPS address via Tailscale Funnel
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
if [ -x "$TS" ] && "$TS" status >/dev/null 2>&1; then
  "$TS" funnel --bg --set-path /vf "http://127.0.0.1:$PORT" >/dev/null
  HOST="$("$TS" status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  echo ""; echo "🔗 Connector URL (add this on claude.ai → Settings → Connectors → Add custom connector):"
  echo "https://$HOST/vf/mcp/$TOKEN"
else
  echo ""; echo "⚠️  Tailscale isn't running yet. Install + log in, then run this script again:"
  echo "    brew install --cask tailscale && open -a Tailscale"
fi
