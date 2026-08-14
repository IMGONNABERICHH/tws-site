// TWS build — turns content/stories/*.md into the finished site.
// No dependencies. Run: node build.js  → output in dist/
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// ── tiny frontmatter parser ──
function parseStory(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    const li = line.match(/^\s+-\s+(.*)$/);
    if (li && listKey) { (meta[listKey] = meta[listKey] || []).push(li[1].trim().replace(/^"|"$/g, '')); continue; }
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      let val = kv[2].trim();
      if (val === '') { listKey = key; meta[key] = meta[key] || []; continue; }
      listKey = null;
      meta[key] = val.replace(/^"|"$/g, '');
    }
  }
  meta.body = m[2].trim();
  return meta;
}

// ── tiny markdown → HTML (paragraphs, images, links, bold, italics) ──
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function md(body) {
  return body.split(/\n\s*\n/).map(block => {
    block = block.trim();
    if (!block) return '';
    const img = block.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) return `<figure class="story-photo"><img src="${img[2]}" alt="${esc(img[1])}" loading="lazy"></figure>`;
    let t = esc(block)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, '<br>');
    return `<p>${t}</p>`;
  }).join('\n        ');
}

// intrinsic size straight from the file header — no dependencies, and it lets
// the browser hold the right space so nothing shifts or crops
function imageSize(file) {
  try {
    const d = fs.readFileSync(file);
    if (d[0] === 0xFF && d[1] === 0xD8) {                       // JPEG
      let i = 2;
      while (i < d.length) {
        if (d[i] !== 0xFF) { i++; continue; }
        const m = d[i + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
          return { height: d.readUInt16BE(i + 5), width: d.readUInt16BE(i + 7) };
        }
        if (m === 0xD8 || m === 0xD9 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; }
        i += 2 + d.readUInt16BE(i + 2);
      }
    } else if (d.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {   // PNG
      return { width: d.readUInt32BE(16), height: d.readUInt32BE(20) };
    }
  } catch { /* unreadable — fall through */ }
  return null;
}

function slugOf(file) { return path.basename(file, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

// ── load stories, newest first ──
const storyDir = path.join(ROOT, 'content', 'stories');
const stories = fs.readdirSync(storyDir)
  .filter(f => f.endsWith('.md'))
  .map(f => ({ ...parseStory(fs.readFileSync(path.join(storyDir, f), 'utf8')), slug: slugOf(f) }))
  .filter(s => s && s.title)
  .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

// ── hero slideshow ──
// Web-sized copies of TWS's own photography live in images/hero. Each slide
// credits the story it was shot for, where we can match it back to one.
const heroDir = path.join(ROOT, 'images', 'hero');
const storyByPhoto = {};
for (const s of stories) {
  for (const photo of s.photos || []) {
    storyByPhoto[path.basename(photo).replace(/\.[^.]+$/, '')] = s;
  }
}

const heroFiles = fs.existsSync(heroDir)
  ? fs.readdirSync(heroDir).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).sort()
  : [];

// attribute-safe: esc() already handled & < >, so only quotes remain
const attr = s => esc(s).replace(/"/g, '&quot;');
// hero files carry an "01-" prefix that sets the running order; the story
// lookup keys off the original upload name, so strip it before matching
const storyOf = file => storyByPhoto[file.replace(/^\d+-/, '').replace(/\.[^.]+$/, '')];

// the credit is passed as plain data; the link is assembled in the page
const creditHtml = file => {
  const s = storyOf(file);
  return s
    ? `TWS Studio · <a href="#" onclick="event.stopPropagation();show('a-${s.slug}');return false;">${esc(s.title)}</a>`
    : 'TWS Studio';
};

const heroSlides = heroFiles.length ? `        <div class="hero-slides">
${heroFiles.map((f, i) => {
    const s = storyOf(f);
    const flags = i === 0 ? 'class="on" fetchpriority="high"' : 'loading="lazy"';
    const data = s ? ` data-story="${attr(s.title)}" data-slug="${attr(s.slug)}"` : '';
    return `          <img src="/images/hero/${encodeURIComponent(f)}" alt="" ${flags}${data}>`;
  }).join('\n')}
        </div>
        <p class="hero-credit" id="hero-credit">${creditHtml(heroFiles[0])}</p>` : '';

// ── load The Wire (the daily brief), if one has been generated ──
const pad = n => String(n).padStart(2, '0');
// Every day's brief is kept. Each run writes its own dated file, so a new
// morning adds to the record instead of replacing it.
const newsDir = path.join(ROOT, 'content', 'news');
const archiveDir = path.join(newsDir, 'archive');

function readBrief(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.items) && parsed.items.length) return parsed;
  } catch (err) {
    console.warn(`Skipping ${path.basename(file)} — ${err.message}`);
  }
  return null;
}

const briefs = (fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [])
  .filter(f => f.endsWith('.json'))
  .sort()
  .reverse()
  .map(f => readBrief(path.join(archiveDir, f)))
  .filter(Boolean);

// nothing archived yet — fall back to the single latest file
if (!briefs.length) {
  const latest = fs.existsSync(path.join(newsDir, 'latest.json'))
    && readBrief(path.join(newsDir, 'latest.json'));
  if (latest) briefs.push(latest);
}

const wireSlug = t => 'w-' + t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// A story can carry over between mornings while it is still inside the
// window, so keep the first sighting of each and drop the repeats. Slugs are
// made unique too: two different stories can round to the same one, and a
// collision would point two feed rows at a single page.
const seenUrl = new Set();
const seenSlug = new Set();
const wireItems = [];
for (const brief of briefs) {
  for (const item of brief.items) {
    if (!item.url || seenUrl.has(item.url)) continue;
    seenUrl.add(item.url);
    let slug = wireSlug(item.title);
    for (let n = 2; seenSlug.has(slug); n++) slug = `${wireSlug(item.title)}-${n}`;
    seenSlug.add(slug);
    wireItems.push({ ...item, slug, dateline: brief.dateline, generated_at: brief.generated_at });
  }
}

const wire = wireItems.length ? { items: wireItems } : null;

const offset = 0;

const wireTab = '';

// ── build the feed ──
// One list. TWS stories keep the display type so original reporting stays the
// loudest thing on the page; brief items carry their summary, photo and credit.
const storyEntries = stories.map(s => ({
  date: new Date(s.date || 0),
  render: n => {
    const meta = [s.kicker, s.location, s.video ? 'Video' : '']
      .filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('');
    const first = (s.photos && s.photos.length) ? s.photos[0] : null;
    const dim = first ? imageSize(path.join(ROOT, first.replace(/^\//, ''))) : null;
    const size = dim ? ` width="${dim.width}" height="${dim.height}"` : '';
    const thumb = first
      ? `          <figure class="wire-shot"><img src="${esc(first)}" alt="" loading="lazy"${size}></figure>`
      : '          <div class="wire-shot"></div>';
    return `        <div class="work-row" onclick="show('a-${s.slug}')">
          <span class="ref">${pad(n)}</span>
${thumb}
          <div class="wire-text">
            <h3>${esc(s.title)}</h3>
            <div class="meta">${meta}</div>
          </div>
        </div>`;
  },
}));

const wireEntries = (wire ? wire.items : []).map(item => ({
  date: new Date(item.published_at || item.generated_at),
  render: n => {
    const p = item.photo;
    // every licence requires the photographer and the licence named
    const size = (p && p.width && p.height) ? ` width="${p.width}" height="${p.height}"` : '';
    const shot = p ? `          <figure class="wire-shot">
            <img src="${esc(p.src)}" alt="${esc(p.subject)}" loading="lazy"${size}>
          </figure>` : '          <div class="wire-shot"></div>';
    // the photographer and licence are licence terms, so they stay; the
    // outlet is named in the story itself and does not need repeating here
    const shotCredit = p
      ? `            <p class="credit">Photo ${esc(p.author)} / ${esc(p.licence)}</p>` : '';
    return `        <div class="wire-item${p ? ' has-shot' : ''}" onclick="show('${item.slug}')">
          <span class="ref">${pad(n)}</span>
${shot}
          <div class="wire-text">
            <h3>${esc(item.title)}</h3>
            ${item.summary ? `<p>${esc(item.summary.split(/\n\s*\n/)[0])}</p>` : ''}
${shotCredit}
          </div>
        </div>`;
  },
}));

const rows = [...wireEntries, ...storyEntries]
  .sort((a, b) => b.date - a.date)
  .map((entry, i) => entry.render(i + 1))
  .join('\n\n');

const radioRef = pad(stories.length + (wire ? wire.items.length : 0) + 1);

// no standing note above the feed: the brief is TWS's own writing and names
// its source inside each story, and nothing links out any more
const wireNote = '';

// ── brief pages ──
// Each item gets a page on TWS: the summary, the photo, and the source
// credited with a link out at the foot for anyone who wants the full report.
const wirePages = (wire ? wire.items : []).map(item => {
  const p = item.photo;
  const shot = p ? `        <figure class="story-photo">
          <img src="${esc(p.src)}" alt="${esc(p.subject)}" loading="lazy">
          <figcaption class="shot-credit">Photo: ${esc(p.author)} · ${esc(p.licence)} · <a href="${esc(p.page)}" target="_blank" rel="noopener">Wikimedia Commons</a></figcaption>
        </figure>` : '';
  const when = item.published_at
    ? new Date(item.published_at).toLocaleDateString('en-US',
        { timeZone: 'America/Los_Angeles', month: 'long', day: 'numeric', year: 'numeric' })
    : (item.dateline || '');
  const body = (item.summary || '').split(/\n\s*\n/)
    .map(par => par.trim()).filter(Boolean)
    .map(par => `        <p>${esc(par)}</p>`).join('\n');
  // When the piece is TWS's own writing it names its source inside the body,
  // so no notice is needed at the foot. When the rewrite failed and we are
  // running the outlet's own summary text, the credit has to stay — those are
  // someone else's words, and dropping it would be passing them off as ours.
  const sourceLine = item.summary_is_ours ? '' : `        <p class="source-line">
          Reported by
          <a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.source)}</a>${item.corroboration > 1 ? `, and covered by ${item.corroboration} outlets` : ''}.
        </p>`;
  return `    <div class="page" id="${item.slug}">
      <div class="article wrap">
        <span class="back" onclick="show('front')">All Coverage</span>
        <p class="kicker">The Wire</p>
        <h2>${esc(item.title)}</h2>
        <p class="byline">TWS${when ? ` · ${esc(when)}` : ''}</p>
${body}
${shot}
${sourceLine}
        <button class="like-btn" data-slug="${esc(item.slug)}" onclick="toggleLike(this)" aria-label="Like this story">
          <svg class="like-icon" viewBox="0 0 24 24"><path d="M12 21s-6.716-4.35-9.428-8.216C.688 10.09 1.2 6.5 4.2 5.1 6.6 4 9 4.8 12 8c3-3.2 5.4-4 7.8-2.9 3 1.4 3.512 5-.372 7.684C18.716 16.65 12 21 12 21z"/></svg>
          Like
        </button>
      </div>
    </div>`;
}).join('\n\n');

// ── build article pages ──
const pages = stories.map(s => {
  const byline = ['TWS Staff', s.location, s.dateline].filter(Boolean).join(' · ');
  const video = s.video
    ? `<div class="embed"><iframe loading="lazy" src="https://www.youtube.com/embed/${s.video}" title="${esc(s.title)} — TWS coverage" allow="encrypted-media; fullscreen" allowfullscreen></iframe></div>` : '';
  const photos = (s.photos && s.photos.length)
    ? `<div class="photo-grid">${s.photos.map(p => `<img src="${p}" alt="" loading="lazy">`).join('')}</div>` : '';
  return `    <div class="page" id="a-${s.slug}">
      <div class="article wrap">
        <span class="back" onclick="show('front')">All Stories</span>
        <p class="kicker">${esc(s.kicker || 'Story')}</p>
        <h2>${esc(s.title)}</h2>
        <p class="byline">${esc(byline)}</p>
        ${md(s.body)}
        ${photos}
        ${video}
        <button class="like-btn" data-slug="a-${s.slug}" onclick="toggleLike(this)" aria-label="Like this story">
          <svg class="like-icon" viewBox="0 0 24 24"><path d="M12 21s-6.716-4.35-9.428-8.216C.688 10.09 1.2 6.5 4.2 5.1 6.6 4 9 4.8 12 8c3-3.2 5.4-4 7.8-2.9 3 1.4 3.512 5-.372 7.684C18.716 16.65 12 21 12 21z"/></svg>
          Like
        </button>
      </div>
    </div>`;
}).join('\n\n');

// ── render + fix radio row number ──
// replacements go through functions so a "$&" in a headline stays literal
let out = fs.readFileSync(path.join(ROOT, 'template.html'), 'utf8')
  .replace('{{HERO_SLIDES}}', () => heroSlides)
  .replace('{{WIRE_TAB}}', () => wireTab)
  .replace('{{WORK_ROWS}}', () => rows)
  .replace('{{WIRE_SECTION}}', () => wireNote)
  .replace('{{ARTICLE_PAGES}}', () => pages + (wirePages ? '\n\n' + wirePages : ''));
// the static radio row keeps ref "07" in the template — renumber it after the stories
out = out.replace(/(<div class="work-row" onclick="show\('radio'\)">\s*<span class="ref">)\d+(<\/span>)/, `$1${radioRef}$2`);

// photo styles injected once (grid + figure)
out = out.replace('</style>', `
    .photo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 34px 0; }
    .photo-grid img { width: 100%; display: block; border: 1px dotted var(--dim); padding: 6px; }
    .story-photo { margin: 30px 0; }
    .story-photo img { width: 100%; display: block; border: 1px dotted var(--dim); padding: 6px; }
    @media (max-width: 560px) { .photo-grid { grid-template-columns: 1fr; } }
  </style>`);

// ── write dist ──
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), out);
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.writeFileSync(d, fs.readFileSync(s));
  }
}
for (const dir of ['admin', 'images']) {
  const src = path.join(ROOT, dir);
  if (fs.existsSync(src)) copyDir(src, path.join(DIST, dir));
}
console.log(`Built ${stories.length} stories${wire ? ` + The Wire (${wire.items.length} headlines)` : ''} → dist/`);
