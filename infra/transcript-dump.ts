// Data-safety half of preserve-then-strike (golden pattern 14c): protocol
// messages are never deleted without a raw dump on disk first. This is the
// guarantee layer — the curated checkpoint genre (naming, format, citation;
// see the workstream's harvested design forks) may supersede its form, but
// never the guarantee.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { gateway, STATE_DIR } from './config.js'
import { atomicWriteFileSync } from './util.js'

const TRANSCRIPTS_DIR = join(STATE_DIR, 'transcripts')

export type TranscriptEntry = { ts: string; author: string; content: string }

// A sentinel-tagged first line marks substance; short italic one-liners are
// protocol scaffolding (status edits, banners). Both are preserved — the
// split just puts the exchange where a reader starts.
const MAX_SCAFFOLDING_LENGTH = 200

function isScaffolding(content: string): boolean {
  const firstLine = content.split('\n')[0].trim()
  if (firstLine.startsWith('[')) return false
  return content.length < MAX_SCAFFOLDING_LENGTH && (firstLine.startsWith('_') || firstLine.startsWith('**'))
}

export function formatTranscript(
  protocol: string,
  threadId: string,
  entries: TranscriptEntry[],
  totalTracked: number,
  meta: Record<string, string> = {},
  statusHistory?: string[],
): string {
  const exchange = entries.filter(e => !isScaffolding(e.content))
  const scaffolding = entries.filter(e => isScaffolding(e.content))
  const metaLines = Object.entries(meta).map(([k, v]) => `> ${k}: ${v}`)
  return [
    `# ${protocol} transcript — thread ${threadId}`,
    '',
    `> Pre-deletion dump; ${entries.length}/${totalTracked} tracked messages captured (${exchange.length} exchange, ${scaffolding.length} scaffolding).`,
    ...metaLines,
    '',
    '## The exchange',
    '',
    ...exchange.map(e => `### [${e.ts}] ${e.author}\n\n${e.content}\n`),
    ...(scaffolding.length > 0
      ? ['## Scaffolding (status lines, banners)', '', ...scaffolding.map(e => `- \`[${e.ts}]\` ${e.content.split('\n')[0]}`)]
      : []),
    ...(statusHistory && statusHistory.length > 0
      ? ['', '## Transitions', '', ...statusHistory.map((line, i) => `${i + 1}. ${line}`)]
      : []),
  ].join('\n')
}

/** Dump the tracked messages to disk. Returns the file path, or null if the
 *  dump failed or was incomplete — callers must NOT delete on null. */
export async function dumpTranscript(
  threadId: string,
  protocol: string,
  messageIds: string[],
  meta: Record<string, string> = {},
  statusHistory?: string[],
): Promise<string | null> {
  try {
    const wanted = new Set(messageIds)
    const msgs = await gateway.fetchMessages(threadId, 100)
    const entries = msgs
      .filter(m => wanted.has(m.id))
      .map(m => ({ ts: m.createdAt.toISOString(), author: m.authorUsername, content: m.content }))
      .sort((a, b) => a.ts.localeCompare(b.ts))
    if (entries.length < messageIds.length) {
      // Fetch window too small (busy thread: >100 messages since the first
      // tracked one) or messages already gone. A partial dump must not
      // authorize deletion — refuse loudly, leave everything in place.
      process.stderr.write(`daemon: transcript dump for ${threadId}: captured ${entries.length}/${messageIds.length} tracked messages — refusing (partial dump cannot authorize deletion)\n`)
      return null
    }
    mkdirSync(TRANSCRIPTS_DIR, { recursive: true })
    const shortId = threadId.slice(-4)
    const path = join(TRANSCRIPTS_DIR, `${protocol}-${Date.now()}-${shortId}.md`)
    atomicWriteFileSync(path, formatTranscript(protocol, threadId, entries, messageIds.length, meta, statusHistory))
    return path
  } catch (err) {
    process.stderr.write(`daemon: transcript dump failed for ${threadId}: ${err}\n`)
    return null
  }
}
