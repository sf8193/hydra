// What one engine is: its name for a person, what its sessions can be asked, and the aliases and id prefix that name its models. Each engine keeps its own profile in its own file (shared/engines/<engine>.ts);
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
  /** The chat aliases that name this engine's models (`spawn neon: topic`), each mapped to the model id it runs. An alias selects the engine as well as the model. */
  aliases: Readonly<Record<string, string>>
  /** Every model id that starts with this is this engine's (`gpt-` is Codex's, `gemini-` is agy's). Absent: the engine's ids are known by other means. */
  idPrefix?: string
}
