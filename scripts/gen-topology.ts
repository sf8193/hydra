#!/usr/bin/env bun
/**
 * Draws the import graph of hydra's key files, placed by the CI gate's own tiers:
 *   docs/topology-data.json  — tiers, nodes, edges (consumed by topology.html)
 *   docs/topology.mmd        — Mermaid diagram
 *
 * Which files are drawn, and the line that says what each is, is the one hand-written part (NODES). Each file's tier is
 * `tierOf` and the edges are `edges` from scripts/check-layers.ts (type-only imports are not edges), so the picture and
 * the gate agree by construction: an arrow up the page is an upward import the gate counts (each tier lists importers first).
 *
 * Usage: bun scripts/gen-topology.ts [--out <dir>]
 *
 * --out <dir>  Write generated files into <dir> instead of docs/. The HTML
 *              template is still read from docs/topology.html. Used by the
 *              freshness test to generate into a temp dir and diff, without
 *              mutating the tree it audits.
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, basename } from 'path'
import { ALLOWED, edges, tierOf, TIER_NAMES } from './check-layers.js'

const ROOT = join(import.meta.dir, '..')

// Output directory — defaults to docs/. `--out <dir>` redirects the three
// generated files (topology-data.json, topology.mmd, topology.html) elsewhere.
const outFlagIdx = process.argv.indexOf('--out')
const OUT = outFlagIdx !== -1 && process.argv[outFlagIdx + 1]
  ? process.argv[outFlagIdx + 1]
  : join(ROOT, 'docs')

/** The files drawn, each with what it is. Their tiers are not set here: `tierOf` places them. */
const NODES: Record<string, string> = {
  'daemon.ts':                       'Daemon entry — boots gateway, server, router',
  'bridge.ts':                       'Bridge entry — MCP relay, one per Claude session',
  'cli/hydra.ts':                    'CLI entry — up/down/restart/health',
  'shared/constants.ts':             'DEFAULT_MODEL, isKnownModel, spawnModel(), MODEL_ALIASES',
  'shared/tool-definitions.ts':      'UNIVERSAL_TOOLS — frozen tool objects (name, description, inputSchema)',
  'infra/config.ts':                 'Env, paths, .env loading, gateway instance',
  'sessions/registry.ts':            'SessionRegistry, ThreadRegistry, session catalog',
  'sessions/bridge-transport.ts':    'BridgeConn map, message queuing, flush',
  'infra/util.ts':                   'safeSend, chunk, parseContextPercent, formatDuration, baseNameFromBranch',
  'infra/tmux.ts':                   'Sync tmux, bounded with a hold: tmuxSync, session and server state, window activity',
  'infra/worktree-manager.ts':       'Git worktree create/reattach/destroy, unpushed-commit check',
  'engines/bridge-tools.ts':         'UNIVERSAL_TOOLS, computeToolsForSession — zero daemon imports (cycle guard)',
  'sessions/tool-surface.ts':        'getToolsForSession, pushToolSurface — reads SessionInfo, bridges to bridge-tools',
  'app/bridge-dispatch.ts':          'executeTool — tool execution dispatch',
  'app/bridge-server.ts':            'Unix socket server, bridge protocol, death detection, flap guard',
  'sessions/protocol-registry.ts':   'Protocol registration, isThreadOccupied query, dispatch{Reconnect,Reply,Disconnect}',
  'app/main-guard.ts':               'Duplicate-main detection logic',
  'app/permission.ts':               'Permission request routing to DM',
  'app/cli-handler.ts':              'CLI socket request handler',
  'app/session-lifecycle.ts':        'doSpawnSession, killSession, tryResume, tryRespawn',
  'app/recovery.ts':                 'Post-reboot/crash recovery: recoverOne cascade, work-key dedup, autoRecoverAfterBoot',
  'sessions/anchor-state.ts':        'Thread anchor message visual state machine',
  'app/router.ts':                   'Inbound routing, command interception, COMMAND_PREFIXES',
  'sessions/access.ts':              'Access control, allowlists, maxChunkLimit',
  'app/templates.ts':                'Spawn templates (review:, fix:, design:)',
  'connectors/github/pr-watch.ts':   'GitHub PR polling, comment delivery',
  'connectors/clock/jobs-clock.ts':  'Jobs clock: tick, dispatch detached attempts, apply results',
  'app/dashboard.ts':                'Slack Home tab dashboard',
  'infra/idempotency.ts':            'Message deduplication',
  'shared/state-machine.ts':         'Generic state machine for protocols',
  'infra/transcript-dump.ts':        'Preserve-then-strike: raw transcript dump before deletion',
  'app/advance-nudge.ts':            'Liveness: nudge protocol participants that post via reply() instead of advance()',
  'app/reply-guard.ts':              'Reply guard: nudge sessions that go silent on user-authored messages',
  'sessions/phase-budget.ts':        'Per-session max lifetime: nudge → grace → reap',
  'sessions/idle-limit.ts':          'Ephemeral idle limit: persisted deadline, nudge → grace → reap',
  'app/session-health.ts':           'Session health poll: crash detection, orphan detection, context alerts',
  'app/auto-handoff.ts':             'Automatic handoff of idle high-context sessions (cache and full-context rules)',
  'infra/usage.ts':                  'Transcript location + incremental token-counter cursor',
  'app/usage-alerts.ts':             'Account rate-limit alerts: report_usage + pane fallback, one dedupe per window',
  'protocols/build.ts':              'Build — implement/review iteration',
  'app/commands/global.ts':          'spawn, kill, restart, recover',
  'app/commands/status.ts':          'sessions list, status display',
  'app/commands/thread.ts':          'listen, pause, resume, join, handoff',
  'app/commands/review.ts':          'review command handler',
  'app/commands/watch.ts':           'watch/unwatch PR commands',
}

/** One colour per tier, T0 core to T5 boot. */
const TIER_COLORS = ['#5BA39B', '#9B8BC4', '#5B8BA3', '#C4A35B', '#6BAB8E', '#6B8DB5'] as const
if (TIER_COLORS.length !== TIER_NAMES.length) throw new Error(`TIER_COLORS has ${TIER_COLORS.length} colours for ${TIER_NAMES.length} tiers: give each tier one`)

/** The tiers top-down, as the page draws them: boot first, core last. A tier is its number everywhere in the data. */
const tiers = TIER_NAMES.map((name, tier) => ({ tier, name, label: `T${tier} ${name}`, color: TIER_COLORS[tier] })).reverse()

// Make a safe node ID from a file path
function nodeId(path: string): string {
  return path.replace(/[/.]/g, '_').replace(/_ts$/, '')
}

const drawn = Object.entries(NODES).map(([path, desc]) => {
  const tier = tierOf(path)
  if (tier === undefined) throw new Error(`${path} has no tier: give it one in tierOf (scripts/check-layers.ts)`)
  let text: string
  try { text = readFileSync(join(ROOT, path), 'utf8') } catch { throw new Error(`${path} is drawn but does not exist: remove it from NODES`) }
  return { node: { id: nodeId(path), label: path, tier, desc }, file: { path, text } }
})
const graphEdges = edges(drawn.map(d => d.file)).map(e => e.split(' -> ').map(nodeId) as [string, string])

/**
 * Each tier's files, those that import first and those they import after (NODES order breaks ties), so a page that fills a
 * tier's rows in this order draws every import inside a tier across or down, never up: an arrow up the page is then always
 * an import from a lower tier to a higher one, the gate's upward import.
 */
function importersFirst(inTier: typeof drawn[number]['node'][]): typeof inTier {
  const ids = new Set(inTier.map(n => n.id))
  const pending = new Map(inTier.map(n => [n.id, 0]))
  for (const [s, t] of graphEdges) if (ids.has(s) && ids.has(t)) pending.set(t, pending.get(t)! + 1)
  const out: typeof inTier = []
  const left = [...inTier]
  while (left.length) {
    // A cycle inside a tier leaves no file with nothing pending: take the first left, as NODES lists it.
    const i = Math.max(0, left.findIndex(n => pending.get(n.id) === 0))
    const [n] = left.splice(i, 1)
    out.push(n)
    for (const [s, t] of graphEdges) if (s === n.id && pending.has(t)) pending.set(t, pending.get(t)! - 1)
  }
  return out
}
const nodes = tiers.flatMap(t => importersFirst(drawn.map(d => d.node).filter(n => n.tier === t.tier)))

// Write JSON. `allowedUpward`: the upward imports the gate allows today, drawn or not (scripts/check-layers.ts ALLOWED).
const data = { tiers, nodes, edges: graphEdges, allowedUpward: ALLOWED.length }
writeFileSync(join(OUT, 'topology-data.json'), JSON.stringify(data, null, 2) + '\n')

// Write Mermaid
let mmd = `%% Hydra import topology, placed by check-layers' tiers — auto-generated by scripts/gen-topology.ts\n%% Run: bun scripts/gen-topology.ts\n\ngraph TD\n\n`
for (const t of tiers) {
  const inTier = nodes.filter(n => n.tier === t.tier)
  if (!inTier.length) continue
  mmd += `  subgraph T${t.tier}["${t.label}"]\n`
  for (const n of inTier) mmd += `    ${n.id}["${basename(n.label, '.ts')}.ts"]\n`
  mmd += `  end\n\n`
}
for (const [s, t] of graphEdges) mmd += `  ${s} --> ${t}\n`

writeFileSync(join(OUT, 'topology.mmd'), mmd)

// Inject data into HTML — replaces either the placeholder or a previous injection.
// The template is always read from docs/; only the write target follows --out.
const html = readFileSync(join(ROOT, 'docs', 'topology.html'), 'utf8')
const dataScript = `const DATA = ${JSON.stringify(data)};`
const INJECTION_POINT = /\/\* __TOPOLOGY_DATA__ \*\/|const DATA = .+;/g
// Exactly one: with none the data would ship stale; with several (a bad merge left copies), only the first would be replaced.
const points = html.match(INJECTION_POINT)?.length ?? 0
if (points !== 1) throw new Error(`topology.html has ${points} injection points, needs exactly 1: the data would ship stale`)
if (/^(<{7}|={7}|>{7})( |$)/m.test(html)) throw new Error('topology.html has merge-conflict markers: resolve them, then rerun')
const injected = html.replace(INJECTION_POINT, dataScript)
writeFileSync(join(OUT, 'topology.html'), injected)

console.log(`Generated: ${nodes.length} nodes, ${graphEdges.length} edges`)
console.log(`  ${join(OUT, 'topology-data.json')}`)
console.log(`  ${join(OUT, 'topology.mmd')}`)
console.log(`  ${join(OUT, 'topology.html')} (data injected)`)
