# Handoff: video-frames connector + Instagram style skill

You are Claude Code running on Bhuvan's Mac mini (macOS, M1, always on). This file is your full briefing.
Work through it end to end yourself. Bhuvan does not want to relay messages between chats or run commands for you:
run everything yourself, ask him only for decisions, and keep replies short with emojis.

## Rules
- Never print, log or paste the token in `~/video-frames-mcp/.token` (it is also in the launchd plist).
- Ask before anything destructive (deleting files, turning services off, changing Tailscale settings beyond Funnel).
- Show him what you tested and the result in one short summary per task.

## System you're working on
- Code: `~/video-frames-mcp/` (source of truth: github.com/cantcatchme97/carousel-media, folder `tools/video-frames-mcp/`).
  - `tools.mjs`: the two tools, `get_transcript` (captions via yt-dlp, falls back to the post caption) and `get_frames`
    (downloads a temp <=360p copy with yt-dlp + YouTube cookies `~/youtube-cookies.txt`, grabs frames with ffmpeg, deletes it).
    Slow work runs as a background job: a call returns "Still working" after ~8s and the same call again returns the result.
  - `server-http.mjs`: HTTP MCP server (stateless StreamableHTTP, SSE replies) on 127.0.0.1:3459, route `/mcp/<token>`, `/health`.
    Logs every request (token hidden) and errors to `~/video-frames-mcp/server.log`.
  - `server.mjs`: same tools over stdio (handy for local testing).
- launchd: `com.bhuvan.video-frames` (service) and `com.bhuvan.video-frames-updater` (runs `update.sh` every 10 min:
  pulls the files above from GitHub raw and restarts the service if they changed; writes `update.log` when it updates).
- Public access: Tailscale Funnel, CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
  `https://bhuvans-mac-mini.tail776202.ts.net/vf` proxies to 127.0.0.1:3459. claude.ai has it as a custom connector
  at `https://bhuvans-mac-mini.tail776202.ts.net/vf/mcp/<token>`.

## Task 1: make the public connector reliable
Symptom: from claude.ai, every tool call returns HTTP 502 "Bad Gateway" from Anthropic's connector proxy.
Timeline (IST, 26 Oct): calls worked 13:23-13:30, failing since ~13:31. Locally the service is healthy and stdio tests pass.
Known: Anthropic's proxy seems to cut requests after ~10-15s (that's why background jobs exist).
1. Run `~/video-frames-mcp/update.sh` once so the request-logging version is live; confirm the service restarted.
2. Test the public path end to end from this Mac: `curl -sv .../vf/health`, then an MCP `initialize` POST and a
   `tools/call` for `get_transcript` on https://www.youtube.com/watch?v=J5EbL1UaqG8 through the public URL
   (headers: `Content-Type: application/json`, `Accept: application/json, text/event-stream`).
3. Check `server.log`: do the requests from claude.ai reach the server at all? Check Funnel status and Tailscale health.
4. Find the root cause, fix it, and prove it with a public-URL tool call that returns a result. Possible areas: Funnel/TLS,
   path prefix handling, SSE vs JSON responses, response size limits for images, timeouts.
5. If the fix is in the code, also commit it to the carousel-media repo (`tools/video-frames-mcp/`) so the auto-updater
   doesn't overwrite it. Ask Bhuvan before pushing.
6. Report the root cause in one line.

## Task 2: study this post and propose a skill (do NOT build until Bhuvan confirms)
Post: https://www.instagram.com/p/Deqhx3cqsj2/ (Ankur Warikoo, "3 money rules we follow for our parents", 0:33, vertical).
1. Get its frames locally (yt-dlp + ffmpeg, or the tools in `~/video-frames-mcp` via `server.mjs`), around 20 frames,
   and look at them yourself. Also get the caption/transcript.
2. Write the list of attributes that make this style, for Bhuvan to confirm: layout and framing, typography (fonts,
   sizes, weights, casing), colours, caption style and timing, motion/animation, transitions, B-roll, sound/music,
   pacing and length, structure (hook, body, payoff), CTA, and what to record (camera, framing, light, audio).
3. Show him the list and wait for his OK or edits.
4. After he confirms, write the skill (SKILL.md) as Bhuvan's own version of this style:
   - His brand: black + off-white, accents gold #f5c542, green #3ddc84, coral #ff7a59; font Albert Sans
     (avoid Inter, Poppins, Montserrat, Space Grotesk, Jost); handle @BHUVAN.KALRA in caps; nothing that looks like generic AI reels.
   - No ADHD/AuDHD topics on his Instagram; pillars: raw business log, AI & systems, the game (mindset), interesting stuff.
   - Sound must feel crafted, not AI slop: subtle synthesized SFX + a quiet bed.
   - He records talking-head clips on iPhone; footage arrives via a Google Drive folder "Reels Raw".
   - His existing skills for reference: bk-dark-carousel, bk-motion-reel.
   Save it in the repo under `skills/<skill-name>/SKILL.md` (ask before pushing) and tell him how to add it to Claude.

## About Bhuvan
Dietitian and high-ticket sales/marketing person in India (IST). Builds his own content system with Claude
(Postiz on this Mac for scheduling, GitHub repo for media). Wants short, direct replies with emojis, one question
at a time, full commands inline (never "the one from before"), and propose-before-building for anything new.
