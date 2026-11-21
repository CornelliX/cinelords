import { CINEMAS, getFilms, saveData, loadData } from './data.js'
import { loadBookmarks, setBookmark, getUser, peekUser, signInWithEmail, verifyOtp, signOut } from './supabase.js'

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// Nur http(s)-URLs als href: eine kompromittierte Kinoseite könnte sonst "javascript:..." einschleusen
function safeUrl(url) {
  if (!url) return ''
  try {
    const u = new URL(url, location.href)
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : ''
  } catch { return '' }
}

// RFC 5545: Komma/Semikolon/Backslash escapen und Zeilenumbrüche entfernen (sonst ließen sich ICS-Felder einschleusen)
function icsEscape(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/([,;\\])/g, '\\$1')
}

const byDateTime = (a, b) => (a.date + a.time).localeCompare(b.date + b.time)
const pad = n => String(n).padStart(2, '0')
// Lokales Datum als YYYY-MM-DD (toISOString wäre UTC: zwischen 0 und 2 Uhr "gestern")
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE') }
const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) }
const localDate = (date, time) => { const [y, m, d] = date.split('-').map(Number); const [h, min] = (time || '20:00').split(':').map(Number); return new Date(y, m - 1, d, h, min) }

function dayLabel(date) {
  if (date === addDays(0)) return 'Heute'
  if (date === addDays(1)) return 'Morgen'
  return new Date(date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })
}
const shortDate = date => new Date(date + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })

// ── Zustand ───────────────────────────────────────────────────────────────────────────────────

const cinemasById = new Map(CINEMAS.map(c => [c.id, c]))
const VERSION_LABEL = { DF: 'Deutsche Fassung', OmU: 'Original mit deutschen Untertiteln', OmeU: 'Original mit englischen Untertiteln', OV: 'Originalfassung ohne Untertitel' }

let currentUser = null
let screenings = []          // films.json: eine Zeile pro Vorstellung
let byId = new Map()         // String(id) -> Vorstellung
let filters = { city: 'Berlin', cinemaId: 'alle', version: 'alle', dates: [], search: '' }
let bookmarked = loadData('bookmarked') || []   // Vorstellungs-IDs als Strings; Server (cine_bookmarks) ist maßgeblich
let going = loadData('going') || []
const seenStored = loadData('seenFilms')
let seenFilms = new Set(seenStored || [])
let currentView = 'filme'
let calendarOffset = 0
const CARD_BATCH = 30
let renderedCardLimit = CARD_BATCH
let loadMoreObserver = null
let titleAnimated = false
let lastNavTap = { view: '', at: 0 }
let appReady = false
let filmsUpdatePending = false
let markSeenTimer = null
let sheetId = null, sheetOpener = null
let helpOpen = false
let fetchSeq = 0

function setScreenings(list) {
  screenings = Array.isArray(list) ? list.filter(s => cinemasById.has(s.locationId) && s.date && s.time && s.title) : []
  byId = new Map(screenings.map(s => [String(s.id), s]))
}

function saveMarks() { saveData('bookmarked', bookmarked); saveData('going', going) }

// ── Filter und Karten ─────────────────────────────────────────────────────────────────────────

function matches(s) {
  const c = cinemasById.get(s.locationId)
  if (c.city !== filters.city) return false
  if (filters.cinemaId !== 'alle' && s.locationId !== Number(filters.cinemaId)) return false
  if (filters.version !== 'alle' && s.version !== filters.version) return false
  if (filters.search) {
    const q = filters.search.toLowerCase()
    if (!s.title.toLowerCase().includes(q) && !c.name.toLowerCase().includes(q)) return false
  }
  return true
}

// Heute bereits begonnene Vorstellungen fallen weg
function upcomingFiltered() {
  const today = addDays(0), now = nowHM()
  return screenings.filter(s => (s.date > today || (s.date === today && s.time >= now)) && matches(s))
}

// Vorstellungen -> Karten (eine pro Film und Tag), sortiert nach Tag und erster Uhrzeit
function buildCards(list) {
  const map = new Map()
  for (const s of list) {
    const key = s.date + '|' + s.filmKey
    let card = map.get(key)
    if (!card) map.set(key, card = { key, date: s.date, filmKey: s.filmKey, title: s.title, shows: [] })
    if (s.title.length < card.title.length) card.title = s.title   // kürzeste Schreibweise: meist ohne Zusätze
    card.shows.push(s)
  }
  const cards = [...map.values()]
  for (const c of cards) c.shows.sort(byDateTime)
  return cards.sort((a, b) => a.date.localeCompare(b.date) || a.shows[0].time.localeCompare(b.shows[0].time) || a.title.localeCompare(b.title, 'de'))
}

function groupByDay(cards) {
  const groups = []
  for (const c of cards) {
    const last = groups[groups.length - 1]
    if (last && last[0] === c.date) last[1].push(c); else groups.push([c.date, [c]])
  }
  return groups
}

const isNewFilm = key => seenStored !== null && !seenFilms.has(key)

function statusOf(id) {
  id = String(id)
  return going.includes(id) ? 'going' : bookmarked.includes(id) ? 'bookmarked' : 'none'
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────

const ICON = {
  trailer: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>',
  letterboxd: '<svg width="20" height="16" viewBox="0 0 30 16" fill="currentColor"><circle cx="6" cy="8" r="5.5" opacity="0.65"/><circle cx="15" cy="8" r="5.5" opacity="0.85"/><circle cx="24" cy="8" r="5.5"/></svg>',
  imdb: '<span style="font:800 11px/1 Arial,sans-serif; letter-spacing:-0.02em; padding:3px 4px; border:1.5px solid currentColor; border-radius:4px;">IMDb</span>',
  share: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>',
  apple: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
  google: '<svg width="15" height="15" viewBox="0 0 48 48" fill="currentColor"><path d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/></svg>',
  ticket: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M13 6v2M13 11v2M13 16v2"/></svg>'
}

function chipInner(s, st) {
  const mark = st === 'going' ? '✓ ' : st === 'bookmarked' ? '♡ ' : ''
  return `<span>${mark}${esc(s.time)}</span>${s.version !== 'DF' ? `<small>${esc(s.version)}</small>` : ''}`
}
function chipLabel(s, st) {
  return `${s.time} Uhr, ${cinemasById.get(s.locationId).name}${s.version !== 'DF' ? ', ' + s.version : ''}${st === 'going' ? ', dabei' : st === 'bookmarked' ? ', gemerkt' : ''}`
}
function renderChip(s) {
  const st = statusOf(s.id)
  return `<button type="button" class="chip" data-show="${esc(s.id)}" data-st="${st}" aria-haspopup="dialog" aria-label="${esc(chipLabel(s, st))}">${chipInner(s, st)}</button>`
}

function renderCinemaRows(shows) {
  const rows = new Map()
  for (const s of shows) (rows.get(s.locationId) || rows.set(s.locationId, []).get(s.locationId)).push(s)
  return [...rows].map(([locId, list]) => `
          <div class="cine-row">
            <div class="cine-name">${esc(cinemasById.get(locId).name)}</div>
            <div class="chips">${list.map(renderChip).join('')}</div>
          </div>`).join('')
}

function renderIconRow(title, shareAttr) {
  const q = encodeURIComponent(title)
  return `
          <div class="icon-row">
            <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(title + ' Trailer')}" target="_blank" rel="noopener" title="Trailer suchen" aria-label="Trailer auf YouTube suchen" class="icon-btn btn-glass">${ICON.trailer}</a>
            <a href="https://letterboxd.com/search/films/${q}/" target="_blank" rel="noopener" title="Letterboxd" aria-label="Auf Letterboxd suchen" class="icon-btn btn-glass">${ICON.letterboxd}</a>
            <a href="https://www.imdb.com/find/?q=${q}&s=tt" target="_blank" rel="noopener" title="IMDb" aria-label="Auf IMDb suchen" class="icon-btn btn-glass">${ICON.imdb}</a>
            <button type="button" ${shareAttr} title="Teilen" aria-label="Teilen" class="icon-btn btn-glass">${ICON.share}</button>
          </div>`
}

function renderFilmCard(card) {
  return `
    <article class="film-card rounded-2xl overflow-hidden" data-card="${esc(card.key)}">
      <div class="card-stripe"></div>
      <div class="p-4" style="padding-bottom:12px;">
        <div class="flex items-center gap-2 flex-wrap" style="margin-bottom:4px;">
          <span class="syne text-xs" style="color:#fbbf24; font-weight:700;">${esc(shortDate(card.date))}</span>
          ${isNewFilm(card.filmKey) ? '<span class="text-xs font-bold" style="color:#f472b6; letter-spacing:0.05em;">NEU</span>' : ''}
        </div>
        <h3 class="syne text-white leading-tight" style="font-size:1.05rem; letter-spacing:-0.01em; margin-bottom:4px;">${esc(card.title)}</h3>
        ${renderCinemaRows(card.shows)}
        ${renderIconRow(card.title, `data-share-card="${esc(card.key)}"`)}
      </div>
    </article>`
}

// Karte einer einzelnen Vorstellung (Gemerkt)
function renderShowCard(s) {
  const c = cinemasById.get(s.locationId)
  return `
    <article class="film-card rounded-2xl overflow-hidden">
      <div class="card-stripe"></div>
      <div class="p-4" style="padding-bottom:12px;">
        <span class="syne text-xs" style="color:#fbbf24; font-weight:700;">${esc(shortDate(s.date))} · ${esc(s.time)}</span>
        <h3 class="syne text-white leading-tight" style="font-size:1.05rem; letter-spacing:-0.01em; margin:4px 0;">${esc(s.title)}</h3>
        <p class="text-xs" style="color:rgba(255,255,255,0.65);">${esc(c.city)}${s.version !== 'DF' ? ' · ' + esc(VERSION_LABEL[s.version] || s.version) : ''}</p>
        ${renderCinemaRows([s])}
        ${renderIconRow(s.title, `data-share-show="${esc(s.id)}"`)}
      </div>
    </article>`
}

function renderDayGroup(date, cards) {
  return `
    <section data-day="${date}">
      <div class="flex items-center gap-3 mb-4">
        <div class="h-px flex-1" style="background:rgba(255,255,255,0.08);"></div>
        <h2 class="syne text-xs tracking-widest uppercase" style="color:rgba(255,255,255,0.65); font-weight:700;">${esc(dayLabel(date))}</h2>
        <div class="h-px flex-1" style="background:rgba(255,255,255,0.08);"></div>
      </div>
      <div class="space-y-3">${cards.map(renderFilmCard).join('')}</div>
    </section>`
}

function hasActiveFilters() { return filters.search || filters.cinemaId !== 'alle' || filters.version !== 'alle' }

function renderFilmPane() {
  const shows = upcomingFiltered()
  const cards = buildCards(shows)
  const tip = loadData('tipSeen') ? '' : `<div data-first-tip class="glass rounded-2xl" style="display:flex; align-items:flex-start; gap:4px; padding:10px 4px 10px 14px; margin-bottom:16px;"><p class="text-xs" style="flex:1; color:rgba(255,255,255,0.8); line-height:1.5; margin-top:5px;"><strong style="color:white;">Tipp:</strong> Tippe auf eine Uhrzeit, um die Vorstellung zu merken, Tickets zu holen oder sie in Deinen Kalender zu übernehmen. Alles Weitere steht unter Hilfe.</p><button data-dismiss-tip aria-label="Tipp schließen" style="width:44px; height:44px; flex-shrink:0; background:none; border:none; color:rgba(255,255,255,0.7); font-size:22px; cursor:pointer;">×</button></div>`
  if (!cards.length) {
    return `${tip}<div class="text-center py-20" style="color:rgba(255,255,255,0.65);"><p class="syne text-2xl mb-2">—</p><p class="text-sm">Keine Vorstellungen gefunden.</p>${hasActiveFilters() ? `<button data-reset-filters class="btn-glass rounded-xl syne text-sm font-semibold" style="height:44px; padding:0 22px; margin-top:18px; color:white;">Filter zurücksetzen</button>` : ''}</div>`
  }
  const films = new Set(cards.map(c => c.filmKey)).size
  const hasMore = cards.length > renderedCardLimit
  return `
    ${tip}
    <p class="text-xs" style="color:rgba(255,255,255,0.65); margin:-6px 0 14px;" aria-live="polite">${films} ${films === 1 ? 'Film' : 'Filme'} · ${shows.length} ${shows.length === 1 ? 'Vorstellung' : 'Vorstellungen'}</p>
    <div id="day-groups" class="space-y-8">${groupByDay(cards.slice(0, renderedCardLimit)).map(([d, list]) => renderDayGroup(d, list)).join('')}</div>
    ${hasMore ? `<div id="load-more-sentinel" style="height:1px;"></div><p id="load-more-footer" class="text-center text-xs py-6 skeleton-pulse" style="color:rgba(255,255,255,0.6);">Weitere Filme werden geladen…</p>` : ''}`
}

// Beim Scrollen nur die nächsten Karten anhängen (kein Neuzeichnen der ganzen Liste)
function appendMoreCards() {
  const groupsEl = document.getElementById('day-groups')
  if (!groupsEl) return
  const cards = buildCards(upcomingFiltered())
  const from = renderedCardLimit
  renderedCardLimit += CARD_BATCH
  for (const [date, list] of groupByDay(cards.slice(from, renderedCardLimit))) {
    const last = groupsEl.lastElementChild
    if (last && last.dataset.day === date) last.querySelector('.space-y-3').insertAdjacentHTML('beforeend', list.map(renderFilmCard).join(''))
    else groupsEl.insertAdjacentHTML('beforeend', renderDayGroup(date, list))
  }
  if (cards.length <= renderedCardLimit) {
    document.getElementById('load-more-sentinel')?.remove()
    document.getElementById('load-more-footer')?.remove()
  }
}

function setupLoadMoreObserver() {
  loadMoreObserver?.disconnect()
  const sentinel = document.getElementById('load-more-sentinel')
  if (!sentinel || !('IntersectionObserver' in window)) return
  loadMoreObserver = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) appendMoreCards() }, { rootMargin: '800px 0px' })
  loadMoreObserver.observe(sentinel)
}

function renderCalendar() {
  const today = new Date()
  const todayStr = addDays(0)
  const viewDate = new Date(today.getFullYear(), today.getMonth() + calendarOffset, 1)
  const year = viewDate.getFullYear(), month = viewDate.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const firstDay = (new Date(year, month, 1).getDay() + 6) % 7
  const monthName = viewDate.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
  const shows = upcomingFiltered()
  const filmsPerDay = new Map()
  for (const s of shows) (filmsPerDay.get(s.date) || filmsPerDay.set(s.date, new Set()).get(s.date)).add(s.filmKey)
  const selected = filters.dates.length ? buildCards(shows.filter(s => filters.dates.includes(s.date))) : []
  return `
    <div class="glass rounded-2xl p-5 mb-5" style="position:relative; z-index:1;">
      <div class="flex items-center justify-between mb-5">
        <button data-cal-prev aria-label="Vorheriger Monat" class="btn-glass w-11 h-11 rounded-xl flex items-center justify-center" style="color:rgba(255,255,255,0.8);">‹</button>
        <h2 class="syne text-white tracking-wide capitalize" style="font-weight:700;">${monthName}</h2>
        <button data-cal-next aria-label="Nächster Monat" class="btn-glass w-11 h-11 rounded-xl flex items-center justify-center" style="color:rgba(255,255,255,0.8);">›</button>
      </div>
      <div class="grid grid-cols-7 gap-1 text-center mb-3">
        ${['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].map(d => `<div class="text-xs font-semibold py-1" style="color:rgba(255,255,255,0.6);">${d}</div>`).join('')}
      </div>
      <div class="grid grid-cols-7 gap-1">
        ${Array(firstDay).fill('<div></div>').join('')}
        ${Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1
          const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`
          const n = filmsPerDay.get(dateStr)?.size || 0
          const isSelected = filters.dates.includes(dateStr)
          const isToday = dateStr === todayStr
          const isPast = dateStr < todayStr
          return `
            <button data-date="${dateStr}" style="aspect-ratio:1; border-radius:12px; font-size:14px; font-weight:${isToday ? 700 : 500}; display:flex; align-items:center; justify-content:center; position:relative; ${isPast ? 'opacity:0.25;' : ''} color:${!n && !isSelected && !isToday ? 'rgba(255,255,255,0.25)' : 'white'}; background:${isSelected ? 'rgba(225,29,72,0.5)' : n ? 'rgba(251,191,36,0.1)' : 'transparent'}; border:1px solid ${isSelected ? 'rgba(251,191,36,0.7)' : n ? 'rgba(251,191,36,0.25)' : isToday ? 'rgba(255,255,255,0.2)' : 'transparent'}; ${isToday ? 'box-shadow:0 0 0 2px rgba(253,230,138,0.85);' : ''} padding:4px; cursor:pointer;" aria-pressed="${isSelected}" aria-label="${day}.${n ? ', ' + n + (n === 1 ? ' Film' : ' Filme') : ''}${isToday ? ', heute' : ''}">
              ${day}
              ${n ? `<span aria-hidden="true" style="position:absolute; bottom:5px; left:0; right:0; display:flex; justify-content:center; gap:2px;">${Array.from({ length: n <= 5 ? 1 : n <= 15 ? 2 : 3 }, () => '<i style="width:4px; height:4px; border-radius:50%; background:#fcd34d; display:block;"></i>').join('')}</span>` : ''}
            </button>`
        }).join('')}
      </div>
      ${calendarOffset !== 0 ? `<button data-cal-today class="mt-4 w-full text-xs rounded-xl btn-glass" style="height:44px; color:rgba(255,255,255,0.8);">Zurück zum aktuellen Monat</button>` : ''}
      ${filters.dates.length
        ? `<button data-clear-dates class="mt-4 w-full text-xs rounded-xl btn-glass" style="height:44px; color:rgba(255,255,255,0.8);">Auswahl zurücksetzen (${filters.dates.length} ${filters.dates.length === 1 ? 'Tag' : 'Tage'})</button>`
        : `<p class="text-center text-xs mt-4" style="color:rgba(255,255,255,0.6);">Tage antippen zum Anzeigen · Mehrfachauswahl möglich</p>`}
    </div>
    ${filters.dates.length === 0 ? '' : selected.length === 0
      ? '<p class="text-center py-6 text-sm" style="color:rgba(255,255,255,0.6);">Keine Vorstellungen an den gewählten Tagen.</p>'
      : `<div class="space-y-8">${groupByDay(selected).map(([d, list]) => renderDayGroup(d, list)).join('')}</div>`}`
}

function renderGemerkt() {
  if (!currentUser) return `<div class="text-center py-14" style="color:rgba(255,255,255,0.7);"><p class="syne text-2xl mb-2">♡</p><p class="text-sm">Melde Dich oben mit Deiner E-Mail an, um Vorstellungen zu merken.</p></div>`
  const today = addDays(0)
  const pick = ids => ids.map(id => byId.get(String(id))).filter(s => s && s.date >= today).sort(byDateTime)
  const g = pick(going), b = pick(bookmarked)
  if (!g.length && !b.length) return `
    <div class="text-center py-14" style="color:rgba(255,255,255,0.7);">
      <p class="syne text-2xl mb-2">♡</p>
      <p class="text-sm" style="font-weight:600;">Noch nichts gemerkt.</p>
      <p class="text-xs" style="color:rgba(255,255,255,0.65); margin:6px 0 18px; line-height:1.5;">Tippe in den Filmen auf eine Uhrzeit und wähle<br>„Merken“ oder „Dabei“.</p>
      <button data-goto-view="filme" class="btn-glass rounded-xl syne text-sm font-semibold" style="height:44px; padding:0 22px; color:white;">Zu den Filmen</button>
    </div>`
  const section = (label, color, list) => `
    <section class="space-y-3">
      <h2 class="syne text-xs tracking-widest uppercase" style="color:${color}; font-weight:700; margin-bottom:4px;">${label}</h2>
      ${list.map(renderShowCard).join('')}
    </section>`
  return `<div class="space-y-8 pt-2">${g.length ? section('✓ Dabei', '#34d399', g) : ''}${b.length ? section('♡ Gemerkt', '#f472b6', b) : ''}</div>`
}

function renderView() {
  const view = document.getElementById('view')
  if (!view) return
  renderedCardLimit = CARD_BATCH
  view.innerHTML = currentView === 'filme' ? renderFilmPane() : currentView === 'kalender' ? renderCalendar() : renderGemerkt()
  const bar = document.getElementById('filter-bar-wrap')
  if (bar) bar.style.display = currentView === 'gemerkt' ? 'none' : ''
  setupLoadMoreObserver()
  if (currentView === 'filme' && [...seenFilms].length !== new Set(screenings.map(s => s.filmKey)).size) {
    clearTimeout(markSeenTimer)
    markSeenTimer = setTimeout(() => { seenFilms = new Set(screenings.map(s => s.filmKey)); saveData('seenFilms', [...seenFilms]) }, 3000)
  }
}

function renderHeader() {
  const firstRender = !titleAnimated
  if (!document.documentElement.classList.contains('intro-on')) titleAnimated = true   // hinter dem Intro gezeichnet zählt nicht
  const big = 'calc(min(1.55rem, 6.4vw) + 2pt)'
  return `
    <div id="app-header" class="pb-3" style="padding-top:max(1.5rem,env(safe-area-inset-top));">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <div class="${firstRender ? 'title-glow-wrap' : ''}" style="flex-shrink:0;">
          <h1 class="syne leading-none ${firstRender ? 'title-glow' : 'title-glow-static'}" style="letter-spacing:-0.02em; font-weight:800; line-height:1; font-size:min(1.55rem, 6.4vw); white-space:nowrap;">
            <span style="font-size:${big};">C</span>INE<span style="font-size:${big};">L</span>ORDS
          </h1>
        </div>
        <div class="syne text-right header-tagline" style="color:rgba(251,191,36,0.75); font-weight:700; font-size:min(0.52em, 1.95vw); line-height:1.3; text-transform:uppercase; overflow:hidden; white-space:nowrap; ${firstRender ? 'animation:tagline-appear 2.4s ease-in-out 2.8s both;' : ''}">
          KINOPROGRAMM IN<br>BERLIN UND LEIPZIG
        </div>
      </div>
    </div>`
}

const INPUT_WRAP = 'display:flex; border-radius:12px; overflow:hidden; border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.06);'
const INPUT_INNER = "flex:1; min-width:0; padding:10px 14px; color:white; outline:none; background:transparent; border:none; font-family:'DM Sans',sans-serif;"
const PRIMARY_BG = 'background:linear-gradient(135deg, rgba(225,29,72,0.6), rgba(245,158,11,0.55));'

function renderAccountBox() {
  if (currentUser) return `<div class="mb-2" style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; color:rgba(255,255,255,0.65);"><button type="button" data-open-help style="background:none; border:none; cursor:pointer; padding:12px 6px; margin:-12px -6px; font-size:12px; font-weight:600; color:#fcd34d;">? Hilfe</button><span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(currentUser.email)} · <button type="button" id="logout-btn" style="background:none; border:none; color:inherit; font-size:12px; cursor:pointer; text-decoration:underline; padding:12px 6px; margin:-12px -6px;">Abmelden</button></span></div>`
  let email = ''
  try { email = localStorage.getItem('cine-email') || '' } catch {}
  return `
    <div class="glass rounded-2xl p-4 mb-4">
      <div id="login-step-1">
        <p style="font-size:12px; color:rgba(255,255,255,0.72); line-height:1.5; margin-bottom:10px;">Melde Dich an, um Vorstellungen zu merken. <button type="button" data-open-help style="background:none; border:none; padding:0; color:#fcd34d; cursor:pointer; text-decoration:underline; font-size:12px;">Mehr in der Hilfe</button></p>
        <div style="${INPUT_WRAP}">
          <input id="login-email" type="email" autocomplete="email" aria-label="E-Mail" placeholder="E-Mail für die Merkliste..." value="${esc(email)}" style="${INPUT_INNER}" />
          <button id="login-btn" type="button" class="syne text-sm font-semibold px-4" style="${PRIMARY_BG} border:none; color:white; white-space:nowrap; cursor:pointer; flex-shrink:0;">Code senden</button>
        </div>
        <p id="login-hint" role="status" style="margin-top:8px; font-size:12px; color:rgba(255,140,140,0.9);"></p>
      </div>
      <div id="login-step-2" style="display:none;">
        <p style="font-size:12px; color:rgba(255,255,255,0.65); margin-bottom:10px;">Code per E-Mail gesendet — bitte Postfach prüfen.</p>
        <div style="${INPUT_WRAP}">
          <input id="login-code" type="text" inputmode="numeric" autocomplete="one-time-code" aria-label="Code aus der E-Mail" placeholder="Code aus der E-Mail..." style="${INPUT_INNER} letter-spacing:0.2em;" />
          <button id="verify-btn" type="button" class="syne text-sm font-semibold px-4" style="${PRIMARY_BG} border:none; color:white; white-space:nowrap; cursor:pointer; flex-shrink:0;">Bestätigen</button>
        </div>
        <p id="verify-hint" role="status" style="margin-top:8px; font-size:12px; color:rgba(255,140,140,0.9); min-height:16px;"></p>
      </div>
    </div>`
}

function renderFilters() {
  const cinemas = CINEMAS.filter(c => c.city === filters.city).sort((a, b) => a.name.localeCompare(b.name, 'de'))
  const seg = 'display:flex; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.07); border-radius:10px; padding:3px;'
  const segBtn = active => `flex:1; min-height:44px; padding:0 4px; border-radius:7px; cursor:pointer; border:none; ${active ? 'background:linear-gradient(135deg,rgba(225,29,72,0.55),rgba(245,158,11,0.45)); color:white; box-shadow:0 1px 8px rgba(225,29,72,0.25);' : 'background:transparent; color:rgba(255,255,255,0.65);'}`
  const field = 'width:100%; min-height:44px; padding:10px 12px; border-radius:10px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); color:white; outline:none;'
  return `
    <div class="glass rounded-2xl p-3 mb-5" style="display:flex; flex-direction:column; gap:8px;">
      <div style="${seg}" role="group" aria-label="Stadt">
        ${['Berlin', 'Leipzig'].map(c => `<button type="button" data-city="${c}" aria-pressed="${filters.city === c}" class="syne text-sm font-semibold" style="${segBtn(filters.city === c)}">${c}</button>`).join('')}
      </div>
      <div style="display:flex; gap:8px;">
        <select id="cinema-select" aria-label="Kino" style="${field} flex:1; min-width:0; -webkit-appearance:none; appearance:none; background-image:linear-gradient(45deg, transparent 50%, rgba(255,255,255,0.6) 50%), linear-gradient(135deg, rgba(255,255,255,0.6) 50%, transparent 50%); background-position:calc(100% - 16px) 50%, calc(100% - 11px) 50%; background-size:5px 5px; background-repeat:no-repeat; padding-right:26px; text-overflow:ellipsis;">
          <option value="alle">Alle Kinos</option>
          ${cinemas.map(c => `<option value="${c.id}" ${String(c.id) === String(filters.cinemaId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select>
        <div style="position:relative; flex:1; min-width:0;">
          <input id="search-input" type="search" aria-label="Film oder Kino suchen" placeholder="Suche…" value="${esc(filters.search)}" style="${field} padding-right:34px; -webkit-appearance:none; appearance:none;" />
          <button id="search-clear" type="button" aria-label="Suche löschen" style="position:absolute; right:0; top:50%; transform:translateY(-50%); width:38px; height:44px; border:none; background:transparent; color:rgba(255,255,255,0.6); font-size:18px; line-height:1; cursor:pointer; display:${filters.search ? 'flex' : 'none'}; align-items:center; justify-content:center; border-radius:50%;">×</button>
        </div>
      </div>
      <div style="${seg}" role="group" aria-label="Sprachfassung">
        ${['alle', 'DF', 'OmU', 'OmeU', 'OV'].map(v => `<button type="button" data-version="${v}" aria-pressed="${filters.version === v}" title="${v === 'alle' ? 'Alle Fassungen' : VERSION_LABEL[v]}" class="syne text-xs font-semibold" style="${segBtn(filters.version === v)}">${v === 'alle' ? 'Alle' : v}</button>`).join('')}
      </div>
    </div>`
}

function renderBottomNav() {
  const today = addDays(0)
  const count = [...going, ...bookmarked].filter(id => byId.get(String(id))?.date >= today).length
  const tabs = [
    { id: 'filme', label: 'Filme', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18"/></svg>' },
    { id: 'kalender', label: 'Kalender', icon: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' },
    { id: 'gemerkt', label: 'Gemerkt', badge: count, icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="${count ? 'rgba(244,114,182,0.7)' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>` }
  ]
  return `
    <nav aria-label="Ansicht" style="max-width:576px; margin:0 auto; background:rgba(16,4,8,0.96); backdrop-filter:blur(24px); -webkit-backdrop-filter:blur(24px); border-top:1px solid rgba(255,255,255,0.07); display:flex; padding-bottom:env(safe-area-inset-bottom,0px);">
      ${tabs.map(t => {
        const active = currentView === t.id
        return `<button type="button" data-nav="${t.id}" ${active ? 'aria-current="page"' : ''} style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; padding:10px 4px 11px; background:none; border:none; cursor:pointer; color:${active ? 'white' : 'rgba(255,255,255,0.5)'}; position:relative; transition:color 0.2s;">
          ${active ? '<span style="position:absolute; top:0; left:50%; transform:translateX(-50%); width:28px; height:2px; background:linear-gradient(90deg,#e11d48,#fbbf24); border-radius:0 0 3px 3px;"></span>' : ''}
          <span style="position:relative; display:inline-block;">
            ${t.icon}
            ${t.badge > 0 ? `<span aria-label="${t.badge} gemerkt" style="position:absolute; top:-4px; right:-6px; min-width:16px; height:16px; border-radius:8px; background:#f472b6; color:white; font-size:10px; font-weight:700; display:flex; align-items:center; justify-content:center; padding:0 3px;">${t.badge > 99 ? '99+' : t.badge}</span>` : ''}
          </span>
          <span class="syne" style="font-size:10px; font-weight:700; letter-spacing:0.05em; text-transform:uppercase;">${t.label}</span>
        </button>`
      }).join('')}
    </nav>`
}

function refreshBottomNav() {
  const nav = document.getElementById('bottom-nav')
  if (nav) nav.innerHTML = renderBottomNav()
}

function render() {
  const inner = document.getElementById('app-inner')
  // Den bisherigen Header behalten: sonst bricht ein laufender Glow ab, wenn im Hintergrund neu gezeichnet wird
  const oldHeader = document.getElementById('app-header')
  inner.innerHTML = `
    ${renderHeader()}
    ${renderAccountBox()}
    <div id="filter-bar-wrap">${renderFilters()}</div>
    <main id="view"></main>`
  if (oldHeader) { oldHeader.style.opacity = ''; document.getElementById('app-header').replaceWith(oldHeader) }
  renderView()
  refreshBottomNav()
}

// ── Anleitung ─────────────────────────────────────────────────────────────────────────────────

function guideIcon(token) {
  const chip = (inner, color = 'rgba(255,255,255,0.75)') => `<span style="display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:20px; padding:0 5px; border-radius:6px; background:rgba(255,255,255,0.07); border:1px solid rgba(255,255,255,0.1); vertical-align:middle; margin:0 1px; color:${color}; font-size:12px; line-height:1;">${inner}</span>`
  const small = svg => svg.replace(/width="\d+" height="\d+"/, 'width="13" height="13"')
  const icons = {
    trailer: chip(small(ICON.trailer)), letterboxd: chip(small(ICON.letterboxd)), imdb: chip('<b style="font:800 9px Arial;">IMDb</b>'),
    share: chip(small(ICON.share)), apple: chip(small(ICON.apple)), google: chip(small(ICON.google)), ticket: chip(small(ICON.ticket)),
    herz: chip('♡', '#f472b6'), haken: chip('✓', '#34d399')
  }
  return Object.hasOwn(icons, token) ? icons[token] : null
}
const guideText = text => esc(text).replace(/\{(\w+)\}/g, (m, token) => guideIcon(token) ?? m)

// Anleitung: [Überschrift, [[Stichwort, Text], ...]] - bei jeder Funktionsänderung mitpflegen
const GUIDE = [
  ['Am Computer', [
    ['Tippen und Doppeltipp', 'Tippen heißt am Computer klicken, Doppeltipp heißt doppelklicken.'],
    ['Aktualisieren', 'Statt die Seite nach unten zu ziehen, lädst Du sie neu (F5).']
  ]],
  ['Filme', [
    ['Überblick', 'Das Programm der nächsten zwei Wochen, eine Karte pro Film und Tag. Darunter stehen die Kinos mit allen Uhrzeiten. Vorstellungen, die heute schon begonnen haben, sind ausgeblendet.'],
    ['Filtern und suchen', 'Nach Stadt, Kino und Sprachfassung filtern, über die Suchleiste nach einem Film oder Kino suchen. Über der Liste steht, wie viele Filme und Vorstellungen passen.'],
    ['Sprachfassung', 'Unter der Uhrzeit steht die Fassung: OmU = Original mit deutschen Untertiteln, OmeU = Original mit englischen Untertiteln, OV = Original ohne Untertitel. Ohne Zusatz läuft die deutsche Fassung (DF).'],
    ['Uhrzeit antippen', 'Öffnet das Menü der Vorstellung: {herz} „Merken“, {haken} „Dabei“, {ticket} Tickets und Kalender ({apple} Apple, {google} Google). Gemerkte Uhrzeiten sind rosa, „Dabei“ grün. Nach jeder Änderung erscheint unten kurz „Rückgängig“.'],
    ['Icon-Leiste', '{trailer} Trailer (YouTube-Suche), {letterboxd} Letterboxd, {imdb} IMDb, {share} Teilen.'],
    ['NEU', 'Filme, die seit Deinem letzten Besuch ins Programm gekommen sind.'],
    ['Suche leert sich selbst', 'Gibt es keinen Treffer, verschwindet der Suchbegriff nach 2 Sekunden. Gibt es Treffer, wird das Suchfeld geleert, sobald Du eine Vorstellung merkst, oder wenn Du 8 Sekunden lang nichts tippst oder berührst.'],
    ['Doppeltipp', 'Doppeltipp auf den Reiter „Filme“ springt ganz nach oben. Die Liste lädt beim Scrollen von selbst weiter.']
  ]],
  ['Kalender', [
    ['Monatsübersicht', 'Tage mit Vorstellungen sind hervorgehoben, die Punkte zeigen, wie viel läuft (1 Punkt: bis 5 Filme, 2 Punkte: bis 15, 3 Punkte: mehr). Tippe auf einen oder mehrere Tage, um ihre Filme zu sehen. Die Filter gelten auch hier.'],
    ['Doppeltipp', 'Doppeltipp auf den Reiter „Kalender“ springt zum aktuellen Monat.']
  ]],
  ['Gemerkt', [
    ['Meine Vorstellungen', 'Oben die Vorstellungen, bei denen Du {haken} dabei bist, darunter die {herz} gemerkten. Tippe auf die Uhrzeit, um den Status zu ändern oder Tickets zu holen. Vergangene Tage verschwinden von selbst.'],
    ['Doppeltipp', 'Doppeltipp auf den Reiter „Gemerkt“ springt ganz nach oben.']
  ]],
  ['Anmeldung', [
    ['E-Mail-Code', 'Merken und „Dabei“ funktionieren nur mit Anmeldung per E-Mail-Code. Ohne Anmeldung kannst Du im Programm stöbern. Die Anmeldung ist unabhängig von LiveLords.']
  ]]
]

function openHelp() {
  helpOpen = true
  document.getElementById('modal-root').innerHTML = `
    <div id="modal-help" class="fixed inset-0 z-50 overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="help-title" style="background:rgba(0,0,0,0.72); backdrop-filter:blur(8px); overscroll-behavior:contain;">
      <div class="max-w-lg mx-auto px-4" style="padding-top:max(56px, calc(env(safe-area-inset-top) + 24px)); padding-bottom:48px;">
        <div class="film-card rounded-2xl overflow-hidden">
          <div class="card-stripe"></div>
          <div class="p-5">
            <div class="flex items-center justify-between" style="margin-bottom:6px;">
              <h2 id="help-title" class="syne text-xl text-white" style="font-weight:800;">Anleitung</h2>
              <button type="button" data-close-help aria-label="Schließen" style="width:44px; height:44px; color:rgba(255,255,255,0.7); background:none; border:none; cursor:pointer; font-size:24px; line-height:1;">×</button>
            </div>
            ${GUIDE.map(([head, items], i) => `
              <h3 class="syne" style="margin:${i === 0 ? '8px' : '18px'} 0 6px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.06); font-size:12px; font-weight:800; letter-spacing:0.08em; text-transform:uppercase; color:#fcd34d;">${esc(head)}</h3>
              <ul style="list-style:disc; padding-left:18px; margin:0;">
                ${items.map(([lead, text]) => `<li class="text-xs" style="color:rgba(255,255,255,0.68); line-height:1.5; margin-top:6px;"><strong style="color:white; font-weight:700;">${esc(lead)}:</strong> ${guideText(text)}</li>`).join('')}
              </ul>`).join('')}
          </div>
        </div>
      </div>
    </div>`
  document.querySelector('[data-close-help]')?.focus()
}

function closeHelp() {
  helpOpen = false
  document.getElementById('modal-root').innerHTML = ''
}

// ── Menü einer Vorstellung ────────────────────────────────────────────────────────────────────

function openSheet(id, opener) {
  const s = byId.get(String(id))
  if (!s) return
  sheetId = String(id)
  sheetOpener = opener || null
  const c = cinemasById.get(s.locationId)
  const st = statusOf(id)
  const ticket = safeUrl(s.ticketUrl)
  const root = document.getElementById('sheet-root')
  root.innerHTML = `
    <div class="sheet-backdrop" data-close-sheet></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
      <div aria-hidden="true" style="width:40px; height:4px; border-radius:2px; background:rgba(255,255,255,0.25); margin:0 auto 12px;"></div>
      <h2 id="sheet-title" class="syne text-white" style="font-size:1.1rem; font-weight:800; line-height:1.25;">${esc(s.title)}</h2>
      <p class="text-sm" style="color:rgba(255,255,255,0.72); margin:4px 0 14px; line-height:1.45;">${esc(dayLabel(s.date))}, ${esc(shortDate(s.date))} · ${esc(s.time)} Uhr<br>${esc(c.name)}, ${esc(c.city)}${s.version !== 'DF' ? ` · <span style="color:#fde68a;">${esc(VERSION_LABEL[s.version] || s.version)}</span>` : ''}</p>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
        <button type="button" data-sheet="bookmarked" aria-pressed="${st === 'bookmarked'}" class="sheet-btn" style="border:1px solid rgba(244,114,182,${st === 'bookmarked' ? 0.7 : 0.35}); background:rgba(244,114,182,${st === 'bookmarked' ? 0.3 : 0.12}); color:#f9a8d4;">♡ ${st === 'bookmarked' ? 'Gemerkt' : 'Merken'}</button>
        <button type="button" data-sheet="going" aria-pressed="${st === 'going'}" class="sheet-btn" style="border:1px solid rgba(52,211,153,${st === 'going' ? 0.7 : 0.35}); background:rgba(52,211,153,${st === 'going' ? 0.28 : 0.1}); color:#6ee7b7;">✓ ${st === 'going' ? 'Dabei' : 'Bin dabei'}</button>
        ${ticket ? `<a href="${esc(ticket)}" target="_blank" rel="noopener" data-sheet="ticket" class="sheet-btn" style="grid-column:1 / -1; ${PRIMARY_BG} border:1px solid rgba(251,191,36,0.4);">${ICON.ticket} Tickets</a>` : ''}
        <button type="button" data-sheet="ics" class="sheet-btn btn-glass">${ICON.apple} Kalender</button>
        <button type="button" data-sheet="gcal" class="sheet-btn btn-glass">${ICON.google} Kalender</button>
      </div>
      <button type="button" data-close-sheet class="w-full text-sm" style="min-height:44px; margin-top:6px; background:none; border:none; color:rgba(255,255,255,0.7); cursor:pointer;">Schließen</button>
    </div>`
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('sheet-open')))
  root.querySelector('[data-sheet]')?.focus({ preventScroll: true })
}

function closeSheet() {
  if (!sheetId) return
  sheetId = null
  const root = document.getElementById('sheet-root')
  root.classList.remove('sheet-open')
  setTimeout(() => { if (!sheetId) root.innerHTML = '' }, 230)
  if (sheetOpener?.isConnected) sheetOpener.focus({ preventScroll: true })
  sheetOpener = null
}

function sheetAction(action) {
  const id = sheetId
  const s = byId.get(id)
  if (!s) return closeSheet()
  closeSheet()
  if (action === 'bookmarked' || action === 'going') setStatus(id, statusOf(id) === action ? 'none' : action)
  else if (action === 'ics') downloadIcs(s)
  else if (action === 'gcal') openGoogleCalendar(s)
}

// ── Merken / Dabei ────────────────────────────────────────────────────────────────────────────

// Eine Vorstellung ist entweder gemerkt oder "dabei" (oder keins von beiden)
function setStatus(id, next, { undoable = true } = {}) {
  if (!currentUser) {
    showToast('Bitte anmelden', 'Zum Merken melde Dich oben mit Deiner E-Mail an.')
    window.scrollTo({ top: 0, behavior: 'smooth' })
    return
  }
  id = String(id)
  const before = statusOf(id)
  if (before === next) return
  bookmarked = bookmarked.filter(x => x !== id)
  going = going.filter(x => x !== id)
  if (next === 'bookmarked') bookmarked.push(id)
  if (next === 'going') going.push(id)
  saveMarks()
  if (before !== 'none') setBookmark(id, before, false)
  if (next !== 'none') setBookmark(id, next, true)
  paintStatus(id)
  if (next !== 'none') clearTypedSearch()
  if (undoable) offerUndo(id, before)
}

// Alle Chips dieser Vorstellung (Liste, Kalender, Gemerkt) und das Badge im Reiter auffrischen
function paintStatus(id) {
  const s = byId.get(String(id))
  if (!s) return
  const st = statusOf(id)
  document.querySelectorAll(`[data-show="${CSS.escape(String(id))}"]`).forEach(chip => {
    chip.dataset.st = st
    chip.innerHTML = chipInner(s, st)
    chip.setAttribute('aria-label', chipLabel(s, st))
  })
  if (currentView === 'gemerkt') renderView()
  refreshBottomNav()
}

function paintAllStatuses() {
  document.querySelectorAll('[data-show]').forEach(chip => {
    const s = byId.get(chip.dataset.show)
    if (!s) return
    const st = statusOf(s.id)
    if (chip.dataset.st === st) return
    chip.dataset.st = st
    chip.innerHTML = chipInner(s, st)
    chip.setAttribute('aria-label', chipLabel(s, st))
  })
  if (currentView === 'gemerkt') renderView()
  refreshBottomNav()
}

// Rückmeldung mit "Rückgängig" nach jeder Statusänderung: stellt den vorherigen Status wieder her
function offerUndo(id, before) {
  const s = byId.get(id)
  const name = s.title.length > 24 ? s.title.slice(0, 23) + '…' : s.title
  const now = statusOf(id)
  const text = now === 'bookmarked' ? `♡ Gemerkt: ${name}, ${s.time}` : now === 'going' ? `✓ Dabei: ${name}, ${s.time}` : before === 'going' ? 'Nicht mehr dabei' : 'Nicht mehr gemerkt'
  showUndoToast(text, () => setStatus(id, before, { undoable: false }))
}

let undoToastEl = null, undoToastTimer = null
function showUndoToast(text, onUndo) {
  undoToastEl?.remove()
  clearTimeout(undoToastTimer)
  const el = document.createElement('div')
  el.setAttribute('role', 'status')
  el.style.cssText = 'position:fixed; left:50%; transform:translateX(-50%); bottom:calc(74px + env(safe-area-inset-bottom, 0px)); width:min(92vw,420px); z-index:60; display:flex; align-items:center; gap:8px; padding:2px 2px 2px 16px; background:rgba(34,10,18,0.98); border:1px solid rgba(251,191,36,0.4); border-radius:14px; box-shadow:0 12px 36px rgba(0,0,0,0.6); color:white; font-size:13px;'
  el.innerHTML = `<span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(text)}</span><button type="button" style="height:44px; padding:0 14px; background:none; border:none; color:#fcd34d; font-weight:700; cursor:pointer; flex-shrink:0;">Rückgängig</button>`
  el.querySelector('button').addEventListener('click', () => { el.remove(); onUndo() })
  document.body.appendChild(el)
  undoToastEl = el
  undoToastTimer = setTimeout(() => el.remove(), 4500)
}

function showToast(title, body, duration = 2500) {
  const el = document.createElement('div')
  el.setAttribute('role', 'status')
  el.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:min(90vw,420px); z-index:9999; background:rgba(34,10,18,0.98); border:1px solid rgba(251,191,36,0.4); border-left:4px solid #e11d48; color:white; border-radius:16px; padding:18px 20px; font-size:14px; box-shadow:0 25px 60px rgba(0,0,0,0.7); cursor:pointer;'
  el.innerHTML = `<strong class="syne" style="color:#fcd34d; font-size:15px;">${esc(title)}</strong><br><span style="color:rgba(255,255,255,0.85);">${esc(body)}</span>`
  el.addEventListener('click', () => el.remove())
  document.body.appendChild(el)
  setTimeout(() => el.remove(), duration)
}

// ── Kalender-Export und Teilen ────────────────────────────────────────────────────────────────

function downloadIcs(s) {
  const c = cinemasById.get(s.locationId)
  const start = localDate(s.date, s.time)
  const end = new Date(start.getTime() + 2 * 3600e3)   // Laufzeit unbekannt: 2 Stunden
  const fmt = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const url = safeUrl(s.ticketUrl)
  // UID/DTSTAMP sind nach RFC 5545 Pflicht - ohne sie lehnen manche Kalender den Import ab
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CINELORDS//DE', 'BEGIN:VEVENT', `UID:${s.id}@cinelords`, `DTSTAMP:${stamp}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(end)}`, `SUMMARY:${icsEscape(s.title)}`, `LOCATION:${icsEscape(c.name)}\\, ${icsEscape(c.city)}`, ...(url ? [`URL:${url}`] : []), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n')
  const blobUrl = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }))
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = `${s.title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60)}.ics`
  a.click()
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10000)   // iOS lädt asynchron, sonst tote URL
}

function openGoogleCalendar(s) {
  const c = cinemasById.get(s.locationId)
  const start = localDate(s.date, s.time)
  const end = new Date(start.getTime() + 2 * 3600e3)
  const utc = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  window.open(`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(s.title)}&dates=${utc(start)}/${utc(end)}&location=${encodeURIComponent(c.name + ', ' + c.city)}&details=${encodeURIComponent(safeUrl(s.ticketUrl))}`, '_blank', 'noopener')
}

async function share(title, text) {
  const url = location.origin + location.pathname
  if (navigator.share) { try { await navigator.share({ title, text, url }) } catch {} return }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); showToast('Kopiert', 'Der Text liegt in der Zwischenablage.') } catch {}
}

function shareCard(key) {
  const card = buildCards(upcomingFiltered().filter(s => s.date + '|' + s.filmKey === key))[0]
  if (!card) return
  const rows = new Map()
  for (const s of card.shows) (rows.get(s.locationId) || rows.set(s.locationId, []).get(s.locationId)).push(s.time + (s.version !== 'DF' ? ' ' + s.version : ''))
  share(card.title, `${card.title} – ${dayLabel(card.date)}, ${shortDate(card.date)}\n${[...rows].map(([loc, t]) => `${cinemasById.get(loc).name}: ${t.join(', ')}`).join('\n')}`)
}

function shareShow(id) {
  const s = byId.get(String(id))
  if (s) share(s.title, `${s.title} – ${shortDate(s.date)}, ${s.time} Uhr, ${cinemasById.get(s.locationId).name}${s.version !== 'DF' ? ' (' + s.version + ')' : ''}`)
}

// ── Suche: leert sich selbst (ohne Treffer nach 2 s, mit Treffern nach 8 s ohne Eingabe/Berührung) ────

const SEARCH_MISS_CLEAR_MS = 2000
const SEARCH_IDLE_CLEAR_MS = 8000
let searchAutoClearTimer = null, searchClearMs = 0, searchTyped = false, searchDebounceTimer = null

function armSearchAutoClear(recheck = true) {
  clearTimeout(searchAutoClearTimer)
  if (!searchTyped || !filters.search) return
  if (recheck) searchClearMs = upcomingFiltered().length ? SEARCH_IDLE_CLEAR_MS : SEARCH_MISS_CLEAR_MS
  searchAutoClearTimer = setTimeout(clearTypedSearch, searchClearMs)
}

function clearTypedSearch() {
  clearTimeout(searchAutoClearTimer)
  if (!searchTyped || !filters.search) return
  searchTyped = false
  setSearch('')
}

function setSearch(value) {
  filters.search = value
  const input = document.getElementById('search-input')
  if (input && input.value !== value) input.value = value
  const clearBtn = document.getElementById('search-clear')
  if (clearBtn) clearBtn.style.display = value ? 'flex' : 'none'
  if (currentView !== 'gemerkt') renderView()
}

function commitSearch(keepFocus) {
  clearTimeout(searchDebounceTimer)
  const input = document.getElementById('search-input')
  if (!keepFocus) input?.blur()
  setSearch(input ? input.value.trim() : '')
  searchTyped = !!filters.search
  armSearchAutoClear()
}

// ── Ereignisse (zentral über Delegation, damit nach jedem Neuzeichnen nichts neu gebunden werden muss) ──

function switchView(view) {
  const now = Date.now()
  const doubleTap = lastNavTap.view === view && now - lastNavTap.at < 400
  lastNavTap = { view, at: now }
  if (currentView === view) {
    if (doubleTap && view === 'kalender') { calendarOffset = 0; renderView() }
    if (doubleTap) window.scrollTo(0, 0)
    return
  }
  currentView = view
  renderView()
  refreshBottomNav()
  window.scrollTo(0, 0)
}

function onClick(e) {
  const t = e.target.closest('button, a, [data-close-sheet]')
  if (!t) return
  const d = t.dataset
  if (d.show) return openSheet(d.show, t)
  if (d.sheet) return sheetAction(d.sheet)
  if ('closeSheet' in d) return closeSheet()
  if (d.nav) return switchView(d.nav)
  if (d.gotoView) return switchView(d.gotoView)
  if (d.shareCard) return shareCard(d.shareCard)
  if (d.shareShow) return shareShow(d.shareShow)
  if (d.city) { filters.city = d.city; filters.cinemaId = 'alle'; return refreshFilters() }
  if (d.version) { filters.version = d.version; return refreshFilters() }
  if (d.date) { filters.dates = filters.dates.includes(d.date) ? filters.dates.filter(x => x !== d.date) : [...filters.dates, d.date]; return renderView() }
  if ('calPrev' in d) { calendarOffset--; return renderView() }
  if ('calNext' in d) { calendarOffset++; return renderView() }
  if ('calToday' in d) { calendarOffset = 0; return renderView() }
  if ('clearDates' in d) { filters.dates = []; return renderView() }
  if ('resetFilters' in d) { filters.cinemaId = 'alle'; filters.version = 'alle'; filters.search = ''; searchTyped = false; return refreshFilters() }
  if ('dismissTip' in d) { saveData('tipSeen', true); t.closest('[data-first-tip]')?.remove(); return }
  if ('openHelp' in d) return openHelp()
  if ('closeHelp' in d) return closeHelp()
  if (t.id === 'search-clear') { clearTimeout(searchDebounceTimer); clearTimeout(searchAutoClearTimer); searchTyped = false; return setSearch('') }
  if (t.id === 'login-btn') return sendCode(t)
  if (t.id === 'verify-btn') return verifyCode(t)
  if (t.id === 'logout-btn') return logout()
}

function refreshFilters() {
  const bar = document.getElementById('filter-bar-wrap')
  if (bar) bar.innerHTML = renderFilters()
  renderView()
}

async function sendCode(btn) {
  const email = document.getElementById('login-email').value.trim()
  const hint = document.getElementById('login-hint')
  if (!email) { hint.textContent = 'Bitte E-Mail eingeben.'; return }
  btn.textContent = 'Sende...'; btn.disabled = true; btn.style.opacity = '0.5'; hint.textContent = ''
  if (await signInWithEmail(email)) {
    btn.classList.add('btn-sweep')
    setTimeout(() => {
      document.getElementById('login-step-1').style.display = 'none'
      document.getElementById('login-step-2').style.display = 'block'
      document.getElementById('login-code')?.focus()
    }, 500)
  } else {
    btn.textContent = 'Code senden'; btn.disabled = false; btn.style.opacity = '1'
    hint.textContent = 'Fehler beim Senden — bitte nochmal versuchen.'
  }
}

async function verifyCode(btn) {
  let email = ''
  try { email = localStorage.getItem('cine-email') || '' } catch {}
  email ||= document.getElementById('login-email')?.value.trim()
  const code = document.getElementById('login-code').value.trim()
  const hint = document.getElementById('verify-hint')
  if (!code) return
  btn.textContent = 'Prüfe...'; btn.disabled = true; btn.style.opacity = '0.5'; hint.textContent = ''
  if (await verifyOtp(email, code)) {
    btn.classList.add('btn-sweep')
    currentUser = await getUser()
    const bm = await loadBookmarks()
    if (bm) { going = bm.going; bookmarked = bm.bookmarked.filter(id => !going.includes(id)); saveMarks() }
    setTimeout(render, 500)
  } else {
    btn.textContent = 'Bestätigen'; btn.disabled = false; btn.style.opacity = '1'
    hint.textContent = 'Falscher oder abgelaufener Code — bitte nochmal versuchen.'
  }
}

async function logout() {
  await signOut()
  // Nutzerdaten nicht stehen lassen (geteiltes Gerät)
  currentUser = null
  bookmarked = []
  going = []
  saveMarks()
  render()
}

let globalsBound = false
function bindGlobals() {
  if (globalsBound) return
  globalsBound = true
  document.addEventListener('click', onClick)
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (sheetId) closeSheet(); else if (helpOpen) closeHelp() }
    if (e.key === 'Enter' && e.target.id === 'search-input') { e.preventDefault(); commitSearch(false) }
    if (e.key === 'Enter' && e.target.id === 'login-email') document.getElementById('login-btn')?.click()
    if (e.key === 'Enter' && e.target.id === 'login-code') document.getElementById('verify-btn')?.click()
  })
  document.addEventListener('click', e => { if (helpOpen && e.target.id === 'modal-help') closeHelp() })
  document.addEventListener('input', e => {
    if (e.target.id !== 'search-input') return
    document.getElementById('search-clear').style.display = e.target.value ? 'flex' : 'none'
    clearTimeout(searchAutoClearTimer)
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = setTimeout(() => commitSearch(true), 1000)
  })
  document.addEventListener('change', e => {
    if (e.target.id === 'cinema-select') { filters.cinemaId = e.target.value; renderView() }
  })
  // Jede Eingabe oder Berührung startet die 8 Sekunden neu (nur bei einer Suche mit Treffern)
  const onActivity = () => { if (searchTyped && searchClearMs === SEARCH_IDLE_CLEAR_MS) armSearchAutoClear(false) }
  for (const type of ['touchstart', 'pointerdown', 'keydown', 'scroll']) document.addEventListener(type, onActivity, { passive: true, capture: true })
  // Kopfzeile blendet beim Scrollen aus; unten kein Zurückfedern, oben bleibt es für "Ziehen zum Aktualisieren"
  window.addEventListener('scroll', () => {
    const hdr = document.getElementById('app-header')
    if (hdr) hdr.style.opacity = String(Math.max(0, 1 - window.scrollY / 90))
    document.documentElement.style.overscrollBehaviorY = window.scrollY > 40 ? 'none' : 'auto'
  }, { passive: true })
  bindPullToRefresh()
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'films-updated') applyFilmsUpdate().catch(() => {}) })
  }
}

function bindPullToRefresh() {
  let start = 0, pulling = false
  document.addEventListener('touchstart', e => {
    if (window.scrollY === 0 && !sheetId && !helpOpen) { start = e.touches[0].clientY; pulling = true }
  }, { passive: true })
  document.addEventListener('touchmove', e => {
    if (!pulling) return
    const diff = e.touches[0].clientY - start
    const ind = document.getElementById('ptr-indicator')
    if (ind && diff > 0) ind.style.height = Math.min(diff / 2, 50) + 'px'
  }, { passive: true })
  document.addEventListener('touchend', async e => {
    if (!pulling) return
    pulling = false
    const ind = document.getElementById('ptr-indicator')
    if (e.changedTouches[0].clientY - start <= 80) { if (ind) ind.style.height = '0'; return }
    if (ind) ind.textContent = '↻ Wird aktualisiert...'
    const seq = ++fetchSeq
    const [list, bm] = await Promise.all([getFilms(), currentUser ? loadBookmarks().catch(() => null) : null])
    if (seq === fetchSeq) {
      if (list.length) setScreenings(list)
      if (bm) { going = bm.going; bookmarked = bm.bookmarked.filter(id => !going.includes(id)); saveMarks() }
      titleAnimated = false
      document.getElementById('app-header')?.remove()   // sonst behält render() den alten Header und der Glow läuft nicht erneut
      render()
    }
    if (ind) { ind.style.height = '0'; ind.textContent = '↻ Aktualisieren...' }
  }, { passive: true })
}

// ── Start ─────────────────────────────────────────────────────────────────────────────────────

// Login prüfen und Merkliste aus Supabase holen, ohne dass der Start darauf wartet
async function loadAccountData() {
  const user = await getUser()
  const loginChanged = !!user !== !!currentUser
  currentUser = user
  if (user) {
    const bm = await loadBookmarks()
    if (bm) { going = bm.going; bookmarked = bm.bookmarked.filter(id => !going.includes(id)); saveMarks() }
  } else if (loginChanged) {
    bookmarked = []; going = []; saveMarks()
  }
  if (loginChanged) render()   // Anmeldung abgelaufen (oder neu): Kopf und Merkliste ändern sich
  else if (user) paintAllStatuses()
}

// Beim Start steht die zuletzt gespeicherte Liste (sw.js); kommt im Hintergrund eine neuere, wird sie hier übernommen.
// Neu gezeichnet wird nur, wenn dabei nichts Laufendes stört (Scrollposition, offenes Menü, Eingaben).
async function applyFilmsUpdate() {
  if (!appReady) { filmsUpdatePending = true; return }
  filmsUpdatePending = false
  const list = await getFilms()
  if (!list.length) return
  setScreenings(list)
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  if (window.scrollY < 80 && !sheetId && !helpOpen && !typing && !filters.search) render()
}

export async function renderApp(el) {
  if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
  window.scrollTo(0, 0)
  el.innerHTML = `
    <div id="ptr-indicator" style="text-align:center; height:0; overflow:hidden; transition:height 0.2s; color:rgba(255,255,255,0.65); font-size:13px; display:flex; align-items:center; justify-content:center;">↻ Aktualisieren...</div>
    <div class="noise app-bg min-h-screen">
      <div style="position:fixed; top:-10%; left:-10%; width:50vw; height:50vw; background:radial-gradient(circle, rgba(225,29,72,0.1) 0%, transparent 70%); pointer-events:none; z-index:0;"></div>
      <div style="position:fixed; bottom:-10%; right:-10%; width:40vw; height:40vw; background:radial-gradient(circle, rgba(245,158,11,0.09) 0%, transparent 70%); pointer-events:none; z-index:0;"></div>
      <div id="app-inner" class="relative z-10 max-w-xl mx-auto px-4 pb-28"></div>
    </div>
    <div id="modal-root"></div>
    <div id="sheet-root"></div>
    <div id="bottom-nav" style="position:fixed; bottom:0; left:0; right:0; z-index:40;"></div>`
  bindGlobals()
  // Schriften schon während des Intros laden (sonst erscheinen die Texte erst nach dem Ausblenden)
  new Promise(done => {
    const load = () => Promise.all(['700 16px Syne', '800 16px Syne', '400 16px "DM Sans"', '500 16px "DM Sans"'].map(f => document.fonts.load(f))).then(done, done)
    const css = document.querySelector('link[href*="fonts.googleapis"]')
    if (!css || css.sheet) load()
    else css.addEventListener('load', load, { once: true })
  })
  // Das Intro (index.html) steht konstant 2 s; bis dahin müssen nur die Filme da sein (aus dem Gerätespeicher, sw.js).
  // Login und Merkliste laden danach im Hintergrund (loadAccountData).
  currentUser = peekUser()
  setScreenings(await getFilms())
  if (seenStored === null) saveData('seenFilms', [...new Set(screenings.map(s => s.filmKey))])   // erster Start: nicht alles als NEU zeigen
  try { sessionStorage.setItem('cine-loaded', '1') } catch {}
  // Tailwind (CDN, async) kurz abwarten, sonst blitzt die Seite unformatiert auf; höchstens 0,3 s
  for (let i = 0; !window.tailwind && i < 6; i++) await new Promise(r => setTimeout(r, 50))
  render()
  requestAnimationFrame(() => window.scrollTo(0, 0))
  appReady = true
  // Intro erst ausblenden, wenn die Seite wieder flüssig Bilder liefert (3 Bilder < 50 ms), höchstens 1 s
  const settle = (last, smooth, until) => requestAnimationFrame(t => {
    smooth = t - last < 50 ? smooth + 1 : 0
    if (smooth >= 3 || t > until) window.__introRelease?.()
    else settle(t, smooth, until)
  })
  requestAnimationFrame(t => settle(t, 0, t + 1000))
  if (filmsUpdatePending) applyFilmsUpdate()
  loadAccountData().catch(() => {})
}
