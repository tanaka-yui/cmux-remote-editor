import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The bridge is reachable from the LAN while cmux runs in allowAll mode, so an
// unauthenticated WebSocket would hand arbitrary command execution (via
// surface.send_text) to any peer on the network. A single shared token gates
// the upgrade: auto-generated on first boot and persisted under .run/ (already
// gitignored), or supplied via CMUX_REMOTE_TOKEN.
const DEFAULT_TOKEN_FILE = join(import.meta.dir, '../.run/token')

export function loadOrCreateToken(tokenFile: string = DEFAULT_TOKEN_FILE): string {
  const fromEnv = process.env.CMUX_REMOTE_TOKEN
  if (fromEnv) return fromEnv

  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, 'utf8').trim()
    if (existing) return existing
  }

  const token = randomBytes(24).toString('base64url')
  mkdirSync(dirname(tokenFile), { recursive: true })
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
  return token
}

export function tokenEquals(expected: string, candidate: string | null): boolean {
  if (!candidate) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(candidate)
  return a.length === b.length && timingSafeEqual(a, b)
}
