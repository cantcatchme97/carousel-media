#!/bin/bash
# Brand Studio installer for Bhuvan's Mac mini. Safe to re-run.
set -e
BS="$HOME/BrandStudio"; TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
export PATH="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:$PATH"
step(){ echo; echo "⏳ $1"; }

step "1/8 Checking Homebrew"
command -v brew >/dev/null || { echo "❌ Homebrew missing. Install it first."; exit 1; }
echo "✅ Homebrew found"

step "2/8 Installing Node 22, whisper.cpp, GitHub CLI, ffmpeg (a few minutes)"
brew install node@22 whisper-cpp gh ffmpeg
echo "✅ Tools installed"

step "3/8 Creating ~/BrandStudio folders"
mkdir -p "$BS"/{inbox,done,work,renders,models}
echo "✅ AirDrop or drop files into: $BS/inbox"

step "4/8 Downloading the multilingual Whisper model (~550 MB)"
M="$BS/models/ggml-large-v3-turbo-q5_0.bin"
[ -s "$M" ] || curl -L --progress-bar -o "$M" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
echo "✅ Model ready"

step "5/8 GitHub login (a browser window opens: copy the code shown here, paste it there, approve)"
gh auth status -h github.com >/dev/null 2>&1 || gh auth login -h github.com -p https -w
gh auth setup-git
[ -d "$BS/engine/.git" ] || git clone https://github.com/cantcatchme97/bk-brand-engine "$BS/engine"
git -C "$BS/engine" pull -q --rebase
echo "✅ Private repo at $BS/engine"

step "6/8 Setting up Remotion (npm install, a few minutes)"
cd "$BS/engine/studio/remotion" && npm install --no-fund --no-audit --loglevel=error
mkdir -p public && ln -sfn "$BS/work" public/media
echo "✅ Remotion ready"

step "7/8 Setting up HyperFrames"
HF="$BS/engine/studio/hyperframes"
if [ ! -d "$HF/starter" ]; then mkdir -p "$HF" && cd "$HF" && npx -y hyperframes@latest init starter < /dev/null || true; fi
ln -sfn "$BS/work" "$HF/media"
cd "$BS/engine" && git add -A && (git commit -qm "Mac mini: HyperFrames starter" && git push -q) || true
echo "✅ HyperFrames ready"

step "8/8 Starting background services + private links"
LA="$HOME/Library/LaunchAgents"; mkdir -p "$LA"
P="/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
mk(){ # label, workdir, command, keepalive(1)/interval
cat > "$LA/$1.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$1</string>
<key>WorkingDirectory</key><string>$2</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>-lc</string><string>$3</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>$P</string></dict>
$4
<key>StandardOutPath</key><string>$BS/$1.log</string><key>StandardErrorPath</key><string>$BS/$1.log</string>
</dict></plist>
PL
launchctl unload "$LA/$1.plist" 2>/dev/null || true; launchctl load "$LA/$1.plist"; }
mk com.bhuvan.brand-studio-watch "$BS/engine" "$BS/engine/studio/process.sh" "<key>StartInterval</key><integer>60</integer>"
mk com.bhuvan.remotion-studio "$BS/engine/studio/remotion" "npx remotion studio src/index.js --port 3000 --no-open" "<key>KeepAlive</key><true/>"
mk com.bhuvan.hyperframes-preview "$HF/starter" "npx hyperframes preview" "<key>KeepAlive</key><true/>"
echo "   waiting for the studios to start..."; sleep 25
"$TS" serve --bg --https=8443 http://127.0.0.1:3000 >/dev/null 2>&1 || true
HP=$(grep -oE 'localhost:[0-9]+' "$BS/com.bhuvan.hyperframes-preview.log" | tail -1 | cut -d: -f2)
[ -n "$HP" ] && "$TS" serve --bg --https=8444 "http://127.0.0.1:$HP" >/dev/null 2>&1 || true
HOST=$("$TS" status --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))" 2>/dev/null)
echo
echo "🎉 Brand Studio is running"
echo "   Remotion timeline:  https://$HOST:8443"
[ -n "$HP" ] && echo "   HyperFrames preview: https://$HOST:8444" || echo "   HyperFrames preview: still starting (tell Claude)"
echo "   Inbox for videos:   $BS/inbox"
echo "   (links only work on your own Tailscale devices)"
