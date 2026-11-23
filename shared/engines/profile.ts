// What one engine is: its name for a person, what its sessions can be asked, and the aliases and id prefix that name its models. Each engine keeps its own profile in its own file (shared/engines/<engine>.ts);
// the list in shared/engines/index.ts is the only place that names them all. A profile is plain data, so config and the CLI can read it without importing an adapter.

/** Which model a spawn that names none runs: `own` the engine asks its own runtime, `spawn` the daemon's spawn default (a Claude id), `{ alias }` one of the engine's own aliases. */
export type DefaultModel = 'own' | 'spawn' | { alias: string }

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
  /** Which model a spawn that names none runs. */
  defaultModel: DefaultModel
  /** The daemon learns the session's Claude session id (from the bridge's registration, else the pane) and keeps it on the record: the id a fork, a resume and a letter's `{{from_transcript}}` read. */
  recordsClaudeSessionId: boolean
  /** The bridge registers before the engine's channel handler is up, and a notification pushed then is dropped: a fresh session's queue waits for its first idle. */
  dropsNotificationsAtStart: boolean
  /** The turn's `confirmedComplete` is true only when the turn is over, never stale between turns: the reply guard acts on it while the pane is still active. */
  reportsTurnEnd: boolean
  /** The engine's own runtime judges its sessions' deaths (and cleans up after them), so the tmux-based crash pass leaves them alone. */
  judgesOwnDeath: boolean
  /** The engine's prompt cache lives an hour: a session idle most of that hour is handed off while the cache is still warm. */
  hasHourPromptCache: boolean
  /** A first turn can be lost to an expired login, so the spawn prompt is kept until the first turn is known to have run (then resent after login). */
  losesFirstTurnToExpiredLogin: boolean
  /** The session's MCP client waits out a long tool call (a fork turn of `ask_predecessor`) instead of stopping at a fixed timeout. */
  waitsOutLongTools: boolean
  /** The engine frames a channel message that lands mid-turn as "not from your user": a trusted sender's message is typed into the pane instead. */
  distrustsMidTurnChannel: boolean
  /** Present when no specialist can run on this engine: why, as the end of the sentence "<label> ..." (the config loader refuses a specialist that names it). */
  specialistRefusal?: string
  /** The chat aliases that name this engine's models (`spawn neon: topic`), each mapped to the model id it runs. An alias selects the engine as well as the model. */
  aliases: Readonly<Record<string, string>>
  /** Every model id that starts with this is this engine's (`gpt-` is Codex's, `gemini-` is agy's). Absent: the engine's ids are known by other means. */
  idPrefix?: string
}
