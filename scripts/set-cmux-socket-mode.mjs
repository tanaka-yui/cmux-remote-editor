#!/usr/bin/env node
// Patch cmux's automation.socketControlMode in ~/.config/cmux/cmux.json.
//
// Why: cmux's default `cmuxOnly` mode authorizes socket clients by PID ancestry
// (the connecting process must descend from the cmux app). A detached background
// daemon — like the bridge server started with `pnpm server:up` — gets reparented
// to launchd and loses that ancestry, so cmux rejects it. Setting the mode to
// `allowAll` (Automation mode) drops the ancestry check and authorizes any local
// client from the same macOS user, which is what the host daemon needs.
//
// Security: `allowAll` lets ANY local process from your macOS user drive cmux via
// its control socket. Only enable it on a machine you trust. Revert any time with
// `node scripts/set-cmux-socket-mode.mjs cmuxOnly`.
//
// The cmux config is JSONC (JSON + comments). This rewrites it as plain JSON after
// saving a timestamped .bak of the original (so the commented template is kept).
//
// Usage:
//   node scripts/set-cmux-socket-mode.mjs            # -> allowAll (default)
//   node scripts/set-cmux-socket-mode.mjs cmuxOnly   # -> revert to default
//
// After running, apply it with:  cmux reload-config

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const VALID = ['off', 'cmuxOnly', 'automation', 'password', 'allowAll', 'openAccess', 'fullOpenAccess', 'notifications', 'full']

const mode = process.argv[2] ?? 'allowAll'
if (!VALID.includes(mode)) {
  console.error(`Invalid mode "${mode}". Valid: ${VALID.join(', ')}`)
  process.exit(1)
}

// Strip // line and /* */ block comments without corrupting string contents
// (the template's $schema value contains "//"), then drop trailing commas.
function stripJsonc(text) {
  let out = ''
  let inStr = false
  let strCh = ''
  let esc = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === strCh) inStr = false
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      strCh = c
      out += c
      continue
    }
    if (c === '/' && n === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

const configPath = join(homedir(), '.config', 'cmux', 'cmux.json')

let config = {}
if (existsSync(configPath)) {
  const raw = readFileSync(configPath, 'utf8')
  try {
    const stripped = stripJsonc(raw).trim()
    config = stripped ? JSON.parse(stripped) : {}
  } catch (err) {
    console.error(`Could not parse ${configPath} (even after stripping comments); aborting so nothing is clobbered.`)
    console.error(String(err))
    process.exit(1)
  }
  if (config.automation?.socketControlMode === mode) {
    console.log(`automation.socketControlMode is already "${mode}" in ${configPath} — nothing to do.`)
    process.exit(0)
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${configPath}.${stamp}.bak`
  writeFileSync(backup, raw)
  console.log(`Backed up original (with comments) -> ${backup}`)
} else {
  mkdirSync(dirname(configPath), { recursive: true })
}

config.automation = { ...(config.automation ?? {}), socketControlMode: mode }
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

console.log(`Set automation.socketControlMode = "${mode}" in ${configPath}`)
console.log('Apply it now with:  cmux reload-config')
