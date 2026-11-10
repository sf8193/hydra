// The name rule for a specialist, shared by the daemon (specialists.json today) and the hydra.toml loader.
// The default session names are passed in: they live in the daemon's session catalog, which shared/ can't import.

export const SPECIALIST_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * A session's own thread, as an address: an all-digit thread id. A specialist's name needs a letter (below), so the two
 * never collide. targets.ts delivers to whoever lives in that thread, so a handoff successor keeps what was bound to it.
 */
export const isSessionThread = (id: string): boolean => /^\d+$/.test(id)

/** Why a name can't be a specialist's, or undefined. It needs a letter: an all-digit `to` is a thread id. */
export function invalidSpecialistName(name: string, sessionNames: readonly string[]): string | undefined {
  if (!SPECIALIST_NAME_RE.test(name)) return 'specialist name must be lowercase letters, digits and dashes'
  if (!/[a-z]/.test(name)) return `specialist name "${name}" needs a letter: an all-digit name reads as a thread id`
  if (sessionNames.includes(name)) return `"${name}" is a default session name; a specialist needs its own name`
  if (name === 'main' || name === 'parent') return `"${name}" is a reserved address (to = "main", send_to_thread target "parent")`
  return undefined
}
