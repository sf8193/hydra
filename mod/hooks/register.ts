// Hydra's Claude Code mod. The daemon copies mod/ to <state dir>/mods/hydra at boot and
// every session it spawns loads it via CLAUDE_CODE_PLUGIN_DIRS (shared/mods.ts).
// Needs Claude Code >= 2.1.287.
import type { On } from 'claude-code'
import { channelChats } from './reply.ts'
import { submittedPrUrls } from './watch.ts'
import { usageReport } from './usage.ts'

const BRIDGE = 'plugin:discord:discord'
// Chats with a Discord message this session hasn't answered (reply) or acknowledged (react) yet.
const unanswered = new Set<string>()
// Two chats were waiting at once (byte): which one an answer is for is unknown, so the daemon's guard handles them.
let ambiguous = false
// Rate-limit windows moved (or none reported yet) and the daemon has not been told.
let usageUnsent = true

export function register(on: On) {
  // A PR this session opened or pushed gets watched, so review comments reach its thread.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    // Settled together, so one refused watch doesn't skip the rest. Output redirected to a file or run in the background shows no URLs.
    await Promise.allSettled(submittedPrUrls(e.command, r.text ?? '').map(pr_url => $.mcp.call(BRIDGE, 'watch_pr', { pr_url })))
    return r
  })

  // An observer of each measurement: it goes on first.
  // - Context fill goes in the status line as `ctx: N%`, the shape daemon/util.ts's footer reader takes first: Claude
  //   Code's own used percentage. Every session hydra launches loads this mod, so none needs a statusline script. The
  //   daemon computes the same figure from the transcript, so the two agree while the session runs on its launch model.
  //   A context with no fill (a new conversation) clears the line, so the daemon's fallback never reads a stale one.
  // - Account-wide rate limits go to the daemon for its usage alerts. Byte alone reports: the limits are the
  //   account's, so one reporter is enough. A failed report is retried next time.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    if (e.changed.includes('context')) $.ui.status(e.context.percent === undefined ? undefined : `ctx: ${e.context.percent}%`)
    if (e.changed.includes('rateLimits')) usageUnsent = true
    if (!usageUnsent || e.rateLimits.length === 0) return r
    try {
      if (await $.env.get('HYDRA_ROLE') !== 'main') return r
      const sent = await $.mcp.call(BRIDGE, 'report_usage', usageReport(e.rateLimits))
      if (!sent.isError) usageUnsent = false
    } catch {}
    return r
  })

  // A session that ends (exit, /clear, resume) takes its context line with it: the next conversation starts empty.
  on('session.end', ($, e, next) => {
    $.ui.status(undefined)
    return next(e)
  })

  // Reply guard: a turn that answered a Discord message in the transcript only gets its answer sent to the chat.
  on('prompt.submit', async ($, e, next) => {
    for (const chat of channelChats(e.text)) unanswered.add(chat)
    if (unanswered.size > 1) ambiguous = true
    // The session's own thread, restated with every prompt: a compaction summary drops it, and a notice with no chat_id would then leave the session guessing where to reply.
    const thread = await $.env.get('HYDRA_THREAD_ID')
    return next(thread ? { ...e, context: [...(e.context ?? []), `Your own chat_id (reply here unless a message names another chat): ${thread}`] } : e)
  })
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if ((e.tool === 'mcp__plugin_discord_discord__reply' || e.tool === 'mcp__plugin_discord_discord__react') && !r.deny && !r.isError) unanswered.delete(String(e.chat_id))
    return r
  })
  // Stop is the main loop ending a turn (an API error raises StopFailure, a subagent SubagentStop). A session that is
  // still waiting on background work or a scheduled wakeup has not given its answer yet.
  on('classic.Stop', async ($, e, next) => {
    if ((e.background_tasks?.length ?? 0) + (e.session_crons?.length ?? 0) > 0) return next(e)
    if (ambiguous) {
      unanswered.clear()
      ambiguous = false
    } else if (e.last_assistant_message && unanswered.size === 1) {
      const [chat_id] = unanswered
      const r = await $.mcp.call(BRIDGE, 'reply', { chat_id, text: e.last_assistant_message })
      if (!r.isError) unanswered.clear()
    }
    return next(e)
  })
  // An interrupted turn raises no Stop; its message is left to the daemon's guard, so a later turn's answer isn't sent for it.
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId && e.isAborted) {
      unanswered.clear()
      ambiguous = false
    }
    return next(e)
  })
}
