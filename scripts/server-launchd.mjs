#!/usr/bin/env node
// Manage the bridge server as a macOS launchd LaunchAgent (KeepAlive + RunAtLoad).
//
// Why launchd: the old nohup daemon had no crash restart and no revival after
// login. Why `down` also deletes the plist: `launchctl bootout` alone is undone
// at the next login because launchd loads every plist left in
// ~/Library/LaunchAgents — deleting it keeps a stopped server stopped.
//
// Usage: node scripts/server-launchd.mjs <up|down|status>

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'com.tanaka-yui.cmux-remote-editor.server'
const PORT = process.env.PORT ?? '48701'
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_DIR = join(REPO_ROOT, 'apps', 'server')
const LOG_PATH = join(SERVER_DIR, '.run', 'server.log')
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const DOMAIN = `gui/${process.getuid()}`

function run(cmd, args) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() }
  }
}

function portListenerPids() {
  const { out } = run('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'])
  return out ? out.split('\n') : []
}

// Returns false if the port is still occupied after ~3s (kill failed / no permission).
function killPortListeners() {
  const pids = portListenerPids()
  if (pids.length) run('kill', pids)
  const deadline = Date.now() + 3000
  while (portListenerPids().length) {
    if (Date.now() > deadline) return false
    run('sleep', ['0.2'])
  }
  return true
}

function buildPlist(bunPath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${SERVER_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CMUX_REMOTE_TLS</key><string>1</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG_PATH}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict>
</plist>
`
}

function up() {
  const bun = run('which', ['bun'])
  if (!bun.ok || !bun.out) {
    console.error('bun not found in PATH — install bun first')
    process.exit(1)
  }
  run('launchctl', ['bootout', `${DOMAIN}/${LABEL}`]) // ignore failure (not loaded)
  if (!killPortListeners()) {
    console.error(`port :${PORT} still busy after kill:`)
    console.error(run('lsof', ['-i', `tcp:${PORT}`, '-sTCP:LISTEN']).out)
    process.exit(1)
  }
  mkdirSync(join(SERVER_DIR, '.run'), { recursive: true })
  mkdirSync(dirname(PLIST_PATH), { recursive: true })
  writeFileSync(PLIST_PATH, buildPlist(bun.out))
  const boot = run('launchctl', ['bootstrap', DOMAIN, PLIST_PATH])
  if (!boot.ok) {
    console.error(`launchctl bootstrap failed:\n${boot.out}`)
    process.exit(1)
  }
  const deadline = Date.now() + 5000
  while (!portListenerPids().length) {
    if (Date.now() > deadline) {
      console.error(`bootstrapped but not listening on :${PORT} — check logs: pnpm server:logs`)
      process.exit(1)
    }
    run('sleep', ['0.2'])
  }
  console.log(`server up via launchd (${LABEL}) on :${PORT} (TLS) — logs: apps/server/.run/server.log`)
}

function down() {
  run('launchctl', ['bootout', `${DOMAIN}/${LABEL}`]) // ignore failure (not loaded)
  if (existsSync(PLIST_PATH)) rmSync(PLIST_PATH)
  if (!killPortListeners()) console.error(`warning: port :${PORT} still has a listener`)
  console.log('server down (LaunchAgent removed — stays down after reboot)')
}

function status() {
  const registered = run('launchctl', ['print', `${DOMAIN}/${LABEL}`]).ok
  console.log(portListenerPids().length ? `running on :${PORT}` : 'stopped')
  console.log(registered ? `launchd: registered (${LABEL})` : 'launchd: not registered')
}

const cmd = process.argv[2]
if (cmd === 'up') up()
else if (cmd === 'down') down()
else if (cmd === 'status') status()
else {
  console.error('Usage: node scripts/server-launchd.mjs <up|down|status>')
  process.exit(1)
}
