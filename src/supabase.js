import { createClient } from '@supabase/supabase-js'

// Gleiches Supabase-Projekt wie LiveLords, eigene Tabelle cine_bookmarks (supabase/cine_bookmarks.sql).
// Eigener storageKey: beide Apps teilen sich localStorage (gleiche Domain), die Logins bleiben getrennt.
const SUPABASE_URL = 'https://cqxpjesovcavarrlljpn.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNxeHBqZXNvdmNhdmFycmxsanBuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0NjI4MjYsImV4cCI6MjA4ODAzODgyNn0._paXbtV1uecR0AA08KUkKLfRkmkQw2k4W3hT5L2y2ho'
const AUTH_KEY = 'cine-auth'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    storageKey: AUTH_KEY,
    storage: window.localStorage,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})

// Angemeldeten Nutzer sofort und ohne Netzwerk aus dem gespeicherten Login lesen (nur fürs erste Zeichnen;
// ob der Login noch gilt, klärt getUser() danach)
export function peekUser() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY))?.user ?? null } catch { return null }
}

export async function getUser() {
  // getSession liest lokal (refresht bei Ablauf); Datenzugriff schützt serverseitig RLS
  const { data: { session } } = await supabase.auth.getSession()
  return session?.user ?? null
}

export async function signInWithEmail(email) {
  try { localStorage.setItem('cine-email', email) } catch {}
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
  return !error
}

export async function verifyOtp(email, token) {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
  return !error
}

export async function signOut() {
  await supabase.auth.signOut()
}

// { bookmarked: [screeningId], going: [screeningId] } (IDs als Strings). null bei Fehler.
export async function loadBookmarks() {
  const user = await getUser()
  if (!user) return { bookmarked: [], going: [] }
  const { data, error } = await supabase.from('cine_bookmarks').select('screening_id, status').eq('user_id', user.id)
  if (error) return null
  return {
    bookmarked: data.filter(r => r.status === 'bookmarked').map(r => r.screening_id),
    going: data.filter(r => r.status === 'going').map(r => r.screening_id)
  }
}

export async function setBookmark(screeningId, status, on) {
  const user = await getUser()
  if (!user) return false
  const id = String(screeningId)
  const { error } = on
    ? await supabase.from('cine_bookmarks').upsert({ user_id: user.id, screening_id: id, status }, { onConflict: 'user_id,screening_id,status' })
    : await supabase.from('cine_bookmarks').delete().eq('user_id', user.id).eq('screening_id', id).eq('status', status)
  return !error
}

// ── History (cine_history, siehe supabase/cine_history.sql) ─────────────────────────────────────
const fromRow = r => ({ id: r.id, screeningId: r.screening_id, title: r.title, cinemaName: r.cinema_name || '', cinemaCity: r.cinema_city || '', date: r.date, time: r.time || '', version: r.version || '', rating: r.rating || 0 })

// Liste der eigenen Einträge, null bei Fehler
export async function loadHistory() {
  const user = await getUser()
  if (!user) return []
  const { data, error } = await supabase.from('cine_history').select('*').eq('user_id', user.id)
  return error ? null : data.map(fromRow)
}

// Snapshot einer Vorstellung anlegen; gibt den neuen Eintrag zurück (null bei Fehler oder schon vorhanden)
export async function addHistory({ screeningId, title, cinemaName, cinemaCity, date, time, version }) {
  const user = await getUser()
  if (!user) return null
  const { data, error } = await supabase.from('cine_history')
    .insert({ user_id: user.id, screening_id: screeningId ?? null, title, cinema_name: cinemaName || null, cinema_city: cinemaCity || null, date, time: time || null, version: version || null })
    .select().single()
  return error ? null : fromRow(data)
}

// fields: { title?, cinemaName?, cinemaCity?, date?, time?, rating? }
export async function updateHistory(id, fields) {
  const user = await getUser()
  if (!user) return false
  const map = { title: 'title', cinemaName: 'cinema_name', cinemaCity: 'cinema_city', date: 'date', time: 'time', rating: 'rating' }
  const row = {}
  for (const [k, col] of Object.entries(map)) if (k in fields) row[col] = fields[k] === '' || fields[k] === 0 ? null : fields[k]
  const { error } = await supabase.from('cine_history').update(row).eq('id', id).eq('user_id', user.id)
  return !error
}

export async function removeHistory(id) {
  const user = await getUser()
  if (!user) return false
  const { error } = await supabase.from('cine_history').delete().eq('id', id).eq('user_id', user.id)
  return !error
}

export async function removeHistoryByScreening(screeningId) {
  const user = await getUser()
  if (!user) return false
  const { error } = await supabase.from('cine_history').delete().eq('screening_id', String(screeningId)).eq('user_id', user.id)
  return !error
}
