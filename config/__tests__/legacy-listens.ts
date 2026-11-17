// The old `listens`, as the loader now reads it: each place becomes a rule `{place, target}` after the explicit ones (a place named by
// its id before one named `#name`), and the specialist keeps no `listens`. For the golden tests whose fixtures predate it.
type Json = Record<string, any>

/** A loaded config as an old file's golden JSON gives it (new key names), with every `listens` read as rules. */
export function listensAsRules(c: Json): Json {
  const legacy = Object.entries(c.specialists as Json).flatMap(([id, s]) => ((s.listens ?? []) as string[]).map(place => ({ place, target: id })))
  legacy.sort((a, b) => Number(a.place.includes('#')) - Number(b.place.includes('#')))
  return {
    ...c,
    rules: [...c.rules, ...legacy],
    specialists: Object.fromEntries(Object.entries(c.specialists as Json).map(([id, s]) => { const { listens: _, ...rest } = s as Json; return [id, rest] })),
  }
}

/** The warning the loader gives a specialist that still has a `listens` key. */
export const isListensWarning = (w: string): boolean => w.includes('`listens` is now `[[rules]]`')
