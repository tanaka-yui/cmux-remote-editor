const STORAGE_KEY = 'cmux-remote-token'

// The bridge requires a shared token on the WebSocket upgrade. It is delivered
// via the page URL (?token=...) and persisted to localStorage. The URL is left
// untouched so reloads and bookmarks keep working even if storage is cleared.
export function getAuthToken(): string {
  if (typeof window === 'undefined') return ''

  const fromUrl = new URLSearchParams(window.location.search).get('token')
  if (fromUrl) {
    localStorage.setItem(STORAGE_KEY, fromUrl)
    return fromUrl
  }

  return localStorage.getItem(STORAGE_KEY) ?? ''
}

// Manual fallback for installed PWAs: iOS home-screen apps launch at the
// manifest start_url and use a storage container separate from Safari, so the
// ?token= bootstrap never reaches them. The token gate stores the pasted
// token here, inside the PWA's own container.
export function saveAuthToken(token: string): void {
  localStorage.setItem(STORAGE_KEY, token.trim())
}
