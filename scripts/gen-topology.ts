#!/usr/bin/env bun
/**
 * Traces actual import statements across the repo and generates:
 *   docs/topology-data.json  — nodes, edges, layers (consumed by topology.html)
 *   docs/topology.mmd        — Mermaid diagram
 *
 * Usage: bun scripts/gen-topology.ts
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, basename } from 'path'

const ROOT = join(import.meta.dir, '..')

// Layer assignments — the only manual configuration.
// Modules not listed here are excluded from the topology.
const LAYER_CONFIG: Record<string, { layer: string; desc: string }> = {
  'daemon.ts':                { layer: 'entry',     desc: 'Daemon entry — boots gateway, server, router' },
  'bridge.ts':                { layer: 'entry',     desc: 'Bridge entry — MCP relay, one per Claude session' },
  'cli/hydra.ts':             { layer: 'entry',     desc: 'CLI entry — up/down/restart/health' },
  'shared/constants.ts':      { layer: 'shared',    desc: 'DEFAULT_MODEL, isKnownModel, spawnModel(), MODEL_ALIASES' },
  'daemon/config.ts':         { layer: 'core',      desc: 'Env, paths, .env loading, gateway instance' },
  'daemon/sessions.ts':       { layer: 'core',      desc: 'SessionRegistry, ThreadRegistry, session catalog' },
  'daemon/bridge-transport.ts': { layer: 'core',    desc: 'BridgeConn map, message queuing, flush' },
  'daemon/util.ts':           { layer: 'core',      desc: 'safeSend, chunk, getContextPercent, formatDuration' },
  'daemon/bridge-tools.ts':   { layer: 'tools',     desc: 'UNIVERSAL_TOOLS, MASTER_ORCHESTRATOR_ONLY_TOOLS, computeToolsForSession — zero daemon imports (cycle guard)' },
  'daemon/bridge-dispatch.ts': { layer: 'tools',    desc: 'executeTool — tool execution dispatch' },
  'daemon/bridge-server.ts':  { layer: 'server',    desc: 'Unix socket server, bridge protocol, death detection, flap guard' },
  'daemon/protocol-registry.ts': { layer: 'server', desc: 'Protocol registration, isThreadOccupied query, dispatch{Reconnect,Reply,Disconnect}' },
  'daemon/main-guard.ts':     { layer: 'server',    desc: 'Duplicate-main detection logic' },
  'daemon/permission.ts':     { layer: 'server',    desc: 'Permission request routing to DM' },
  'daemon/cli-handler.ts':    { layer: 'server',    desc: 'CLI socket request handler' },
  'daemon/session-lifecycle.ts': { layer: 'lifecycle', desc: 'doSpawnSession, killSession, tryResume, tryRespawn' },
  'daemon/anchor-state.ts':   { layer: 'lifecycle', desc: 'Thread anchor message visual state machine' },
  'daemon/router.ts':         { layer: 'domain',    desc: 'Inbound routing, command interception, COMMAND_PREFIXES' },
  'daemon/access.ts':         { layer: 'domain',    desc: 'Access control, allowlists, maxChunkLimit' },
  'daemon/templates.ts':      { layer: 'domain',    desc: 'Spawn templates (review:, fix:)' },
  'daemon/pr-watch.ts':       { layer: 'domain',    desc: 'GitHub PR polling, comment delivery' },
  'daemon/dashboard.ts':      { layer: 'domain',    desc: 'Slack Home tab dashboard' },
  'daemon/idempotency.ts':    { layer: 'domain',    desc: 'Message deduplication' },
  'daemon/state-machine.ts':  { layer: 'domain',    desc: 'Generic state machine for protocols' },
  'daemon/transcript-dump.ts': { layer: 'domain',   desc: 'Preserve-then-strike: raw transcript dump before deletion' },
  'daemon/advance-nudge.ts':  { layer: 'domain',    desc: 'Liveness: nudge protocol participants that post via reply() instead of advance()' },
  'daemon/reply-guard.ts':    { layer: 'domain',    desc: 'Reply guard: nudge sessions that go silent on user-authored messages' },
  'daemon/phase-budget.ts':   { layer: 'domain',    desc: 'Per-session max lifetime: nudge → grace → reap' },
  'daemon/session-health.ts': { layer: 'domain',    desc: 'Session health poll: crash detection, orphan detection, context alerts' },
  'daemon/protocol-loader.ts': { layer: 'domain',   desc: 'Protocol loader: dynamic import + cache + validation' },
  'daemon/commands/global.ts':  { layer: 'commands', desc: 'spawn, kill, restart, recover' },
  'daemon/commands/status.ts':  { layer: 'commands', desc: 'sessions list, status display' },
  'daemon/commands/thread.ts':  { layer: 'commands', desc: 'listen, pause, resume, join, handoff' },
  'daemon/commands/protocol.ts': { layer: 'commands', desc: 'unified protocol command handler' },
  'daemon/commands/watch.ts':   { layer: 'commands', desc: 'watch/unwatch PR commands' },
}

const LAYERS = [
  { id: 'entry',     name: 'Entry',     color: '#6B8DB5', y: 30 },
  { id: 'shared',    name: 'Shared',    color: '#9B8BC4', y: 100  },
  { id: 'core',      name: 'Core',      color: '#5BA39B', y: 170 },
  { id: 'tools',     name: 'Tools',     color: '#7B8BC4', y: 250 },
  { id: 'server',    name: 'Server',    color: '#5B8BA3', y: 330 },
  { id: 'lifecycle', name: 'Lifecycle', color: '#6BAB8E', y: 410 },
  { id: 'domain',    name: 'Domain',    color: '#C4A35B', y: 490 },
  { id: 'protocols', name: 'Protocols', color: '#C47B7B', y: 580 },
  { id: 'commands',  name: 'Commands',  color: '#8B7DB8', y: 670 },
]

// Resolve import path to a relative project path
function resolveImport(fromFile: string, importPath: string): string | null {
  const clean = importPath.replace(/\.js$/, '.ts').replace(/^['"]|['"]$/g, '')
  if (clean.startsWith('.')) {
    const dir = fromFile.includes('/') ? fromFile.replace(/\/[^/]+$/, '') : '.'
    const parts = join(dir, clean).split('/').filter(p => p !== '.')
    const resolved: string[] = []
    for (const p of parts) {
      if (p === '..') resolved.pop()
      else resolved.push(p)
    }
    return resolved.join('/')
  }
  return null
}

// Make a safe node ID from a file path
function nodeId(path: string): string {
  return path.replace(/[/.]/g, '_').replace(/_ts$/, '')
}

// Trace imports
const nodes: Array<{ id: string; label: string; layer: string; desc: string }> = []
const edges: Array<[string, string]> = []
const knownPaths = new Set(Object.keys(LAYER_CONFIG))

for (const filePath of Object.keys(LAYER_CONFIG)) {
  const config = LAYER_CONFIG[filePath]
  const id = nodeId(filePath)
  nodes.push({ id, label: filePath, layer: config.layer, desc: config.desc })

  const fullPath = join(ROOT, filePath)
  let content: string
  try { content = readFileSync(fullPath, 'utf8') } catch { continue }

  const importRegex = /import\s+.*?from\s+['"]([^'"]+)['"]/g
  const sideEffectRegex = /import\s+['"]([^'"]+)['"]/g

  for (const regex of [importRegex, sideEffectRegex]) {
    let match
    while ((match = regex.exec(content)) !== null) {
      const resolved = resolveImport(filePath, match[1])
      if (resolved && knownPaths.has(resolved)) {
        const targetId = nodeId(resolved)
        if (targetId !== id) {
          edges.push([id, targetId])
        }
      }
    }
  }
}

// Deduplicate edges
const edgeSet = new Set(edges.map(([s, t]) => `${s}→${t}`))
const dedupedEdges = [...edgeSet].map(e => e.split('→') as [string, string])

// Write JSON
const data = { layers: LAYERS, nodes, edges: dedupedEdges }
writeFileSync(join(ROOT, 'docs', 'topology-data.json'), JSON.stringify(data, null, 2) + '\n')

// Write Mermaid
const layerOrder = Object.fromEntries(LAYERS.map((l, i) => [l.id, i]))
const nodesByLayer: Record<string, typeof nodes> = {}
nodes.forEach(n => { (nodesByLayer[n.layer] ??= []).push(n) })

let mmd = `%% Hydra import topology — auto-generated by scripts/gen-topology.ts\n%% Run: bun scripts/gen-topology.ts\n\ngraph TD\n\n`
for (const layer of LAYERS) {
  const layerNodes = nodesByLayer[layer.id] || []
  if (!layerNodes.length) continue
  mmd += `  subgraph ${layer.id}["${layer.name}"]\n`
  for (const n of layerNodes) {
    mmd += `    ${n.id}["${basename(n.label, '.ts')}.ts"]\n`
  }
  mmd += `  end\n\n`
}
for (const [s, t] of dedupedEdges) {
  mmd += `  ${s} --> ${t}\n`
}

writeFileSync(join(ROOT, 'docs', 'topology.mmd'), mmd)

// Inject data into HTML — replaces either the placeholder or a previous injection
const htmlPath = join(ROOT, 'docs', 'topology.html')
let html = readFileSync(htmlPath, 'utf8')
const dataScript = `const DATA = ${JSON.stringify(data)};`
html = html.replace(/\/\* __TOPOLOGY_DATA__ \*\/|const DATA = .+;/, dataScript)
writeFileSync(htmlPath, html)

console.log(`Generated: ${nodes.length} nodes, ${dedupedEdges.length} edges`)
console.log(`  docs/topology-data.json`)
console.log(`  docs/topology.mmd`)
console.log(`  docs/topology.html (data injected)`)
