# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**CineLords** (CINELORDS in the header logo) is a PWA showing the cinema programme of selected cinemas in Berlin (focus Prenzlauer Berg, Pankow, Friedrichshain, Mitte) and Leipzig. It is the sister app of LiveLords (`e:\Eigene Musik\konzert-app`) and follows the same principles: Vite + vanilla JS + Tailwind CDN, a Node scraper writing a JSON snapshot, Supabase for login/bookmarks, GitHub Pages at `/cinelords/`.

## Commands

```bash
npm run dev                      # Vite dev server
npm run build                    # production build to dist/
node scraper/scrape.js [quelle]  # run from the project root; writes public/films.json (optional: only one source, e.g. yorck)
```

No tests or lint. `.github/workflows/deploy.yml` scrapes Wed+Thu 06:00 UTC and on every push to main, commits `public/films.json` back, builds and deploys to gh-pages.

## Data

`public/films.json`: one record per screening, `{ id, filmKey, title, date, time, locationId, version: 'DF'|'OmU'|'OmeU'|'OV', ticketUrl, source, addedAt }`. `id` = `stableId(locationId|date|time|filmKey)`, so bookmarks survive scraper runs. `filmKey` = normalised title (version tags, 3D, year etc. stripped, NFD) so the same film from several cinemas lands on one card. Window: next 14 days. A cinema that returns nothing keeps its screenings from the previous snapshot.

Cinemas live in `src/data.js` (`CINEMAS`, id/name/city); scraper ids must match. Sources in `scraper/scrape.js`: yorck, kinoheld (Puppeteer), cinetixx, babylon, arsenal, brotfabrik, passage, cineding, regina, cinestar. Not covered: UT Connewitz (mostly concerts). Kino Zukunft and Colosseum (kino.colosseumberlin.com) come via kinoheld. Do not probe or introspect private APIs of ticketing platforms; scrape the public pages.

## Frontend (`src/`)

- `app.js`: everything UI. Tabs Filme / Kalender / Gemerkt. One card per film and day (`buildCards`), one row per cinema with time chips; tapping/clicking a chip opens the sheet (`openSheet`: Merken, Dabei, Tickets, Apple .ics, Google Calendar). Every status change offers undo (`offerUndo`). Filters: city, cinema select, version, search (auto-clears: 2 s without hits, 8 s idle). List appends batches on scroll (`appendMoreCards`). One delegated click handler (`onClick`). The help guide is `GUIDE` in app.js: keep it in sync with feature changes.
- `data.js`: `loadData/saveData` add the `cine-` prefix to every localStorage key; `getFilms()` consumes `window.__filmsP` (started in index.html) once.
- `supabase.js`: same project as LiveLords, auth storageKey `cine-auth`, table `cine_bookmarks` (see `supabase/cine_bookmarks.sql`, RLS own rows only). Server is the source of truth for bookmarks; logout clears local lists.

## Shared origin with LiveLords

Both apps run on the same github.io origin and share localStorage, sessionStorage and Cache Storage. Therefore: all keys/caches use the `cine-` prefix (`cine-auth`, `cine-email`, `cine-loaded`, caches `cine-v1`, `cine-films`) and each `sw.js` only deletes caches with its own prefix (LiveLords: `konzert-`). Never broaden that cleanup. The Supabase Auth redirect URLs must include `…github.io/cinelords/`.

## Startup / intro (lessons from LiveLords on iPhone)

- Film-leader countdown intro (3-2-1) is static markup in `index.html` (`#cine-intro`, first open per session via sessionStorage `cine-loaded`), constant 2 s: timed by a `requestAnimationFrame` loop (1.6 s), then a 0.4 s CSS opacity transition. No delayed CSS animations or setTimeout for timing; animate only transform/opacity. If the app is not ready, the intro waits for `window.__introRelease()` (called by `renderApp` once frames are smooth, max 1 s).
- `sw.js` serves `films.json` stale-while-revalidate and posts `films-updated`; `applyFilmsUpdate()` swaps the list in and re-renders only if nothing is in progress.
- Tailwind CDN loads async, `renderApp` waits max 0.3 s for it. First render uses `peekUser()`; `loadAccountData()` verifies login and loads bookmarks in the background. Keep heavy per-screening loops out of the startup path.

## UI rules

Touch targets >= 44 px, inputs 16 px (zoom stays allowed), faint text >= 0.6 alpha. Every touch interaction needs a click equivalent on desktop. Escape all output (`esc`), hrefs through `safeUrl`, ICS fields through `icsEscape`. Accent Kinorot -> Gold (`#e11d48` -> `#fbbf24`), background `#14040a`.

## Later phases (not built yet)

History of watched films, Radar (notify when a film shows up; use an index, not an all-vs-all loop), Lords/community sharing, stats.
