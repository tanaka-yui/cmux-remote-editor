#!/usr/bin/env node
// cmux のワークスペース横断 RPC を、既定では読み取り専用で確認する。
// --write は使い捨て terminal surface だけを作成・操作し、必ず削除する。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const RPC_TIMEOUT_MS = 10_000
const LOAD_DURATION_MS = 15_000
const FOREGROUND_INTERVAL_MS = 1_000
const BACKGROUND_INTERVAL_MS = 3_000
const BACKGROUND_STAGGER_MS = 400
const SCROLLBACK_LINES = 2_000

function usage(message) {
  if (message) console.error(message)
  console.error('Usage: node scripts/cmux-probe.mjs [--write] [--load <clients>]')
  process.exit(1)
}

function parseOptions(argv) {
  let write = false
  let loadClients = null

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--write') {
      write = true
      continue
    }
    if (argument === '--load') {
      const value = Number(argv[index + 1])
      if (!Number.isInteger(value) || value < 1) usage('--load requires a positive integer')
      loadClients = value
      index += 1
      continue
    }
    usage(`Unknown option: ${argument}`)
  }

  return { write, loadClients }
}

function resolveSocketPath() {
  if (process.env.CMUX_SOCKET_PATH) return process.env.CMUX_SOCKET_PATH

  const pointers = [
    path.join(homedir(), '.local/state/cmux/last-socket-path'),
    path.join(homedir(), 'Library/Application Support/cmux/last-socket-path'),
  ]
  for (const pointer of pointers) {
    if (!existsSync(pointer)) continue
    const socketPath = readFileSync(pointer, 'utf8').trim()
    if (socketPath && existsSync(socketPath)) return socketPath
  }

  throw new Error('cmux socket was not found; set CMUX_SOCKET_PATH to override discovery')
}

function createRpcConnection(socketPath) {
  const socket = net.createConnection(socketPath)
  const decoder = new StringDecoder('utf8')
  const pending = new Map()
  let buffer = ''
  let nextId = 0

  const ready = new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  socket.on('data', (chunk) => {
    buffer += decoder.write(chunk)
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.trim()) continue

      try {
        const message = JSON.parse(line)
        const resolve = pending.get(String(message.id))
        if (resolve) {
          pending.delete(String(message.id))
          resolve(message)
        }
      } catch {
        // The socket may emit non-JSON notifications; they are irrelevant here.
      }
    }
  })

  socket.on('error', (error) => {
    for (const resolve of pending.values()) resolve({ error: { message: error.message } })
    pending.clear()
  })

  return {
    ready,
    rpc(method, params = {}) {
      return new Promise((resolve) => {
        const id = String(++nextId)
        const timeout = setTimeout(() => {
          if (pending.delete(id)) resolve({ error: { message: 'TIMEOUT' } })
        }, RPC_TIMEOUT_MS)
        pending.set(id, (message) => {
          clearTimeout(timeout)
          resolve(message)
        })
        socket.write(`${JSON.stringify({ id, method, params })}\n`)
      })
    },
    close() {
      decoder.end()
      socket.end()
    },
  }
}

function isSuccess(response) {
  return !response.error && response.ok !== false
}

function summarize(response) {
  if (response.error) return `ERROR ${JSON.stringify(response.error)}`
  if (response.ok === false) return `NOT_OK ${JSON.stringify(response).slice(0, 240)}`
  const grid = response.result?.render_grid
  if (grid) return `OK grid rows=${grid.rows ?? '?'} cols=${grid.cols ?? '?'}`
  if (typeof response.result?.text === 'string') return `OK text bytes=${Buffer.byteLength(response.result.text)}`
  return `OK ${JSON.stringify(response.result).slice(0, 240)}`
}

function contentDigest(response) {
  const content = typeof response.result?.text === 'string' ? response.result.text : null
  return content === null ? null : createHash('sha256').update(content).digest('hex').slice(0, 12)
}

function collectMethodNames(value, names = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectMethodNames(item, names)
    return names
  }
  if (!value || typeof value !== 'object') return names

  for (const [key, item] of Object.entries(value)) {
    if (key.includes('.')) names.add(key)
    if ((key === 'name' || key === 'method') && typeof item === 'string' && item.includes('.')) names.add(item)
    collectMethodNames(item, names)
  }
  return names
}

function findValue(value, key) {
  if (!value || typeof value !== 'object') return undefined
  if (Object.hasOwn(value, key)) return value[key]
  for (const item of Object.values(value)) {
    const found = findValue(item, key)
    if (found !== undefined) return found
  }
  return undefined
}

function getWindow(treeResponse) {
  const window = treeResponse.result?.windows?.[0]
  if (!window) throw new Error(`system.tree returned no window: ${summarize(treeResponse)}`)
  return window
}

function terminalSurfaces(window) {
  return (window.workspaces ?? []).flatMap((workspace) =>
    (workspace.panes ?? []).flatMap((pane) =>
      (pane.surfaces ?? [])
        .filter((surface) => surface.type === 'terminal')
        .map((surface) => ({ ...surface, workspace, pane })),
    ),
  )
}

function findSurface(window, id) {
  return terminalSurfaces(window).find((surface) => surface.id === id)
}

function focusSnapshot(treeResponse) {
  const active = treeResponse.result?.active ?? {}
  return `${active.workspace_ref ?? '-'} / ${active.pane_ref ?? '-'} / ${active.surface_ref ?? '-'}`
}

function printCapabilities(response) {
  if (!isSuccess(response)) {
    console.log(`system.capabilities: ${summarize(response)}`)
    return
  }

  const capabilities = response.result ?? {}
  const methods = Array.isArray(capabilities.methods)
    ? new Set(capabilities.methods.filter((method) => typeof method === 'string'))
    : collectMethodNames(capabilities)
  const hash = createHash('sha256').update(JSON.stringify(capabilities)).digest('hex')
  const protocol = capabilities.protocol ?? findValue(capabilities, 'protocol') ?? '(unknown)'
  const version = capabilities.version ?? findValue(capabilities, 'version') ?? '(unknown)'
  const accessMode = capabilities.access_mode ?? findValue(capabilities, 'access_mode') ?? '(unknown)'
  console.log(`system.capabilities: protocol=${protocol} version=${version} access_mode=${accessMode}`)
  console.log(`  methods=${methods.size} sha256=${hash}`)
}

async function probeSurface(rpc, label, surface) {
  console.log(`\n${label}: ${surface.workspace.ref} "${surface.workspace.title ?? ''}" / ${surface.ref}`)
  for (const [identifier, params] of [
    ['UUID surface_id', { surface_id: surface.id }],
    ['short surface_ref', { surface_ref: surface.ref }],
  ]) {
    const [replay, readText] = await Promise.all([
      rpc('terminal.replay', params),
      rpc('surface.read_text', params),
    ])
    console.log(`  ${identifier} terminal.replay: ${summarize(replay)}`)
    console.log(`  ${identifier} surface.read_text: ${summarize(readText)}`)
  }
}

async function probeSurfaceRefFallback(rpc, window, activeRef) {
  const active = terminalSurfaces(window).find((surface) => surface.ref === activeRef)
  const target = terminalSurfaces(window).find((surface) => surface.ref !== activeRef)
  if (!active || !target) {
    console.log('\nnegative control (surface_ref fallback): skipped (two distinct terminal surfaces are required)')
    return
  }

  const [targetById, targetByRef, activeById] = await Promise.all([
    rpc('surface.read_text', { surface_id: target.id }),
    rpc('surface.read_text', { surface_ref: target.ref }),
    rpc('surface.read_text', { surface_id: active.id }),
  ])
  const targetDigest = contentDigest(targetById)
  const refDigest = contentDigest(targetByRef)
  const activeDigest = contentDigest(activeById)
  const fallbackDetected =
    targetDigest !== null && refDigest !== null && activeDigest !== null && refDigest === activeDigest && refDigest !== targetDigest
  const inconclusive = targetDigest === null || refDigest === null || activeDigest === null || targetDigest === activeDigest

  console.log('\nnegative control (surface_ref fallback):')
  console.log(`  target UUID ${target.ref}: ${summarize(targetById)} digest=${targetDigest ?? '-'}`)
  console.log(`  target short ref ${target.ref}: ${summarize(targetByRef)} digest=${refDigest ?? '-'}`)
  console.log(`  active UUID ${active.ref}: ${summarize(activeById)} digest=${activeDigest ?? '-'}`)
  console.log(`  fallback to another surface: ${fallbackDetected ? 'DETECTED' : inconclusive ? 'INCONCLUSIVE' : 'NOT DETECTED'}`)
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function percentile(samples, fraction) {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
}

async function runLoad(socketPath, clients, targets) {
  if (targets.length === 0) {
    console.log('\nload: skipped (no terminal surface)')
    return
  }

  console.log(`\nload: ${clients} client(s), ${LOAD_DURATION_MS / 1000}s each`)
  console.log('  per client: foreground replay + read_text, then wait 1s; up to 7 background replay, then wait 3s, staggered 400ms')

  async function runClient(tag) {
    const connection = createRpcConnection(socketPath)
    await connection.ready
    const foreground = targets[0]
    const background = targets.slice(1, 8)
    const foregroundLatencies = []
    const backgroundLatencies = []
    let stopped = false

    const foregroundLoop = async () => {
      while (!stopped) {
        const startedAt = Date.now()
        await connection.rpc('terminal.replay', { surface_id: foreground.id })
        await connection.rpc('surface.read_text', { surface_id: foreground.id, scrollback: true, lines: SCROLLBACK_LINES })
        foregroundLatencies.push(Date.now() - startedAt)
        await delay(FOREGROUND_INTERVAL_MS)
      }
    }
    const backgroundLoop = (surface, index) =>
      (async () => {
        await delay(index * BACKGROUND_STAGGER_MS)
        while (!stopped) {
          const startedAt = Date.now()
          await connection.rpc('terminal.replay', { surface_id: surface.id })
          backgroundLatencies.push(Date.now() - startedAt)
          await delay(BACKGROUND_INTERVAL_MS)
        }
      })()

    try {
      const loops = [foregroundLoop(), ...background.map(backgroundLoop)]
      await delay(LOAD_DURATION_MS)
      stopped = true
      await Promise.all(loops)
    } finally {
      connection.close()
    }

    return {
      tag,
      foreground: foregroundLatencies,
      background: backgroundLatencies,
    }
  }

  const results = await Promise.all(Array.from({ length: clients }, (_, index) => runClient(`client-${index + 1}`)))
  for (const result of results) {
    const foregroundMax = result.foreground.length === 0 ? 0 : Math.max(...result.foreground)
    console.log(
      `  [${result.tag}] foreground n=${result.foreground.length} p50=${percentile(result.foreground, 0.5)}ms p95=${percentile(result.foreground, 0.95)}ms max=${foregroundMax}ms | background n=${result.background.length} p50=${percentile(result.background, 0.5)}ms p95=${percentile(result.background, 0.95)}ms`,
    )
  }
}

async function runWriteProbe(rpc) {
  const initialTree = await rpc('system.tree', {})
  const initialWindow = getWindow(initialTree)
  const originalWorkspace = initialWindow.workspaces?.find((workspace) => workspace.selected)
  const targetWorkspace = initialWindow.workspaces?.find((workspace) => !workspace.selected && workspace.panes?.length)
  if (!originalWorkspace || !targetWorkspace) {
    console.log('\nwrite probe: skipped (selected and non-selected workspaces are required)')
    return
  }

  const scratchIds = new Set()
  let writeAborted = false
  let hasTrustedScratch = false
  const resolveCreatedSurface = async (response) => {
    const surfaceId = typeof response.result?.surface_id === 'string' ? response.result.surface_id : null
    const surfaceRef = typeof response.result?.surface_ref === 'string' ? response.result.surface_ref : null
    if (!isSuccess(response) || (!surfaceId && !surfaceRef)) {
      writeAborted = true
      console.log('    aborted: surface.create response has no trusted surface_id or surface_ref; no further writes will run')
      return null
    }

    await delay(900)
    const currentWindow = getWindow(await rpc('system.tree', {}))
    const matches = terminalSurfaces(currentWindow).filter(
      (surface) => (!surfaceId || surface.id === surfaceId) && (!surfaceRef || surface.ref === surfaceRef),
    )
    if (matches.length !== 1) {
      writeAborted = true
      console.log(
        `    aborted: response identity surface_id=${surfaceId ?? '-'} surface_ref=${surfaceRef ?? '-'} matched ${matches.length} surfaces; no further writes will run`,
      )
      return null
    }
    return matches[0]
  }
  const createScratch = async (label, params, expectedWorkspaceId, focus = false) => {
    const response = await rpc('surface.create', { type: 'terminal', focus, ...params })
    const created = await resolveCreatedSurface(response)
    if (created) {
      scratchIds.add(created.id)
      hasTrustedScratch = true
    }
    const responseWorkspaceId = response.result?.workspace_id
    console.log(`  ${label}: ${summarize(response)}`)
    console.log(
      `    response workspace_id=${responseWorkspaceId ?? '-'} expected=${expectedWorkspaceId} match=${responseWorkspaceId === expectedWorkspaceId}`,
    )
    console.log(
      `    actual workspace=${created?.workspace.ref ?? '-'} expected=${expectedWorkspaceId} match=${created?.workspace.id === expectedWorkspaceId}`,
    )
    return created
  }

  console.log(`\nwrite probe: original selection=${originalWorkspace.ref}; all writes use disposable terminal surfaces`)
  try {
    const workspaceRefScratch = await createScratch('workspace_ref ignored', { workspace_ref: targetWorkspace.ref }, originalWorkspace.id)
    if (!workspaceRefScratch) return

    const scratch = await createScratch('workspace_id targets non-selected workspace', { workspace_id: targetWorkspace.id }, targetWorkspace.id)
    if (!scratch) return

    const signature = `CMUX_PROBE_${Date.now()}`
    const sent = await rpc('surface.send_text', { surface_id: scratch.id, text: `printf '${signature}\\n'\\r` })
    await delay(1_500)
    const readBack = await rpc('surface.read_text', { surface_id: scratch.id })
    console.log(`  send_text disposable surface: ${summarize(sent)}`)
    console.log(`    signature read back=${typeof readBack.result?.text === 'string' && readBack.result.text.includes(signature)}`)

    const moved = await rpc('surface.move', { surface_id: scratch.id, workspace_id: originalWorkspace.id })
    await delay(700)
    const movedSurface = findSurface(getWindow(await rpc('system.tree', {})), scratch.id)
    console.log(`  surface.move disposable surface: ${summarize(moved)}`)
    console.log(`    actual destination=${movedSurface?.workspace.ref ?? '-'} expected=${originalWorkspace.ref}`)

    const invalidWorkspaceScratch = await createScratch(
      'invalid workspace_id falls back to selected workspace',
      { workspace_id: 'BOGUS-NOT-A-UUID' },
      originalWorkspace.id,
    )
    if (!invalidWorkspaceScratch) return

    const focusedSurface = await createScratch('focus:true disposable create', { workspace_id: targetWorkspace.id }, targetWorkspace.id, true)
    if (!focusedSurface) return
    const afterFocus = getWindow(await rpc('system.tree', {}))
    console.log(`    selection changed to target=${afterFocus.workspaces?.some((workspace) => workspace.selected && workspace.id === targetWorkspace.id)}`)
  } finally {
    if (writeAborted || !hasTrustedScratch) {
      console.log('  cleanup skipped: unresolved create response aborted the write probe; no surface.close or workspace.select was sent')
      return
    }
    for (const surfaceId of scratchIds) {
      const closed = await rpc('surface.close', { surface_id: surfaceId })
      console.log(`  cleanup surface.close ${surfaceId}: ${summarize(closed)}`)
    }
    const restored = await rpc('workspace.select', { workspace_id: originalWorkspace.id })
    const restoredWindow = getWindow(await rpc('system.tree', {}))
    console.log(`  restore workspace.select: ${summarize(restored)}`)
    console.log(`  final selection restored=${restoredWindow.workspaces?.some((workspace) => workspace.selected && workspace.id === originalWorkspace.id)}`)
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const socketPath = resolveSocketPath()
  console.log(`socket: ${socketPath}`)
  console.log(`mode: read-only${options.write ? ' + isolated --write probe' : ''}`)

  const connection = createRpcConnection(socketPath)
  await connection.ready
  try {
    const [capabilities, initialTree] = await Promise.all([
      connection.rpc('system.capabilities', {}),
      connection.rpc('system.tree', {}),
    ])
    printCapabilities(capabilities)

    const initialWindow = getWindow(initialTree)
    const focusBefore = focusSnapshot(initialTree)
    console.log(`local focus before: ${focusBefore}`)
    const surfaces = terminalSurfaces(initialWindow)
    const selected = surfaces.find((surface) => surface.workspace.selected)
    const nonSelected = surfaces.find((surface) => !surface.workspace.selected)
    if (selected) await probeSurface(connection.rpc, 'selected workspace', selected)
    else console.log('\nselected workspace: skipped (no terminal surface)')
    if (nonSelected) await probeSurface(connection.rpc, 'non-selected workspace', nonSelected)
    else console.log('\nnon-selected workspace: skipped (no terminal surface)')
    await probeSurfaceRefFallback(connection.rpc, initialWindow, initialTree.result?.active?.surface_ref)

    if (options.loadClients !== null) await runLoad(socketPath, options.loadClients, surfaces)
    if (options.write) await runWriteProbe(connection.rpc)

    const focusAfterResponse = await connection.rpc('system.tree', {})
    const focusAfter = focusSnapshot(focusAfterResponse)
    console.log(`\nlocal focus after: ${focusAfter}`)
    console.log(`local focus unchanged: ${focusBefore === focusAfter}`)
  } finally {
    connection.close()
  }
}

main().catch((error) => {
  console.error(`cmux probe failed: ${error.message}`)
  process.exitCode = 1
})
