// What one engine is, so far: its name for a person, and what its sessions can be asked. Each engine keeps its own profile in its own file (shared/engines/<engine>.ts);
// the list in shared/engines/index.ts is the only place that names them all. A profile is plain data, so config and the CLI can read it without importing an adapter.

export type EngineProfile = {
  /** How a notice about one of the engine's sessions names it. */
  label: string
  /** Can run a session with less than the operator's access: restricted (`restricted = true`) or write-confined (`can_only_write_to`). */
  limitsAccess: boolean
  /** A new session can start as a fork of another session's conversation (`fork_from`). */
  forkable: boolean
  /** A `read_only` spawn really blocks writes. */
  enforcesReadOnly: boolean
  /** `respawn +f` can layer a template's tools and session type onto the session. */
  takesTemplates: boolean
}
