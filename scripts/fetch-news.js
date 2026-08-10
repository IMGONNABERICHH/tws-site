// TWS — The Wire
// Pulls the day's music & culture headlines from public RSS feeds, writes a
// short summary for each, and saves the result to content/news/latest.json.
//
// Run: node scripts/fetch-news.js
// Needs ANTHROPIC_API_KEY for summaries. Without it the brief still builds,
// just headlines and links.

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
];

const WINDOW_HOURS = 24;       // how far back a story can be and still be "today"
const FALLBACK_HOURS = 48;     // widen if a slow news day leaves us short
const MAX_ITEMS = 12;          // headlines in the finished brief
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
    };
  }).filter(item => item.title && item.url);
}

// ── selection ──
const normalize = title => title.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

function select(items, hours) {
  const cutoff = Date.now() - hours * 3600 * 1000;
  const seen = new Set();
  const perSource = {};
  const picked = [];

  const fresh = items
    .filter(i => i.published_at && new Date(i.published_at).getTime() >= cutoff)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

  for (const item of fresh) {
    const key = normalize(item.title);
    if (!key || seen.has(key)) continue;
    // same story, different outlet — first five words are usually enough to tell
    const stem = key.split(' ').slice(0, 5).join(' ');
    if ([...seen].some(k => k.startsWith(stem))) continue;
    if ((perSource[item.source] || 0) >= MAX_PER_SOURCE) continue;

    seen.add(key);
    perSource[item.source] = (perSource[item.source] || 0) + 1;
    picked.push(item);
    if (picked.length >= MAX_ITEMS) break;
  }
  return picked;
}

// ── summaries ──
const SYSTEM = `You write the one-line summaries for The Wire, the daily music and culture brief at TWS, an independent Los Angeles publication.

For each headline you are given the outlet's own summary text. Write one or two sentences saying what happened, in TWS's voice: direct, specific, no hype, no filler openers like "In a surprising move" or "Music fans everywhere".

Rules:
- Use only the headline and summary text provided. If they don't say something, don't write it.
- Never invent quotes, dates, chart positions, sales figures, or names that aren't in the source text.
- If the source text is thin, write a shorter summary rather than padding it out.
- No editorializing and no closing sign-offs. Just the news.
- Do not repeat the headline verbatim — add what the headline leaves out.
- Plain sentences. No markdown, no emoji.`;

async function summarize(items) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('  ANTHROPIC_API_KEY not set — publishing headlines without summaries.');
    return items;
  }

  // keys copied on a phone often arrive wrapped across lines — strip any
  // whitespace so a stray newline in the secret doesn't fail the run
  const apiKey = process.env.ANTHROPIC_API_KEY.replace(/\s+/g, '');

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const payload = items.map((item, i) => ({
    index: i,
    headline: item.title,
    source: item.source,
    source_text: item.blurb || '(none provided)',
  }));

  let response;
  try {
    response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 16000,
      system: SYSTEM,
      output_config: {
        effort: 'low',
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
                    summary: { type: 'string' },
                  },
                  required: ['index', 'summary'],
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
        content: `Write a summary for each of these ${items.length} headlines. Return one entry per index.\n\n${JSON.stringify(payload, null, 2)}`,
      }],
    });
  } catch (err) {
    // No credits, rate limit, outage — none of it should stop the brief.
    console.warn(`  Summaries unavailable (${err.message.split('\n')[0]})`);
    console.warn('  Publishing headlines and links only.');
    return items;
  }

  if (response.stop_reason === 'refusal') {
    console.warn('  Summaries declined by the model — publishing headlines only.');
    return items;
  }

  try {
    const text = response.content.find(b => b.type === 'text');
    const parsed = JSON.parse(text.text);
    for (const { index, summary } of parsed.summaries) {
      if (items[index] && summary) items[index].summary = summary.trim();
    }
  } catch (err) {
    console.warn(`  Could not read the summaries (${err.message}) — publishing headlines only.`);
  }
  return items;
}

// ── main ──
(async () => {
  console.log(`Reading ${FEEDS.length} feeds…`);
  const all = (await Promise.all(FEEDS.map(fetchFeed))).flat();
  console.log(`Found ${all.length} entries.`);

  let picked = select(all, WINDOW_HOURS);
  if (picked.length < MIN_ITEMS) {
    console.log(`Only ${picked.length} in the last ${WINDOW_HOURS}h — widening to ${FALLBACK_HOURS}h.`);
    picked = select(all, FALLBACK_HOURS);
  }

  if (!picked.length) {
    console.error('No headlines found. Leaving the existing brief in place.');
    process.exit(1);
  }

  await summarize(picked);

  const brief = {
    generated_at: new Date().toISOString(),
    dateline: new Date().toLocaleDateString('en-US', {
      timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric',
    }),
    items: picked.map(({ title, url, source, published_at, summary }) =>
      ({ title, url, source, published_at, summary: summary || '' })),
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(brief, null, 2) + '\n');
  console.log(`Wrote ${brief.items.length} headlines → content/news/latest.json`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
