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
