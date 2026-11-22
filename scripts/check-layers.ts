// Imports point down the tiers, never up. Every production .ts file has a tier; an import from a lower tier to a higher one is a violation (a cycle needs at least one).
// The tiers are the target layout, so files that have not moved yet are placed by name below. Today's upward imports are listed in ALLOWED and the list only shrinks:
// a new one fails, and so does an entry that no longer matches (delete it). Type-only imports are not counted. Tests, test-setup.ts and scripts/ are out of scope.
//   bun scripts/check-layers.ts            check
//   bun scripts/check-layers.ts --list     print the violations in ALLOWED's format
//
//   T0 core      shared/, config/, routing/, pure rules and prompts (no I/O of their own)
//   T1 edges     gateways/, engines/, infra (config paths, tmux, util, files, host probes)
//   T2 sessions  the registry, access, reachability, transport, specialist data
//   T3 domain    specialists/ (delivery), connectors/, protocols/ (specs)
//   T4 app       use cases and inbound handling: lifecycle, recovery, router, commands, protocol-runner, bridge-server...  (the default for daemon/)
//   T5 boot      daemon.ts, bridge.ts, cli/, and the boot probe (it loads every module on purpose)

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { dirname, join, resolve, relative } from 'path'
import { fileURLToPath } from 'url'

export const TIER_NAMES = ['core', 'edges', 'sessions', 'domain', 'app', 'boot'] as const

const CORE_DAEMON = ['landing', 'notice-limit', 'context-lines', 'review-result', 'policy-record', 'protocol-types', 'state-machine']
// modifiers and protocol-dsl read config or util, so they are not pure: edges (they move to protocols/ later).
const EDGE_DAEMON = ['modifiers', 'protocol-dsl', 'boot-probe']
const SESSIONS_DAEMON = ['sessions', 'access', 'hydra-config', 'session-reachability', 'bridge-transport', 'delivery-notice', 'ended-sessions', 'anchor-state', 'lineage', 'session-activity', 'phase-budget', 'idle-limit', 'protocol-registry', 'thread-route', 'main-session', 'reply-context', 'resume-health', 'cli-caller']

/** The tier of a production file, by path. daemon/ files not named above are app (T4). */
export function tierOf(path: string): number | undefined {
  const top = path.split('/')[0]
  if (['shared', 'config', 'routing'].includes(top) || path.startsWith('daemon/prompts/') || path === 'throttled-queue.ts') return 0
  if (path === 'specialists/specialists.ts') return 2
  if (top === 'infra' || top === 'gateways' || top === 'omp' || top === 'engines') return 1
  if (['specialists', 'connectors', 'protocols'].includes(top)) return 3
  if (top === 'cli' || path === 'daemon.ts' || path === 'bridge.ts' || path === 'daemon/boot-probe.ts') return 5
  if (top === 'daemon') {
    const name = path.replace(/^daemon\//, '').replace(/\.ts$/, '')
    if (CORE_DAEMON.includes(name)) return 0
    if (EDGE_DAEMON.includes(name)) return 1
    if (SESSIONS_DAEMON.includes(name)) return 2
    return 4
  }
  return undefined
}

/** `from -> to`, one per allowed upward import. */
export const ALLOWED: readonly string[] = [
  'config/load.ts -> connectors/slack/app.ts',
  'connectors/slack/runtime.ts -> daemon/tool-surface.ts',
  'infra/artifacts.ts -> connectors/slack/conversation.ts',
  'infra/config.ts -> daemon/access.ts',
  'infra/cpu-watch.ts -> daemon/access.ts',
  'infra/cpu-watch.ts -> daemon/session-activity.ts',
  'infra/cpu-watch.ts -> daemon/sessions.ts',
  'engines/agy-engine.ts -> daemon/restricted.ts',
  'engines/boot.ts -> daemon/sessions.ts',
  'engines/claude-engine.ts -> daemon/pane-probe.ts',
  'engines/claude-engine.ts -> daemon/restricted.ts',
  'engines/claude-engine.ts -> daemon/write-confinement.ts',
  'engines/claude-verify.ts -> daemon/restricted.ts',
  'engines/codex-engine-adapter.ts -> daemon/reply-context.ts',
  'engines/codex-engine-adapter.ts -> daemon/restricted.ts',
  'engines/codex-engine-adapter.ts -> daemon/sessions.ts',
  'engines/codex-piggyback.ts -> daemon/bridge-transport.ts',
  'engines/codex-piggyback.ts -> daemon/sessions.ts',
  'engines/codex-runtime.ts -> daemon/anchor-state.ts',
  'engines/codex-runtime.ts -> daemon/protocol-registry.ts',
  'engines/codex-runtime.ts -> daemon/reply-guard.ts',
  'engines/codex-runtime.ts -> daemon/sessions.ts',
  'engines/instances.ts -> daemon/bridge-transport.ts',
  'infra/events.ts -> daemon/hydra-config.ts',
  'infra/host-health.ts -> daemon/hydra-config.ts',
  'infra/observability.ts -> daemon/session-reachability.ts',
  'infra/observability.ts -> daemon/sessions.ts',
  'gateways/slack.ts -> connectors/slack/conversation.ts',
  'gateways/slack.ts -> daemon/access.ts',
  'specialists/specialist-deliver.ts -> daemon/recovery.ts',
  'specialists/specialist-deliver.ts -> daemon/session-lifecycle.ts',
  'specialists/specialist-deliver.ts -> daemon/tool-surface.ts',
  'specialists/targets.ts -> daemon/pane-probe.ts',
  'specialists/targets.ts -> daemon/recovery.ts',
]

const skip = (p: string) => !p.endsWith('.ts') || p.endsWith('.d.ts') || p.endsWith('.test.ts') || /(^|\/)(__tests__|node_modules|docs|scripts|mods\.local|mod)\//.test(p) || p === 'test-setup.ts'

function resolveLocal(from: string, spec: string, files: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined
  const base = join(dirname(from), spec.replace(/\.(js|ts)$/, ''))
  return [base + '.ts', join(base, 'index.ts')].map(p => resolve('/', p).slice(1)).find(p => files.has(p))
}

/** Every runtime local import as `from -> to` (type-only imports are erased). Edges to files outside the scanned set are ignored. */
export function edges(files: Array<{ path: string; text: string }>): string[] {
  const paths = new Set(files.filter(f => !skip(f.path)).map(f => f.path))
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const out: string[] = []
  for (const { path, text } of files) {
    if (!paths.has(path)) continue
    const code = transpiler.transformSync(text)
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)["']([^"']+)["']/gm)) {
      const to = resolveLocal(path, m[1], paths)
      if (to && to !== path) out.push(`${path} -> ${to}`)
    }
  }
  return [...new Set(out)]
}

const counts = (xs: readonly string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())

export function violations(files: Array<{ path: string; text: string }>, allowed: readonly string[] = ALLOWED): string[] {
  const out: string[] = []
  const upward: string[] = []
  for (const f of files) if (!skip(f.path) && tierOf(f.path) === undefined) out.push(`${f.path}: has no tier. Give it one in tierOf (scripts/check-layers.ts)`)
  for (const e of edges(files)) {
    const [from, to] = e.split(' -> ')
    const a = tierOf(from), b = tierOf(to)
    if (a !== undefined && b !== undefined && a < b) upward.push(e)
  }
  const want = new Set(allowed), have = new Set(upward)
  for (const e of have) if (!want.has(e)) {
    const [from, to] = e.split(' -> ')
    out.push(`${e}: imports upward, from ${TIER_NAMES[tierOf(from)!]} (T${tierOf(from)}) to ${TIER_NAMES[tierOf(to)!]} (T${tierOf(to)}). Import from a lower tier, or move the code down; if it must stay, add it to ALLOWED and say in the PR why`)
  }
  for (const e of want) if (!have.has(e)) out.push(`${e}: no longer an upward import. Delete this entry from ALLOWED in scripts/check-layers.ts`)
  return out
}

if (import.meta.main) {
  const cwd = join(fileURLToPath(import.meta.url), '..', '..')
  const paths = execFileSync('git', ['ls-files', '*.ts'], { cwd, encoding: 'utf8' }).split('\n').filter(Boolean)
  const files = paths.map(path => ({ path, text: readFileSync(join(cwd, path), 'utf8') }))
  if (process.argv.includes('--list')) {
    const up = edges(files).filter(e => { const [f, t] = e.split(' -> '); const a = tierOf(f), b = tierOf(t); return a !== undefined && b !== undefined && a < b })
    console.log(up.sort().map(e => `  '${e}',`).join('\n'))
    console.error(`${up.length} upward imports`)
    process.exit(0)
  }
  const v = violations(files)
  if (v.length) { for (const line of v) console.error(line); process.exit(1) }
}
