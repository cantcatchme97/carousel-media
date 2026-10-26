#!/bin/bash
# One-line installer for the video-frames MCP on macOS (Claude desktop).
set -e
DIR="$HOME/video-frames-mcp"; RAW="https://raw.githubusercontent.com/cantcatchme97/carousel-media/main/tools/video-frames-mcp"
mkdir -p "$DIR" && cd "$DIR"
curl -fsSL "$RAW/server.mjs" -o server.mjs && curl -fsSL "$RAW/package.json" -o package.json
npm install --silent --no-fund --no-audit
NODE="$(command -v node)"
python3 - "$DIR" "$NODE" <<'PY'
import json, os, sys
d, node = sys.argv[1], sys.argv[2]
p = os.path.expanduser('~/Library/Application Support/Claude/claude_desktop_config.json')
c = json.load(open(p)) if os.path.exists(p) else {}
c.setdefault('mcpServers', {})['video-frames'] = {
  "command": node, "args": [d + "/server.mjs"],
  "env": {"PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "YTDLP_COOKIES_FILE": os.path.expanduser('~/youtube-cookies.txt')}}
json.dump(c, open(p, 'w'), indent=2)
PY
echo "✅ video-frames installed. Quit Claude (Cmd+Q) and reopen it."
