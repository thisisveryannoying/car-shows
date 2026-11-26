/* Real-events updater for the car shows app.

   Every run (GitHub Actions, every 6 hours):
     1. Discovery: searches the web for organiser pages in the next area on a rotating list (every county of the UK,
        every kind of event, the main car clubs), so each run looks somewhere different and the whole country is swept
        about once a month. New pages are checked (they load, allow bots, have real text) and added to sources.json.
     2. Downloads every source page (respecting robots.txt) and keeps only the parts that mention dates.
        A page with no dates on it can't list events, so it costs nothing. A page whose dated parts haven't changed
        since last time costs nothing either.
     3. Claude reads only the changed pages, at half price through the Message Batches API, and lists the car events
        on each (structured JSON; only what the page states, nothing guessed). It also points out further pages of the
        same site that list more events, which are added and read next time.
     4. Each event gets a map position from postcodes.io, duplicates are merged, past and cancelled ones dropped.
     5. Writes events.json (what the app loads) and data/state.json (memory between runs).

   Flags: --dry-run (no Claude calls, nothing saved: shows what would be read and the rough cost)
          --sync (call Claude directly instead of a batch: faster, full price; handy for testing)
          --discover[=N] (N discovery searches this run, default 1)   --limit=N   --budget=USD (per run, default 4)
          --only=<text> (sources whose URL contains it)   --sources=<file>   --force (read changed pages even if read today)
   Needs ANTHROPIC_API_KEY in the environment unless --dry-run. */

import Anthropic from '@anthropic-ai/sdk';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = f => path.resolve(ROOT, f);
const args = process.argv.slice(2);
const flag = f => args.includes(f) || args.some(a => a.startsWith(f + '='));
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };

// Reading pages: the model you chose for accuracy. Finding new pages: a much cheaper model is enough, because every
// page it suggests is then checked by downloading it, and the events on it are still read by the main model.
const MODEL = process.env.EVENTS_MODEL || 'claude-opus-5-5';
const DISCOVERY_MODEL = process.env.DISCOVERY_MODEL || 'claude-haiku-5-5';
const DRY = flag('--dry-run'), SYNC = flag('--sync');
const DISCOVER = flag('--discover') ? Math.max(1, +opt('discover', 1) || 1) : 0;
const LIMIT = +opt('limit', 80), BUDGET = +opt('budget', 4), ONLY = opt('only', '');
const MAX_CHARS = 60_000;                 // longest page text sent to Claude after trimming (~15k tokens)
const BATCH_WAIT_MIN = +opt('wait', 100);
const UA = 'CarShowsBot/1.0 (UK car events listing; reads public event pages a few times a day)';
// Dollars per million tokens (input, output). The batch halves them. Web search is $10 per 1,000 searches.
const PRICES = { opus: [4, 20], sonnet: [2, 10], haiku: [0.1, 0.5] };
const priceOf = m => PRICES[Object.keys(PRICES).find(k => m.includes(k))] || PRICES.opus;
const BATCH_FACTOR = 0.5, SEARCH_EACH = 0.01;

const TYPES = ['classic', 'supercar', 'jdm', 'muscle', 'meet', 'track', 'offroad', 'auction'];
const BLOCKED_HOSTS = /(^|\.)(facebook|fb|instagram|twitter|x|tiktok|eventbrite|ticketmaster|seetickets|skiddle|ents24|allevents|motaclan|carshowfinder|youtube|reddit|wikipedia|google|tickettailor|ticketsource|designmynight|visitengland|visitbritain|tripadvisor)\./i;

const log = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 24);
const readJson = async (f, d) => { try { return JSON.parse(await readFile(P(f), 'utf8')); } catch { return d; } };
const writeJson = async (f, v) => { await mkdir(path.dirname(P(f)), { recursive: true }); await writeFile(P(f), JSON.stringify(v, null, 2) + '\n'); };

/* ---------- Dates, in UK time ---------- */
const ukDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = ukDate();

/* ---------- Spend: every Claude call is costed as it happens ---------- */
const usage = { in: 0, out: 0, searches: 0, usd: 0 };
function addUsage(u, model, batch) {
  if (!u) return;
  const tin = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), tout = u.output_tokens || 0;
  const s = u.server_tool_use?.web_search_requests || 0, [pi, po] = priceOf(model);
  usage.in += tin; usage.out += tout; usage.searches += s;
  usage.usd += (tin * pi + tout * po) / 1e6 * (batch ? BATCH_FACTOR : 1) + s * SEARCH_EACH;
}
const estimate = text => { const [pi, po] = priceOf(MODEL); return ((text.length / 3.6 + 1500) * pi + 3500 * po) / 1e6 * (SYNC ? 1 : BATCH_FACTOR); };

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
// Visible text with links kept as "text [url]" so Claude can give each event its own page, plus any structured event
// data (JSON-LD), which is the most reliable thing on a page when a site provides it.
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
  return { text: s, ld: ld.join('\n').slice(0, 20000) };
}
/* Keep only what matters: lines near a date, plus the top of the page (its title) and links to more listings.
   Menus, footers, cookie notices and long articles fall away, which cuts the cost of reading a page by half or more,
   and means a change to the page's footer or a news item doesn't trigger a paid re-read. */
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_HINT = new RegExp(`\\b(?:\\d{1,2}(?:st|nd|rd|th)?(?:\\s*(?:-|–|to|&)\\s*\\d{1,2}(?:st|nd|rd|th)?)?\\s+${MONTH}\\b|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b|\\d{1,2}[/.]\\d{1,2}[/.](?:20)?\\d{2}\\b|20\\d{2}-\\d{2}-\\d{2}|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b)`, 'i');
const MORE_HINT = /\b(more events|all events|what'?s on|calendar|next page|page \d|load more|upcoming|events?)\b/i;
function relevant({ text, ld }) {
  const lines = text.split('\n'), keep = new Array(lines.length).fill(false);
  let dated = 0;
  lines.forEach((l, i) => {
    if (DATE_HINT.test(l)) { dated++; for (let k = Math.max(0, i - 4); k <= Math.min(lines.length - 1, i + 4); k++) keep[k] = true; }
    else if (i < 12 || (MORE_HINT.test(l) && /\[https?:/.test(l) && l.length < 200)) keep[i] = true;
  });
  let out = []; let gap = false;
  lines.forEach((l, i) => { if (keep[i]) { out.push(l); gap = false; } else if (!gap) { out.push('…'); gap = true; } });
  let s = out.join('\n');
  if (ld) s = 'Structured event data on the page:\n' + ld + '\n\nPage text (parts without dates left out):\n' + s;
  return { text: s.slice(0, MAX_CHARS), dated: dated + (ld ? 1 : 0) };
}

/* ---------- What Claude is asked, and the exact shape of its answer ---------- */
const SYSTEM = `You read one web page from a UK car event organiser, venue or club and list the car events on it, for a car shows app. Parts of the page without dates have been cut out and marked "…".

Rules:
- Only list events that are clearly about cars or motoring and open to the public (shows, meets, cars and coffee, track days, auctions, off-road days, festivals, club rallies, hill climbs and race meetings people can watch). Skip talks, kids' crafts, weddings, and anything not about vehicles. Motorcycle-only events are out.
- Only events taking place on or after TODAY and within the next 12 months. A multi-day event counts if it ends on or after today.
- Accuracy matters more than anything. Use only what the page says. Never guess a date, time, price or place. If the year isn't stated and can't be worked out for certain from the page (for example a "2027 calendar" heading), leave the event out. Unknown text is "", unknown number is -1.
- Dates as YYYY-MM-DD; times as 24-hour HH:MM in UK time. A recurring event (e.g. "first Sunday of every month") is listed once for each date in the next 3 months.
- type: classic (classic, vintage, heritage, single-marque club days), supercar (supercars, hypercars, prestige, Italian/German exotica), jdm (Japanese, tuner, modified), muscle (American cars, hot rods), meet (cars and coffee, breakfast meets, informal evening meets, open gatherings), track (track days, driving experiences, race meetings, hill climbs, sprints, drag racing), offroad (4x4, overland, off-road, green laning), auction (car auctions and sales). Pick the closest one.
- mode: "enter" if you can only take part by bringing a car (e.g. track days), "spectate" if visitors only (e.g. auctions, races to watch), "both" if you can visit and also display a car.
- price_look: cheapest adult ticket to visit, in pounds. price_car: cost to bring or display a car, in pounds. 0 means free. -1 if not stated.
- description: one or two short sentences in your own words saying what happens there, for someone deciding whether to go. No marketing language, no copying long text.
- url: the event's own page if the page links to one, otherwise the page URL given. Must be a full https link.
- venue: the venue name. town: the town or nearest town. postcode: only if the page gives it.
- cancelled: true only if the page says it is cancelled or postponed.
- If the page has no qualifying events, return an empty list.
- more_pages: links on this page to other pages of the same website that list MORE upcoming car events (the next page of the calendar, a "motoring events" or "car shows" section, a month view). Not single event pages, not news, not ticket shops. At most 5; empty if none.`;

const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' };
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['events', 'more_pages'],
  properties: {
    more_pages: { type: 'array', items: str },
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
  return { events: Array.isArray(data.events) ? data.events : [], more: Array.isArray(data.more_pages) ? data.more_pages : [] };
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
const realDate = s => { const d = new Date(s + 'T12:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
async function normalise(raw, src, geoCache) {
  const out = [];
  for (const e of raw) {
    if (!e || e.cancelled || !TYPES.includes(e.type) || !DATE_RE.test(e.start_date) || !realDate(e.start_date) || !e.name?.trim()) continue;
    const end = DATE_RE.test(e.end_date) && realDate(e.end_date) && e.end_date >= e.start_date && e.end_date <= addDays(e.start_date, 14) ? e.end_date : e.start_date;
    if (end < TODAY || e.start_date > addDays(TODAY, 366)) continue;
    const where = await geocode(e, geoCache);
    if (!where || where.lat < 49.8 || where.lat > 61 || where.lon < -8.7 || where.lon > 2) { log(`      no map position for "${e.name}" (${e.town || e.postcode || 'no place'}), skipped`); continue; }
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
// The same show listed on two pages (or by two organisers): keep one, filling its gaps from the other. Names are
// compared without years, punctuation and filler words, so "The 2027 Classic Car Show" matches "Classic Car Show".
const nameKey = n => n.toLowerCase().replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b(the|and|annual|show|event|day|uk|at)\b/g, ' ').replace(/[^a-z0-9]/g, '');
function merge(all) {
  const byKey = new Map();
  for (const e of all) {
    const k = nameKey(e.name) + '|' + e.start.slice(0, 10), prev = byKey.get(k);
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
async function extractSync(jobs) {
  const results = {};
  for (const j of jobs) {
    try {
      const msg = await client.messages.stream(requestFor(j.src, j.text)).finalMessage();
      addUsage(msg.usage, MODEL, false); results[j.id] = { ok: true, ...parseAnswer(msg) };
    } catch (err) { results[j.id] = { ok: false, error: String(err.message || err) }; }
  }
  return results;
}
async function batchResults(batchId) {
  const results = {};
  for await (const r of await client.messages.batches.results(batchId)) {
    if (r.result.type === 'succeeded') {
      addUsage(r.result.message.usage, MODEL, true);
      try { results[r.custom_id] = { ok: true, ...parseAnswer(r.result.message) }; }
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

/* ---------- Discovery: a different corner of the UK, or kind of event, every run ----------
   Every county and region, every kind of event and the main marque clubs. One search per run (four a day) works
   through the whole list in about a month, then starts again, so new organisers keep being picked up. */
const AREAS = [
  'Cornwall', 'Devon', 'Somerset', 'Dorset', 'Wiltshire', 'Gloucestershire', 'Bristol and Bath', 'Hampshire', 'Isle of Wight',
  'Berkshire', 'Oxfordshire', 'Buckinghamshire', 'Surrey', 'West Sussex', 'East Sussex', 'Kent', 'Greater London', 'Essex',
  'Hertfordshire', 'Bedfordshire', 'Cambridgeshire', 'Suffolk', 'Norfolk', 'Northamptonshire', 'Leicestershire and Rutland',
  'Lincolnshire', 'Nottinghamshire', 'Derbyshire', 'Staffordshire', 'Warwickshire', 'West Midlands and Birmingham',
  'Worcestershire', 'Herefordshire', 'Shropshire', 'Cheshire', 'Greater Manchester', 'Merseyside', 'Lancashire', 'Cumbria',
  'North Yorkshire', 'West Yorkshire', 'South Yorkshire', 'East Yorkshire and Hull', 'County Durham', 'Northumberland',
  'Tyne and Wear', 'Teesside', 'North Wales', 'Mid Wales', 'South Wales', 'West Wales and Pembrokeshire', 'Anglesey',
  'Scottish Borders and Dumfries and Galloway', 'Edinburgh and the Lothians', 'Glasgow and Ayrshire', 'Fife and Perthshire',
  'Aberdeen and Aberdeenshire', 'Highlands and Islands', 'Dundee and Angus', 'Stirling and Central Scotland',
  'Belfast and County Antrim', 'County Down and Armagh', 'Derry, Tyrone and Fermanagh', 'Isle of Man', 'Channel Islands',
];
const KINDS = [
  'cars and coffee and breakfast meets', 'classic car shows and classic vehicle rallies', 'supercar and prestige car events',
  'JDM, modified, VAG, stance and tuner shows', 'American car, muscle car and hot rod shows', 'track days and driving days',
  'hill climbs, sprints and race meetings open to spectators', 'drag racing and run what you brung days',
  'classic and collector car auctions', '4x4, off-road, Land Rover and overland shows', 'steam rallies and vintage vehicle shows with cars',
  'charity car shows and village car shows', 'car shows at country estates, stately homes and showgrounds', 'motor museum events',
];
const CLUBS = [
  'MG', 'Triumph', 'Jaguar', 'Land Rover and Range Rover', 'Porsche', 'Ferrari', 'Lotus', 'TVR', 'Mini', 'Ford RS and Escort',
  'Ford Capri and Cortina', 'Volkswagen and Volkswagen camper', 'BMW', 'Mercedes-Benz', 'Morgan', 'Austin Healey', 'Rover',
  'Vauxhall', 'Citroen', 'Alfa Romeo and Fiat', 'Aston Martin', 'Bentley and Rolls-Royce', 'Mazda MX-5', 'Subaru and Mitsubishi',
  'Toyota and Honda', 'Saab and Volvo', 'Caterham and kit cars', 'Riley, Wolseley and Austin', 'Reliant', 'Jensen',
];
const FOCUS = [
  ...AREAS.map(a => `car shows, meets and motoring events in ${a}`),
  ...KINDS.map(k => `${k} anywhere in the UK`),
  ...CLUBS.map(c => `${c} owners clubs with public event calendars in the UK`),
];
async function discover(sources, state, passes) {
  const added = [];
  for (let i = 0; i < passes; i++) {
    const idx = (state.discoverIndex ?? 0) % FOCUS.length;
    state.discoverIndex = idx + 1;
    log(`   search ${idx + 1} of ${FOCUS.length}: ${FOCUS[idx]}`);
    try { added.push(...await discoverOne(sources, FOCUS[idx], 15)); }
    catch (err) { log(`   search failed: ${err.message || err}`); }
  }
  return added;
}
async function searchOnce(model, content) {
  // The newer search tool (it filters results before reading them, so it costs fewer tokens) on the models that have it
  const tool = /opus|sonnet|fable|mythos/.test(model) ? 'web_search_20260209' : 'web_search_20250305';
  const messages = [{ role: 'user', content }];
  const tools = [{ type: tool, name: 'web_search', max_uses: 8, user_location: { type: 'approximate', country: 'GB' } }];
  let msg;
  for (let i = 0; i < 5; i++) {
    msg = await client.messages.stream({ model, max_tokens: 8000, tools, messages }).finalMessage();
    addUsage(msg.usage, model, false);
    if (msg.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: msg.content });   // a long search turn paused: send it back to carry on
  }
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}
async function discoverOne(sources, focus, room) {
  const known = sources.map(s => new URL(s.url).host.replace(/^www\./, '')).filter((h, i, a) => a.indexOf(h) === i).join(', ');
  const content = `Find web pages that list upcoming dated car events, for a UK car shows app. Focus: ${focus}.

Wanted: the organiser's, club's or venue's own events, calendar or "what's on" page, listing dated events in the page itself (car shows, meets, cars and coffee, track days, auctions, off-road days, rallies, motoring festivals).
Not wanted: Facebook, Instagram or other social media; Eventbrite or other ticket sellers; directories or listing sites that collect other people's events; news articles; PDFs; single past events.

Websites already covered (skip): ${known}

Finish with a JSON array in a \`\`\`json code block, at most 20 items, each {"url": "...", "name": "organiser name"}.`;
  let text;
  try { text = await searchOnce(DISCOVERY_MODEL, content); }
  catch (err) {
    if (DISCOVERY_MODEL === MODEL) throw err;
    log(`   ${DISCOVERY_MODEL} couldn't search (${err.message}); using ${MODEL}`);
    text = await searchOnce(MODEL, content);
  }
  const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\[[\s\S]*\])/);
  let found = []; try { found = JSON.parse(m[1]); } catch { log('   no list in the answer'); return []; }
  const keyOf = u => u.host.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  const have = new Set(sources.map(s => keyOf(new URL(s.url))));
  const added = [];
  for (const c of found.slice(0, 20)) {
    let u; try { u = new URL(c.url); } catch { continue; }
    u.hash = '';
    if (u.protocol !== 'https:' || BLOCKED_HOSTS.test(u.host) || have.has(keyOf(u)) || /\.pdf$/i.test(u.pathname)) continue;
    try {
      if (!(await robotsAllows(u.href))) { log(`      ${u.href}: blocks bots, skipped`); continue; }
      const { html, finalUrl } = await fetchPage(u.href);
      const r = relevant(cleanHtml(html, finalUrl));
      if (!r.dated) { log(`      ${u.href}: no dates on the page, skipped`); continue; }
    } catch (err) { log(`      ${u.href}: didn't load (${err.message}), skipped`); continue; }
    const s = { name: String(c.name || u.host).slice(0, 80), url: u.href, enabled: true, added: 'auto', addedOn: TODAY, focus };
    sources.push(s); have.add(keyOf(u)); added.push(s);
    log(`      added ${s.name} (${s.url})`);
    if (added.length >= room) break;
  }
  return added;
}

/* ---------- The run ---------- */
async function main() {
  const sourcesPath = opt('sources', 'sources.json');
  const sourcesFile = await readJson(sourcesPath, { sources: [] });
  const sources = sourcesFile.sources;
  const state = await readJson('data/state.json', { pages: {}, geo: {}, pendingBatch: null });
  state.pages ??= {}; state.geo ??= {};
  if (!DRY) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ maxRetries: 4 });
  }
  log(`Car events update, ${TODAY}. Reading with ${MODEL}${DRY ? ' (DRY RUN)' : SYNC ? ' (direct calls)' : ' (batch)'}, budget $${BUDGET}`);
  let sourcesChanged = false, waitingOnBatch = false;

  // What Claude found on a page: its events, and further pages of the same site to read from now on
  const handle = async (jobsById, results) => {
    for (const [id, job] of Object.entries(jobsById)) {
      const r = results[id], pg = state.pages[job.url] ??= {};
      if (!r?.ok) { pg.error = r?.error || 'no result'; log(`   ${job.name}: ${pg.error}`); continue; }
      const src = sources.find(s => s.url === job.url) || { name: job.name, url: job.url };
      pg.events = await normalise(r.events, src, state.geo);
      pg.hash = job.hash; pg.lastExtract = new Date().toISOString(); pg.error = null;
      log(`   ${job.name}: ${r.events.length} found, ${pg.events.length} kept`);
      const root = src.from || src.url, host = new URL(root).host;
      for (const link of r.more || []) {
        let u; try { u = new URL(link, src.url); } catch { continue; }
        u.hash = '';
        if (u.protocol !== 'https:' || u.host !== host || sources.some(s => s.url === u.href) || /\.(pdf|jpe?g|png)$/i.test(u.pathname)) continue;
        if (sources.filter(s => s.from === root).length >= 8) break;
        sources.push({ name: `${(sources.find(s => s.url === root) || src).name} (more)`, url: u.href, enabled: true, added: 'followed', from: root, addedOn: TODAY });
        sourcesChanged = true;
        log(`      will also read ${u.href}`);
      }
    }
  };

  // 1. A batch sent by an earlier run: collect it if it's back
  if (state.pendingBatch && !DRY) {
    const pb = state.pendingBatch;
    log(`Collecting batch ${pb.id} from ${pb.sentAt}`);
    const b = await client.messages.batches.retrieve(pb.id);
    if (b.processing_status === 'ended') { await handle(pb.jobs, await batchResults(pb.id)); state.pendingBatch = null; }
    else if (Date.now() - Date.parse(pb.sentAt) > 30 * 3600000) { log('   over 30 hours old, dropping it'); state.pendingBatch = null; }
    else { waitingOnBatch = true; log(`   still ${b.processing_status}; it'll be collected next run`); }
  }

  // 2. Discovery first, so anything new is read in this same run
  let added = [];
  if (DISCOVER && !DRY) {
    log(`Looking for new organiser pages (${DISCOVERY_MODEL})`);
    added = await discover(sources, state, DISCOVER);
    if (added.length) sourcesChanged = true;
  }

  // 3. Download every page; keep the dated parts; see which changed
  const live = sources.filter(s => s.enabled !== false && (!ONLY || s.url.includes(ONLY)));
  const jobs = [];
  let unchanged = 0, undated = 0, failed = 0, later = 0;
  log(`Checking ${live.length} pages`);
  const check = async src => {
    const pg = state.pages[src.url] ??= {};
    try {
      if (!(await robotsAllows(src.url))) { pg.error = 'robots.txt asks bots not to read this page'; failed++; return; }
      const { html, finalUrl } = await fetchPage(src.url);
      const { text, dated } = relevant(cleanHtml(html, finalUrl)), hash = sha(text);
      pg.lastFetch = new Date().toISOString(); pg.lastOk = pg.lastFetch; pg.error = null;
      if (!dated) { if (pg.events?.length) pg.events = []; pg.hash = hash; undated++; log(`   ${src.name}: no dates on the page`); return; }   // no dates, no events: free
      if (hash === pg.hash) { unchanged++; return; }
      const recent = pg.lastExtract && Date.now() - Date.parse(pg.lastExtract) < 20 * 3600000;
      const soon = (pg.events || []).some(e => e.start.slice(0, 10) <= addDays(TODAY, 3));
      if (recent && !soon && !flag('--force')) { later++; return; }   // changed again today: read tomorrow, unless something's on soon
      jobs.push({ src, text, hash, url: src.url, name: src.name, fresh: !pg.lastExtract, soon });
    } catch (err) {
      pg.error = String(err.message || err); pg.lastFetch = new Date().toISOString(); failed++;
      log(`   ${src.name}: couldn't be read (${pg.error})`);
    }
  };
  for (let i = 0; i < live.length; i += 6) await Promise.all(live.slice(i, i + 6).map(check));   // six at a time, different sites
  log(`   ${jobs.length} changed, ${unchanged} unchanged, ${undated} with no dates, ${later} left until tomorrow, ${failed} couldn't be read`);

  // 4. Claude reads the changed pages: never-read pages and ones with something on soon first, within the budget
  jobs.sort((a, b) => (b.soon - a.soon) || (b.fresh - a.fresh));
  const todo = [];
  let planned = 0;
  if (!waitingOnBatch) for (const j of jobs) {
    const c = estimate(j.text);
    if (todo.length >= LIMIT || planned + c > BUDGET) break;
    todo.push({ ...j, id: 'p' + todo.length }); planned += c;
  }
  if (jobs.length > todo.length && !waitingOnBatch) log(`   ${jobs.length - todo.length} changed pages left for the next run (budget $${BUDGET}, limit ${LIMIT})`);
  if (todo.length && DRY) {
    log(`Dry run: would read ${todo.length} pages, roughly $${planned.toFixed(2)}`);
    for (const j of todo) log(`   ${j.name}: ${Math.round(j.text.length / 1000)}k characters`);
  } else if (todo.length) {
    const jobsById = Object.fromEntries(todo.map(j => [j.id, { url: j.url, name: j.name, hash: j.hash }]));
    if (SYNC) {
      log(`Reading ${todo.length} pages with Claude`);
      await handle(jobsById, await extractSync(todo));
    } else {
      const batch = await client.messages.batches.create({ requests: todo.map(j => ({ custom_id: j.id, params: requestFor(j.src, j.text) })) });
      state.pendingBatch = { id: batch.id, sentAt: new Date().toISOString(), jobs: jobsById };
      await writeJson('data/state.json', state);   // so a cancelled run can still collect it next time
      log(`Sent ${todo.length} pages to Claude as batch ${batch.id} (about $${planned.toFixed(2)}); waiting up to ${BATCH_WAIT_MIN} minutes`);
      if (await waitForBatch(batch.id, BATCH_WAIT_MIN)) { await handle(jobsById, await batchResults(batch.id)); state.pendingBatch = null; }
    }
  } else if (!waitingOnBatch) log('Nothing new to read; no Claude calls needed');
  if (sourcesChanged && !DRY) await writeJson(sourcesPath, { ...sourcesFile, sources });

  // 5. Pages that have failed for over a week stop contributing events; everything else is merged into events.json
  const weekAgo = Date.now() - 7 * 86400000, all = [];
  for (const src of sources) {
    const pg = state.pages[src.url];
    if (!pg?.events || src.enabled === false) continue;
    if (pg.lastOk && Date.parse(pg.lastOk) < weekAgo) continue;
    all.push(...pg.events);
  }
  const events = merge(all);
  log(`${events.length} upcoming events from ${new Set(events.map(e => e.source.replace(/ \(more\)$/, ''))).size} organisers, ${sources.filter(s => s.enabled !== false).length} pages watched. This run: ${usage.in} tokens in, ${usage.out} out, ${usage.searches} searches, about $${usage.usd.toFixed(2)}`);
  if (DRY) return;
  await writeJson('events.json', { updated: new Date().toISOString(), count: events.length, events });
  await writeJson('data/state.json', state);
  const runs = await readJson('data/runs.json', []);
  runs.unshift({ at: new Date().toISOString(), read: todo.length, events: events.length, sources: sources.length, added: added.length, tokensIn: usage.in, tokensOut: usage.out, searches: usage.searches, costUsd: Math.round(usage.usd * 1000) / 1000 });
  await writeJson('data/runs.json', runs.slice(0, 300));
}

main().catch(err => { console.error(err); process.exit(1); });
