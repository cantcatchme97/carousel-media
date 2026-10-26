// Shared tools: get_frames (images streamed from the video) + get_transcript (captions as text).
import { z } from "zod";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COOKIES = process.env.YTDLP_COOKIES_FILE;
const cookieArgs = () => (COOKIES && fs.existsSync(COOKIES) ? ["--cookies", COOKIES] : []);

export const run = (cmd, args, { binary = false, timeout = 120000 } = {}) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    const out = [], err = [];
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`${cmd} timed out`)); }, timeout);
    p.stdout.on("data", d => out.push(d));
    p.stderr.on("data", d => err.push(d));
    p.on("error", e => { clearTimeout(timer); reject(e); });
    p.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${cmd} failed (${code}): ${Buffer.concat(err).toString().slice(-600)}`));
      const buf = Buffer.concat(out);
      resolve(binary ? buf : buf.toString());
    });
  });

const toSec = t => (t === undefined || t === null || t === "") ? undefined
  : typeof t === "number" ? t : String(t).split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
const fmt = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); };

async function resolveStream(url) {
  const out = await run("yt-dlp", ["-f", "best[height<=480][vcodec!=none]/bv*[height<=480]/bv*/best", "--no-playlist", "--no-warnings",
    "--print", "%(title)s", "--print", "%(duration)s", "--print", "%(url)s", "--print", "%(http_headers)j", ...cookieArgs(), url]);
  const [title, duration, streamUrl, headersJson] = out.trim().split("\n");
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

function cleanVtt(vtt, every = 20) {
  const out = []; let last = "", lastStamp = -every;
  for (const block of vtt.split(/\n\n+/)) {
    const m = block.match(/(\d+):(\d+):(\d+)\.\d+ -->/) || block.match(/(\d+):(\d+)\.\d+ -->/);
    if (!m) continue;
    const t = m.length === 4 ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
    const text = block.split("\n").filter(l => !l.includes("-->") && l.trim()).join(" ")
      .replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/\s+/g, " ").trim();
    if (!text || text === last) continue;
    const add = text.startsWith(last) ? text.slice(last.length).trim() : text;
    last = text;
    if (!add) continue;
    if (t - lastStamp >= every) { out.push(`\n[${fmt(t)}] ${add}`); lastStamp = t; } else out.push(add);
  }
  return out.join(" ").trim();
}

export function registerTools(server) {
  server.tool(
    "get_transcript",
    "Get a video's transcript (YouTube, Instagram, etc.) as text with a timestamp every ~20s, plus title, channel, views and duration. Tries the original-language captions first. Nothing is downloaded except the caption text.",
    { url: z.string().describe("Video link"), lang: z.string().optional().describe("Caption language, default English") },
    async ({ url, lang = "en" }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-"));
      try {
        const info = JSON.parse(await run("yt-dlp", ["-J", "--no-warnings", "--no-playlist", ...cookieArgs(), url]));
        const head = `${info.title} — ${info.channel || info.uploader || ""} · ${fmt(info.duration || 0)} · ${info.view_count ?? "?"} views · ${info.like_count ?? "?"} likes · ${info.upload_date ?? ""}`;
        let text = "";
        for (const langs of [`${lang}-orig`, `${lang}`, `${lang}.*`]) {
          try {
            await run("yt-dlp", ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", langs, "--sub-format", "vtt",
              "--no-warnings", "--no-playlist", "-o", path.join(dir, "v.%(ext)s"), ...cookieArgs(), url]);
            const f = fs.readdirSync(dir).find(n => n.endsWith(".vtt"));
            if (f) { text = cleanVtt(fs.readFileSync(path.join(dir, f), "utf8")); if (text) break; }
          } catch {}
        }
        return { content: [{ type: "text", text: text ? `${head}\n${text}` : `${head}\n(no captions available)\n\n${(info.description || "").slice(0, 1500)}` }] };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  );

  server.tool(
    "get_frames",
    "See a video: returns evenly spaced frames (or frames at exact timestamps) from a YouTube, Instagram or other yt-dlp supported link, as images, streamed without saving the video. Pair with get_transcript for full context.",
    {
      url: z.string().describe("Video link"),
      count: z.number().int().min(1).max(40).optional().describe("How many frames (default 16, max 40)"),
      start: z.union([z.string(), z.number()]).optional().describe("Start time, seconds or MM:SS"),
      end: z.union([z.string(), z.number()]).optional().describe("End time, seconds or MM:SS"),
      timestamps: z.array(z.union([z.string(), z.number()])).optional().describe("Exact times to grab instead of even spacing"),
      width: z.number().int().min(240).max(1280).optional().describe("Frame width in px (default 512; 1024 to read on-screen text)"),
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
      const results = new Array(times.length); let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < times.length) { const i = next++; try { results[i] = await grab(stream, times[i], width); } catch (e) { results[i] = e; } }
      }));
      const content = [{ type: "text", text: `${stream.title} (${fmt(stream.duration)}) — ${times.length} frames` }];
      times.forEach((t, i) => {
        const r = results[i];
        if (r instanceof Error || !r?.length) content.push({ type: "text", text: `${fmt(t)}: frame failed (${r?.message ?? "empty"})` });
        else { content.push({ type: "text", text: fmt(t) }); content.push({ type: "image", data: r.toString("base64"), mimeType: "image/jpeg" }); }
      });
      return { content };
    }
  );
}
