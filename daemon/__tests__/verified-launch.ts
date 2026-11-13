// For tests that start a confined session through a fake engine: a debug file, as Claude Code writes it, for exactly the policy the
// launch was given, so the start's own check (engines/claude-verify.ts) passes, and a way to make it see something else.
import { BRIDGE_MCP_SERVER_KEY } from '../plugin-manifest.js'
import { expectedLoad, verifyDeps } from '../engines/claude-verify.js'
import type { ConfinedPolicy } from '../scope.js'

/** The lines of a launch's debug file that say what loaded, for a launch that loaded exactly this policy. */
export function debugLogFor(policy: Pick<ConfinedPolicy, 'servers'>, extra: string[] = []): string {
  const want = expectedLoad(policy)
  const T = '2026-11-13T04:34:18.000Z [DEBUG] '
  return [
    `[DEBUG] Applying permission update: Adding ${want.allow.length} allow rule(s) to destination 'flagSettings': ${JSON.stringify(want.allow)}`,
    '[DEBUG] [claudeai-mcp] Disabled via env var',
    '[DEBUG] Loaded inline plugin from path: hydra',
    '[DEBUG] Checking plugin hydra: skillsPath=exists, skillsPaths=0 paths',
    '[DEBUG] Checking plugin discord: skillsPath=exists, skillsPaths=0 paths',
    '[DEBUG] plugin.register: cc-plugin-privacy (builtin, cc-plugin-privacy@builtin), judged by core alone: admitted',
    '[DEBUG] Checking plugin cc-plugin-privacy: skillsPath=none, skillsPaths=0 paths',
    ...want.servers.map(s => `[DEBUG] MCP server "${s}": Starting connection with timeout of 30000ms`),
    ...want.servers.map(s => `[DEBUG] MCP server "${s}": Successfully connected (transport: stdio) in 10ms`),
    ...extra,
  ].map(l => l.startsWith('[DEBUG] ') ? T + l.slice('[DEBUG] '.length) : l).join('\n') + '\n'
}

/** Makes the check read `logFor(the policy of the latest launch)`; returns what to call to put the real reader back. */
export function verifyLaunchesAgainst(latest: () => { policy?: unknown } | undefined, logFor: (p: ConfinedPolicy) => string = p => debugLogFor(p)): () => void {
  const real = verifyDeps.read
  verifyDeps.read = () => {
    const p = latest()?.policy as ConfinedPolicy | undefined
    if (!p) throw new Error('no launch to read a debug file for')
    return logFor(p)
  }
  return () => { verifyDeps.read = real }
}

export { BRIDGE_MCP_SERVER_KEY }
