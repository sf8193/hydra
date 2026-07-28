/**
 * Artifacts + context-line rendering for the Home dashboard.
 *
 * Pure module (no config/gateway/registry imports) so it stays test-importable.
 *
 * An *artifact* is a deliverable a session produces — captured from its own
 * outbound replies (GitHub PRs, Arti design docs, Claude artifacts). This is
 * distinct from a session's *context links*, which are reference URLs extracted
 * from inbound messages routed to it (see router.ts).
 */

export const MAX_ARTIFACTS = 10

// In-memory PR title cache — populated at artifact capture time, used for rendering.
// Keyed by canonical PR URL.
const prTitleCache = new Map<string, string>()
export function cachePrTitle(url: string, title: string): void { prTitleCache.set(url, title) }
export function getCachedPrTitle(url: string): string | undefined { return prTitleCache.get(url) }

// Strict per-type matchers. Each captures the pieces needed to build a *canonical*
// URL — so trailing markdown (`*`, `**`), quotes/brackets (["url"]), HTML entities
// (…/&lt;id), comment/review anchors (#discussion_r…), query strings, `http` vs
// `https`, and Arti version suffixes all normalize away. This keeps storage clean
// and makes plain-string dedup reliable (no need to grab-a-blob then trim).
// Domains are deliberately disjoint from the inbound context-link domains.
const ARTIFACT_MATCHERS: Array<{ re: RegExp; canonical: (m: RegExpExecArray) => string }> = [
  { re: /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)/g,
    canonical: m => `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` },
  { re: /https?:\/\/arti\.(?:internal\.)?angellist\.com\/s\/([A-Za-z0-9._-]+)/g,
    canonical: m => `https://arti.internal.angellist.com/s/${m[1]}` },  // drop version → link to latest
  { re: /https?:\/\/claude\.ai\/public\/artifacts\/([A-Za-z0-9._-]+)/g,
    canonical: m => `https://claude.ai/public/artifacts/${m[1]}` },
]

/** Extract canonical artifact URLs from text. Dedupes; grouped by type. */
export function extractArtifactLinks(text: string): string[] {
  const links: string[] = []
  for (const { re, canonical } of ARTIFACT_MATCHERS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) links.push(canonical(m))
  }
  return [...new Set(links)]
}

/** Re-canonicalize an already-stored list, dropping entries that no longer parse. */
export function sanitizeArtifacts(list: string[]): string[] {
  const out: string[] = []
  for (const u of list) out.push(...extractArtifactLinks(u))
  return [...new Set(out)]
}

/** Normalized identity for a GitHub PR URL (owner/repo#N), for cross-source dedup. */
function prIdentity(url: string): string | null {
  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/)
  return m ? `pr:${m[1]}/${m[2]}#${m[3]}` : null
}

/**
 * Merge newly-found artifact URLs into a session's existing list. Dedupes,
 * keeps the newest `max`, and reports whether anything new was actually added
 * (callers use `changed` to skip a dashboard refresh when nothing changed).
 * Set insertion order preserves existing-then-new, so slice(-max) keeps newest.
 */
export function mergeArtifacts(
  existing: string[] | undefined,
  found: string[],
  max: number = MAX_ARTIFACTS,
): { next: string[]; changed: boolean } {
  const set = new Set(existing ?? [])
  const before = set.size
  for (const url of found) set.add(url)
  if (set.size === before) return { next: existing ?? [], changed: false }
  return { next: [...set].slice(-max), changed: true }
}

/** Render one artifact URL as a Slack mrkdwn context line (leading bullet + 📎). */
export function renderArtifactLink(link: string): string {
  const pr = link.match(/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/)
  if (pr) {
    const title = prTitleCache.get(link)
    const label = title || `${pr[1]}#${pr[2]}`
    return `• 📎 <${link}|${label}>`
  }
  const arti = link.match(/arti\.(?:internal\.)?angellist\.com\/s\/([^/\s]+)/)
  if (arti) return `• 📎 <${link}|Arti: ${arti[1]}>`
  if (/claude\.ai\/public\/artifacts/.test(link)) return `• 📎 <${link}|Claude artifact>`
  let label: string
  try { label = new URL(link).hostname.replace(/^www\./, '') } catch { label = 'link' }
  return `• 📎 <${link}|${label}>`
}

/** Render one context (inbound-reference) URL as a Slack mrkdwn context line. */
export function renderContextLink(link: string): string {
  // Slack channel mention: slack:channel:C0ABC123:channel-name
  const channelMatch = link.match(/^slack:channel:([A-Z0-9]+):(.+)$/)
  if (channelMatch) {
    return `• 🔗 <#${channelMatch[1]}|${channelMatch[2]}>`
  }
  // Slack thread/message — render as channel link so Slack resolves the name
  const archiveMatch = link.match(/slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/)
  if (archiveMatch) {
    return `• 🔗 <${link}|thread in <#${archiveMatch[1]}>>`
  }
  let label: string
  if (/slack\.com\/archives/.test(link)) label = 'Slack thread'
  else if (/linear\.app/.test(link)) label = 'Linear'
  else if (/incident\.io/.test(link)) label = 'Incident'
  else if (/datadoghq\.com/.test(link)) label = 'Datadog'
  else if (/sentry\.io/.test(link)) label = 'Sentry'
  else if (/notion\.so/.test(link)) label = 'Notion'
  else if (/pagerduty\.com/.test(link)) label = 'PagerDuty'
  else { try { label = new URL(link).hostname.replace(/^www\./, '') } catch { label = 'link' } }
  return `• 🔗 <${link}|${label}>`
}

function checkStatusEmoji(status: string): string {
  switch (status) {
    case 'success': return '✓'
    case 'failure': return '✗'
    case 'pending': return '⏳'
    default: return ''
  }
}

export type WatchLine = { prUrl: string; title?: string; prNumber: number; lastCheckStatus: string }

/**
 * Merge the three per-session link sources into the rendered context lines for a
 * Home item, in priority order (watches → artifacts → context links), deduped
 * across sources and capped at `max` total lines. Dedup is by exact URL *and* by
 * PR identity (owner/repo/#), so a PR that is both watched and captured as an
 * artifact shows once — as the watch (with its title + CI status).
 */
export function assembleContextLines(input: {
  watches: WatchLine[]
  artifacts: string[]
  contextLinks: string[]
  max?: number
}): string[] {
  const max = input.max ?? 5
  const lines: string[] = []
  const seen = new Set<string>()

  // Mark a URL (and its PR identity, if any) as seen. Returns false if it was
  // already seen — caller skips it.
  const claim = (url: string): boolean => {
    const pr = prIdentity(url)
    if (seen.has(url) || (pr && seen.has(pr))) return false
    seen.add(url)
    if (pr) seen.add(pr)
    return true
  }

  for (const w of input.watches) {
    if (lines.length >= max) break
    if (!claim(w.prUrl)) continue
    const title = w.title || `#${w.prNumber}`
    lines.push(`• <${w.prUrl}|${title}> ${checkStatusEmoji(w.lastCheckStatus)}`)
  }

  for (const link of input.artifacts) {
    if (lines.length >= max) break
    if (!claim(link)) continue
    lines.push(renderArtifactLink(link))
  }

  for (const link of input.contextLinks) {
    if (lines.length >= max) break
    if (!claim(link)) continue
    lines.push(renderContextLink(link))
  }

  return lines
}
