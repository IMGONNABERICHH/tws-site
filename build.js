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

function slugOf(file) { return path.basename(file, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

// ── load stories, newest first ──
const storyDir = path.join(ROOT, 'content', 'stories');
const stories = fs.readdirSync(storyDir)
  .filter(f => f.endsWith('.md'))
  .map(f => ({ ...parseStory(fs.readFileSync(path.join(storyDir, f), 'utf8')), slug: slugOf(f) }))
  .filter(s => s && s.title)
  .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

// ── build work rows ──
const pad = n => String(n).padStart(2, '0');
const rows = stories.map((s, i) => {
  const meta = [s.kicker, s.location, s.video ? 'Video' : '', (s.photos && s.photos.length) ? 'Photos' : '']
    .filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('');
  return `        <div class="work-row" onclick="show('a-${s.slug}')">
          <span class="ref">${pad(i + 1)}</span>
          <div>
            <h3>${esc(s.title)}<span class="block">▓</span></h3>
            <div class="meta">${meta}</div>
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
      </div>
    </div>`;
}).join('\n\n');

// ── render + fix radio row number ──
let out = fs.readFileSync(path.join(ROOT, 'template.html'), 'utf8')
  .replace('{{WORK_ROWS}}', rows)
  .replace('{{ARTICLE_PAGES}}', pages);
// the static radio row keeps ref "07" in the template — renumber it after the stories
out = out.replace(/(<div class="work-row" onclick="show\('radio'\)">\s*<span class="ref">)\d+(<\/span>)/, `$1${pad(stories.length + 1)}$2`);

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
console.log(`Built ${stories.length} stories → dist/`);
