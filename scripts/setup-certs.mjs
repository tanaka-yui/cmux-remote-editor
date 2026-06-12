#!/usr/bin/env node
// Generate the TLS certificate that the nginx client container serves.
//
// mkcert maintains a local root CA (trusted on this Mac via `mkcert -install`)
// and issues a leaf certificate for every name the PWA may be reached by: the
// mDNS hostname (<name>.local), localhost, loopback addresses, and every LAN
// IPv4 currently assigned. LAN IPs change — re-run this script (and
// `docker compose restart`) when they do; the `.local` name keeps working.
//
// Outputs (gitignored, mounted into nginx via compose.yml):
//   certs/server.pem / certs/server-key.pem
//   certs/rootCA.pem — copy of the mkcert root CA, for AirDropping to the iPhone
//
// Usage:
//   node scripts/setup-certs.mjs   # or: pnpm certs:setup

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

const caRoot = spawnSync('mkcert', ['-CAROOT'], { encoding: 'utf8' })
if (caRoot.error || caRoot.status !== 0) {
  console.error('mkcert not found. Install it first:')
  console.error('  brew install mkcert   # Firefox を使う場合は brew install nss も')
  process.exit(1)
}

// Idempotent: first run installs the root CA into the system trust store.
const install = spawnSync('mkcert', ['-install'], { stdio: 'inherit' })
if (install.status !== 0) process.exit(install.status ?? 1)

const sans = new Set()

const localHostName = spawnSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' })
if (localHostName.status === 0 && localHostName.stdout.trim()) {
  sans.add(`${localHostName.stdout.trim()}.local`)
}

sans.add('localhost')
sans.add('127.0.0.1')
sans.add('::1')

for (const ifaces of Object.values(networkInterfaces())) {
  for (const iface of ifaces ?? []) {
    if (iface.family === 'IPv4' && !iface.internal) sans.add(iface.address)
  }
}

const certsDir = join(import.meta.dirname, '../certs')
mkdirSync(certsDir, { recursive: true })

const names = [...sans]
const issue = spawnSync(
  'mkcert',
  ['-cert-file', join(certsDir, 'server.pem'), '-key-file', join(certsDir, 'server-key.pem'), ...names],
  { stdio: 'inherit' },
)
if (issue.status !== 0) process.exit(issue.status ?? 1)

copyFileSync(join(caRoot.stdout.trim(), 'rootCA.pem'), join(certsDir, 'rootCA.pem'))

console.log(`\nCertificate issued for: ${names.join(', ')}`)
console.log('Apply to a running client with:  docker compose restart')
console.log('iPhone: AirDrop certs/rootCA.pem, install the profile, then enable it under')
console.log('設定 > 一般 > 情報 > 証明書信頼設定')
