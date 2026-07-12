# TWS — tws.7-langes.com

Independent music & culture publication. Los Angeles.

## How publishing works

- Stories live in `content/stories/` as simple text files.
- Photos live in `images/uploads/`.
- Write and publish at **tws.7-langes.com/admin** (log in with GitHub).
- Every publish triggers Netlify to rebuild the site automatically (`node build.js` → `dist/`).

## Files

- `template.html` — the site design. Edit this to change the look.
- `build.js` — assembles the site from the design + stories. No dependencies.
- `admin/` — the publishing interface (Decap CMS).
- `content/stories/*.md` — one file per story: headline, kicker, location, date, YouTube ID, photos, body.

## Manual build (optional)

    node build.js

Output lands in `dist/`.
