/* Real-events updater for the car shows app.

   Every run (GitHub Actions, every 6 hours):
     1. Downloads each page in sources.json (respecting robots.txt) and turns it into plain text.
     2. Compares it with last time. Only pages whose text changed are sent to Claude, so most runs cost nothing.
     3. Claude reads each changed page and lists the car events on it (structured JSON, nothing invented).
        This goes through the Message Batches API at half price; if the batch isn't back yet, the next run collects it.
     4. Each event gets a map position from postcodes.io, duplicates are merged, past and cancelled ones dropped.
     5. Writes events.json (what the app loads) and data/state.json (memory between runs).
   With --discover (the weekly run), Claude also searches the web for new organiser pages and adds good ones.

   Flags: --dry-run (no Claude calls, nothing saved: shows what would be read and the rough cost)
          --sync (call Claude directly instead of a batch: faster, full price; handy for testing)
          --limit=N (read at most N changed pages this run)   --discover   --only=<text> (sources whose URL contains it)
   Needs ANTHROPIC_API_KEY in the environment unless --dry-run. */

import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = f => path.join(ROOT, f);
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };

const MODEL = process.env.EVENTS_MODEL || 'claude-opus-5-5';
const DRY = flag('--dry-run'), SYNC = flag('--sync'), DISCOVER = flag('--discover');
const LIMIT = +opt('limit', 60), ONLY = opt('only', '');
const MAX_CHARS = 90_000;                 // longest page text sent to Claude (~22k tokens)
const BATCH_WAIT_MIN = +opt('wait', 100); // how long to wait for a batch before leaving it for the next run
const UA = 'CarShowsBot/1.0 (UK car events listing; reads public event pages a few times a day)';
// Opus 5.5 prices per million tokens; the batch halves them. Web search is $10 per 1,000 searches.
const PRICE = { in: 4, out: 20 }, BATCH_FACTOR = 0.5, SEARCH_EACH = 0.01;

const TYPES = ['classic', 'supercar', 'jdm', 'muscle', 'meet', 'track', 'offroad', 'auction'];
const BLOCKED_HOSTS = /(^|\.)(facebook|fb|instagram|twitter|x|tiktok|eventbrite|ticketmaster|seetickets|skiddle|ents24|allevents|motaclan|carshowfinder|youtube|reddit|wikipedia|google)\./i;

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 24);
const readJson = async (f, d) => { try { return JSON.parse(await readFile(P(f), 'utf8')); } catch { return d; } };
const writeJson = async (f, v) => { await mkdir(path.dirname(P(f)), { recursive: true }); await writeFile(P(f), JSON.stringify(v, null, 2) + '\n'); };

/* ---------- Dates, in UK time ---------- */
const ukDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = ukDate();

/* ---------- robots.txt: skip anything a site asks bots not to read ---------- */
const robotsCache = new Map();
async function robotsAllows(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
      if (r.ok) rules = parseRobots(await r.text());
    } catch {}
    robotsCache.set(u.origin, rules);
  }
  const p = u.pathname + u.search;
  let best = null;   // the longest matching rule wins; Allow wins a tie
  for (const r of robotsCache.get(u.origin)) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(p) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
function parseRobots(txt) {
  const groups = []; let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!lastWasAgent) groups.push(cur = { agents: [], rules: [] }); cur.agents.push(v.toLowerCase()); lastWasAgent = true; }
    else { lastWasAgent = false; if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v }); }
  }
  const mine = groups.filter(g => g.agents.some(a => a.includes('carshowsbot')));
  return (mine.length ? mine : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
}

/* ---------- Fetching and cleaning a page ---------- */
async function fetchPage(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();
  if (html.length > 6_000_000) throw new Error('page too large');
  return { html, finalUrl: r.url };
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', pound: '£', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…' };
const decode = s => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(parseInt(e[1].toLowerCase() === 'x' ? e.slice(2) : e.slice(1), e[1].toLowerCase() === 'x' ? 16 : 10) || 32) : ENT[e.toLowerCase()] ?? m);
// Visible text with links kept as "text [url]" so Claude can give each event its own page. Structured event data
// (JSON-LD) is kept too, because it's the most reliable thing on a page when a site provides it.
function cleanHtml(html, base) {
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1].trim()).filter(s => /Event/.test(s));
  let s = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
      const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text || /^(#|javascript:|mailto:|tel:)/i.test(href)) return ' ' + text + ' ';
      let abs; try { abs = new URL(decode(href), base).href; } catch { return ' ' + text + ' '; }
      return ` ${text} [${abs}] `;
    })
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|li|h[1-6]|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decode(s).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim();
  if (ld.length) s = 'Structured event data on the page:\n' + ld.join('\n').slice(0, 20000) + '\n\nPage text:\n' + s;
  return s.slice(0, MAX_CHARS);
}

/* ---------- What Claude is asked, and the exact shape of its answer ---------- */
const SYSTEM = `You read one web page from a UK car event organiser or venue and list the car events on it, for a car shows app.

Rules:
- Only list events that are clearly about cars or motoring and open to the public (shows, meets, cars and coffee, track days, auctions, off-road days, festivals, club rallies). Skip talks, kids' crafts, weddings, and anything not about vehicles.
- Only events taking place on or after TODAY and within the next 12 months. A multi-day event counts if it ends on or after today.
- Use only what the page says. Never guess a date, time, price or place. Unknown text is "", unknown number is -1.
- Dates as YYYY-MM-DD; times as 24-hour HH:MM in UK time.
- type: classic (classic, vintage, heritage, single-marque club days), supercar (supercars, hypercars, prestige, Italian/German exotica), jdm (Japanese, tuner, modified), muscle (American cars), meet (cars and coffee, breakfast meets, informal evening meets, open gatherings), track (track days, driving experiences on circuits, sprints you enter), offroad (4x4, overland, off-road), auction (car auctions and sales). Pick the closest one.
- mode: "enter" if you can only take part by bringing a car (e.g. track days), "spectate" if visitors only (e.g. auctions, races to watch), "both" if you can visit and also display a car.
- price_look: cheapest adult ticket to visit, in pounds. price_car: cost to bring or display a car, in pounds. 0 means free. -1 if not stated.
- description: one or two short sentences in your own words saying what happens there, for someone deciding whether to go. No marketing language, no copying long text.
- url: the event's own page if the page links to one, otherwise the page URL given. Must be a full https link.
- venue: the venue name. town: the town or nearest town. postcode: only if the page gives it.
- cancelled: true only if the page says it is cancelled or postponed.
- If the page has no qualifying events, return an empty list.`;

const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' };
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['events'],
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'type', 'start_date', 'end_date', 'start_time', 'end_time', 'venue', 'town', 'postcode', 'price_look', 'price_car', 'mode', 'description', 'url', 'cancelled'],
        properties: {
          name: str, type: { type: 'string', enum: TYPES }, start_date: str, end_date: str, start_time: str, end_time: str,
          venue: str, town: str, postcode: str, price_look: num, price_car: num,
          mode: { type: 'string', enum: ['enter', 'spectate', 'both'] }, description: str, url: str, cancelled: bool,
        },
      },
    },
  },
};
const requestFor = (src, text) => ({
  model: MODEL,
  max_tokens: 16000,
  system: SYSTEM,
  messages: [{ role: 'user', content: `TODAY is ${TODAY}.\nOrganiser: ${src.name}\nPage URL: ${src.url}\n\n<page>\n${text}\n</page>` }],
  output_config: { format: { type: 'json_schema', schema: SCHEMA } },
});
function parseAnswer(message) {
  if (message.stop_reason === 'max_tokens') throw new Error('answer cut off (max_tokens)');
  if (message.stop_reason === 'refusal') throw new Error('refused');
  const block = message.content.find(b => b.type === 'text');
  if (!block) throw new Error('no text in answer');
  const data = JSON.parse(block.text);
  return Array.isArray(data.events) ? data.events : [];
}

/* ---------- Map positions from postcodes.io (free, UK only) ---------- */
const PC_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i, OUT_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/i;
async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) });
  return r.ok ? r.json() : null;
}
async function geocode(ev, cache) {
  const tries = [];
  const pc = (ev.postcode || '').trim().toUpperCase();
  if (PC_RE.test(pc)) tries.push(['pc:' + pc, `https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`, j => j?.result && [j.result.latitude, j.result.longitude, j.result.admin_district]]);
  const out = pc.split(/\s+/)[0];
  if (OUT_RE.test(out)) tries.push(['out:' + out, `https://api.postcodes.io/outcodes/${encodeURIComponent(out)}`, j => j?.result && [j.result.latitude, j.result.longitude, null]]);
  for (const q of [ev.town, ev.venue].map(s => (s || '').trim()).filter(Boolean)) {
    tries.push(['place:' + q.toLowerCase(), `https://api.postcodes.io/places?q=${encodeURIComponent(q)}&limit=1`, j => j?.result?.[0] && [j.result[0].latitude, j.result[0].longitude, j.result[0].name_1]]);
  }
  for (const [key, url, pick] of tries) {
    if (!(key in cache)) { try { cache[key] = pick(await getJson(url)) || null; } catch { continue; } await sleep(120); }
    const hit = cache[key];
    if (hit && hit[0] != null && hit[1] != null) return { lat: hit[0], lon: hit[1], place: hit[2] };
  }
  return null;
}

/* ---------- Turning Claude's list into the app's events ---------- */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const money = n => (typeof n === 'number' && n >= 0 && n < 10000) ? Math.round(n * 100) / 100 : null;
async function normalise(raw, src, geoCache) {
  const out = [];
  for (const e of raw) {
    if (!e || e.cancelled || !TYPES.includes(e.type) || !DATE_RE.test(e.start_date) || !e.name?.trim()) continue;
    const end = DATE_RE.test(e.end_date) && e.end_date >= e.start_date ? e.end_date : e.start_date;
    if (end < TODAY || e.start_date > addDays(TODAY, 366)) continue;
    const where = await geocode(e, geoCache);
    if (!where || where.lat < 49.8 || where.lat > 61 || where.lon < -8.7 || where.lon > 2) { log(`   no map position for "${e.name}" (${e.town || e.postcode || 'no place'}), skipped`); continue; }
    const startTime = TIME_RE.test(e.start_time) ? e.start_time : '', endTime = TIME_RE.test(e.end_time) ? e.end_time : '';
    let url = ''; try { const u = new URL(e.url || src.url); if (u.protocol === 'https:') url = u.href; } catch {}
    const name = e.name.trim().slice(0, 120);
    out.push({
      id: 'r' + sha(name.toLowerCase().replace(/[^a-z0-9]/g, '') + e.start_date),
      name, type: e.type,
      start: e.start_date + (startTime ? 'T' + startTime : ''),
      end: end + (endTime ? 'T' + endTime : ''),
      timeKnown: !!startTime,
      venue: (e.venue || '').trim().slice(0, 120) || (e.town || '').trim(),
      town: (e.town || where.place || '').trim().slice(0, 60),
      postcode: PC_RE.test((e.postcode || '').trim()) ? e.postcode.trim().toUpperCase() : '',
      lat: Math.round(where.lat * 1e5) / 1e5, lon: Math.round(where.lon * 1e5) / 1e5,
      priceLook: money(e.price_look), priceCar: money(e.price_car),
      mode: e.mode, desc: (e.description || '').trim().slice(0, 300), url,
      source: src.name, sourceUrl: src.url,
    });
  }
  return out;
}
// The same show listed on two pages: keep one, filling gaps from the other
const dedupeKey = e => e.name.toLowerCase().replace(/\b(19|20)\d{2}\b/g, '').replace(/[^a-z0-9]/g, '') + '|' + e.start.slice(0, 10);
function merge(all) {
  const byKey = new Map();
  for (const e of all) {
    const k = dedupeKey(e), prev = byKey.get(k);
    if (!prev) { byKey.set(k, { ...e }); continue; }
    for (const f of ['postcode', 'desc', 'venue', 'town']) if (!prev[f] && e[f]) prev[f] = e[f];
    if (prev.priceLook == null) prev.priceLook = e.priceLook;
    if (prev.priceCar == null) prev.priceCar = e.priceCar;
    if (!prev.timeKnown && e.timeKnown) { prev.start = e.start; prev.end = e.end; prev.timeKnown = true; }
    if (prev.url === prev.sourceUrl && e.url !== e.sourceUrl) prev.url = e.url;
  }
  return [...byKey.values()].filter(e => e.end.slice(0, 10) >= TODAY).sort((a, b) => a.start.localeCompare(b.start));
}

/* ---------- Claude calls: one at a time (--sync) or as a half-price batch ---------- */
let client = null;
const usage = { in: 0, out: 0, searches: 0, batch: !SYNC };
const addUsage = u => { if (!u) return; usage.in += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); usage.out += u.output_tokens || 0; usage.searches += u.server_tool_use?.web_search_requests || 0; };
async function extractSync(jobs) {
  const results = {};
  for (const j of jobs) {
    try {
      const msg = await client.messages.stream(requestFor(j.src, j.text)).finalMessage();
      addUsage(msg.usage); results[j.id] = { ok: true, events: parseAnswer(msg) };
    } catch (err) { results[j.id] = { ok: false, error: String(err.message || err) }; }
    log(`   ${j.src.name}: ${results[j.id].ok ? results[j.id].events.length + ' events' : 'failed, ' + results[j.id].error}`);
  }
  return results;
}
async function batchResults(batchId) {
  const results = {};
  for await (const r of await client.messages.batches.results(batchId)) {
    if (r.result.type === 'succeeded') {
      addUsage(r.result.message.usage);
      try { results[r.custom_id] = { ok: true, events: parseAnswer(r.result.message) }; }
      catch (err) { results[r.custom_id] = { ok: false, error: String(err.message || err) }; }
    } else results[r.custom_id] = { ok: false, error: r.result.type + (r.result.error?.type ? ' ' + r.result.error.type : '') };
  }
  return results;
}
async function waitForBatch(batchId, minutes) {
  const until = Date.now() + minutes * 60000;
  while (true) {
    const b = await client.messages.batches.retrieve(batchId);
    if (b.processing_status === 'ended') return true;
    if (Date.now() > until) { log(`   batch ${batchId} still ${b.processing_status}; the next run will collect it`); return false; }
    log(`   batch ${b.processing_status}: ${b.request_counts.processing} reading, ${b.request_counts.succeeded} done`);
    await sleep(60000);
  }
}

/* ---------- Weekly: look for new organiser pages ---------- */
async function discover(sources) {
  const known = sources.map(s => s.url).join('\n');
  const messages = [{ role: 'user', content: `Find official web pages of UK organisers and venues that list upcoming car events: car shows, car meets and cars and coffee, track days, car auctions, off-road and 4x4 days, motoring festivals. Look across the whole UK, especially regions and kinds of event not already covered below.

Only pages that are the organiser's or venue's own events or calendar page, listing several dated events in the page itself. Not Facebook, Instagram, Eventbrite or other ticket sellers, not directories or listing sites that collect other people's events, not news articles, not PDFs.

Already covered:\n${known}\n\nFinish with a JSON array in a \`\`\`json code block, at most 15 items, each {"url": "...", "name": "organiser name", "why": "a few words"}.` }];
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 12, user_location: { type: 'approximate', country: 'GB' } }];
  let msg;
  for (let i = 0; i < 6; i++) {
    msg = await client.messages.stream({ model: MODEL, max_tokens: 16000, tools, messages }).finalMessage();
    addUsage(msg.usage);
    if (msg.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: msg.content });   // a long search turn paused: send it back to carry on
  }
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\[[\s\S]*\])/);
  let found = []; try { found = JSON.parse(m[1]); } catch { log('   discovery: no list in the answer'); return []; }
  const have = new Set(sources.map(s => { const u = new URL(s.url); return u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, ''); }));
  const added = [];
  for (const c of found.slice(0, 15)) {
    let u; try { u = new URL(c.url); } catch { continue; }
    const key = u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
    if (u.protocol !== 'https:' || BLOCKED_HOSTS.test(u.host) || have.has(key) || /\.pdf$/i.test(u.pathname)) continue;
    try {
      if (!(await robotsAllows(u.href))) { log(`   discovery: ${u.href} blocks bots, skipped`); continue; }
      const { html, finalUrl } = await fetchPage(u.href);
      if (cleanHtml(html, finalUrl).length < 1500) { log(`   discovery: ${u.href} has too little text (probably built by scripts), skipped`); continue; }
    } catch (err) { log(`   discovery: ${u.href} didn't load (${err.message}), skipped`); continue; }
    const s = { name: String(c.name || u.host).slice(0, 80), url: u.href, enabled: true, added: 'auto', addedOn: TODAY, why: String(c.why || '').slice(0, 120) };
    sources.push(s); have.add(key); added.push(s);
    log(`   discovery: added ${s.name} (${s.url})`);
    if (added.length >= 10) break;
  }
  return added;
}

/* ---------- The run ---------- */
async function main() {
  const sourcesFile = await readJson('sources.json', { sources: [] });
  const sources = sourcesFile.sources;
  const state = await readJson('data/state.json', { pages: {}, geo: {}, pendingBatch: null });
  state.pages ??= {}; state.geo ??= {};
  if (!DRY) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ maxRetries: 4 });
  }
  log(`Car events update, ${TODAY}, model ${MODEL}${DRY ? ', DRY RUN' : SYNC ? ', direct calls' : ', batch'}`);

  // 1. A batch sent by an earlier run: collect it if it's back
  const handle = async (jobsById, results) => {
    for (const [id, job] of Object.entries(jobsById)) {
      const r = results[id], pg = state.pages[job.url] ??= {};
      if (!r?.ok) { pg.error = r?.error || 'no result'; log(`   ${job.name}: ${pg.error}`); continue; }
      const src = sources.find(s => s.url === job.url) || { name: job.name, url: job.url };
      pg.events = await normalise(r.events, src, state.geo);
      pg.hash = job.hash; pg.lastExtract = new Date().toISOString(); pg.error = null;
      log(`   ${job.name}: ${r.events.length} found, ${pg.events.length} kept`);
    }
  };
  let waitingOnBatch = false;
  if (state.pendingBatch && !DRY) {
    const pb = state.pendingBatch;
    log(`Collecting batch ${pb.id} from ${pb.sentAt}`);
    const b = await client.messages.batches.retrieve(pb.id);
    if (b.processing_status === 'ended') { await handle(pb.jobs, await batchResults(pb.id)); state.pendingBatch = null; }
    else if (Date.now() - Date.parse(pb.sentAt) > 30 * 3600000) { log('   batch is over 30 hours old, dropping it'); state.pendingBatch = null; }
    else { waitingOnBatch = true; log(`   still ${b.processing_status}; pages will be checked again next run`); }
  }

  // 2. Download every page and see which ones changed
  const live = sources.filter(s => s.enabled !== false && (!ONLY || s.url.includes(ONLY)));
  const jobs = [];
  log(`Checking ${live.length} pages`);
  for (const src of live) {
    const pg = state.pages[src.url] ??= {};
    try {
      if (!(await robotsAllows(src.url))) { pg.error = 'robots.txt asks bots not to read this page'; log(`   ${src.name}: blocked by robots.txt`); continue; }
      const { html, finalUrl } = await fetchPage(src.url);
      const text = cleanHtml(html, finalUrl), hash = sha(text);
      pg.lastFetch = new Date().toISOString(); pg.lastOk = pg.lastFetch;
      if (text.length < 800) { pg.error = 'almost no text (page probably built by scripts)'; log(`   ${src.name}: almost no text, skipped`); continue; }
      if (hash === pg.hash) { log(`   ${src.name}: unchanged`); continue; }
      // Changed, but read recently and nothing from it is coming up soon: wait, so a page that changes a little every
      // few hours (a clock, a counter) doesn't cost four reads a day
      const recent = pg.lastExtract && Date.now() - Date.parse(pg.lastExtract) < 20 * 3600000;
      const soon = (pg.events || []).some(e => e.start.slice(0, 10) <= addDays(TODAY, 3));
      if (recent && !soon && !flag('--force')) { log(`   ${src.name}: changed, read again tomorrow`); continue; }
      jobs.push({ id: 'p' + jobs.length, src, text, hash, url: src.url, name: src.name });
      log(`   ${src.name}: changed, ${Math.round(text.length / 1000)}k characters`);
    } catch (err) {
      pg.error = String(err.message || err); pg.lastFetch = new Date().toISOString();
      log(`   ${src.name}: couldn't load (${pg.error})`);
    }
  }
  const todo = waitingOnBatch ? [] : jobs.slice(0, LIMIT);
  if (jobs.length > todo.length && !waitingOnBatch) log(`   ${jobs.length - todo.length} more changed pages left for the next run (limit ${LIMIT})`);

  // 3. Claude reads the changed pages
  if (todo.length && DRY) {
    const tokIn = todo.reduce((n, j) => n + j.text.length / 3.6 + 1500, 0), tokOut = todo.length * 4000;
    const cost = (tokIn * PRICE.in + tokOut * PRICE.out) / 1e6 * BATCH_FACTOR;
    log(`Dry run: would read ${todo.length} pages, about ${Math.round(tokIn / 1000)}k tokens in, roughly $${cost.toFixed(2)} with the batch discount`);
  } else if (todo.length) {
    const jobsById = Object.fromEntries(todo.map(j => [j.id, { url: j.url, name: j.name, hash: j.hash }]));
    if (SYNC) {
      log(`Reading ${todo.length} pages with Claude`);
      await handle(jobsById, await extractSync(todo));
    } else {
      const batch = await client.messages.batches.create({ requests: todo.map(j => ({ custom_id: j.id, params: requestFor(j.src, j.text) })) });
      state.pendingBatch = { id: batch.id, sentAt: new Date().toISOString(), jobs: jobsById };
      await writeJson('data/state.json', state);   // so a cancelled run can still collect it next time
      log(`Sent ${todo.length} pages to Claude as batch ${batch.id}; waiting up to ${BATCH_WAIT_MIN} minutes`);
      if (await waitForBatch(batch.id, BATCH_WAIT_MIN)) { await handle(jobsById, await batchResults(batch.id)); state.pendingBatch = null; }
    }
  } else if (!waitingOnBatch) log('Nothing changed; no Claude calls needed');

  // 4. Weekly discovery
  let added = [];
  if (DISCOVER && !DRY) {
    log('Looking for new organiser pages');
    try { added = await discover(sources); await writeJson('sources.json', { ...sourcesFile, sources }); }
    catch (err) { log(`   discovery failed: ${err.message || err}`); }
  }

  // 5. Pages that have failed for over a week stop contributing events; everything else is merged into events.json
  const weekAgo = Date.now() - 7 * 86400000;
  const all = [];
  for (const src of sources) {
    const pg = state.pages[src.url];
    if (!pg?.events || src.enabled === false) continue;
    if (pg.lastOk && Date.parse(pg.lastOk) < weekAgo) continue;
    all.push(...pg.events);
  }
  const events = merge(all);
  const cost = ((usage.in * PRICE.in + usage.out * PRICE.out) / 1e6) * (SYNC ? 1 : BATCH_FACTOR) + usage.searches * SEARCH_EACH;
  log(`${events.length} upcoming events from ${new Set(events.map(e => e.source)).size} organisers. Claude use this run: ${usage.in} tokens in, ${usage.out} out, ${usage.searches} searches, about $${cost.toFixed(2)}`);
  if (DRY) return;
  await writeJson('events.json', { updated: new Date().toISOString(), count: events.length, events });
  await writeJson('data/state.json', state);
  const runs = await readJson('data/runs.json', []);
  runs.unshift({ at: new Date().toISOString(), read: todo.length, events: events.length, added: added.length, tokensIn: usage.in, tokensOut: usage.out, searches: usage.searches, costUsd: Math.round(cost * 1000) / 1000 });
  await writeJson('data/runs.json', runs.slice(0, 200));
}

main().catch(err => { console.error(err); process.exit(1); });
