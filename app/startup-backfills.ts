import { gateway } from '../infra/config.js'
import { registry } from '../sessions/registry.js'
import { tmuxHasSession } from '../infra/tmux.js'
import { extractArtifactLinks, mergeArtifacts, sanitizeArtifacts, cachePrTitle } from '../infra/artifacts.js'
import { backfillTitles, fetchPrTitle, parsePrUrl } from '../connectors/github/pr-watch.js'
import { refreshDashboardNow } from './dashboard.js'
import { warmContextLink } from './router.js'

/** Gives each session the id of its last reply, for threads recorded before replies were tracked. Awaited by the boot chain once the gateway is up. */
export async function backfillLastReplyIds(): Promise<void> {
  if (gateway.getLastReplyId) {
    let backfilled = 0
    for (const s of registry.values()) {
      if (s.lastReplyId) continue
      try {
        const lastId = await gateway.getLastReplyId(s.threadId)
        if (lastId) { s.lastReplyId = lastId; backfilled++ }
      } catch (err) {
        process.stderr.write(`daemon: backfill failed for ${s.tmuxName} (${s.threadId}): ${err instanceof Error ? err.message : err}\n`)
      }
    }
    if (backfilled > 0) {
      registry.persist()
      process.stderr.write(`daemon: backfilled lastReplyId for ${backfilled} session(s)\n`)
    }
  }
}

// Backfill artifacts from each live session's own recent thread posts, so
// deliverables produced before this feature existed appear without waiting for a
// new reply. Idempotent (mergeArtifacts dedupes), so it's safe to run every boot.
export async function backfillArtifacts(): Promise<void> {
  if (!gateway.fetchMessages) return
  let changedCount = 0
  let dirty = false
  for (const s of registry.values()) {
    if (!tmuxHasSession(s.tmuxName)) continue
    if (s.artifactsBackfilled) continue  // one-time scan — avoids a fetch-burst on every restart
    try {
      const msgs = await gateway.fetchMessages(s.threadId, 100)
      const found: string[] = []
      for (const m of msgs) {
        // Only the session's own posts (bot-authored, in its own thread) — not the human's inbound refs.
        if (gateway.botId && m.authorId !== gateway.botId) continue
        found.push(...extractArtifactLinks(m.content))
      }
      // Re-canonicalize existing entries too, so this pass also self-heals any
      // pollution captured before the extractor was tightened.
      const before = s.artifacts ?? []
      const { next } = mergeArtifacts(sanitizeArtifacts(before), found)
      if (JSON.stringify(next) !== JSON.stringify(before)) { s.artifacts = next; changedCount++ }
      s.artifactsBackfilled = true
      dirty = true
    } catch (err) {
      // Leave the flag unset so a transient fetch failure retries next boot.
      process.stderr.write(`daemon: artifact backfill failed for ${s.tmuxName}: ${err instanceof Error ? err.message : err}\n`)
    }
  }
  if (dirty) registry.persist()
  if (changedCount > 0) {
    refreshDashboardNow()
    process.stderr.write(`daemon: backfilled artifacts for ${changedCount} session(s)\n`)
  }
}

/** The three non-blocking boot backfills (PR titles, artifact PR titles, Slack context links). Each logs its own outcome; none is awaited. */
export function startBackgroundBackfills(): void {
  // Backfill PR titles for existing watches (non-blocking)
  backfillTitles().then(n => {
    if (n > 0) {
      process.stderr.write(`daemon: backfilled ${n} PR title(s)\n`)
      refreshDashboardNow()
    }
  }).catch(err => process.stderr.write(`daemon: PR title backfill failed: ${err}\n`))

  // Backfill PR titles for artifact links (non-blocking)
  void (async () => {
    let filled = 0
    for (const s of registry.values()) {
      for (const url of s.artifacts ?? []) {
        if (!parsePrUrl(url)) continue
        try {
          const title = await fetchPrTitle(url)
          if (title) { cachePrTitle(url, title); filled++ }
        } catch {}
      }
    }
    if (filled > 0) {
      refreshDashboardNow()
      process.stderr.write(`daemon: backfilled ${filled} artifact PR title(s)\n`)
    }
  })().catch(err => process.stderr.write(`daemon: artifact title backfill failed: ${err}\n`))

  // Backfill Slack channel names + thread summaries for context links (non-blocking)
  void (async () => {
    let filled = 0
    for (const s of registry.values()) for (const url of s.contextLinks ?? []) filled += await warmContextLink(url)
    if (filled > 0) {
      refreshDashboardNow()
      process.stderr.write(`daemon: backfilled ${filled} Slack context link(s)\n`)
    }
  })().catch(err => process.stderr.write(`daemon: Slack context backfill failed: ${err}\n`))
}
