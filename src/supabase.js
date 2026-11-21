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
