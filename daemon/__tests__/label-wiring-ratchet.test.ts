import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

// Ratchet: the cost bucket has to stay wired into the spawn path.
//
// `resolveSpawnLabel` and `deadSessionLabel` are pure and mutation-covered, but
// the sites that feed them build an object inside functions no test can invoke —
// doSpawnSession launches tmux. Deleting any of them leaves the suite green
// while the label silently stops reaching the registry, the wire, and every
// cost query built on it.
//
// session-lifecycle is the one that matters: it is the sole writer of
// SessionInfo.label, so losing it disables the feature fleet-wide. The rest are
// one recovery path's bucket each and are listed so the set stays deliberate.
// Counts, not presence: several of these appear more than once (each recovery
// tier passes its own), and dropping one of two is the likelier regression.
const REQUIRED_WIRING: Record<string, Record<string, number>> = {
  'session-lifecycle.ts': {
    // rawTopic, because `topic` has had the flag stripped out of it by then —
    // resolveSpawnLabel's own tests cannot see which string it is handed. All
    // three arguments, because dropping one silently disables that tier.
    'resolveSpawnLabel(rawTopic, opts?.label, opts?.inheritedLabel)': 1,
    // Into the live registry entry, which is what factsFromRegistry reads.
    '...labelFields,': 1,
    // And into the durable history entry a later resume reads.
    'label: sessionLabel,': 1,
  },
  'factory.ts': { 'inheritedLabel:': 1 },
  // commonOpts (tiers 2 and 3) and tryResume (tier 1).
  'recovery.ts': { 'label: recoveredLabel': 2 },
  // Three fork paths (native, thread-reconstruct, failed-fork fallback) and respawn.
  'commands/thread.ts': { 'inheritedLabel:': 4, 'deadSessionLabel(': 2 },
  // protocol-runner is deliberately absent: protocol-scenarios.test.ts asserts
  // the resumed and spawned critic's label end to end, so pinning the text here
  // would only add a second way to go red for the same regression.
}

// Comments are stripped first: this pins wiring, and text left behind in a
// `//` or a `/* */` is not wiring. Commenting out a pinned line used to keep
// this green, which made it read as coverage while catching nothing.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const occurrences = (haystack: string, needle: string): number =>
  stripComments(haystack).split(needle).length - 1

describe('cost-bucket wiring ratchet', () => {
  test.each(Object.entries(REQUIRED_WIRING))('%s still spreads its label', (file, needles) => {
    const src = readFileSync(join(import.meta.dir, '..', file), 'utf8')
    for (const [needle, count] of Object.entries(needles)) {
      expect(occurrences(src, needle), `${file}: "${needle}" — the label stops flowing there`).toBe(count)
    }
  })
})
