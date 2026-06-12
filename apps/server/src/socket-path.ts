import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// cmux records the path of its live Unix socket in a `last-socket-path` file.
// Newer cmux builds use the XDG state dir; older builds used Application Support.
// The default socket location moved over time, so resolving it from these
// pointer files keeps us robust against future relocations.
const DEFAULT_LAST_SOCKET_PATH_FILES = [
  join(homedir(), '.local/state/cmux/last-socket-path'),
  join(homedir(), 'Library/Application Support/cmux/last-socket-path'),
]

const DEFAULT_FALLBACK_SOCKET_PATH = join(homedir(), '.local/state/cmux/cmux.sock')

interface ResolveOptions {
  env?: string
  pointerFiles?: string[]
  fallback?: string
}

export function resolveCmuxSocketPath(options: ResolveOptions = {}): string {
  const env = options.env ?? process.env.CMUX_SOCKET_PATH
  if (env) return env

  const pointerFiles = options.pointerFiles ?? DEFAULT_LAST_SOCKET_PATH_FILES
  for (const pointer of pointerFiles) {
    if (!existsSync(pointer)) continue
    try {
      const socketPath = readFileSync(pointer, 'utf8').trim()
      if (socketPath && existsSync(socketPath)) return socketPath
    } catch {
      // Pointer file unreadable; fall through to the next candidate.
    }
  }

  return options.fallback ?? DEFAULT_FALLBACK_SOCKET_PATH
}
