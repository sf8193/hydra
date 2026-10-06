// Hydra's Claude Code mod. The daemon copies mod/ to <state dir>/mods/hydra at boot and
// every session it spawns loads it via CLAUDE_CODE_PLUGIN_DIRS (shared/mods.ts).
// Needs Claude Code >= 2.1.287.
import type { On } from 'claude-code'
import { submittedPrUrls } from './watch.ts'

export function register(on: On) {
  // A PR this session opened or pushed gets watched, so review comments reach its thread.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    // Settled together, so one refused watch doesn't skip the rest. Output redirected to a file or run in the background shows no URLs.
    await Promise.allSettled(submittedPrUrls(e.command, r.text ?? '').map(pr_url => $.mcp.call('plugin:discord:discord', 'watch_pr', { pr_url })))
    return r
  })
}
