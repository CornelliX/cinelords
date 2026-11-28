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

Cinemas live in `src/data.js` (`CINEMAS`, id/name/city); scraper ids must match. Sources in `scraper/scrape.js`: yorck, kinoheld (Puppeteer), cinetixx, babylon, arsenal, brotfabrik, passage, cineding, regina, cinestar, cinemotion (Puppeteer, CineMotion Hohenschönhausen id 29), schauburg (static, Schauburg Leipzig id 40). zoopalast (Puppeteer on zoopalast.premiumkino.de/programm, id 30: clicks each date tab `swiper-slide[data-iso]` and scrolls the inner scroll container, not the window, because the film list lazy-loads; it must wait for and decline the cookie dialog first, which otherwise blocks scrolling (`html.cdk-global-scrollblock`) and so the list, notably on the slower CI runner; kinoheld only lists Zoo Palast specials/presales). The scrape dedup key includes `version`, so OV and DF at the same time both stay. Yorck houses are mapped by name in `YORCK` (ids 1–3, 21–27), CineStar houses by URL slug in `CINESTAR` (Kulturbrauerei 13, Cubix 28, Leipzig 39). Lichtblick comes via kinoheld. Not covered: UT Connewitz (mostly concerts). Kino Zukunft and Colosseum (kino.colosseumberlin.com) come via kinoheld. Do not probe or introspect private APIs of ticketing platforms; scrape the public pages.

## Frontend (`src/`)

- `app.js`: everything UI. Tabs Filme / Kalender / Gemerkt / History. One card per film and day (`buildCards`), one row per cinema with time chips; tapping/clicking a chip opens the sheet (`openSheet`: Merken, Dabei, Tickets, Apple .ics, Google Calendar). Every status change offers undo (`offerUndo`). Filters: city + star toggle `favOnly` right of it (only favourite cinemas; stars `.fav-btn` next to each cinema name in the cards, `favCinemas` in localStorage `cine-favCinemas`, device only, no Supabase sync), cinema select (favourites marked ★) + search, film picker (button `#film-btn` opens `openFilmSheet`: alphabetical list via `deCollator`, A–Z bar `#az-bar` (jumps to `data-first-letter`) and "↑ Alle Filme" jump button once scrolled; options follow city/cinema/version, resets when the film drops out) + time select ("Zeit": `filters.time` = 'HH:MM' minimum start, 'egal' stays selected and shown but filters nothing; reset → 'alle' shows "Zeit") + version select ("Sprache": Deutsch=DF/OmU/OmeU/OV; this row wraps the film button onto its own line below ~374 px via a media query in style.css), search auto-clears (2 s without hits, 8 s idle). List appends batches on scroll (`appendMoreCards`). One delegated click handler (`onClick`). The help guide is `GUIDE` in app.js: keep it in sync with feature changes.
- `data.js`: `loadData/saveData` add the `cine-` prefix to every localStorage key; `getFilms()` consumes `window.__filmsP` (started in index.html) once.
- `supabase.js`: same project as LiveLords, auth storageKey `cine-auth`, table `cine_bookmarks` (see `supabase/cine_bookmarks.sql`, RLS own rows only). Server is the source of truth for bookmarks; logout clears local lists. History: table `cine_history` (`supabase/cine_history.sql`, own rows only) holds snapshots (title/cinema/date/time/version, `screening_id` only for dedupe), because the scraper drops past screenings. `setStatus(..., "going")` creates the snapshot at once (`archiveScreening`), un-marking before the start deletes it; `syncGoingToHistory()` after login fills gaps except ids in localStorage `cine-historyDismissed` (deleted on purpose). The tab shows entries once started (`isPast`), stars 1-5 (same star again clears), edit sheet (title, cinema with datalist, date <= today, time; delete). No photos, no radar.

## Shared origin with LiveLords

Both apps run on the same github.io origin and share localStorage, sessionStorage and Cache Storage. Therefore: all keys/caches use the `cine-` prefix (`cine-auth`, `cine-email`, `cine-loaded`, caches `cine-v1`, `cine-films`) and each `sw.js` only deletes caches with its own prefix (LiveLords: `konzert-`). Never broaden that cleanup. The Supabase Auth redirect URLs must include `…github.io/cinelords/`.

## Startup / intro (lessons from LiveLords on iPhone)

- Film-leader countdown intro (3-2-1) is static markup in `index.html` (`#cine-intro`, first open per session via sessionStorage `cine-loaded`), constant 2 s: timed by a `requestAnimationFrame` loop (1.6 s), then a 0.4 s CSS opacity transition. No delayed CSS animations or setTimeout for timing; animate only transform/opacity. If the app is not ready, the intro waits for `window.__introRelease()` (called by `renderApp` once frames are smooth, max 1 s).
- `sw.js` serves `films.json` stale-while-revalidate and posts `films-updated`; `applyFilmsUpdate()` swaps the list in and re-renders only if nothing is in progress.
- Tailwind CDN loads async, `renderApp` waits max 0.3 s for it. First render uses `peekUser()`; `loadAccountData()` verifies login and loads bookmarks in the background. Keep heavy per-screening loops out of the startup path.

## UI rules

Touch targets >= 44 px, inputs 16 px (zoom stays allowed), faint text >= 0.6 alpha. Every touch interaction needs a click equivalent on desktop. Escape all output (`esc`), hrefs through `safeUrl`, ICS fields through `icsEscape`. Colours: main tone velvety deep wine red (background gradient `#12030a` -> `#3a0b1f`, wine `#6b0f2a`/`#9f1d3f`, logo `#b3244b`), accents mid orange `#f97316` and light orange `#fdba74`/`#fed7aa`, dates yellow `#fde047`; status pink `#f472b6` (gemerkt), green `#34d399` (dabei).

## Later phases (not built yet)

Radar (notify when a film shows up; use an index, not an all-vs-all loop), Lords/community sharing, stats.

Background: one solid colour `#2e0817` (`.app-bg`, body, theme-color, manifest), no gradient (user request); cards stay darker.
