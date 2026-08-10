// TWS — The Wire
// Pulls the day's music & culture headlines from public RSS feeds and saves
// them to content/news/latest.json.
//
// Each item shows the outlet's own summary line, credited and linked back.
// No API keys, no dependencies, no cost.
//
// Run: node scripts/fetch-news.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'content', 'news');
const OUT_FILE = path.join(OUT_DIR, 'latest.json');

// ── the beat ──
const FEEDS = [
  { name: 'Pitchfork',       url: 'https://pitchfork.com/feed/feed-news/rss' },
  { name: 'Billboard',       url: 'https://www.billboard.com/feed/' },
  { name: 'Rolling Stone',   url: 'https://www.rollingstone.com/music/feed/' },
  { name: 'Consequence',     url: 'https://consequence.net/feed/' },
  { name: 'Stereogum',       url: 'https://www.stereogum.com/feed/' },
  { name: 'Variety',         url: 'https://variety.com/v/music/feed/' },
  { name: 'The FADER',       url: 'https://www.thefader.com/feed.rss' },
  { name: 'HipHopDX',        url: 'https://hiphopdx.com/rss/news.xml' },
  { name: 'NPR Music',       url: 'https://feeds.npr.org/1039/rss.xml' },
  { name: 'BrooklynVegan',   url: 'https://www.brooklynvegan.com/feed/' },
  { name: 'Deadline',        url: 'https://deadline.com/feed/' },
  { name: 'Hollywood Reporter', url: 'https://www.hollywoodreporter.com/feed/' },
  { name: 'Variety',         url: 'https://variety.com/feed/' },
];

const WINDOW_HOURS = 24;       // how far back a story can be and still be "today"
const FALLBACK_HOURS = 48;     // widen if a slow news day leaves us short
const MAX_ITEMS = 8;           // headlines in the finished brief
const MAX_PER_SOURCE = 2;      // so one outlet can't run the whole page
const MIN_ITEMS = 6;           // below this we widen the window

// ── feed fetching ──
async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'TWS-TheWire/1.0 (+https://tws.7-langes.com)',
        'accept': 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseFeed(await res.text(), feed.name);
  } catch (err) {
    console.warn(`  ${feed.name}: skipped (${err.message})`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ── minimal RSS 2.0 + Atom parsing, no dependencies ──
function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&[lr]dquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

function linkOf(block) {
  const rss = tag(block, 'link');
  if (rss && /^https?:/i.test(rss)) return rss;
  const atom = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    || block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return atom ? decode(atom[1]) : '';
}

function parseFeed(xml, source) {
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  return blocks.map(block => {
    const published = tag(block, 'pubDate') || tag(block, 'published')
      || tag(block, 'updated') || tag(block, 'dc:date');
    const date = published ? new Date(published) : null;
    return {
      title: tag(block, 'title'),
      url: linkOf(block),
      source,
      published_at: date && !isNaN(date) ? date.toISOString() : null,
      blurb: (tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'))
        .slice(0, 600),
      // some publishers syndicate the whole article; that is theirs to offer
      syndicated: tag(block, 'content:encoded'),
    };
  }).filter(item => item.title && item.url);
}

// ── selection ──
// "Breaking" is not the same as "newest". A story several outlets ran in the
// same few hours is a bigger story than whatever happened to publish last, so
// items are clustered across sources and ranked on how many picked it up.
const STOPWORDS = new Set(['the','a','an','and','or','of','for','on','in','at','to','with','his','her','their','its','new','says','said','is','are','was','were','from','how','why','what','this','that','has','have','had','will','be','by','as','after','over','into','out','up','down','more','than','who','you','your','it']);

const keyWords = title => new Set(
  title.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')   // Cuarón and Cuaron are one name
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w)));

function overlap(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return { shared, ratio: shared / Math.min(a.size, b.size) };
}

// roundups and explainers are not breaking news, whatever their timestamp
const ROUNDUP = /\b(best|every|everything|all the|ranked|so far|guide|roundup|list of|top \d+|things to|watch:|recap|review|explained|here's what|we know)\b/i;

function rank(items, hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const fresh = items
    .filter(i => i.published_at && new Date(i.published_at).getTime() >= cutoff)
    .sort((a, b) => new Date(a.published_at) - new Date(b.published_at));

  // group the same story as told by different outlets
  const clusters = [];
  for (const item of fresh) {
    const words = keyWords(item.title);
    // both tests must pass: two short headlines can share a common word pair
    // by accident ("Artists First" vs "First Artists") and merge two unrelated
    // stories, which would then look corroborated
    const home = clusters.find(c => {
      const o = overlap(words, c.words);
      return o.shared >= 3 && o.ratio >= 0.45;
    });
    if (home) {
      home.items.push(item);
      home.sources.add(item.source);
    } else {
      clusters.push({ words, items: [item], sources: new Set([item.source]) });
    }
  }

  const now = Date.now();
  for (const c of clusters) {
    // the outlet that published first is the one that broke it
    const lead = c.items[0];
    const newest = c.items[c.items.length - 1];
    const ageHours = (now - new Date(newest.published_at).getTime()) / 3600000;
    const corroboration = c.sources.size;
    c.lead = lead;
    c.corroboration = corroboration;
    c.score =
      1.7 * Math.log2(1 + corroboration)          // how many outlets ran it
      + Math.max(0, 1 - ageHours / hours)          // how fresh it still is
      - (ROUNDUP.test(lead.title) ? 0.55 : 0);     // not breaking news
  }

  clusters.sort((a, b) => b.score - a.score);

  const perSource = {};
  const picked = [];
  for (const c of clusters) {
    if ((perSource[c.lead.source] || 0) >= MAX_PER_SOURCE) continue;
    perSource[c.lead.source] = (perSource[c.lead.source] || 0) + 1;
    picked.push({ ...c.lead, corroboration: c.corroboration });
    if (picked.length >= MAX_ITEMS) break;
  }
  return picked;
}

// ── the summary line ──
// Every feed ships the outlet's own one-line description of each story.
// That's what we show: their words, trimmed, credited, and linked back.
function summaryLine(blurb) {
  if (!blurb) return '';
  // some feeds double-encode their markup, so tags survive the first decode
  let text = blurb.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  // feeds often tack on "Read more", "The post ... appeared first on ..." etc.
  text = text
    .replace(/\s*The post\s+.*?\s+appeared first on\s+.*$/i, '')
    .replace(/\s*Continue reading.*$/i, '')
    .replace(/\s*Read (the full story|more).*$/i, '')
    .replace(/\s*\[…\]\s*$/, '')
    .trim();

  if (text.length <= 220) return text;
  // cut at a sentence end if there's one nearby, otherwise at a word boundary
  const stop = text.slice(0, 220).lastIndexOf('. ');
  if (stop > 120) return text.slice(0, stop + 1);
  return text.slice(0, text.lastIndexOf(' ', 200)).trim() + '…';
}

// ── TWS-voice summaries (optional) ──
// With an ANTHROPIC_API_KEY the brief is rewritten in TWS's voice. Without one
// — or if the API is unreachable — it falls back to each outlet's own line, so
// the brief always publishes.
const SYSTEM = `You write for The Wire, the daily entertainment desk at TWS, an independent Los Angeles publication covering music, film, TV and the culture around them.

You are given a headline, the outlet that reported it, and source text from that report. Write TWS's own article on the story as an array of paragraphs: four to six of them, each a real paragraph of two to four sentences, in TWS's voice — direct, specific, unhurried, no hype. Aim for 250 to 400 words in total. One long block is not an article; break the story into paragraphs that each do one job.

How to write it:
- Open with what happened and who it involves. The first paragraph should stand on its own as the news.
- Then the detail that makes it matter: dates, titles, numbers, names, what it follows, what comes next.
- Close on where things stand, not on a flourish. No "stay tuned", no "time will tell", no rhetorical questions.
- Attribute the reporting once, naturally, in the body — "Billboard reported", "according to Deadline" — where a reader would want to know who found this out.

Hard rules:
- Every fact must come from the source text. If it is not there, it does not go in the article.
- Never invent quotes, dates, figures, titles, or names. If the source text is genuinely thin, write two or three paragraphs rather than padding with invention — short and true beats long and made up.
- Write it fresh in your own sentences and structure. Do not follow the source's phrasing, sentence order, or turns of phrase. If a quote is used, keep it exact, in quotation marks, and say who said it.
- No markdown, no headings, no emoji. Return each paragraph as its own string in the array.

Also name the main person or group the story is about, exactly as it would title a Wikipedia article, or null if the story is not about one.`;

async function rewrite(items) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  No ANTHROPIC_API_KEY — using each outlet\'s own summary line.');
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY.replace(/\s+/g, '');
  let response;
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: SYSTEM,
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              summaries: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer' },
                    paragraphs: { type: 'array', items: { type: 'string' } },
                    subject: { type: ['string', 'null'] },
                  },
                  required: ['index', 'paragraphs', 'subject'],
                  additionalProperties: false,
                },
              },
            },
            required: ['summaries'],
            additionalProperties: false,
          },
        },
      },
      messages: [{
        role: 'user',
        content: `Write TWS's article for each of these ${items.length} stories. Return one entry per index.\n\n`
          + JSON.stringify(items.map((it, i) => ({
              index: i, headline: it.title, reported_by: it.source,
              source_text: it.article || it.blurb || '(none provided)',
            })), null, 2),
      }],
    });
  } catch (err) {
    console.warn(`  Rewrites unavailable (${String(err.message).split('\n')[0]})`);
    console.warn('  Falling back to each outlet\'s own summary line.');
    return;
  }

  if (response.stop_reason === 'refusal') {
    console.warn('  Rewrites declined by the model — using the outlets\' lines.');
    return;
  }
  try {
    const text = response.content.find(b => b.type === 'text');
    for (const { index, paragraphs, subject } of JSON.parse(text.text).summaries) {
      if (!items[index]) continue;
      const body = (paragraphs || []).map(t => t.trim()).filter(Boolean);
      if (body.length) items[index].rewritten = body.join('\n\n');
      if (subject) items[index].subject = subject.trim();
    }
    console.log(`  Wrote ${items.filter(i => i.rewritten).length} articles in TWS's voice.`);
  } catch (err) {
    console.warn(`  Could not read the rewrites (${err.message}) — using the outlets' lines.`);
  }
}

// ── source text ──
// A rewrite needs facts. Publishers who put the article in the feed have
// offered it; for the rest we read the page, but only where robots.txt allows.
const robotsCache = new Map();

async function robotsAllows(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    let rules = [];
    try {
      const r = await fetch(u.origin + '/robots.txt', { headers: WIKI_UA });
      if (r.ok) {
        const txt = await r.text();
        let applies = false;
        for (const line of txt.split(/\r?\n/)) {
          const m = line.match(/^\s*(user-agent|disallow)\s*:\s*(.*?)\s*(?:#.*)?$/i);
          if (!m) continue;
          if (m[1].toLowerCase() === 'user-agent') applies = m[2] === '*';
          else if (applies && m[2]) rules.push(m[2]);
        }
      }
    } catch { /* no robots.txt reachable — treat as unrestricted */ }
    robotsCache.set(u.origin, rules);
  }
  const path = u.pathname + u.search;
  return !robotsCache.get(u.origin).some(rule => path.startsWith(rule));
}

function readableText(html) {
  const body = html.replace(/<(script|style|noscript|figure|aside|nav|header|footer)[\s\S]*?<\/\1>/gi, ' ');
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 60 && !/^(share|advertisement|sign up|subscribe|related|read more)/i.test(t));
  return paras.join('\n\n');
}

async function sourceText(item) {
  const syndicated = (item.syndicated || '').replace(/\s+/g, ' ').trim();
  if (syndicated.length > 700) return syndicated.slice(0, 6000);
  try {
    if (!(await robotsAllows(item.url))) return item.blurb || '';
    const r = await fetch(item.url, { headers: WIKI_UA, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return item.blurb || '';
    const text = readableText(await r.text());
    return text.length > (item.blurb || '').length ? text.slice(0, 6000) : (item.blurb || '');
  } catch {
    return item.blurb || '';
  }
}

// ── photos ──
// Wikipedia lead images of the people involved. Free to use, but every licence
// requires the photographer and licence named, so we carry both and show them.
const WIKI_UA = { 'user-agent': 'TWS-TheWire/1.0 (+https://tws.7-langes.com; raven.curry@7langes.la)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wikimedia rate-limits anonymous callers, so space the requests out, back off
// once on a 429, and never ask the same question twice in a run.
let lastCall = 0;
const wikiCache = new Map();
async function wikiFetch(url) {
  const wait = 300 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  let r = await fetch(url, { headers: WIKI_UA });
  if (r.status === 429) {
    await sleep(3000);
    lastCall = Date.now();
    r = await fetch(url, { headers: WIKI_UA });
  }
  return r;
}
const STOP = new Set(['the','a','an','and','of','for','on','in','at','to','with','his','her','its','new','says','said','is','are','from','how','why','what','everything','we','learned','best','first','top','this','that','he','she','they','plus','watch','listen']);
const PERSONISH = /(singer|rapper|band|musician|actor|actress|songwriter|group|producer|dj|duo|artist|comedian|drummer|guitarist|composer|record label)/i;

// name-shaped phrases from a headline, longest first — possessives stripped
// before quote marks, or "Hargitay's" turns into "Hargitays" and never matches
function nameCandidates(title) {
  const toks = title
    .replace(/[\u2019']s\b/g, '')
    .replace(/[\u201c\u201d\u2018\u2019"()]/g, '')
    .split(/\s+/).filter(Boolean);
  const out = [];
  for (const n of [3, 2, 1]) {
    for (let i = 0; i + n <= toks.length; i++) {
      const run = toks.slice(i, i + n);
      if (STOP.has(run[0].toLowerCase())) continue;
      const phrase = run.join(' ').replace(/[:,.\u2014\u2013|]+$/, '').trim();
      if (phrase.length > 2 && !out.includes(phrase)) out.push(phrase);
    }
  }
  return out.slice(0, 10);
}

async function wikiSummary(phrase) {
  if (wikiCache.has(phrase)) return wikiCache.get(phrase);
  const miss = v => { wikiCache.set(phrase, v); return v; };
  try {
    const r = await wikiFetch(
      'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(phrase.replace(/ /g, '_')));
    if (!r.ok) return null;
    const d = await r.json();
    // "standard" rules out disambiguation pages, which are usually wrong guesses
    if (d.type !== 'standard' || !d.thumbnail) return miss(null);
    if (!PERSONISH.test((d.description || '') + ' ' + (d.extract || '').slice(0, 200))) return miss(null);
    return miss(d);
  } catch { return miss(null); }
}

// the licence lives on the Commons file page, not in the summary response
async function licenceFor(imageUrl) {
  // thumbnails now carry tracking params — strip them before deriving the name
  const file = decodeURIComponent(
    imageUrl.split('?')[0].split('/').pop().replace(/^\d+px-/, ''));
  try {
    const r = await wikiFetch('https://commons.wikimedia.org/w/api.php?action=query&titles='
      + encodeURIComponent('File:' + file)
      + '&prop=imageinfo&iiprop=extmetadata&format=json');
    if (!r.ok) return null;
    const pages = (await r.json()).query?.pages || {};
    const info = Object.values(pages)[0]?.imageinfo?.[0]?.extmetadata;
    if (!info) return null;
    const strip = v => (v || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return {
      author: strip(info.Artist?.value).slice(0, 80) || 'Unknown',
      licence: strip(info.LicenseShortName?.value) || 'see Commons',
      page: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(file),
    };
  } catch { return null; }
}

async function findPhoto(item) {
  const tried = item.subject ? [item.subject, ...nameCandidates(item.title)] : nameCandidates(item.title);
  for (const phrase of tried) {
    const page = await wikiSummary(phrase);
    if (!page) continue;
    const lic = await licenceFor(page.thumbnail.source);
    if (!lic) continue;
    return {
      // use the size Wikimedia actually serves — asking for a wider thumb than
      // the source image 400s, and it varies per file
      src: page.thumbnail.source.split('?')[0],
      subject: page.title,
      author: lic.author,
      licence: lic.licence,
      page: lic.page,
    };
  }
  return null;
}

// ── main ──
(async () => {
  console.log(`Reading ${FEEDS.length} feeds…`);
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  console.log(`Found ${all.length} entries.`);

  let picked = rank(all, WINDOW_HOURS);
  if (picked.length < MIN_ITEMS) {
    console.log(`Only ${picked.length} in the last ${WINDOW_HOURS}h — widening to ${FALLBACK_HOURS}h.`);
    picked = rank(all, FALLBACK_HOURS);
  }

  if (!picked.length) {
    console.error('No headlines found. Leaving the existing brief in place.');
    process.exit(1);
  }

  console.log('Reading the source reports…');
  for (const item of picked) {
    item.article = await sourceText(item);
  }
  const gotFull = picked.filter(i => (i.article || '').length > 700).length;
  console.log(`  Full text for ${gotFull} of ${picked.length}.`);

  await rewrite(picked);

  console.log('Looking for photos…');
  let withPhoto = 0;
  for (const item of picked) {
    item.photo = await findPhoto(item);
    if (item.photo) withPhoto++;
  }
  console.log(`  Found ${withPhoto} of ${picked.length}.`);

  const brief = {
    generated_at: new Date().toISOString(),
    dateline: new Date().toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric',
    }),
    items: picked.map(({ title, url, source, published_at, blurb, rewritten, photo, corroboration }) => ({
      title, url, source, published_at,
      corroboration: corroboration || 1,
      summary: rewritten || summaryLine(blurb),
      // the outlet's own line is theirs; a rewrite is ours
      summary_is_ours: Boolean(rewritten),
      photo: photo || null,
    })),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(brief, null, 2) + '\n');
  console.log(`Wrote ${brief.items.length} headlines → content/news/latest.json`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
