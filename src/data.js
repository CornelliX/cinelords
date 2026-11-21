// CineLords läuft auf derselben Domain wie LiveLords (github.io) und teilt sich damit localStorage:
// jeder Schlüssel bekommt hier automatisch das Präfix "cine-". localStorage kann werfen (iOS privat, voller Speicher),
// die App läuft dann ohne Speichern weiter.
export function loadData(key) {
  try {
    const raw = localStorage.getItem('cine-' + key)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { localStorage.removeItem('cine-' + key); return null }
  } catch { return null }
}

export function saveData(key, value) {
  try { localStorage.setItem('cine-' + key, JSON.stringify(value)) } catch {}
}

// IDs passen zu den locationIds in scraper/scrape.js (beim Hinzufügen eines Kinos beide Dateien ändern)
export const CINEMAS = [
  { id: 1, name: 'Filmtheater am Friedrichshain', city: 'Berlin' },
  { id: 2, name: 'Kino International', city: 'Berlin' },
  { id: 3, name: 'Blauer Stern', city: 'Berlin' },
  { id: 4, name: 'Babylon', city: 'Berlin' },
  { id: 5, name: 'Hackesche Höfe Kino', city: 'Berlin' },
  { id: 6, name: 'Central', city: 'Berlin' },
  { id: 7, name: 'Acud Kino', city: 'Berlin' },
  { id: 8, name: 'Zeughauskino', city: 'Berlin' },
  { id: 9, name: 'Arsenal', city: 'Berlin' },
  { id: 10, name: 'City Kino Wedding', city: 'Berlin' },
  { id: 11, name: 'Lichtblick', city: 'Berlin' },
  { id: 12, name: 'Krokodil', city: 'Berlin' },
  { id: 13, name: 'CineStar Kulturbrauerei', city: 'Berlin' },
  { id: 14, name: 'b-ware! Ladenkino', city: 'Berlin' },
  { id: 16, name: 'Tilsiter Lichtspiele', city: 'Berlin' },
  { id: 17, name: 'Kino Intimes', city: 'Berlin' },
  { id: 18, name: 'Toni', city: 'Berlin' },
  { id: 19, name: 'Brotfabrik', city: 'Berlin' },
  { id: 31, name: 'Passage Kinos', city: 'Leipzig' },
  { id: 32, name: 'Schaubühne Lindenfels', city: 'Leipzig' },
  { id: 33, name: 'Cineding', city: 'Leipzig' },
  { id: 35, name: 'Luru Kino', city: 'Leipzig' },
  { id: 36, name: 'Kinobar Prager Frühling', city: 'Leipzig' },
  { id: 37, name: 'Cinémathèque', city: 'Leipzig' },
  { id: 38, name: 'Regina Palast', city: 'Leipzig' },
  { id: 39, name: 'CineStar Leipzig', city: 'Leipzig' },
]

// index.html startet den Abruf schon vor dem Bundle (window.__filmsP); nur beim ersten Aufruf nutzbar, danach frisch laden
export async function getFilms() {
  const early = window.__filmsP
  window.__filmsP = null
  const fresh = () => fetch('./films.json').then(res => res.ok ? res.json() : [])
  try {
    return (await (early ? early.then(list => list || fresh()) : fresh())) || []
  } catch {
    return []
  }
}
