#!/usr/bin/env node
// Guards the one thing the site cannot do: lose something it already published.
//
// Two checks, run at the two points where a brief can go missing.
//
//   --archive   before the daily job commits. The morning run may only add to
//               content/news/archive. Rewriting or deleting a past day is how
//               August 10 was lost, so it fails the job instead.
//
//   --built     after the build, before deploying. Every item in every archived
//               brief must have a page and a feed row in the output. A build
//               that quietly drops one never reaches Cloudflare.
//
// Exit 0 = safe to continue. Exit 1 = stop, with what went missing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ARCHIVE = path.join(ROOT, 'content', 'news', 'archive');

function briefs() {
  if (!fs.existsSync(ARCHIVE)) return [];
  return fs.readdirSync(ARCHIVE).filter(f => f.endsWith('.json')).sort()
    .map(f => ({ file: f, data: JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8')) }));
}

function fail(lines) {
  for (const l of lines) console.error(l);
  process.exit(1);
}

// ── the morning run may only add ──────────────────────────────────────────
function checkArchive() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  let status = '';
  try {
    status = execFileSync('git', ['diff', '--name-status', 'HEAD', '--', 'content/news/archive'],
      { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    fail([`Could not inspect the archive: ${err.message}`]);
  }

  const problems = [];
  for (const line of status.split('\n').filter(Boolean)) {
    const [code, file] = line.split('\t');
    const day = path.basename(file || '', '.json');
    if (code.startsWith('D')) problems.push(`  deleted:  ${file}`);
    else if (code.startsWith('R')) problems.push(`  renamed:  ${line}`);
    else if (code.startsWith('M') && day !== today) problems.push(`  rewrote:  ${file} (only ${today} may change)`);
  }

  if (problems.length) {
    fail([
      'Refusing to publish: this run would remove briefs that are already live.',
      ...problems,
      '',
      'The daily run may only add its own dated file. Nothing already published',
      'may be rewritten or deleted — that is how a previous day disappears.',
    ]);
  }
  console.log(`Archive check passed — ${briefs().length} day(s) on record, none rewritten.`);
}

// ── everything archived must actually be on the page ──────────────────────
function checkBuilt() {
  const out = path.join(ROOT, 'dist', 'index.html');
  if (!fs.existsSync(out)) fail(['dist/index.html does not exist — run node build.js first.']);
  const html = fs.readFileSync(out, 'utf8');

  const pages = new Set([...html.matchAll(/<div class="page" id="(w-[^"]+)"/g)].map(m => m[1]));
  const rows = new Set([...html.matchAll(/class="wire-item[^"]*" onclick="show\('([^']+)'\)/g)].map(m => m[1]));

  // Match on the slug the build derives from the title. Source URLs are not in
  // the page — the briefs stopped linking out — so they cannot anchor this.
  const slugOf = t => 'w-' + String(t).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

  const days = briefs();
  const wanted = new Map();          // url → title, deduplicated the way the build does
  for (const { data } of days) {
    for (const item of data.items || []) {
      if (item.url && !wanted.has(item.url)) wanted.set(item.url, item.title || '');
    }
  }

  const missing = [];
  for (const [url, title] of wanted) {
    const base = slugOf(title);
    // a title collision gets a -2 suffix, so accept the numbered variants too
    const found = [...pages].some(id => id === base || new RegExp(`^${base}-\\d+$`).test(id));
    if (!found) missing.push(`  ${title.slice(0, 52)}`);
  }

  const orphanRows = [...rows].filter(r => !pages.has(r));

  const problems = [];
  if (missing.length) problems.push(`Archived items with no page in the build (${missing.length}):`, ...missing);
  if (orphanRows.length) problems.push('Feed rows pointing at a page that was not built:', ...orphanRows.map(r => `  ${r}`));
  if (pages.size < wanted.size) problems.push(`Only ${pages.size} brief pages built for ${wanted.size} archived items.`);
  if (!pages.size && days.length) problems.push('The archive has briefs but the build produced no brief pages at all.');

  if (problems.length) {
    fail(['Refusing to deploy: the build has dropped published work.', ...problems]);
  }
  console.log(`Build check passed — ${days.length} day(s), ${pages.size} brief pages, ${rows.size} feed rows, none orphaned.`);
}

const mode = process.argv[2];
if (mode === '--archive') checkArchive();
else if (mode === '--built') checkBuilt();
else fail(['Usage: node scripts/verify-brief.js --archive | --built']);
