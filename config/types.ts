// The shape of `<state>/hydra.toml` once loaded: who Hydra recognizes, the specialists that answer, and where.
// Every default is filled in and every reference checked (config/load.ts), so a consumer reads these as facts.
// Keys are camelCase here; the file's are snake_case (`prompt_file` → `promptFile`).
// Content and actions (what may be said, tools, approvals) are out of scope: they belong to each specialist.

/** A platform hydra can connect to. A person's address and most places start with one. */
export type Platform = 'discord' | 'slack' | 'github'

/** Where a person can be reached: `discord:<user id>`, `slack:<user id>`, `github:<login>` (lowercased). One address, one person. */
export type Address = `${Platform}:${string}`

/**
 * An address hydra can hear: `slack:#help`, `slack:dm`, `discord:#feed`, `discord:dm`, `github:owner/repo` (lowercased), `cli`.
 * A Slack or Discord channel may also be named by its platform id: `slack:C0TEST`, `discord:1234567890`.
 * A place is data hydra keeps, not something declared: specialists name the ones they listen on.
 */
export type Place = string

/** Labels anyone holds without declaring them: everyone on the roster holds `people`; anyone at all holds `anyone`. */
export const BUILTIN_ROLES = ['people', 'anyone'] as const
export type BuiltinRole = typeof BUILTIN_ROLES[number]

export type Person = {
  id: string
  /** Addresses on each platform. */
  ids: Address[]
  /** Labels used only by a specialist's `allow` (and a rule's `from`). */
  roles: string[]
  /** Shown in the metadata a specialist receives. Default: the id. */
  name: string
}

export type SessionsMode = 'shared' | 'per-conversation'

export type Specialist = {
  id: string
  /** The folder it runs in, `~` expanded. Its knowledge and tools live there. */
  workdir: string
  /** What it is told on a fresh start (a revive resumes instead). At most one of the two is set. */
  prompt?: string
  /** `~` expanded; a relative path is under `workdir`. Read when it's needed, so it's not checked on load. */
  promptFile?: string
  /** Places it answers. No two specialists listen on the same place. */
  listens: Place[]
  /** Roles that may reach it. Default `['people']`. The operator is always allowed. */
  allow: string[]
  /** `shared`: one session for everything (default). `per-conversation`: one per thread. */
  sessions: SessionsMode
  /** Per-conversation cap. Extra messages stay owed. Default 20. */
  max: number
  /** End a session after this long without activity, and resume on the next message. Absent: never. */
  idleMs?: number
  /** Where you watch it (its threads open there), and where replies with no conversation go: a place or a channel id. Absent: the operator's channel. */
  home?: string
  model?: string
  engine?: 'claude' | 'codex' | 'omp'
  /** `~` expanded; a relative path is under `workdir`. */
  envFile?: string
  /** Old ids, so a rename keeps its thread, session and owed messages. */
  was: string[]
}

export type Connectors = {
  discord?: { botTokenEnv: string }
  slack?: { botTokenEnv: string; appTokenEnv?: string }
  /** `repos` are `owner/repo`, lowercased. */
  github?: { repos: string[]; pollMs: number }
}

/** Optional platform options for one place. */
export type PlaceOptions = {
  /** An emoji added when a message is picked up. */
  ack?: string
  /** Download attachments. Default false. */
  files: boolean
  /** Whether an untagged message opens a conversation. Default `mentions`. */
  listen: 'mentions' | 'all'
  /** Hear other bots. Default false; hydra's own bot is never heard. */
  bots: boolean
}

/** A clock that sends a message to a specialist. Loaded and checked now; run by B3. */
export type Schedule = {
  id: string
  /** 5 fields, local time. */
  cron: string
  to: string
  prompt: string
  /** A script run first: empty output sends nothing; its output is appended. */
  check?: string
  /** Absolute, `~` expanded. A relative `envFile` is under it. */
  cwd?: string
  envFile?: string
  runner: 'launchd' | 'daemon'
}

/** An override for when the place isn't enough. Loaded and checked now; applied by B2. First match in file order. */
export type Rule = {
  /** Required: identity can refine a place, never take one over. */
  at: Place
  /** A person or a role. Absent: anyone at that place. */
  from?: string
  to: string
}

/** The operator's hook, run after routing and the allow check. Loaded and checked now; run by B2. */
export type Guard = {
  command: string
  timeoutMs: number
  includeText: boolean
  /** How long a "not now" (exit 75) may keep a message owed. */
  owedMaxMs: number
}

export type HydraConfig = {
  /** The one person whose DMs reach `main` and who may reach every specialist. Required once anything else is declared. */
  operator?: string
  connectors: Connectors
  people: Record<string, Person>
  specialists: Record<string, Specialist>
  places: Record<Place, PlaceOptions>
  schedules: Record<string, Schedule>
  rules: Rule[]
  guard?: Guard
}

/** One finding, located by its path in the file (`specialists.zoho.listens[1]`). */
export type ConfigIssue = { path: string; message: string }

export type LoadResult =
  | { ok: true; config: HydraConfig; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] }

/** What a load needs from the machine, passed in so a test can stand in for it. */
export type LoadEnv = {
  /** Expands a leading `~`. */
  home: string
  isDir(path: string): boolean
  /** A path to an executable file, or a name found on PATH. */
  isCommand(command: string): boolean
  /** The daemon's default session names, which no specialist may take. */
  sessionNames: readonly string[]
}
