# TWS — tws.7-langes.com

Independent music & culture publication. Los Angeles.

## How publishing works

- Stories live in `content/stories/` as simple text files.
- Photos live in `images/uploads/`.
- Write and publish at **tws.7-langes.com/admin** (log in with GitHub).
- Every publish triggers Netlify to rebuild the site automatically (`node build.js` → `dist/`).

## The Wire (daily brief)

Every morning at 7am Los Angeles time, a GitHub Action gathers the day's music
and culture headlines from other publications and publishes them to the site as
**The Wire**. Nothing to do by hand, and nothing to pay for.

- Headlines come from public RSS feeds (Billboard, Rolling Stone, Variety,
  Stereogum, Consequence, HipHopDX, NPR Music, The FADER, BrooklynVegan,
  Deadline, Pitchfork).
- The line under each headline is the outlet's own summary, as published in its
  news feed. The Wire credits and links — it does not republish anyone's
  reporting.
- Run it now instead of waiting for the morning: Actions -> **The Wire — daily
  brief** -> Run workflow.
- To change which outlets are covered or how many headlines run, edit `FEEDS`
  and `MAX_ITEMS` at the top of `scripts/fetch-news.js`.

The brief lives in `content/news/latest.json` and is rewritten each day. If it
is ever missing, the site just builds without The Wire.

## Front page slideshow

The hero cycles TWS's own photography behind the wordmark. Each slide credits
`TWS Studio` and, when the photo belongs to a story, links to that story.

- Slides come from `images/hero/`. Drop a photo in and it joins the rotation.
- **Keep hero files web-sized** — around 1800px on the long edge and under
  ~500KB. Camera originals (20MB+) will make the front page crawl on phones.
  Photos already attached to a story lead the rotation, since they have
  somewhere to click through to.
- Only the first slide loads up front; the rest load as they come around.
- Readers with "reduce motion" turned on see the first photo and no cycling.

## Files

- `template.html` — the site design. Edit this to change the look.
- `build.js` — assembles the site from the design + stories + the daily brief. No dependencies.
- `admin/` — the publishing interface (Decap CMS).
- `content/stories/*.md` — one file per story: headline, kicker, location, date, YouTube ID, photos, body.
- `scripts/fetch-news.js` — gathers The Wire. No dependencies.
- `content/news/latest.json` — today's brief, written by the daily job.
- `images/hero/` — web-sized photos for the front page slideshow.
- `images/uploads/` — photos attached to stories, as uploaded through the admin.

## Manual build (optional)

    node build.js

Output lands in `dist/`.
