// video-frames MCP: returns frames of a YouTube/Instagram/any yt-dlp video as images,
// streamed straight from the source with ffmpeg. No video file is saved.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import fs from "node:fs";

const COOKIES = process.env.YTDLP_COOKIES_FILE;
const run = (cmd, args, { binary = false, timeout = 120000 } = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out = [], err = [];
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeout);
    p.stdout.on("data", d => out.push(d));
    p.stderr.on("data", d => err.push(d));
    p.on("error", e => { clearTimeout(timer); reject(e); });
    p.on("close", code => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code !== 0) return reject(new Error(`${cmd} failed (${code}): ${Buffer.concat(err).toString().slice(-600)}`));
      resolve(binary ? buf : buf.toString());
    });
  });

const toSec = t => {
  if (t === undefined || t === null || t === "") return undefined;
  if (typeof t === "number") return t;
  return String(t).split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
};
const fmt = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };

async function resolveStream(url) {
  const args = ["-f", "best[height<=480][vcodec!=none]/bv*[height<=480]/bv*/best", "--no-playlist", "--no-warnings",
    "--print", "%(title)s", "--print", "%(duration)s", "--print", "%(url)s", "--print", "%(http_headers)j"];
  if (COOKIES && fs.existsSync(COOKIES)) args.push("--cookies", COOKIES);
  args.push(url);
  const lines = (await run("yt-dlp", args)).trim().split("\n");
  const [title, duration, streamUrl, headersJson] = lines;
  let headers = "";
  try { headers = Object.entries(JSON.parse(headersJson)).map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n"; } catch {}
  return { title, duration: Number(duration) || 0, streamUrl, headers };
}

async function grab(stream, t, width) {
  const args = ["-loglevel", "error"];
  if (stream.headers) args.push("-headers", stream.headers);
  args.push("-ss", String(t), "-i", stream.streamUrl, "-frames:v", "1", "-vf", `scale=${width}:-2`,
    "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "-");
  return run("ffmpeg", args, { binary: true, timeout: 60000 });
}

const server = new McpServer({ name: "video-frames", version: "1.0.0" });

server.tool(
  "get_frames",
  "See a video: returns evenly spaced frames (or frames at exact timestamps) from a YouTube, Instagram or other yt-dlp supported link, as images, streamed without saving the video. Pair with a transcript tool for full context.",
  {
    url: z.string().describe("Video link"),
    count: z.number().int().min(1).max(40).optional().describe("How many frames (default 16, max 40)"),
    start: z.union([z.string(), z.number()]).optional().describe("Start time, seconds or MM:SS"),
    end: z.union([z.string(), z.number()]).optional().describe("End time, seconds or MM:SS"),
    timestamps: z.array(z.union([z.string(), z.number()])).optional().describe("Exact times to grab instead of even spacing"),
    width: z.number().int().min(240).max(1280).optional().describe("Frame width in px (default 512; use 1024 to read on-screen text)"),
  },
  async ({ url, count = 16, start, end, timestamps, width = 512 }) => {
    const stream = await resolveStream(url);
    let times;
    if (timestamps?.length) times = timestamps.map(toSec);
    else {
      const a = toSec(start) ?? 0, b = Math.min(toSec(end) ?? stream.duration, stream.duration || Infinity);
      const span = Math.max(1, (b || a + 1) - a);
      times = Array.from({ length: count }, (_, i) => a + span * (i + 0.5) / count);
    }
    const content = [{ type: "text", text: `${stream.title} (${fmt(stream.duration)}) — ${times.length} frames` }];
    const results = new Array(times.length);
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < times.length) {
        const i = next++;
        try { results[i] = await grab(stream, times[i], width); } catch (e) { results[i] = e; }
      }
    }));
    times.forEach((t, i) => {
      const r = results[i];
      if (r instanceof Error || !r?.length) content.push({ type: "text", text: `${fmt(t)}: frame failed (${r?.message ?? "empty"})` });
      else { content.push({ type: "text", text: `${fmt(t)}` }); content.push({ type: "image", data: r.toString("base64"), mimeType: "image/jpeg" }); }
    });
    return { content };
  }
);

await server.connect(new StdioServerTransport());
