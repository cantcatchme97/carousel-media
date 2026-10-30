// AuDHD Comment Guard for @how.to.audhd: hides self-promo/spam comments and replies once to anyone who comments "TREATY".
// Runs every 10 min via launchd. Safety: once per person per post, rotating texts, random gaps,
// max 3 replies per run (~18/hour), pauses itself on any API error.
import fs from 'fs'; import os from 'os'; import path from 'path';
const API = 'https://graph.threads.net/v1.0';
const ME = 'how.to.audhd';
const DIR = path.join(os.homedir(), '.audhd-comment-guard');
const STATE = path.join(DIR, 'state.json'); const LOG = path.join(DIR, 'log.csv');
fs.mkdirSync(DIR, { recursive: true });
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { replied: {}, counters: {}, paused: false };
st.hidden = st.hidden || {};
const SPAM_USERS = new Set(['oliveadhd','neuroguidejourney','ihsan.bydesign','careclinicapp','auvie.app','commandcenteradhd','weightlosswithken']);
const SPAM_RE = /(link (is )?in (my )?bio|check (out )?my (bio|profile|page)|on my profile|in my bio|more in my bio|i write about this|my (gumroad|shop|store|course|app)|dm me for|follow me|https?:\/\/|www\.|\.com\b)/i;
const isSpam = c => SPAM_USERS.has(c.username) || SPAM_RE.test(c.text || '');
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const log = (...a) => fs.appendFileSync(LOG, [new Date().toISOString(), ...a].join(',') + '\n');
// Network blips (Mac offline, DNS, timeouts) never pause. Any other pause retries itself after 60 min.
if (st.paused && (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(st.paused) || Date.now() - (st.paused_at || 0) > 36e5)) { log('unpaused', st.paused); st.paused = false; save(); }
if (st.paused) { log('paused', st.paused); process.exit(0); }
function token() {
  try { const t = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.threads-connector', 'token.json'), 'utf8')); if (t.access_token) return t.access_token; } catch {}
  return fs.readFileSync(path.join(DIR, 'token'), 'utf8').trim();
}
const T = token();
async function call(p, method = 'GET', params = {}) {
  const u = new URL(p.startsWith('http') ? p : API + '/' + p);
  const body = new URLSearchParams({ ...params, access_token: T });
  const r = method === 'GET' ? await fetch(u + (u.search ? '&' : '?') + body) : await fetch(u, { method, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${r.status} ${JSON.stringify(j.error || j).slice(0, 200)}`);
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TEXTS = [
  'Here you go 💜 {L}',
  "Sent! It's free, takes a few minutes: {L}",
  'Yay, here it is: {L} Tell me which clash surprised you most',
  "Here's your peace treaty 🫶 {L}",
];
const ist = () => new Date(Date.now() + 5.5 * 3600e3);
const mmdd = () => { const d = ist(); return String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); };
try {
  const since = Math.floor(Date.now() / 1000) - 3 * 86400;
  const posts = (await call('me/threads', 'GET', { fields: 'id,timestamp', since, limit: 100 })).data || [];
  let sent = 0;
  for (const p of posts) {
    const conv = (await call(`${p.id}/conversation`, 'GET', { fields: 'id,text,username,hide_status', reverse: 'false', limit: 100 })).data || [];
    for (const c of conv) {
      if (c.username !== ME && !st.hidden[c.id] && c.hide_status !== 'HIDDEN' && isSpam(c)) {
        try { await call(`${c.id}/manage_reply`, 'POST', { hide: 'true' }); st.hidden[c.id] = c.username; st.spamCount = st.spamCount || {}; st.spamCount[c.username] = (st.spamCount[c.username] || 0) + 1; if (st.spamCount[c.username] === 3) log('repeat-spammer', c.username, `https://www.threads.com/@${c.username}`); save(); log('hidden', c.id, c.username, p.id, JSON.stringify((c.text||'').slice(0,80)).replace(/,/g,' ')); }
        catch (e) { if (String(e.message).startsWith('500')) { st.hidden[c.id] = 'already-hidden?'; save(); continue; } log('hide-failed', c.id, c.username, String(e.message).slice(0,80).replace(/,/g,';')); st.hidden[c.id] = 'failed'; save(); }
        continue;
      }
      if (sent >= 3) continue;
      if (c.username === ME || !/\btreaty\b/i.test(c.text || '')) continue;
      const key = p.id + ':' + c.username;
      if (st.replied[c.id] || st.replied[key]) continue;
      const day = mmdd(); st.counters[day] = (st.counters[day] || 0) + 1;
      const code = `${day}r${st.counters[day]}`;
      const text = TEXTS[(Object.keys(st.replied).length / 2 | 0) % TEXTS.length].replace('{L}', `https://go.howtoaudhd.net/${code}`);
      await sleep(30e3 + Math.random() * 90e3);
      const cr = await call('me/threads', 'POST', { media_type: 'TEXT', text, reply_to_id: c.id });
      await sleep(5e3);
      await call('me/threads_publish', 'POST', { creation_id: cr.id });
      st.replied[c.id] = code; st.replied[key] = code; save();
      log('replied', code, c.id, c.username, p.id); sent++;
    }
  }
  log('run-ok', `sent=${sent}`);
} catch (e) {
  const m = String(e.message).replace(/,/g, ';');
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(m)) { log('net-error', m); }
  else { st.paused = m; st.paused_at = Date.now(); save(); log('PAUSED', m); }
}
