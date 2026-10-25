#!/usr/bin/env node
// Threads MCP connector for Bhuvan (how.to.audhd). Zero dependencies, Node 18+.
// Speaks MCP over stdio (newline-delimited JSON-RPC 2.0) and wraps the official Threads Graph API.
// Credentials: THREADS_ACCESS_TOKEN + THREADS_USER_ID (env). A refreshed token is saved to
// ~/.threads-connector/token.json and takes priority over the env token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const API = (process.env.THREADS_API_BASE || 'https://graph.threads.net/v1.0').replace(/\/$/, '');
const TOKEN_FILE = path.join(os.homedir(), '.threads-connector', 'token.json');
const USER_ID = process.env.THREADS_USER_ID || 'me';
const log = (...a) => process.stderr.write('[threads-connector] ' + a.join(' ') + '\n');

function token() {
  try { const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); if (t.access_token) return t.access_token; } catch {}
  const t = process.env.THREADS_ACCESS_TOKEN;
  if (!t) throw new Error('THREADS_ACCESS_TOKEN is not set in the Claude config.');
  return t;
}

const POST_FIELDS = 'id,media_product_type,media_type,media_url,permalink,username,text,timestamp,shortcode,thumbnail_url,children{id,media_type,media_url},is_quote_post,quoted_post,reposted_post,alt_text,link_attachment_url,topic_tag,has_replies,reply_audience';
const REPLY_FIELDS = 'id,text,username,permalink,timestamp,media_type,media_url,shortcode,has_replies,root_post,replied_to,is_reply,is_reply_owned_by_me,hide_status';
const POST_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'shares'];
const USER_METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes', 'clicks', 'followers_count'];

async function api(method, p, params = {}, { retries = 2 } = {}) {
  const url = new URL(API + p);
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(clean)) (method === 'GET' || method === 'DELETE' ? url.searchParams : body).set(k, String(v));
  url.searchParams.set('access_token', token());
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { method, body: method === 'GET' || method === 'DELETE' ? undefined : body, signal: AbortSignal.timeout(30000) });
    } catch (e) {
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      throw new Error('Network error reaching Threads: ' + e.message);
    }
    const text = await res.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (res.ok && !data.error) return data;
    const err = data.error || {};
    if ((res.status >= 500 || res.status === 429 || err.is_transient) && attempt < retries) { await sleep(1200 * (attempt + 1)); continue; }
    const hint = err.code === 190 ? ' (token expired or invalid: run refresh_token, or generate a new token in the Meta app)'
      : err.code === 10 || err.code === 200 ? ' (missing permission in the Meta app for this action)' : '';
    throw new Error(`Threads API ${res.status}: ${err.message || text || 'unknown error'}${err.code ? ' [code ' + err.code + (err.error_subcode ? '/' + err.error_subcode : '') + ']' : ''}${hint}`);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = d => ({ data: d.data || [], next_cursor: d.paging?.cursors?.after && d.paging?.next ? d.paging.cursors.after : null });
const flatMetrics = d => Object.fromEntries((d.data || []).map(m => [m.name, m.total_value?.value ?? m.values?.[0]?.value ?? (m.total_value?.breakdowns ? m.total_value.breakdowns : null)]));
const toUnix = v => { if (v === undefined || v === null || v === '') return undefined; if (/^\d+$/.test(String(v))) return Number(v); const t = Date.parse(v); if (isNaN(t)) throw new Error('Bad date: ' + v + ' (use YYYY-MM-DD or a unix timestamp)'); return Math.floor(t / 1000); };

async function waitContainer(id, maxMs = 120000) {
  const start = Date.now();
  while (true) {
    const s = await api('GET', `/${id}`, { fields: 'status,error_message' });
    if (s.status === 'FINISHED' || s.status === 'PUBLISHED') return s;
    if (s.status === 'ERROR' || s.status === 'EXPIRED') throw new Error(`Media container ${s.status}: ${s.error_message || 'no details'}`);
    if (Date.now() - start > maxMs) throw new Error('Media container still processing after 2 minutes; check later with get_container_status id=' + id);
    await sleep(3000);
  }
}
async function createAndPublish(params, { needsWait }) {
  const c = await api('POST', `/${USER_ID}/threads`, params);
  if (needsWait) await waitContainer(c.id); else await sleep(1500);
  const p = await api('POST', `/${USER_ID}/threads_publish`, { creation_id: c.id });
  const post = await api('GET', `/${p.id}`, { fields: 'id,permalink,text,timestamp' }).catch(() => ({ id: p.id }));
  return { published: true, ...post };
}

// ---------- tools ----------
const S = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = d => ({ type: 'string', description: d }), num = d => ({ type: 'number', description: d }), bool = d => ({ type: 'boolean', description: d });
const READ = { readOnlyHint: true, openWorldHint: true }, WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const replyControl = { type: 'string', enum: ['everyone', 'accounts_you_follow', 'mentioned_only', 'parent_post_author_only', 'followers_only'], description: 'Who can reply (default everyone)' };

const TOOLS = [
  { name: 'get_profile', description: 'Your Threads profile: id, username, name, bio, picture, verified.', inputSchema: S({}), annotations: READ,
    run: () => api('GET', `/${USER_ID}`, { fields: 'id,username,name,threads_profile_picture_url,threads_biography,is_verified' }) },
  { name: 'lookup_profile', description: 'Public profile of any Threads user by username (followers, likes, posts counts where public). Needs threads_profile_discovery.', inputSchema: S({ username: str('Username without @') }, ['username']), annotations: READ,
    run: a => api('GET', '/profile_lookup', { username: a.username.replace(/^@/, '') }) },
  { name: 'list_posts', description: 'Your posts, newest first, with text, permalink, type and timestamps. Paginate with cursor.', inputSchema: S({ limit: num('1-100, default 25'), since: str('YYYY-MM-DD or unix'), until: str('YYYY-MM-DD or unix'), cursor: str('next_cursor from a previous call') }), annotations: READ,
    run: async a => page(await api('GET', `/${USER_ID}/threads`, { fields: POST_FIELDS, limit: Math.min(100, a.limit || 25), since: toUnix(a.since), until: toUnix(a.until), after: a.cursor })) },
  { name: 'get_post', description: 'One post by id with all fields.', inputSchema: S({ id: str('Post id') }, ['id']), annotations: READ,
    run: a => api('GET', `/${a.id}`, { fields: POST_FIELDS }) },
  { name: 'get_post_insights', description: 'Views, likes, replies, reposts, quotes, shares for one post.', inputSchema: S({ id: str('Post id') }, ['id']), annotations: READ,
    run: async a => ({ id: a.id, ...flatMetrics(await api('GET', `/${a.id}/insights`, { metric: POST_METRICS.join(',') })) }) },
  { name: 'top_posts', description: 'Your posts in a date range ranked by a metric, each with full insights. Best tool for "what is working".', inputSchema: S({ since: str('YYYY-MM-DD (default 7 days ago)'), until: str('YYYY-MM-DD'), sort_by: { type: 'string', enum: POST_METRICS, description: 'Default views' }, limit: num('How many to return, default 10'), max_posts: num('Max posts to scan, default 150') }), annotations: READ,
    run: async a => {
      const since = toUnix(a.since) ?? Math.floor(Date.now() / 1000) - 7 * 86400, until = toUnix(a.until), max = Math.min(500, a.max_posts || 150);
      let posts = [], cursor;
      do { const d = await api('GET', `/${USER_ID}/threads`, { fields: 'id,text,permalink,timestamp,media_type,media_product_type', limit: 100, since, until, after: cursor }); posts.push(...(d.data || [])); cursor = d.paging?.next ? d.paging.cursors.after : null; } while (cursor && posts.length < max);
      posts = posts.filter(p => p.media_type !== 'REPOST_FACADE').slice(0, max);
      const out = [];
      for (let i = 0; i < posts.length; i += 8) {
        const batch = await Promise.all(posts.slice(i, i + 8).map(async p => { try { return { ...p, text: (p.text || '').slice(0, 160), ...flatMetrics(await api('GET', `/${p.id}/insights`, { metric: POST_METRICS.join(',') })) }; } catch (e) { return { ...p, insights_error: e.message }; } }));
        out.push(...batch);
      }
      const key = a.sort_by || 'views';
      out.sort((x, y) => (y[key] || 0) - (x[key] || 0));
      const totals = Object.fromEntries(POST_METRICS.map(m => [m, out.reduce((s, p) => s + (p[m] || 0), 0)]));
      return { scanned: out.length, totals, top: out.slice(0, a.limit || 10) };
    } },
  { name: 'get_account_insights', description: 'Account totals in a date range: views, likes, replies, reposts, quotes, link clicks, follower count. Ranges after 13 Apr 2024 only.', inputSchema: S({ since: str('YYYY-MM-DD (default 7 days ago)'), until: str('YYYY-MM-DD (default now)') }), annotations: READ,
    run: async a => {
      const since = toUnix(a.since) ?? Math.floor(Date.now() / 1000) - 7 * 86400, until = toUnix(a.until);
      const res = {};
      for (const m of USER_METRICS) {
        try { const d = await api('GET', `/${USER_ID}/threads_insights`, { metric: m, ...(m === 'followers_count' ? {} : { since, until }) }); const row = (d.data || [])[0] || {}; res[m] = row.total_value?.value ?? row.total_value?.link_total_values ?? (row.values ? row.values.reduce((s, v) => s + (v.value || 0), 0) : null); if (m === 'views' && row.values) res.views_by_day = row.values.map(v => ({ date: v.end_time?.slice(0, 10), views: v.value })); }
        catch (e) { res[m + '_error'] = e.message; }
      }
      return res;
    } },
  { name: 'get_follower_demographics', description: 'Follower breakdown by country, city, age or gender (needs 100+ followers).', inputSchema: S({ breakdown: { type: 'string', enum: ['country', 'city', 'age', 'gender'], description: 'Breakdown' } }, ['breakdown']), annotations: READ,
    run: async a => { const d = await api('GET', `/${USER_ID}/threads_insights`, { metric: 'follower_demographics', breakdown: a.breakdown }); const b = d.data?.[0]?.total_value?.breakdowns?.[0]?.results || []; return { breakdown: a.breakdown, results: b.map(r => ({ [a.breakdown]: r.dimension_values?.[0], followers: r.value })).sort((x, y) => y.followers - x.followers) }; } },
  { name: 'get_replies', description: 'Direct replies to a post (top level). Includes hide_status.', inputSchema: S({ id: str('Post id'), reverse: bool('Oldest first if false (default newest first)'), cursor: str('Pagination cursor') }, ['id']), annotations: READ,
    run: async a => page(await api('GET', `/${a.id}/replies`, { fields: REPLY_FIELDS, reverse: a.reverse === false ? 'false' : 'true', after: a.cursor })) },
  { name: 'get_conversation', description: 'Full flattened conversation under a post (all depths).', inputSchema: S({ id: str('Post id'), cursor: str('Pagination cursor') }, ['id']), annotations: READ,
    run: async a => page(await api('GET', `/${a.id}/conversation`, { fields: REPLY_FIELDS, reverse: 'false', after: a.cursor })) },
  { name: 'inbox', description: 'Replies from other people across your recent posts that you have not answered yet. Best tool for the daily comment sweep.', inputSchema: S({ posts: num('How many recent posts to scan, default 30'), include_answered: bool('Also show replies you already answered (default false)') }), annotations: READ,
    run: async a => {
      const me = (await api('GET', `/${USER_ID}`, { fields: 'username' })).username;
      const d = await api('GET', `/${USER_ID}/threads`, { fields: 'id,text,permalink,timestamp,has_replies,media_type', limit: Math.min(100, a.posts || 30) });
      const posts = (d.data || []).filter(p => p.has_replies !== false && p.media_type !== 'REPOST_FACADE');
      const items = [];
      for (let i = 0; i < posts.length; i += 6) {
        await Promise.all(posts.slice(i, i + 6).map(async p => {
          try {
            const conv = (await api('GET', `/${p.id}/conversation`, { fields: REPLY_FIELDS, reverse: 'false' })).data || [];
            const answered = new Set(conv.filter(r => r.username === me && r.replied_to?.id).map(r => r.replied_to.id));
            conv.filter(r => r.username !== me && r.hide_status !== 'HIDDEN' && (a.include_answered || !answered.has(r.id)))
              .forEach(r => items.push({ reply_id: r.id, from: r.username, text: r.text, timestamp: r.timestamp, permalink: r.permalink, answered: answered.has(r.id), on_post: { id: p.id, text: (p.text || '').slice(0, 120) } }));
          } catch (e) { items.push({ on_post: { id: p.id }, error: e.message }); }
        }));
      }
      const seen = new Set(), uniq = items.filter(x => !x.reply_id || (!seen.has(x.reply_id) && seen.add(x.reply_id)));
      uniq.sort((x, y) => (y.timestamp || '').localeCompare(x.timestamp || ''));
      return { count: uniq.length, replies: uniq };
    } },
  { name: 'get_mentions', description: 'Posts where you are @mentioned.', inputSchema: S({ limit: num('Default 25'), cursor: str('Pagination cursor') }), annotations: READ,
    run: async a => page(await api('GET', `/${USER_ID}/mentions`, { fields: 'id,text,username,permalink,timestamp,media_type', limit: a.limit || 25, after: a.cursor })) },
  { name: 'keyword_search', description: 'Search public Threads posts by keyword or topic tag (e.g. find AuDHD conversations). Needs threads_keyword_search.', inputSchema: S({ q: str('Keyword'), search_type: { type: 'string', enum: ['TOP', 'RECENT'], description: 'Default TOP' }, search_mode: { type: 'string', enum: ['KEYWORD', 'TAG'], description: 'Default KEYWORD' }, since: str('YYYY-MM-DD'), until: str('YYYY-MM-DD'), limit: num('Default 25') }, ['q']), annotations: READ,
    run: async a => page(await api('GET', '/keyword_search', { q: a.q, search_type: a.search_type, search_mode: a.search_mode, since: toUnix(a.since), until: toUnix(a.until), limit: a.limit || 25, fields: 'id,text,username,permalink,timestamp,media_type,has_replies' })) },
  { name: 'get_publishing_limit', description: 'How many posts and replies you can still publish in the current 24h window.', inputSchema: S({}), annotations: READ,
    run: () => api('GET', `/${USER_ID}/threads_publishing_limit`, { fields: 'quota_usage,config,reply_quota_usage,reply_config' }) },
  { name: 'search_locations', description: 'Find location ids for tagging posts.', inputSchema: S({ q: str('Place name') }, ['q']), annotations: READ,
    run: async a => page(await api('GET', '/location_search', { q: a.q, fields: 'id,name,address,city,country' })) },
  { name: 'get_container_status', description: 'Status of a media container (for video posts that are still processing).', inputSchema: S({ id: str('Container id') }, ['id']), annotations: READ,
    run: a => api('GET', `/${a.id}`, { fields: 'status,error_message' }) },
  { name: 'reply', description: 'Publish a reply to a post or reply. Only call after Bhuvan approved the exact text.', inputSchema: S({ reply_to_id: str('Id of the post or reply to answer'), text: str('Reply text, max 500 characters'), image_url: str('Optional public image URL') }, ['reply_to_id', 'text']), annotations: WRITE,
    run: a => { if ([...a.text].length > 500) throw new Error('Reply is over 500 characters.'); return createAndPublish({ media_type: a.image_url ? 'IMAGE' : 'TEXT', text: a.text, image_url: a.image_url, reply_to_id: a.reply_to_id }, { needsWait: !!a.image_url }); } },
  { name: 'publish_post', description: 'Publish a new text, image or video post (optionally quoting a post). Only after approval.', inputSchema: S({ text: str('Max 500 characters'), image_url: str('Public image URL'), video_url: str('Public video URL'), quote_post_id: str('Post id to quote'), link_attachment: str('URL for a link preview (text posts)'), topic_tag: str('Topic tag without #'), location_id: str('From search_locations'), alt_text: str('Alt text for media'), reply_control: replyControl }), annotations: WRITE,
    run: a => {
      if (a.text && [...a.text].length > 500) throw new Error('Text is over 500 characters.');
      if (!a.text && !a.image_url && !a.video_url) throw new Error('Give text, image_url or video_url.');
      const media_type = a.video_url ? 'VIDEO' : a.image_url ? 'IMAGE' : 'TEXT';
      return createAndPublish({ media_type, text: a.text, image_url: a.image_url, video_url: a.video_url, quote_post_id: a.quote_post_id, link_attachment: media_type === 'TEXT' ? a.link_attachment : undefined, topic_tag: a.topic_tag, location_id: a.location_id, alt_text: a.alt_text, reply_control: a.reply_control }, { needsWait: media_type !== 'TEXT' });
    } },
  { name: 'publish_carousel', description: 'Publish a carousel of 2-20 images/videos with optional text. Only after approval.', inputSchema: S({ items: { type: 'array', minItems: 2, maxItems: 20, items: S({ image_url: str('Public image URL'), video_url: str('Public video URL'), alt_text: str('Alt text') }), description: 'Carousel items in order' }, text: str('Caption, max 500 characters'), reply_control: replyControl, topic_tag: str('Topic tag without #') }, ['items']), annotations: WRITE,
    run: async a => {
      if (a.text && [...a.text].length > 500) throw new Error('Text is over 500 characters.');
      const children = [];
      for (const it of a.items) { if (!it.image_url && !it.video_url) throw new Error('Each item needs image_url or video_url.'); const c = await api('POST', `/${USER_ID}/threads`, { media_type: it.video_url ? 'VIDEO' : 'IMAGE', image_url: it.image_url, video_url: it.video_url, alt_text: it.alt_text, is_carousel_item: 'true' }); children.push(c.id); }
      for (const id of children) await waitContainer(id);
      return createAndPublish({ media_type: 'CAROUSEL', children: children.join(','), text: a.text, reply_control: a.reply_control, topic_tag: a.topic_tag }, { needsWait: true });
    } },
  { name: 'repost', description: 'Repost a post to your profile. Only after approval.', inputSchema: S({ id: str('Post id') }, ['id']), annotations: WRITE,
    run: a => api('POST', `/${a.id}/repost`) },
  { name: 'hide_reply', description: 'Hide or unhide a reply on your posts.', inputSchema: S({ reply_id: str('Reply id'), hide: bool('true to hide, false to unhide') }, ['reply_id', 'hide']), annotations: WRITE,
    run: a => api('POST', `/${a.reply_id}/manage_reply`, { hide: a.hide ? 'true' : 'false' }) },
  { name: 'delete_post', description: 'Permanently delete one of your posts or replies. Only after explicit approval.', inputSchema: S({ id: str('Post id') }, ['id']), annotations: DESTRUCTIVE,
    run: a => api('DELETE', `/${a.id}`) },
  { name: 'refresh_token', description: 'Extend the long-lived access token by 60 days and save it locally. Run when the token is close to expiry.', inputSchema: S({}), annotations: WRITE,
    run: async () => {
      const u = new URL(API.replace(/\/v[\d.]+$/, '') + '/refresh_access_token'); u.searchParams.set('grant_type', 'th_refresh_token'); u.searchParams.set('access_token', token());
      const res = await fetch(u); const d = await res.json(); if (!res.ok || d.error) throw new Error('Refresh failed: ' + (d.error?.message || res.status));
      fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true }); fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: d.access_token, expires_at: new Date(Date.now() + d.expires_in * 1000).toISOString() }, null, 2), { mode: 0o600 });
      return { refreshed: true, expires_at: new Date(Date.now() + d.expires_in * 1000).toISOString(), saved_to: TOKEN_FILE };
    } },
  { name: 'check_permissions', description: 'Health check: tries each permission area and reports what works and what is missing.', inputSchema: S({}), annotations: READ,
    run: async () => {
      const checks = {
        threads_basic: () => api('GET', `/${USER_ID}`, { fields: 'id,username' }),
        list_posts: () => api('GET', `/${USER_ID}/threads`, { fields: 'id', limit: 1 }),
        threads_manage_insights: () => api('GET', `/${USER_ID}/threads_insights`, { metric: 'followers_count' }),
        threads_read_replies: async () => { const d = await api('GET', `/${USER_ID}/threads`, { fields: 'id', limit: 1 }); return d.data?.[0] ? api('GET', `/${d.data[0].id}/replies`, { fields: 'id', limit: 1 }) : 'no posts to test'; },
        threads_manage_mentions: () => api('GET', `/${USER_ID}/mentions`, { fields: 'id', limit: 1 }),
        threads_keyword_search: () => api('GET', '/keyword_search', { q: 'adhd', fields: 'id', limit: 1 }),
        threads_profile_discovery: () => api('GET', '/profile_lookup', { username: 'threads' }),
        threads_content_publish: () => api('GET', `/${USER_ID}/threads_publishing_limit`, { fields: 'quota_usage' }),
        threads_location_tagging: () => api('GET', '/location_search', { q: 'Delhi', fields: 'id' })
      };
      const out = {};
      for (const [k, f] of Object.entries(checks)) { try { await f(); out[k] = 'ok'; } catch (e) { out[k] = 'FAILED: ' + e.message; } }
      return out;
    } }
];
const BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));

// ---------- MCP stdio ----------
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async line => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  const { id, method, params } = msg;
  const reply = result => id !== undefined && send({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
  try {
    if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'threads-connector', version: '1.0.0' }, instructions: 'Threads tools for @how.to.audhd. Never call reply, publish_post, publish_carousel, repost, hide_reply or delete_post without Bhuvan approving the exact action first. Use inbox for the comment sweep and top_posts for performance.' });
    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) });
    if (method === 'tools/call') {
      const t = BY_NAME[params?.name]; if (!t) return fail(-32602, 'Unknown tool: ' + params?.name);
      try { const out = await t.run(params.arguments || {}); return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] }); }
      catch (e) { log(params.name, 'failed:', e.message); return reply({ content: [{ type: 'text', text: e.message }], isError: true }); }
    }
    if (method === 'resources/list') return reply({ resources: [] });
    if (method === 'prompts/list') return reply({ prompts: [] });
    return fail(-32601, 'Method not found: ' + method);
  } catch (e) { fail(-32603, e.message); }
});
rl.on('close', () => process.exit(0));
log('ready,', TOOLS.length, 'tools, API', API);
