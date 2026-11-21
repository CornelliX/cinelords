import { renderApp } from './app.js'
import { supabase } from './supabase.js'

async function init() {
  // Magic-Link-Token aus der URL übernehmen (PWA)
  const hash = window.location.hash
  if (hash.includes('access_token')) {
    const params = new URLSearchParams(hash.substring(1))
    const access_token = params.get('access_token')
    const refresh_token = params.get('refresh_token')
    if (access_token && refresh_token) await supabase.auth.setSession({ access_token, refresh_token })
    window.history.replaceState(null, '', window.location.pathname)
  }
  renderApp(document.getElementById('app'))
}

init()

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('/cinelords/sw.js')
}
