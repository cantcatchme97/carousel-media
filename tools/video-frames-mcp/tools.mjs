// Shared tools: get_frames (images streamed from the video) + get_transcript (captions as text).
import { z } from "zod";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const COOKIES = process.env.YTDLP_COOKIES_FILE;
// Only allow public http(s) links, so nobody can pass yt-dlp options or point it at your home network.
export function safeUrl(u) {
  let x; try { x = new URL(String(u).trim()); } catch { throw new Error("Not a valid link"); }
  if (!["http:", "https:"].includes(x.protocol)) throw new Error("Only http/https links are allowed");
  const h = x.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h === "::1" || h === "[::1]" ||
      /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^\[?f[cd]/.test(h))
    throw new Error("Private or local addresses are not allowed");
  return x.toString();
}
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

// Download a small temporary copy (<=360p, video only), grab frames from it, then delete it.
async function fetchTemp(url, dir) {
  const out = await run("yt-dlp", ["-f", "bv*[height<=360][ext=mp4]/bv*[height<=360]/b[height<=360]/worst", "--no-playlist", "--no-warnings",
    "--no-part", "-o", path.join(dir, "v.%(ext)s"), "--print", "%(title)s", "--print", "%(duration)s", "--print", "after_move:filepath",
    "--no-simulate", ...cookieArgs(), "--", safeUrl(url)], { timeout: 240000 });
  const [title, duration, file] = out.trim().split("\n");
  if (!file || !fs.existsSync(file)) throw new Error("download failed");
  return { title, duration: Number(duration) || 0, file };
}

async function grab(file, t, width) {
  return run("ffmpeg", ["-loglevel", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:-2`,
    "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "4", "-"], { binary: true, timeout: 30000 });
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

// Background jobs: anything slower than ~8s keeps running here, and the same call made again picks up the result.
const JOBS = new Map();
const WAIT_MS = 8000;
async function asJob(key, work) {
  for (const [k, j] of JOBS) if (Date.now() - j.t > 30 * 60 * 1000) JOBS.delete(k);
  let job = JOBS.get(key);
  if (!job) {
    job = { t: Date.now(), done: false };
    job.p = work().then(r => { job.done = true; job.result = r; }, e => { job.done = true; job.error = e; });
    JOBS.set(key, job);
  }
  if (!job.done) await Promise.race([job.p, new Promise(r => setTimeout(r, WAIT_MS))]);
  if (!job.done) return { content: [{ type: "text", text: `Still working (${Math.round((Date.now() - job.t) / 1000)}s so far). Call this tool again with exactly the same arguments in about 20 seconds to get the result.` }] };
  JOBS.delete(key);
  if (job.error) throw job.error;
  return job.result;
}

export function registerTools(server) {
  server.tool(
    "get_transcript",
    "Get a video's transcript (YouTube, Instagram, etc.) as text with a timestamp every ~20s, plus title, channel, views and duration. Tries the original-language captions first. Nothing is downloaded except the caption text.",
    { url: z.string().describe("Video link"), lang: z.string().optional().describe("Caption language, default English") },
    async ({ url, lang = "en" }) => asJob(JSON.stringify(["t", url, lang]), async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-"));
      try {
        url = safeUrl(url);
        const info = JSON.parse(await run("yt-dlp", ["-J", "--no-warnings", "--no-playlist", ...cookieArgs(), "--", url]));
        const head = `${info.title} — ${info.channel || info.uploader || ""} · ${fmt(info.duration || 0)} · ${info.view_count ?? "?"} views · ${info.like_count ?? "?"} likes · ${info.upload_date ?? ""}`;
        let text = "";
        for (const langs of [`${lang}-orig`, `${lang}`, `${lang}.*`]) {
          try {
            await run("yt-dlp", ["--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", langs, "--sub-format", "vtt",
              "--no-warnings", "--no-playlist", "-o", path.join(dir, "v.%(ext)s"), ...cookieArgs(), "--", url]);
            const f = fs.readdirSync(dir).find(n => n.endsWith(".vtt"));
            if (f) { text = cleanVtt(fs.readFileSync(path.join(dir, f), "utf8")); if (text) break; }
          } catch {}
        }
        return { content: [{ type: "text", text: text ? `${head}\n${text}` : `${head}\n(no captions available)\n\n${(info.description || "").slice(0, 1500)}` }] };
      } catch (e) { console.error(new Date().toISOString(), "get_transcript", url, e.message); throw e; }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    })
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
    async ({ url, count = 16, start, end, timestamps, width = 512 }) => asJob(JSON.stringify(["f", url, count, start, end, timestamps, width]), async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-"));
      try {
      const stream = await fetchTemp(url, dir);
      let times;
      if (timestamps?.length) times = timestamps.map(toSec);
      else {
        const a = toSec(start) ?? 0, b = Math.min(toSec(end) ?? stream.duration, stream.duration || Infinity);
        const span = Math.max(1, (b || a + 1) - a);
        times = Array.from({ length: count }, (_, i) => a + span * (i + 0.5) / count);
      }
      const results = new Array(times.length); let next = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < times.length) { const i = next++; try { results[i] = await grab(stream.file, times[i], width); } catch (e) { results[i] = e; } }
      }));
      const content = [{ type: "text", text: `${stream.title} (${fmt(stream.duration)}) — ${times.length} frames` }];
      times.forEach((t, i) => {
        const r = results[i];
        if (r instanceof Error || !r?.length) content.push({ type: "text", text: `${fmt(t)}: frame failed (${r?.message ?? "empty"})` });
        else { content.push({ type: "text", text: fmt(t) }); content.push({ type: "image", data: r.toString("base64"), mimeType: "image/jpeg" }); }
      });
      return { content };
      } catch (e) { console.error(new Date().toISOString(), "get_frames", url, e.message); throw e; }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    })
  );
}
