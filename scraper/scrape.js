// CineLords-Scraper: liest das Programm der Kinos in Berlin und Leipzig und schreibt public/films.json
// (eine Zeile pro Vorstellung, die App gruppiert nach filmKey + Datum). Aufruf: node scraper/scrape.js [quelle]
import fs from 'fs'
import path from 'path'
import * as cheerio from 'cheerio'
import puppeteer from 'puppeteer'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const DAYS_AHEAD = 14

// ─── Hilfsfunktionen ────────────────────────────────────────────────────────

function today() { return berlinDate(new Date()) }
function berlinDate(d) { return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }) }
function lastDay() { return berlinDate(new Date(Date.now() + DAYS_AHEAD * 864e5)) }

async function fetchText(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'user-agent': UA, 'accept-language': 'de-DE,de;q=0.9', ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  return r.text()
}

// "So., 22.11." / "22.11.2026" / "Heute" -> YYYY-MM-DD; Jahr ohne Angabe: das nächste passende
function parseDate(str) {
  const s = String(str).trim().toLowerCase()   // Monatsnamen ("21. November 2026", "6 Nov. 26") zu Zahlen
    .replace(/(\d{1,2})\.?\s*(jan|feb|mär|mar|apr|mai|jun|jul|aug|sep|okt|nov|dez)[a-zä]*\.?\s*/, (_, d, m) => `${d}.${['jan', 'feb', 'mär', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dez'].indexOf(m === 'mar' ? 'mär' : m) + 1}.`)
  if (/^heute/.test(s)) return today()
  if (/^morgen/.test(s)) return berlinDate(new Date(Date.now() + 864e5))
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const m = s.match(/(\d{1,2})\.\s*(\d{1,2})(?:\.(?:\s*(\d{4}|\d{2}(?!:)))?)?/)
  if (!m) return null
  const t = today(), y0 = +t.slice(0, 4)
  let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : y0
  const d = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  if (!m[3] && d < berlinDate(new Date(Date.now() - 60 * 864e5))) y++   // "05.01." im Dezember = nächstes Jahr
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

function parseTime(str) {
  const m = String(str).match(/(\d{1,2})[:.](\d{2})/)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null
}

// Sprachfassung aus Zusätzen wie "(OmU)", "OV", "OmeU", "Original mit Untertiteln"; sonst deutsche Fassung
function detectVersion(...texts) {
  const t = texts.filter(Boolean).join(' ')
  if (/\bom\s*e(ng)?\.?\s*u\b|\bomeu\b|\bom\s*engl|english\s+subtitles|engl(ische[n]?|\.)?\s*(ut|untertitel)/i.test(t)) return 'OmeU'
  if (/\bomdu\b|\bomu\b|\bom\s*u\b|\bom\s*dt|\bo\.\s*m\.\s*u\b|original\s*(fassung)?\s*(mit|\()\s*(deutschen\s*)?untertitel|deutsche[n]?\s+untertitel/i.test(t)) return 'OmU'
  if (/\bov\b|\bof\b|\bo\.v\.|original\s*version|originalfassung/i.test(t)) return 'OV'
  return 'DF'
}

// Titel ohne Fassungs-/Format-Zusätze; filmKey = normalisierte Form davon (gruppiert Kinos und Fassungen)
// ov/of/df sind auch englische Wörter ("Of Mice and Men"): nur in Klammern oder am Titelende entfernen
const TITLE_NOISE = /\s*[([]?\b(omu|omdu|omeu|om\s*e?\.?\s*u|o\.v\.|3d|2d|imax|dolby\s*atmos)\b[)\]]?\s*|\s*[([](ov|of|df)[)\]]\s*|\s+(ov|of|df|o\.v\.)\s*$/gi
const FSK = /\s*[-–,]?\s*\b(ausverkauft|ab\s*\d{1,2}(\s*j(ahren)?)?)\s*$/i
function cleanTitle(title) {
  return String(title || '').replace(/\s*\((wa:?\s*\d{4}|\d{4}|[^()]*\b(ut|untertitel|subtitles|fsk\s*folgt))\)/gi, ' ').replace(/\s*\([A-Z]{2,3}\)\s*$/, '')
    .replace(TITLE_NOISE, ' ').replace(FSK, '').replace(TITLE_NOISE, ' ').replace(/\s*[-–|:]\s*$/, '').replace(/\s+/g, ' ').trim()
}
function filmKey(title) {
  return cleanTitle(title).toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // é, ç, ñ … ohne Akzent
    .replace(/\(\d{4}\)/g, '').replace(/^(der|die|das|the)\s+/, '')
    .replace(/[^a-z0-9]+/g, '')
}

// Kinotitel kommen oft in Versalien ("BARRIO TRISTE"): zu "Barrio Triste" umwandeln, gemischte Schreibung bleibt
function niceTitle(title) {
  const t = cleanTitle(title)
  if (t !== t.toUpperCase() || !/[A-ZÄÖÜ]{3}/.test(t)) return t
  return t.toLowerCase().replace(/(^|[\s(\-–:"„'/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
}

function stableId(str) {
  const normalized = str.toLowerCase().replace(/[^a-z0-9]/g, '')
  let hash = 0
  for (let i = 0; i < normalized.length; i++) { hash = ((hash << 5) - hash) + normalized.charCodeAt(i); hash |= 0 }
  return Math.abs(hash)
}

let browserP = null
function browser() { return browserP ||= puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] }) }

// ─── Yorck-Gruppe (Next.js-Seite enthält das komplette Programm als JSON) ───────────────────────

const YORCK = { 'Filmtheater am Friedrichshain': 1, 'Kino International': 2, 'Blauer Stern': 3, 'delphi LUX': 21, 'Delphi Filmpalast': 22, 'Kant Kino': 23, Odeon: 24, Passage: 25, 'Neues Off': 26, 'Cinema Paris': 27 }

async function scrapeYorck() {
  const html = await fetchText('https://www.yorck.de/de/filme')
  const data = JSON.parse(html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1])
  const out = []
  for (const f of data.props.pageProps.films) {
    for (const s of f.fields.sessions || []) {
      const x = s.fields, locationId = YORCK[x.cinema?.fields?.name?.trim()]
      if (!locationId) continue
      const fm = (x.formats || []).join(' ')
      out.push({ title: f.fields.title, date: x.startTime.slice(0, 10), time: x.startTime.slice(11, 16), locationId,
        version: /OmeU/.test(fm) ? 'OmeU' : /OmU/.test(fm) ? 'OmU' : /\bOV\b/.test(fm) ? 'OV' : 'DF',
        ticketUrl: `https://www.yorck.de/de/filme/${f.fields.slug}`, source: 'yorck' })
    }
  }
  return out
}

// ─── Kinoheld (Programmseite wird im Browser gerendert, "Mehr laden" bis alles da ist) ──────────

const KINOHELD = [
  ['hackesche-hoefe-kino', 5], ['central-kino', 6], ['lichtblick-kino-berlin', 11], ['b-ware-ladenkino', 14],
  ['tilsiter-lichtspiele-programmkino-berlin', 16], ['kino-intimes-berlin', 17], ['toni-berlin', 18], ['city-kino-wedding-berlin-ab', 10], ['kino-krokodil', 12], ['kino-zukunft-berlin', 15], ['colosseum-filmtheater-berlin', 20],
]

async function scrapeKinoheldCinema(slug, locationId) {
  const url = `https://www.kinoheld.de/kino/berlin/${slug}/vorstellungen`
  const page = await (await browser()).newPage()
  try {
    await page.setUserAgent(UA)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('[data-program-movie]', { timeout: 20000 }).catch(() => {})
    for (let i = 0; i < 15; i++) {   // "Mehr laden" klicken, bis der Knopf weg ist oder das Ende des Zeitraums erreicht ist
      const more = await page.$$eval('button', bs => { const b = bs.find(x => /mehr laden/i.test(x.innerText)); if (b) b.click(); return !!b })
      if (!more) break
      await new Promise(r => setTimeout(r, 1500))
    }
    // Je Uhrzeit ein Link mit eigener Vorstellungs-Adresse; die Fassung steht in den Flags ("OV | Highlight")
    // bzw. als Klammerzusatz im aria-label ("2001: A Space Odyssey (OV)") - nur den Zusatz nehmen, englische Titel enthalten oft "of"
    const shows = await page.$$eval('[data-program-movie]', els => els.flatMap(el => {
      const title = el.querySelector('span')?.innerText || ''
      return [...el.querySelectorAll('[data-movie-playtimes-day-list]')].flatMap(day => {
        const dayLabel = day.querySelector('[data-movie-playtimes-day-list-date]')?.innerText.trim() || ''
        return [...day.querySelectorAll('a[data-show-link]')].map(a => ({
          title, dayLabel, time: a.querySelector('[data-show-link-time]')?.innerText.trim() || '', href: a.href,
          flags: [...a.querySelectorAll('[data-show-link-flag]')].map(f => f.innerText).join(' '),
          labelTag: ((a.getAttribute('aria-label') || '').match(/\(([^()]*)\)\s*$/) || [])[1] || ''
        }))
      })
    }))
    return shows.filter(s => /^\d{1,2}:\d{2}$/.test(s.time)).map(s => ({
      title: s.title, date: parseDate(s.dayLabel), time: parseTime(s.time), locationId,
      version: detectVersion(s.flags, s.labelTag, s.title), ticketUrl: s.href || url, source: 'kinoheld'
    })).filter(s => s.date)
  } finally { await page.close() }
}

async function scrapeKinoheld() {
  const out = []
  for (const [slug, id] of KINOHELD) {
    try {
      let r = await scrapeKinoheldCinema(slug, id)
      if (!r.length) { await new Promise(res => setTimeout(res, 5000)); r = await scrapeKinoheldCinema(slug, id) }   // kinoheld liefert ab und zu eine leere Seite
      console.log(`  kinoheld ${slug}: ${r.length}`); out.push(...r) }
    catch (e) { console.log(`  ⚠️ kinoheld ${slug}: ${e.message}`) }
  }
  return out
}

// ─── Cinetixx (Buchungsseite rendert je Film eine Tabelle: Spalten = Tage, Zeilen = Säle) ─────────

const CINETIXX = [['1627459203', 7], ['1836256128', 8], ['1898834974', 32], ['2348716262', 35], ['1627481494', 36], ['2258131773', 37]]

async function scrapeCinetixxCinema(cinemaId, locationId) {
  const page = await (await browser()).newPage()
  try {
    await page.goto(`https://booking.cinetixx.de/frontend/#/program/${cinemaId}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.row.event h3', { timeout: 20000 })
    const rows = await page.$$eval('.row.event', evs => evs.flatMap(ev => {
      const title = ev.querySelector('h3')?.innerText.trim() || ''
      const lang = [...ev.querySelectorAll('span')].map(s => s.innerText).find(t => /^Sprache:/.test(t)) || ''
      return [...ev.querySelectorAll('table')].flatMap(tb => {
        const days = [...tb.querySelectorAll('thead th')].map(th => th.innerText.trim())
        return [...tb.querySelectorAll('tbody tr')].flatMap(tr => [...tr.children].flatMap((td, i) =>
          [...td.querySelectorAll('.show-hour')].map(s => ({ title, lang, day: days[i], time: s.innerText.trim(), href: s.getAttribute('href') }))))
      })
    }))
    return rows.map(r => ({
      title: r.title.replace(/\s+[A-Za-z]{1,5},\s*ab\s*\d+\s*$/, '').replace(/\s+ab\s*\d+\s*$/, ''),
      date: parseDate(r.day), time: parseTime(r.time), locationId,
      version: detectVersion(r.lang.replace(/^Sprache:\s*/, '').split(',')[0], r.title.match(/\s([A-Za-z]{1,5}),\s*ab\s*\d+\s*$/)?.[1]),
      ticketUrl: r.href ? `https://booking.cinetixx.de/frontend/${r.href}` : `https://booking.cinetixx.de/frontend/#/program/${cinemaId}`, source: 'cinetixx',
    }))
  } finally { await page.close() }
}

async function scrapeCinetixx() {
  const out = []
  for (const [id, loc] of CINETIXX) {
    try { const r = await scrapeCinetixxCinema(id, loc); console.log(`  cinetixx ${id} (${loc}): ${r.length}`); out.push(...r) }
    catch (e) { console.log(`  ⚠️ cinetixx ${id} (${loc}): ${e.message}`) }
  }
  return out
}

// ─── Babylon Mitte (Programmseite: ein .mix-Kasten pro Vorstellung mit data-date) ──────────────

async function scrapeBabylon() {
  const $ = cheerio.load(await fetchText('https://babylonberlin.eu/programm'))
  return $('.mix[data-date]').not('.cat-LIVE-EVENT, .cat-LITERATUR, .cat-ORCHESTER').map((_, el) => {
    const m = $(el), [date, time] = m.attr('data-date').split(' ')
    const intro = m.find('.mix-introtext').text()
    let version = detectVersion(intro)
    if (version === 'DF' && /tag-english-subtitles/.test(m.attr('class'))) version = 'OmeU'
    return { title: m.find('img').attr('alt') || m.find('.mix-title').text(), date, time: time.slice(0, 5), locationId: 4, version,
      ticketUrl: 'https://babylonberlin.eu' + (m.find('a').attr('href') || '/programm'), source: 'babylon' }
  }).get()
}

// ─── Arsenal (Kalender wird per JavaScript gefüllt, daher im Browser rendern) ───────────────────

// Seite im Browser rendern; moreRe: Text eines "Mehr laden"-Knopfs, der geklickt wird, bis er verschwindet
async function renderHtml(url, waitFor, moreRe) {
  const page = await (await browser()).newPage()
  try {
    await page.setUserAgent(UA)
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 20000 })
    for (let i = 0; moreRe && i < 20; i++) {
      const clicked = await page.$$eval('button, a', (bs, src) => {
        const b = bs.find(x => new RegExp(src, 'i').test(x.innerText) && x.offsetParent); if (b) b.click(); return !!b
      }, moreRe.source)
      if (!clicked) break
      await new Promise(r => setTimeout(r, 1500))
    }
    return await page.content()
  } finally { await page.close() }
}

async function scrapeArsenal() {
  const $ = cheerio.load(await renderHtml('https://www.arsenal-berlin.de/kalender/', '.teaser-list__item', /mehr ergebnisse laden/))
  return $('.teaser-list__item').map((_, el) => {
    const m = $(el), ticket = m.find('a[href*="ticket"], a[href*="booking"]').attr('href')
    if (!ticket || /foyer/i.test(m.find('.teaser-list__info-text').text())) return null   // nur Vorführungen im Saal
    const when = m.find('.teaser-list__date').text()
    return { title: m.find('.teaser-list__title').text().trim(), date: parseDate(when), time: parseTime(when.replace(/^.*?\d{1,2}\.\d{1,2}\.\s*/, '')), locationId: 9,
      version: detectVersion(m.find('.teaser-list__label').text()), ticketUrl: ticket, source: 'arsenal' }
  }).get().filter(Boolean)
}

// ─── Brotfabrik (WordPress "The Events Calendar": öffentliche REST-Schnittstelle, Kategorie kino) ─

async function scrapeBrotfabrik() {
  const out = []
  for (let p = 1; p <= 5; p++) {
    const u = `https://brotfabrik-berlin.de/wp-json/tribe/events/v1/events?categories=kino&per_page=50&page=${p}&start_date=${today()}&end_date=${lastDay()}`
    const j = JSON.parse(await fetchText(u))
    for (const e of j.events || []) {
      const text = s => cheerio.load(s || '').text()
      out.push({ title: text(e.title), date: e.start_date.slice(0, 10), time: e.start_date.slice(11, 16), locationId: 19,
        version: detectVersion(text(e.title), text(e.excerpt)), ticketUrl: e.url, source: 'brotfabrik' })
    }
    if (p >= (j.total_pages || 1)) break
  }
  return out
}

// ─── Passage Kinos Leipzig (Terminseite: eine Zeile pro Vorstellung, Fassung als Symbol mit Tooltip) ─

async function scrapePassage() {
  const $ = cheerio.load(await fetchText('https://www.passage-kinos.de/termine'))
  return $('.timetable-border-bottom').map((_, el) => {
    const r = $(el), dt = r.find('time[datetime]').attr('datetime') || ''   // "21.11.2026 18:00:00"
    const film = r.find('a.block').not('.button-pk').first()
    const tips = r.find('[data-tooltip]').map((_, i) => $(i).attr('data-tooltip')).get().join(' ')
    return { title: film.text() || r.find('a.button-pk').text(), date: parseDate(dt), time: parseTime(dt.slice(11)), locationId: 31,
      version: detectVersion(tips, r.find('a.button-pk').text()), ticketUrl: 'https://www.passage-kinos.de' + (film.attr('href') || '/termine'), source: 'passage' }
  }).get()
}

// ─── Cineding Leipzig (WordPress "Events Manager", gruppierte Liste auf /programm) ───────────────

async function scrapeCineding() {
  const $ = cheerio.load(await fetchText('https://www.cineding-leipzig.de/programm/'))
  return $('.em-events-list-grouped').first().find('.em-event').map((_, el) => {
    const e = $(el), a = e.find('a[href*="/veranstaltungen/"]').filter((_, x) => $(x).closest('h2, h3').length).first()
    const title = a.text().replace(/\s*\+\s*((film)?gespräch|q\s*&\s*a).*$/i, '')
    return { title, date: parseDate(e.find('.em-icon-calendar').parent().text()), time: parseTime(e.find('.em-icon-clock').parent().text()), locationId: 33,
      version: detectVersion(a.text()), ticketUrl: a.attr('href'), source: 'cineding' }
  }).get()
}

// ─── Regina Palast Leipzig (kinoleipzig.com: statische Tabelle, jede Uhrzeit ein Link mit data-date/data-time) ─

async function scrapeRegina() {
  const $ = cheerio.load(await fetchText('https://www.kinoleipzig.com/programm'))
  return $('a.btn-time[data-date]').map((_, el) => {
    const a = $(el), title = (a.attr('aria-label') || '').match(/^Ticket für (.+) am \d/)?.[1]
    return { title, date: a.attr('data-date'), time: a.attr('data-time'), locationId: 38,
      version: detectVersion(a.closest('tr').find('th span').text()), ticketUrl: 'https://www.kinoleipzig.com' + a.attr('href'), source: 'regina' }
  }).get()
}

// ─── Schauburg Leipzig (statische Liste: Datum nur beim ersten Eintrag des Tages, Fassung als "(in OmdU)" + <small>) ─

async function scrapeSchauburg() {   // Links relativ zu <base href> = Domain
  const url = 'https://www.schauburg-leipzig.de/kinoprogramm-schauburg-leipzig'
  const $ = cheerio.load(await fetchText(url))
  let date = null
  return $('.item').map((_, el) => {
    const e = $(el), d = e.find('.date-wrapper').first().text().trim()
    if (/\d/.test(d)) date = parseDate(d)
    const a = e.find('.title a').first(), note = a.find('small').text()
    const title = a.clone().children().remove().end().text().replace(/\s*\(in [^)]*\)/i, '')
    return { title, date, time: parseTime(e.find('.time').text()), locationId: 40,
      version: detectVersion(a.text(), note), ticketUrl: a.attr('href') ? new URL(a.attr('href'), 'https://www.schauburg-leipzig.de/').href : url, source: 'schauburg' }
  }).get().filter(s => s.date && s.time)
}

// ─── CineStar (Programmseite zeigt nur Filmkacheln; die Spielzeiten stehen gerendert auf jeder Filmseite) ─

const CINESTAR = [['berlin-kino-in-der-kulturbrauerei', 13], ['kino-berlin-cubix-am-alexanderplatz', 28], ['kino-leipzig', 39]]

async function scrapeCinestarCinema(slug, locationId) {
  const page = await (await browser()).newPage()
  try {
    await page.setUserAgent(UA)
    await page.setRequestInterception(true)
    page.on('request', r => ['image', 'media', 'font'].includes(r.resourceType()) ? r.abort() : r.continue())
    await page.goto(`https://www.cinestar.de/${slug}`, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.ShowTile', { timeout: 20000 })
    const films = await page.$$eval('.ShowTile a.image', as => [...new Set(as.map(a => a.href))])
    const out = []
    for (const url of films) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
        await page.waitForFunction(() => /Spielzeiten wählen/.test(document.body.innerText), { timeout: 15000 })
        const { title, text } = await page.evaluate(() => ({ title: document.querySelector('h1')?.innerText || '', text: document.body.innerText }))
        const block = text.split(/Spielzeiten wählen[^\n]*/)[1]?.split(/\nKinotag|\nDie Spielzeiten werden|\nFilm-Details/)[0] || ''
        let date = null, fmt = ''
        for (const l of block.split('\n').map(s => s.trim()).filter(Boolean)) {
          if (/^(heute|morgen)$|^[a-z]{2},?\s*\d{1,2}\.\d{1,2}\.?$/i.test(l)) { date = parseDate(l); fmt = ''; continue }
          if (/^\d{1,2}:\d{2}$/.test(l)) { if (date) out.push({ title, date, time: parseTime(l), locationId, version: detectVersion(fmt), ticketUrl: url, source: 'cinestar' }); continue }
          fmt = l   // "2D", "OV", "Original (Untertitel)" … gilt für die folgenden Zeiten
        }
      } catch (e) { console.log(`  ⚠️ cinestar ${url}: ${e.message}`) }
    }
    return out
  } finally { await page.close() }
}

async function scrapeCinestar() {
  const out = []
  for (const [slug, id] of CINESTAR) {
    try { const r = await scrapeCinestarCinema(slug, id); console.log(`  cinestar ${slug}: ${r.length}`); out.push(...r) }
    catch (e) { console.log(`  ⚠️ cinestar ${slug}: ${e.message}`) }
  }
  return out
}

// ─── CineMotion Hohenschönhausen (Programmseite rendert per JS; "Alle Vorstellungen" zeigt alle Tage) ─

// ─── Zoo Palast (premiumkino, Angular): je Tag ein Datums-Reiter (data-iso), je Film eine app-movie-box ─
// kinoheld führt für den Zoo Palast nur Sonder- und Vorverkaufstermine, daher die öffentliche Programmseite selbst.

async function scrapeZooPalast() {
  const base = 'https://zoopalast.premiumkino.de', page = await (await browser()).newPage()
  try {
    await page.setUserAgent(UA)
    await page.setViewport({ width: 1300, height: 1000 })
    await page.goto(base + '/programm', { waitUntil: 'networkidle2', timeout: 60000 })
    await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /ablehnen|nur notwendige/i.test(b.innerText))?.click())
    await page.waitForSelector('swiper-slide[data-iso]', { timeout: 20000 })
    const from = today().replace(/-/g, ''), to = lastDay().replace(/-/g, '')
    const days = (await page.$$eval('swiper-slide[data-iso]', ss => ss.map(s => s.dataset.iso))).filter(d => d >= from && d <= to)
    const out = []
    const grab = () => page.$$eval('app-movie-box', boxes => boxes.flatMap(b => {
      const title = b.querySelector('h3')?.innerText.trim() || '', href = b.querySelector('a[href^="/film/"]')?.getAttribute('href') || ''
      return [...b.querySelectorAll('app-movie-performance-button')].map(pb => {
        const lines = [...pb.querySelectorAll('button > div')].map(d => d.innerText.trim())
        return { title, href, time: lines.find(l => /^\d{1,2}:\d{2}$/.test(l)) || '', flags: lines.slice(-1)[0] || '' }
      })
    }))
    // Die Seite scrollt nicht das Fenster, sondern einen inneren Container (den größten scrollbaren)
    const scroll = by => page.evaluate(by => {
      const el = [...document.querySelectorAll('*')].filter(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 10)
        .sort((a, b) => b.clientHeight - a.clientHeight)[0] || document.scrollingElement
      if (by === 0) el.scrollTop = 0; else el.scrollTop += by
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 5
    }, by)
    for (const iso of days) {
      await scroll(0)
      await page.evaluate(d => document.querySelector(`swiper-slide[data-iso="${d}"]`)?.click(), iso)
      await new Promise(r => setTimeout(r, 1500))
      // Die Filmliste lädt erst beim Scrollen nach: bis ans Ende scrollen und unterwegs alles einsammeln
      const seen = new Map()
      for (let i = 0, idle = 0; i < 60 && idle < 3; i++) {
        const before = seen.size
        for (const r of await grab()) seen.set(`${r.title}|${r.time}|${r.flags}`, r)
        const atEnd = await scroll(800)
        await new Promise(r => setTimeout(r, 700))
        idle = seen.size === before && atEnd ? idle + 1 : 0
      }
      const rows = [...seen.values()]
      const date = `${iso.slice(0, 4)}-${iso.slice(4, 6)}-${iso.slice(6)}`
      out.push(...rows.filter(r => r.title && r.time).map(r => ({ title: r.title, date, time: parseTime(r.time), locationId: 30,
        version: detectVersion(r.flags), ticketUrl: r.href ? base + r.href : base + '/programm', source: 'zoopalast' })))
    }
    return out
  } finally { await page.close() }
}

async function scrapeCinemotion() {
  const url = 'https://berlin.cinemotion-kino.de/programmuebersicht/'
  const page = await (await browser()).newPage()
  try {
    await page.setUserAgent(UA)
    await page.setViewport({ width: 1300, height: 1000 })
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
    await page.waitForSelector('.movie-item', { timeout: 20000 })
    await page.evaluate(() => [...document.querySelectorAll('a, button')].find(e => /^alle vorstellungen$/i.test(e.innerText.trim()))?.click())
    await page.waitForFunction(() => document.querySelectorAll('.movie-times-item .showtime').length > 0, { timeout: 20000 })
    const rows = await page.$$eval('.movie-item', items => items.flatMap(it => {
      const h2 = it.querySelector('h2.title')
      const title = (h2?.innerText.trim() || h2?.querySelector('img')?.alt || '').replace(/\s*-\s*Logo$/i, '').trim()
      const times = it.querySelector('.movie-times')   // erste Zeitenliste (die zweite ist die Handy-Ansicht)
      return [...(times?.querySelectorAll('.movie-times-item') || [])].flatMap(day => {
        const date = day.querySelector('.date')?.innerText.trim() || ''
        return [...day.querySelectorAll('.show-wrapper')].map(sw => ({
          title, date, time: sw.querySelector('.showtime')?.innerText.trim() || '',
          attrs: [...sw.querySelectorAll('[data-attribute]')].map(a => a.dataset.attribute).join(' '),
        }))
      })
    }))
    return rows.filter(r => r.title && /^\d{1,2}:\d{2}$/.test(r.time)).map(r => ({
      title: r.title, date: parseDate(r.date), time: parseTime(r.time), locationId: 29,
      version: /\bomeu\b/.test(r.attrs) ? 'OmeU' : /\b(omu|subtitled)\b/.test(r.attrs) ? 'OmU' : /\b(ov|of)\b/.test(r.attrs) ? 'OV' : 'DF',
      ticketUrl: url, source: 'cinemotion',
    }))
  } finally { await page.close() }
}

// ─── Ablauf ─────────────────────────────────────────────────────────────────

const SCRAPERS = { cinestar: scrapeCinestar, passage: scrapePassage, cineding: scrapeCineding, regina: scrapeRegina, yorck: scrapeYorck, kinoheld: scrapeKinoheld, cinetixx: scrapeCinetixx, babylon: scrapeBabylon, arsenal: scrapeArsenal, brotfabrik: scrapeBrotfabrik, cinemotion: scrapeCinemotion, schauburg: scrapeSchauburg, zoopalast: scrapeZooPalast }

async function main() {
  const only = process.argv[2]
  const outPath = path.join(process.cwd(), 'public', 'films.json')
  let old = []
  try { old = JSON.parse(fs.readFileSync(outPath, 'utf8')) } catch {}
  let all = []
  for (const [name, fn] of Object.entries(SCRAPERS)) {
    if (only && name !== only) continue
    try { const r = await fn(); console.log(`📽  ${name}: ${r.length} Vorstellungen`); all.push(...r) }
    catch (e) { console.log(`⚠️  ${name}: ${e.message}`) }
  }
  if (browserP) await (await browserP).close()

  const from = today(), to = lastDay()
  all = all.filter(s => s.title && s.date && s.time && s.date >= from && s.date <= to)
    .map(s => ({ ...s, title: niceTitle(s.title), filmKey: filmKey(s.title) }))
  // Kinos ohne Ergebnis (Seite down, Umbau): alte Vorstellungen behalten statt sie verschwinden zu lassen
  const got = new Set(all.map(s => s.locationId))
  const kept = old.filter(s => !got.has(s.locationId) && s.date >= from)
  if (kept.length && !only) console.log(`↩️  ${kept.length} Vorstellungen aus dem letzten Lauf übernommen (Kinos ohne Ergebnis: ${[...new Set(kept.map(s => s.locationId))].join(', ')})`)
  if (only) all.push(...old.filter(s => !got.has(s.locationId) && s.date >= from))
  else all.push(...kept)

  // "Neu"-Markierung pro Film: Datum, an dem der Film zum ersten Mal im Programm stand
  const firstSeen = new Map(old.map(s => [s.filmKey, s.addedAt]))
  const seen = new Set()
  all = all.filter(s => { const k = `${s.locationId}|${s.date}|${s.time}|${s.filmKey}|${s.version}`; return !seen.has(k) && seen.add(k) })
    .map(s => ({ id: stableId(`${s.locationId}|${s.date}|${s.time}|${s.filmKey}`), ...s, addedAt: s.addedAt || firstSeen.get(s.filmKey) || from }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(all))
  const perLoc = {}
  all.forEach(s => perLoc[s.locationId] = (perLoc[s.locationId] || 0) + 1)
  console.log(`\n✅ ${all.length} Vorstellungen, ${new Set(all.map(s => s.filmKey)).size} Filme → public/films.json`, perLoc)
}

main().catch(e => { console.error(e); process.exit(1) })
