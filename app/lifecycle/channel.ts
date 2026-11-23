import { existsSync, openSync, readFileSync, readSync, closeSync } from 'fs'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'
import { CLAUDE_CONFIG, gateway } from '../../infra/config.js'
import { atomicWriteFileSync } from '../../infra/util.js'
import { authorityId, registry, threadRegistry } from '../../sessions/registry.js'
import type { Predecessor, SessionInfo, SpawnOpts } from '../../sessions/registry.js'
import { reportUnaddressableThreads } from '../../sessions/thread-route.js'
import { computeToolsForSession } from '../../engines/bridge-tools.js'
import { resolveEngine } from '../../sessions/engine-instances.js'
import type { EngineAdapter } from '../../engines/engine-adapter.js'
import type { ToolBase } from '../../shared/constants.js'
import { readHandoffTemplate } from '../handoff-templates.js'
import { projectDirName, transcriptPathFor } from '../../infra/usage.js'
import { channelListen, defaultListenOf } from '../../sessions/access.js'

// ---------------------------------------------------------------------------
// Channel resolution — determines where to create a new thread
// ---------------------------------------------------------------------------

type ChannelProbe = { isThread: boolean; isDM: boolean; parentId: string | null }
type ChannelResolution = {
  targetChannelId: string
  threadId?: string
  parentChannelId?: string
  warning?: string
}

export async function resolveSpawnChannel(
  chatId: string | undefined,
  defaultChannel: string,
  fetchChannel: (id: string) => Promise<ChannelProbe>,
  canThreadInDM: boolean,
): Promise<ChannelResolution> {
  // Every fallback lands here: an empty default would reach Discord as `GET /channels/` ("404: Not Found").
  const toDefault = (warning?: string): ChannelResolution => {
    if (!defaultChannel) throw new Error(`no channel to spawn in${warning ? ` (${warning})` : ''}: pass chat_id (the parent channel ID), or set DEFAULT_SESSION_CHANNEL in .env`)
    return { targetChannelId: defaultChannel, ...(warning ? { warning } : {}) }
  }
  if (!chatId) return toDefault()
  let ch: ChannelProbe
  try {
    ch = await fetchChannel(chatId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return toDefault(`fetchChannel(${chatId}) failed: ${msg} — falling back to default channel`)
  }
  if (ch.isThread) {
    const parentChannelId = ch.parentId ?? undefined
    if (parentChannelId) {
      // Return both: threadId so the caller can reuse the thread (respawn in
      // dead thread), and targetChannelId=parent so new thread creation lands
      // in the right channel if the thread can't be reused.
      return { targetChannelId: parentChannelId, threadId: chatId, parentChannelId }
    }
    return toDefault(`chatId ${chatId} is a thread with no parentId — structurally unexpected, falling back to default channel`)
  }
  if (ch.isDM && !canThreadInDM) {
    // Intentionally silent — DMs without thread support are expected on Slack
    return toDefault()
  }
  return { targetChannelId: chatId }
}

// ---------------------------------------------------------------------------
// Boot-time backfill — resolve anchorChannelId for sessions missing it
// ---------------------------------------------------------------------------

export async function backfillAnchorChannelIds(): Promise<void> {
  reportUnaddressableThreads()
  const missing = [...registry.values()].filter(s => !s.anchorChannelId && s.threadId && gateway.isThreadId(s.threadId))
  if (missing.length === 0) return

  process.stderr.write(`daemon: backfill: ${missing.length} session(s) missing anchorChannelId\n`)
  let filled = 0
  let failed = 0

  for (const info of missing) {
    try {
      const ch = await gateway.fetchChannel(info.threadId)
      if (ch.isThread && ch.parentId) {
        info.anchorChannelId = ch.parentId
        const thread = threadRegistry.get(info.threadId)
        if (thread && !thread.anchorChannelId) thread.anchorChannelId = ch.parentId
        filled++
      }
    } catch (err) {
      process.stderr.write(`daemon: WARNING: backfill anchorChannelId failed for ${info.tmuxName} (thread ${info.threadId}): ${err}\n`)
      failed++
    }
    // Stagger to avoid Discord rate limits during fleet recovery
    if (missing.length > 1) await new Promise(r => setTimeout(r, 200))
  }

  if (filled > 0) {
    registry.persist()
    threadRegistry.persist()
  }
  process.stderr.write(`daemon: backfill: ${filled} filled, ${failed} failed, ${missing.length - filled - failed} skipped\n`)
}

// ---------------------------------------------------------------------------
// Fork CWD resolution — exported for testing
// ---------------------------------------------------------------------------

/**
 * When forking into a worktree, the process must start in the PM's original
 * CWD (spawnCwd) so that `--resume --fork-session` can locate the conversation
 * file at ~/.claude/projects/<cwd>/<sessionId>.jsonl. For all other spawn
 * forms, use effectiveCwd (which may be the worktree path itself).
 */
export function resolveForkSpawnCwd(
  isFork: boolean,
  hasWorktree: boolean,
  spawnCwd: string,
  effectiveCwd: string,
): string {
  return (isFork && hasWorktree) ? spawnCwd : effectiveCwd
}

/**
 * Append worktree location to the prompt for fork+worktree builders.
 * The builder starts from spawnCwd (for --resume CWD compatibility), so it
 * needs an explicit path to cd into. Returns '' for all other spawn forms.
 */
export function buildWorktreePromptAppend(isFork: boolean, worktreePath: string | undefined): string {
  if (isFork && worktreePath) {
    return `\n\nWORKTREE: Your isolated worktree is at ${worktreePath}. cd there before making any code changes.`
  }
  return ''
}

// ---------------------------------------------------------------------------
// Listen state resolution: thread override → channel group → global → false
// ---------------------------------------------------------------------------

/** Tool names recorded in a spawn's sessionMetadata. Codex sessions discover
 *  tools via their own MCP sidecar, not the daemon bridge. */
export function spawnToolNames(adapter: EngineAdapter, spawnType: ToolBase): string[] {
  return adapter.channel === 'bridge' ? computeToolsForSession(spawnType, new Set()).map(t => t.name) : []
}

export function resolveListenState(threadId: string, channelId?: string): boolean {
  const thread = threadRegistry.get(threadId)
  return resolveListenStatePure(channelId, thread?.listenOverride, thread?.parentChannelId, thread?.anchorChannelId)
}

export function resolveListenStatePure(
  channelId: string | undefined,
  listenOverride?: boolean,
  parentChannelId?: string,
  anchorChannelId?: string,
): boolean {
  if (listenOverride !== undefined) return listenOverride
  for (const id of [channelId, parentChannelId, anchorChannelId]) {
    if (id) {
      const listen = channelListen(id)
      if (listen !== undefined) return listen
    }
  }
  return defaultListenOf()
}


/** Resume count for a new session resuming `resumeFrom`: the most recently
 *  dead session on that conversation's count + 1, or 0 when there is none. */
export function nextResumeCount(sessions: Iterable<SessionInfo>, resumeFrom: string): number {
  const predecessor = [...sessions]
    .filter(s => s.claudeSessionId === resumeFrom && s.deadAt)
    .sort((a, b) => (b.deadAt ?? 0) - (a.deadAt ?? 0))[0]
  return predecessor ? (predecessor.resumeCount ?? 0) + 1 : 0
}



const LAUNCH_CWD_HEAD_BYTES = 256 * 1024

/**
 * The directory a Claude session was launched from, read from its transcript: the first
 * recorded cwd whose project-dir name matches the dir the transcript lives in. `--resume`
 * looks transcripts up by that dir, and a session forked into a worktree was launched
 * from SPAWN_CWD, not from its worktree.
 */
export function claudeLaunchCwd(claudeSessionId: string): string | undefined {
  const path = transcriptPathFor(claudeSessionId)
  if (!path) return undefined
  const dir = basename(dirname(path))
  let head: string
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(LAUNCH_CWD_HEAD_BYTES)
      head = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0))
    } finally { closeSync(fd) }
  } catch { return undefined }
  for (const line of head.split('\n')) {
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
      if (typeof cwd === 'string' && projectDirName(cwd) === dir) return cwd
    } catch {}  // blank, or the truncated last line
  }
  return undefined
}

/** What it takes to fork info after it is gone, or undefined when its engine has no native id to fork. */
export function predecessorOf(info: SessionInfo): Predecessor | undefined {
  // Still alive here, so a missing native id can be learned from the running session.
  const fork = resolveEngine(info.engine).recoveryPlan(info, { discover: true }).fork
  if (!fork) return undefined
  const cwd = (fork.claudeSessionId ? claudeLaunchCwd(fork.claudeSessionId) : undefined)
    ?? info.worktree?.path ?? info.sessionMetadata?.cwd ?? process.env.SPAWN_CWD
  if (!cwd) return undefined
  const model = info.sessionMetadata?.model
  return { engine: info.engine ?? 'claude', fork, cwd, ...(model ? { model } : {}) }
}

// read_only: blocks Claude's file-editing tools. Bash remains, so it is a guard, not a sandbox.
export const READ_ONLY_DISALLOWED_TOOLS = ['Edit', 'Write', 'NotebookEdit']

/** What a successor carries off the session it continues: one copy for revive, recovery and handoff. */
export function carryOver(dead: SessionInfo): NonNullable<SpawnOpts['carryOver']> {
  return {
    artifacts: dead.artifacts, contextLinks: dead.contextLinks, description: dead.description,
    predecessor: dead.predecessor, launchCwd: dead.launchCwd, disallowedTools: dead.disallowedTools,
    parentId: authorityId(dead), initiator: dead.initiator,
    // The dead session's launch policy: a replacement continues it, or (resume, fork) is refused where it differs from hydra.toml now.
    policy: dead.policy,
    kickoffHash: dead.kickoffHash,
  }
}

/** The successor's local arrival text (<STATE_DIR>/actions/handoff/arriving.md), filled for this handoff; undefined → built-in prompt only. */
export function handoffArrival(opts: SpawnOpts, vars: { from: string; session: string; cwd: string; worktree: string; branch: string }): string | undefined {
  return readHandoffTemplate('arriving', {
    ...vars,
    artifact: opts.artifact ?? '',
    note: opts.handoffNote ?? '',
    from_session: opts.handoffFromClaudeSessionId ?? '',
    from_transcript: transcriptPathFor(opts.handoffFromClaudeSessionId) ?? '',
  })
}

/**
 * Marks folders as trusted in Claude's config, so a session launched there doesn't wait on the trust dialog.
 * For folders hydra chose (a worktree it made) or the operator declared (a specialist's workdir). Never fatal.
 */
export function preApproveClaudeTrust(paths: string[], what: string): void {
  // Atomic: a running Claude reads this file too, and must never see half of it.
  const claudeJsonPath = join(CLAUDE_CONFIG, '.claude.json')
  try {
    const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'))
    if (!claudeJson.projects) claudeJson.projects = {}
    const trustEntry = {
      allowedTools: [] as string[],
      mcpContextUris: [] as string[],
      mcpServers: {} as Record<string, unknown>,
      enabledMcpjsonServers: [] as string[],
      disabledMcpjsonServers: [] as string[],
      hasTrustDialogAccepted: true,
      hasClaudeMdExternalIncludesApproved: true,
      hasClaudeMdExternalIncludesWarningShown: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: 0,
    }
    let changed = false
    for (const p of paths) {
      const existing = claudeJson.projects[p]
      if (!existing || !existing.hasClaudeMdExternalIncludesApproved) {
        claudeJson.projects[p] = { ...existing, ...trustEntry }
        changed = true
      }
    }
    if (changed) {
      atomicWriteFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2) + '\n')
      process.stderr.write(`daemon: pre-approved trust for ${what}\n`)
    }
  } catch (err) {
    process.stderr.write(`daemon: trust pre-approval failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`)
  }
}
