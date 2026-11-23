import { registry } from '../sessions/registry.js'
import { transport } from '../sessions/bridge-transport.js'
import { safeSend } from '../infra/util.js'
import { gateway } from '../infra/config.js'
import { emojiOfName } from '../sessions/anchor-state.js'
import { resolveModelAlias } from '../shared/constants.js'
import type { ProviderId } from '../engines/engine-adapter.js'
import { doSpawnSession } from './session-lifecycle.js'
import { parseTemplateTopic, buildTemplateSpawnOpts, runTemplateAction, getTemplate } from './templates.js'
import { debouncedRefreshListDisplay } from './commands/status.js'
import { confirmedStuckState, isBlockingKind, resolveStuckFromHome } from './pane-probe.js'
import { handleResumeIntercept } from './commands/thread.js'
import { refreshDashboardNow } from './dashboard.js'
import { daemonPastOrphanGrace } from '../sessions/occupancy.js'
import { homeRecoverable } from '../infra/home-status.js'

const liveDeps = {
  session: (sessionId: string) => registry.get(sessionId),
  connected: (sessionId: string) => transport.has(sessionId),
  stuck: confirmedStuckState,
  daemonWarm: () => daemonPastOrphanGrace(),
  send: safeSend,
  resume: handleResumeIntercept,
  resolveStuck: resolveStuckFromHome,
  refresh: refreshDashboardNow,
}

export async function runHomeStatusAction(sessionId: string, shown: string, deps: typeof liveDeps = liveDeps): Promise<void> {
  try {
    const info = deps.session(sessionId)
    if (!info) return
    if (shown === 'disconnected') {
      if (deps.connected(sessionId) || !homeRecoverable(info.sessionType, deps.stuck(info.tmuxName), deps.daemonWarm())) return
      const [anchorId] = await deps.send(info.threadId, `> ⏯️ Recover requested for **${info.tmuxName}** from the Home tab.`)
      if (!anchorId) {
        process.stderr.write(`daemon: home recover ${info.tmuxName}: thread post failed, recover not started\n`)
        return
      }
      await deps.resume({ id: anchorId, channelId: info.threadId, isThread: true, effectiveThreadId: info.threadId })
    } else if (isBlockingKind(shown)) {
      await deps.resolveStuck(info.tmuxName, shown)
    }
  } finally {
    deps.refresh()
  }
}

/** The Home tab's "spawn" box: a topic, optionally `template [model]:` prefixed and `--codex` flagged, becomes a session. */
export async function runHomeSpawnAction(topic: string, userId: string): Promise<void> {
  try {
    let parsed = parseTemplateTopic(topic)
    let modelOverride: string | undefined
    let engine: ProviderId | undefined

    // "review sonnet: topic" — parseTemplateTopic sees "review sonnet" as candidate, misses it.
    // Fall back: split prefix on space to find "template model: topic".
    if (!parsed) {
      const colonIdx = topic.indexOf(':')
      if (colonIdx > 0) {
        const prefix = topic.slice(0, colonIdx).trim().toLowerCase()
        const spaceIdx = prefix.indexOf(' ')
        if (spaceIdx > 0) {
          const tplName = prefix.slice(0, spaceIdx)
          const modelAlias = prefix.slice(spaceIdx + 1)
          const tpl = getTemplate(tplName)
          const resolved = resolveModelAlias(modelAlias)
          if (tpl && resolved) {
            parsed = { templateName: tplName, template: tpl, topic: topic.slice(colonIdx + 1).trim() }
            modelOverride = resolved
          }
        }
      }
    }

    let cleanTopic = parsed?.topic || topic

    // --codex flag support
    if (/\s*--codex\b/.test(cleanTopic)) {
      engine = 'codex'
      cleanTopic = cleanTopic.replace(/\s*--codex\b/, '').trim()
    }
    if (!cleanTopic.trim()) {
      const hint = parsed?.templateName ?? 'review'
      void gateway.send(userId, `_Need a topic — e.g. \`${hint}: describe the task\`_`).catch(() => {})
      return
    }

    const spawnOpts = {
      ...(parsed && buildTemplateSpawnOpts(parsed.templateName, parsed.template, modelOverride)),
      ...(engine && { engine }),
      initiator: userId,
    }

    const result = await doSpawnSession(cleanTopic, undefined, undefined, spawnOpts)

    if (parsed) {
      const parts: string[] = [`**${parsed.templateName}** template`]
      if (modelOverride) parts.push(`model \`${modelOverride}\``)
      void safeSend(result.threadId, `_Using ${parts.join(' · ')}_`)
      if (parsed.template.action) {
        try {
          await runTemplateAction(parsed.template.action, result.threadId, result.sessionId, cleanTopic)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          void safeSend(result.threadId, `_Action **${parsed.template.action}** failed: ${errMsg}_`)
        }
      }
    }

    // Notify main bridge so the main session sees the spawn
    const mainBridge = transport.get('main')
    if (mainBridge) {
      const label = parsed?.templateName
      const labelSuffix = label ? ` (${label})` : ''
      const modelSuffix = modelOverride ? ` [${modelOverride}]` : ''
      transport.sendToBridge(mainBridge, {
        type: 'notification',
        content: `[system] Spawned ${emojiOfName(result.name)} \`${result.name}\`${labelSuffix}${modelSuffix} for: ${cleanTopic}${result.url ? ` — ${result.url}` : ''}`,
        meta: { chat_id: 'home', message_id: '', user: 'system', user_id: userId, ts: new Date().toISOString() },
      })
    }

    process.stderr.write(`daemon: home:spawn created session ${result.name}${parsed ? ` (template: ${parsed.templateName})` : ''}\n`)
    refreshDashboardNow()
    debouncedRefreshListDisplay()
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`daemon: home:spawn failed: ${errMsg}\n`)
    void gateway.send(userId, `_Spawn failed: ${errMsg}_`).catch(() => {})
  }
}
