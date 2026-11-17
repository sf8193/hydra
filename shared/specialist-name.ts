// The name rule for a specialist, shared by the daemon (specialists.json today) and the hydra.toml loader.
// The default session names are passed in: they live in the daemon's session catalog, which shared/ can't import.

export const SPECIALIST_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/**
 * A thread id is whatever the running gateway names a thread with: digits on Discord, `<channel>:<ts>` on the Slack gateway
 * (`D0BE3RB4Y00:1792616731.235729`; the channel starts with C, D or G). The one definition of that shape: every check that asks
 * "is this a thread id?" calls it. A specialist's name is lowercase, so neither form is ever a name. targets.ts delivers to whoever
 * lives in that thread, so a handoff successor keeps what was bound to it.
 */
const THREAD_ID_RE = /^(\d+|[CDG][A-Z0-9]+:\d{1,12}\.\d{1,6})$/
export const isSessionThread = (id: string): boolean => THREAD_ID_RE.test(id)

/** What a thread id looks like, for error texts. */
export const THREAD_ID_FORMS = 'digits (Discord) or <channel>:<ts> (Slack gateway)'

/** Why a name can't be a specialist's, or undefined. It needs a letter: an all-digit `to` is a thread id. */
export function invalidSpecialistName(name: string, sessionNames: readonly string[]): string | undefined {
  if (!SPECIALIST_NAME_RE.test(name)) return 'specialist name must be lowercase letters, digits and dashes'
  if (!/[a-z]/.test(name)) return `specialist name "${name}" needs a letter: an all-digit name reads as a thread id`
  if (sessionNames.includes(name)) return `"${name}" is a default session name; a specialist needs its own name`
  if (name === 'main' || name === 'parent') return `"${name}" is a reserved address (to = "main", send_to_thread target "parent")`
  return undefined
}
