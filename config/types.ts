// The shape of `<state>/hydra.toml` once loaded: who Hydra recognizes, the specialists that answer, and where.
// Every default is filled in and every reference checked (config/load.ts), so a consumer reads these as facts.
// Keys are camelCase here; the file's are snake_case (`kickoff_file` → `kickoffFile`).
// Content (what may be said, approvals) is out of scope: it belongs to each specialist. What a specialist's session may
// reach is not: `restricted` says whether it runs in its folder alone, `tools` and `mcp_servers` (with `[mcp_servers.*]`) list what a restricted
// specialist may use, and `sends_to` names the specialists it may send to.

/** A platform hydra can connect to. A person's address and most places start with one. */
export const PLATFORMS = ['discord', 'slack', 'github'] as const
export type Platform = typeof PLATFORMS[number]
/** A platform a daemon can run as its chat gateway (`CHAT_PLATFORM`): every Platform but the code host. */
export type ChatPlatform = Exclude<Platform, 'github'>

/** Where a person can be reached: `discord:<user id>`, `slack:<user id>`, `github:<login>` (lowercased). One address, one person. */
export type Address = `${Platform}:${string}`

/** A Slack app's id: lowercase, so it can never be taken for a channel id (`C0TEST`); at most 35, since it can become the app's display name. */
export const SLACK_APP_ID_RE = /^[a-z][a-z0-9_-]{0,34}$/
/** A person's id in `[people]`: lowercase letters, digits and dashes. */
export const PERSON_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const REPO_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]+$/
const CHANNEL_NAME_RE = /^#[a-z0-9][a-z0-9_-]*$/
/** A Slack conversation id as a group DM or private channel has it: `G…` (older workspaces) or `C…`, then capitals and digits. */
const SLACK_CONVERSATION_ID_RE = /^[CG][A-Z0-9]+$/

/**
 * What a place is. `channel`: a channel by name or by the platform's id. `person-dm`: the operator's DM with one `[people]` person. `app-dm`: a DM with one
 * Slack app's bot, from anyone (Discord has one bot, so only every one of them). `group-dm`: one group DM. `repository`: a code repository. `cli`: the command line.
 */
export const PLACE_KINDS = ['channel', 'person-dm', 'app-dm', 'group-dm', 'repository', 'cli'] as const
export type PlaceKind = typeof PLACE_KINDS[number]
/** The kinds written with `*` for every one of them. A channel or a repository has no such form: a rule that means every place leaves `place` out. */
export const EVERY_KINDS = ['person-dm', 'app-dm', 'group-dm'] as const
/** The ref that, on a kind of `EVERY_KINDS`, means every place of that kind. */
export const EVERY = '*'

/**
 * Where something happened, once parsed from its toml string (`parsePlace`): the platform, what kind of place, and which one (`ref`).
 * A concrete place is what an inbound message happened at; a place with ref `*` (`isEvery`) is only ever written, in a rule or `[places]`, and covers every concrete place of its kind.
 * `ref` is a channel name with its `#` (`#help`), a platform id, a person id, an app id, or `owner/repo` (lowercased); `cli` has the ref `cli`.
 * A place is data hydra keeps, not something declared: a `[[rules]]` entry names the ones a specialist hears.
 */
export type Place = { readonly platform: Platform | 'cli'; readonly kind: PlaceKind; readonly ref: string }

/** The one string a place is keyed by (`[places]`, log lines, `hydra route`): what the operator writes. `parsePlace(placeKey(p))` is `p`. */
export function placeKey(p: Place): string {
  if (p.kind === 'cli') return 'cli'
  if (p.kind === 'channel' || p.kind === 'repository') return `${p.platform}:${p.ref}`
  return `${p.platform}:${p.kind}:${p.ref}`
}

export const placeOf = (platform: Platform | 'cli', kind: PlaceKind, ref: string): Place => ({ platform, kind, ref })
/** Whether this place is `*` of its kind. */
export const isEvery = (p: Place): boolean => p.ref === EVERY
/** `p`'s kind with `*`, when its kind has one: the place that covers `p`. */
export const everyOf = (p: Place): Place | undefined => (EVERY_KINDS as readonly PlaceKind[]).includes(p.kind) && !isEvery(p) ? { ...p, ref: EVERY } : undefined
export const samePlace = (a: Place, b: Place): boolean => placeKey(a) === placeKey(b)
/** A channel written by its name (`#help`), as opposed to its platform id. */
export const isChannelName = (p: Place): boolean => p.kind === 'channel' && p.ref.startsWith('#')
/**
 * Whether a rule at `earlier` takes every message a rule at `later` would: `placeCovers`, or the same Slack conversation by id. The loader cannot tell a
 * group DM's id from a channel's, so the channel key `slack:G0X` and `slack:group-dm:G0X` name one conversation, and neither is worth more than the other.
 */
export const placeShadows = (earlier: Place, later: Place): boolean => {
  if (placeCovers(earlier, later)) return true
  const byId = (p: Place) => p.platform === 'slack' && ((p.kind === 'channel' && !isChannelName(p)) || (p.kind === 'group-dm' && !isEvery(p)))
  return byId(earlier) && byId(later) && earlier.ref === later.ref
}
/** Whether `pattern` names `place`: the same platform and kind, and the same ref or `*`. */
export const placeCovers = (pattern: Place, place: Place): boolean =>
  pattern.platform === place.platform && pattern.kind === place.kind && (pattern.ref === place.ref || isEvery(pattern))
/** Whether any of `at` is named by `pattern`. */
export const coversAny = (pattern: Place, at: readonly Place[]): boolean => at.some(a => placeCovers(pattern, a))
/** A DM with the bot of an app (on Discord, its one bot). */
export const isDmPlace = (p: Place): boolean => p.kind === 'app-dm'
/** A DM between other people: the operator's with one person, or a group DM. The bot is not part of the first. */
export const namesDmWithOthers = (p: Place): boolean => p.kind === 'person-dm' || p.kind === 'group-dm'

const PLACE_FORMS = 'slack:#channel, slack:<channel id>, slack:person-dm:<person>, slack:app-dm:<app>, slack:group-dm:<G id>, discord:#channel, discord:<channel id>, discord:app-dm:*, github:owner/repo or cli (person-dm, app-dm and group-dm also take * for every one)'

/**
 * The one reader of a place's toml string, `platform:thing` (or `cli`). Syntax only: whether a person, an app or a repo exists is the loader's to check.
 * A form an earlier version wrote (`slack:dm`, `slack:dm:<person>`, `slack:group-dm`, `discord:dm`) is an error that names the form to write now.
 */
export function parsePlace(raw: string): { ok: true; place: Place } | { ok: false; error: string } {
  const bad = (why: string) => ({ ok: false as const, error: `"${raw}" ${why}` })
  if (raw === 'cli') return { ok: true, place: placeOf('cli', 'cli', 'cli') }
  const colon = raw.indexOf(':')
  const platform = raw.slice(0, colon) as Platform
  const rest = raw.slice(colon + 1)
  if (colon < 0 || !(PLATFORMS as readonly string[]).includes(platform)) return bad(`is not a place: use ${PLACE_FORMS}`)
  const ok = (kind: PlaceKind, ref: string) => ({ ok: true as const, place: placeOf(platform, kind, ref) })
  if (platform === 'github') {
    const repo = rest.toLowerCase()
    return REPO_RE.test(repo) ? ok('repository', repo) : bad('is not a place: a GitHub place is a repository, github:owner/repo')
  }
  // The forms an earlier version wrote, each with its replacement.
  const gone = 'slack:dm is gone: it named a DM without saying whose. Write slack:person-dm:<person> (the operator\'s DM with one person), slack:app-dm:<app> (a DM with one app\'s bot; a single-app setup\'s app is `default`) or slack:group-dm:<G id> (one group DM); each also takes * for every one'
  if (rest === 'dm') return bad(platform === 'slack' ? `is the old form of a DM with a Slack app. ${gone}; slack:app-dm:* is what slack:dm meant` : 'is the old form: write discord:app-dm:*')
  if (platform === 'slack' && rest.startsWith('dm:')) {
    const person = rest.slice(3)
    return bad(PERSON_ID_RE.test(person) ? `is the old form of the operator's DM with a person: write slack:person-dm:${person}` : `is not a place. ${gone}`)
  }
  if (platform === 'slack' && rest === 'group-dm') return bad('is the old form of every group DM: write slack:group-dm:* (or slack:group-dm:<G id> for one)')
  if (CHANNEL_NAME_RE.test(rest) || (platform === 'slack' ? SLACK_CONVERSATION_ID_RE.test(rest) : /^\d+$/.test(rest))) return ok('channel', rest)
  const kind = (['person-dm', 'app-dm', 'group-dm'] as const).find(k => rest.startsWith(`${k}:`))
  if (!kind) return bad(`is not a place: use ${PLACE_FORMS}`)
  const ref = rest.slice(kind.length + 1)
  if (platform === 'discord') {
    if (kind !== 'app-dm') return bad(`is not a Discord place: Discord has one bot, so there is no ${kind === 'person-dm' ? 'DM with one person' : 'group DM'} to name; its DM is discord:app-dm:*`)
    return ref === EVERY ? ok(kind, ref) : bad('is not a Discord place: Discord has one bot, so its DM is discord:app-dm:*')
  }
  if (ref === EVERY) return ok(kind, ref)
  if (kind === 'person-dm') return PERSON_ID_RE.test(ref) ? ok(kind, ref) : bad('is not a place: person-dm takes a person id from [people] (lowercase letters, digits, dashes) or *')
  if (kind === 'app-dm') return SLACK_APP_ID_RE.test(ref) ? ok(kind, ref) : bad('is not a place: app-dm takes the id of a Slack app declared in [slack.apps.<id>] (lowercase) or *')
  return SLACK_CONVERSATION_ID_RE.test(ref) ? ok(kind, ref) : bad('is not a place: group-dm takes a Slack conversation id (G… or C…) or *')
}

/** A specialist's `home_place` as a Place, or undefined when it has none or is a bare channel id (which names no platform). */
export function homePlaceOf(s: { homePlace?: string }): Place | undefined {
  const r = s.homePlace === undefined ? undefined : parsePlace(s.homePlace)
  return r?.ok ? r.place : undefined
}

/** A place known to parse, for code and tests that write one out. Throws on a malformed string. */
export function mustParsePlace(raw: string): Place {
  const r = parsePlace(raw)
  if (!r.ok) throw new Error(r.error)
  return r.place
}

/**
 * The options set for one place: its own entry, else the entry of every place of its kind. The entry is taken whole, so a setting the
 * specific entry leaves out is not read from the wildcard one. Entries are keyed by `placeKey`.
 */
export function optionsOf(places: Readonly<Record<string, PlaceOptions>>, p: Place): PlaceOptions | undefined {
  const own = placeKey(p)
  if (Object.hasOwn(places, own)) return places[own]
  const every = everyOf(p)
  return every !== undefined && Object.hasOwn(places, placeKey(every)) ? places[placeKey(every)] : undefined
}

/** The options that apply to a message that happened at `at` (concrete places, most specific first): a specific entry before a wildcard one, then the earliest place. */
export function optionsAt(places: Readonly<Record<string, PlaceOptions>>, at: readonly Place[]): PlaceOptions | undefined {
  for (const p of at) if (Object.hasOwn(places, placeKey(p))) return places[placeKey(p)]
  for (const p of at) { const every = everyOf(p); if (every && Object.hasOwn(places, placeKey(every))) return places[placeKey(every)] }
  return undefined
}

/** Labels anyone holds without declaring them: everyone on the roster holds `people`; anyone at all holds `anyone`. */
export const BUILTIN_ROLES = ['people', 'anyone'] as const
export type BuiltinRole = typeof BUILTIN_ROLES[number]

export type Person = {
  id: string
  /** Addresses on each platform. */
  addresses: Address[]
  /** Labels used only by a specialist's `reachable_by` (and a rule's `person`). */
  roles: string[]
  /** Shown in the metadata a specialist receives. Absent: the sender's Slack display name, else the id. Only a label: a display name is the sender's own text, so trust `person`, `roles` and `operator`, not this. */
  name?: string
}

export const SESSIONS_MODES = ['shared', 'per-conversation'] as const
export type SessionsMode = typeof SESSIONS_MODES[number]

/**
 * What fires a schedule's slot. launchd (the default): a launchd calendar entry runs the check at each slot, once on wake
 * for a slot missed asleep, and leaves its result for the daemon to deliver. daemon: the daemon's clock, which retries a slot until it is done.
 */
export const RUNNERS = ['launchd', 'daemon'] as const
export type Runner = typeof RUNNERS[number]

/** A precondition the daemon checks before a daemon schedule's slot runs. */
export const NEEDS = ['internet'] as const
export type Need = typeof NEEDS[number]

/** The built-in tools a restricted specialist (`restricted = true`) may list. Anything else runs code or reaches past its folder. */
export const WORKDIR_TOOLS = ['Read', 'Grep', 'Glob'] as const

/** A server specialists may list in `mcp_servers`, declared `[mcp_servers.<name>]`. Per-operator: only hydra.toml declares one. */
export type McpServer = {
  name: string
  /** The executable (a path or a name on PATH). */
  command: string
  /** Names in the state dir's `.env`; only these reach the server. */
  tokenEnv: string[]
  /** The server's tools a specialist may call. */
  tools: string[]
  /** For a `can_only_write_to` specialist: arguments added to the server's command, with {profile_dir} and {download_dir} for its own browser folders. */
  profileArgs?: string[]
  /** `hydra specialist browser`: the command (argv, `{profile_dir}`/`{download_dir}` placeholders) that opens this server's browser, headed, on the specialist's profile folder, for the operator to log it in. Per-operator: no browser is named in hydra's code. */
  loginCommand?: string[]
  /** `hydra specialist browser`: file names a running browser leaves in a profile folder in use (Chromium's `SingletonLock`, Firefox's `.parentlock`): if one is there, the profile is in use and the command refuses. */
  profileLocks?: string[]
  /** For a `can_only_write_to` specialist: variables set for the server, same placeholders. */
  profileEnv?: Record<string, string>
  /** For a `can_only_write_to` specialist: tools of this server its session may not call, each written as a `permissions.deny` rule `mcp__<server>__<tool>`. */
  denyTools?: string[]
}

export type Specialist = {
  id: string
  /** The folder it runs in, `~` expanded. Its knowledge and tools live there. */
  workdir: string
  /** What it is told on a fresh start (a revive resumes instead). At most one of the two is set. */
  kickoff?: string
  /** `~` expanded; a relative path is under `workdir`. Read when it's needed, so it's not checked on load. */
  kickoffFile?: string
  /**
   * Pins it to Slack apps (ids). It answers only messages that come through those apps. Those apps deliver only to specialists pinned to them.
   * Absent: unpinned. It answers messages through every app that no specialist is pinned to.
   */
  pinnedTo?: string[]
  /** The Slack app it posts as when no message came in (its `home_place`, a new thread). Absent: its first pinned app, else `default`. If pinned, one of `pinned_to`. */
  speaksAs?: string
  /** Roles (never people) that may reach it: `reachable_by`. Default `["people"]`. The operator is always allowed. */
  reachableBy: string[]
  /** `shared`: one session for everything (default). `per-conversation`: one per thread. */
  sessions: SessionsMode
  /** Per-conversation cap. Extra messages stay owed. Default 20. */
  maxSessions: number
  /** End a session after this long without activity, and resume on the next message. Absent: never. */
  idleMs?: number
  /** The Place it posts to when nobody wrote to it first (a new thread), and where replies with no conversation go: a place or a channel id. toml key `home_place`. Absent: the operator's channel. */
  homePlace?: string
  model?: string
  /** Shown in its sessions' thread names in place of the default session emoji: one emoji character. Absent: the default. */
  emoji?: string
  engine?: 'claude' | 'codex' | 'omp'
  /**
   * `true`: its session runs in its folder with only the tools and servers it lists, and it can answer only its own conversation.
   * `false` (default): the operator's account, with all their tools, servers and files.
   */
  restricted: boolean
  /** `can_only_write_to = "workdir"` (not with `restricted`): the operator's account and tools, with Bash and Edit/Write writes confined to `workdir` and its own browser profile in it. Absent: writes anywhere. */
  canOnlyWriteTo?: 'workdir'
  /** `can_only_write_to` or `cannot_read` set: paths Claude Code's tools and shell may not read, added to the built-in credential places (those, and the other specialists' workdirs, are worked out at launch). */
  cannotRead?: string[]
  /** `can_only_write_to` only: the folder (inside `workdir`, `~` expanded, relative to `workdir`) given to its listed servers as `{profile_dir}`; its downloads go beside it as `<folder>-downloads`. Absent: `<workdir>/.browser/profile` and `.../downloads`. Names the folder; does not confine the browser process. */
  browserProfile?: string
  /** The layer's: Bash command patterns it may not run, on top of the confinement. */
  denyCommands?: string[]
  /** `restricted` only: the built-in tools it may use (default Read, Grep, Glob). */
  tools?: string[]
  /** `restricted`: the `[mcp_servers.<name>]` servers it may use (default none). `can_only_write_to`: the servers started for it with its own browser profile. */
  mcpServerNames?: string[]
  /** `restricted` only: the specialists its session may send to with `send_to_thread` (default none). Shared-session specialists; never `main`. */
  sendsTo?: string[]
  /** `~` expanded; a relative path is under `workdir`. */
  envFile?: string
  /** Old ids, so a rename keeps its thread, session and owed messages. */
  renamedFrom: string[]
}

/**
 * One Slack app this hydra runs as, declared `[slack.apps.<id>]`.
 * The token fields name environment variables; the tokens themselves stay in `.env`. Defaults are filled in.
 */
export type SlackApp = {
  /** The table's key: lowercase `[a-z][a-z0-9_-]*`, at most 35 characters, so it can never be taken for a Slack channel id (uppercase). */
  id: string
  botTokenEnv: string
  /** Socket Mode's app-level token. Required for Slack to connect; not for `hydra slack manifest`. */
  socketTokenEnv?: string
  /** The operator's token (a Slack user token), used only to read threads the bot is not in; never to post. */
  operatorTokenEnv?: string
  /** What the app is called: in `hydra slack manifest`, and in every alert, health line and notice hydra says about it. As set, else `hydra` for `default` and the id for any other. */
  displayName: string
  /** What the manifest says the app does: as set, else a default (which mentions the operator token when there is one). */
  description: string
}

/** The app named `default`, used where nothing names an app. */
export const DEFAULT_SLACK_APP = 'default'

/** The Slack app hydra connects (`default`), or undefined when hydra.toml declares none. */
export function defaultSlackApp(config: Pick<HydraConfig, 'slackApps'>): SlackApp | undefined {
  return Object.hasOwn(config.slackApps, DEFAULT_SLACK_APP) ? config.slackApps[DEFAULT_SLACK_APP] : undefined
}

/** Whether hydra.toml declares any Slack app: Slack is on. */
export const slackConfigured = (config: Pick<HydraConfig, 'slackApps'>): boolean => Object.keys(config.slackApps).length > 0

/** Event sources hydra hears from. */
export type Connectors = {
  /** `repos` are `owner/repo`, lowercased. */
  github?: { repos: string[]; pollMs: number }
}

/** How the operator talks to hydra. The Slack gateway reads its tokens from `.env`, so only Discord is declared. */
export type Gateways = {
  discord?: { botTokenEnv: string }
}

/** Optional platform options for one place. */
export type PlaceOptions = {
  /** The Slack reaction name added when a message is picked up, like `eyes`: the name, never the character or `:eyes:`. Only the Slack connector reads it. Only the Slack connector reads it. */
  ack?: string
  /** Download attachments. Default false. */
  files: boolean
  /** Which messages open a conversation: `addressed` (a DM or a tag of the app) or `all` (any top-level message). Default `addressed`. */
  messages: 'addressed' | 'all'
  /** Hear other bots. Default false; hydra's own bot is never heard. */
  bots: boolean
  /**
   * A Slack channel or the bot's DM. Whether a person's emoji reaction is delivered to the session that owns the conversation it is in:
   * `bot-messages` (only on a message the bot posted), `all` (on any message of a conversation hydra holds), or `off`. Default `off`.
   * Who may be heard is the place's rules, as for a message.
   */
  reactions: 'off' | 'bot-messages' | 'all'
  /**
   * Whether links in what hydra posts here unfurl into previews (Slack `unfurl_links`/`unfurl_media`, Discord's suppress-embeds flag), on each
   * gateway's one sending point: replies, new threads, DMs, buttons, alerts, Discord edits and button clicks. Not Slack edits (`chat.update` has
   * no such argument), and not a Discord channel given by name. Default true. A preview can show readers content they could not open themselves, and fetches the URL with whatever is in it.
   */
  linkPreviews: boolean
  /**
   * A Slack channel only. Which app answers an unmentioned message when several apps are in the channel.
   * Absent: the app named `default` if it is there, else the first app in hydra.toml order that is.
   */
  defaultApp?: string
}

/** A clock that sends a message to a specialist. Loaded and checked here; run by the daemon. */
export type Schedule = {
  id: string
  /** 5 fields, local time. */
  cron: string
  /** A specialist or `main`. Absent: a sensor. Its check runs and its result is recorded; a failure alerts the operator. */
  target?: string
  /** What is sent each run (after a check's output, when there is one). */
  message: string
  /** A script run first: empty output sends nothing; its output is appended. */
  check?: string
  /** Absolute, `~` expanded. A relative `envFile` is under it. */
  workdir?: string
  envFile?: string
  runner: Runner
  /** Defined and validated, but never fires on either runner: its launchd entry is unregistered, the daemon clock skips it. */
  paused?: true
  /** An IANA zone name: `cron` is that zone's wall-clock time, not the host's. Daemon runner only. */
  timezone?: string
  /** Daemon runner only: preconditions checked before a run; unmet is deferred, and the slot stays owed. */
  needs?: Need[]
  /** Daemon runner only: how long a failure run lasts before the operator is alerted, once. Default 1 day. */
  alertAfterMs?: number
}

/**
 * Who answers what: the one home of "which target answers a place". Checked when hydra.toml loads, applied by `route()`. First match in file order.
 * A rule names a place, an app, or both; identity (`person`) only refines them. A rule with `person` alone is an error.
 * Two rules that take every message at one place through one app are an error: the later could never match.
 */
export type Rule = {
  /** A place. Absent: every place. At least one of `place` and `app` is set: identity can refine them, never take them over. */
  place?: Place
  /** A Slack app id (`default`, or a `[slack.apps.<id>]`). Absent: every app. */
  app?: string
  /** A person or a role. Absent: anyone there. */
  person?: string
  /** A specialist or `main`. */
  target: string
}

/**
 * The places where specialist `id` answers every message: the `place` of its `[[rules]]` that name no `person` (or `anyone`), in file order.
 * A rule with a `person` takes only those people's messages, so it does not make the place the specialist's to answer.
 */
export const placesAnsweredBy = (cfg: Pick<HydraConfig, 'rules'>, id: string): Place[] =>
  [...new Map(cfg.rules.flatMap(r => r.target === id && r.place !== undefined && (r.person === undefined || r.person === 'anyone') ? [[placeKey(r.place), r.place] as const] : [])).values()]

/** The operator's hook, run after routing and the `reachable_by` check. Checked when hydra.toml loads, run by the Slack watcher after routing. */
export type Guard = {
  command: string
  timeoutMs: number
  includeText: boolean
  /** How long a deferred (exit 75) may keep a message owed. */
  owedMaxMs: number
}

/** When the vitals tick tells the operator the host is in trouble. Every key has a default (config/load.ts `VITALS_DEFAULTS`). */
export type Vitals = {
  /** Overload: the 15-minute load at least this many times the core count... */
  overloadLoadPerCore: number
  /** ...while host CPU idle is under this %. macOS load counts waiting threads, so load alone is no overload. */
  overloadIdlePct: number
  /**
   * Memory off macOS (Linux): swap used at least this % of the swap total, for `ticks` in a row. Not used on macOS, whose
   * swap total grows by whole swap files on demand, so used/total moves with allocation, not with pressure. There the
   * OS's pressure level is judged: warn or critical for `ticks` in a row alerts; critical alerts at once, even after a
   * warn alert; each has its own `memory_cooldown`. A missing level there is no reading.
   */
  swapUsedPct: number
  /** Consecutive vitals ticks (one a minute) a condition must hold before it alerts. */
  ticks: number
  /**
   * Overload is not judged for this long after the machine wakes from sleep: every due job fires at once on wake. A loop
   * stall does not count as a wake where the OS can tell them apart (macOS); elsewhere a stall of 60 s or more does.
   */
  resumeSettleMs: number
  /** At most one memory alert this often while the daemon runs, even across episodes (a restart starts afresh). */
  memoryCooldownMs: number
}

/** `[main]`. `model` as written (an alias, or a full ID); whatever starts main resolves it as a specialist's `model` is. */
export type MainOptions = { model: string }

export type HydraConfig = {
  /** The one person whose DMs reach `main` and who may reach every specialist. Required once anything else is declared. */
  operator?: string
  /** `[main]`: how main (the operator's harness) runs. Absent when it sets nothing. */
  main?: MainOptions
  connectors: Connectors
  gateways: Gateways
  /** Every Slack app, by id (no prototype: look one up with Object.hasOwn). */
  slackApps: Record<string, SlackApp>
  people: Record<string, Person>
  specialists: Record<string, Specialist>
  /** Per-place options, keyed by `placeKey`: read through `optionsOf` / `optionsAt`, which put a specific entry before a wildcard one. */
  places: Record<string, PlaceOptions>
  schedules: Record<string, Schedule>
  rules: Rule[]
  /** The servers specialists may list in `mcp_servers`. Absent when none is declared. */
  mcpServers?: Record<string, McpServer>
  /** Folders (`~` expanded) no `restricted = true` specialist's workdir may be, hold or sit inside, beyond the built-in ones. Absent: none. */
  offLimits?: string[]
  /** `[restricted] allow_unproven_macos = true`: restricted specialists that list servers may launch on a macOS version the sandbox is not proven on. Absent: they are refused there. */
  allowUnprovenMacos?: boolean
  guard?: Guard
  /** Absent: `VITALS_DEFAULTS`. */
  vitals?: Vitals
}

/** One finding, located by its path in the file (`rules[1].target`). */
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
  // What a restricted check needs. All required: a load on a machine that cannot answer is not one that skips the question,
  // so `hydra config check` and `hydra config add` pass the same real probes the daemon does (systemEnv).
  /** The state dir: hydra.toml, `.env` and the daemon's records live there. */
  stateDir: string
  /** Claude's config folder (CLAUDE_CONFIG_DIR): its account state and transcripts. */
  claudeConfigDir: string
  /** The path with symlinks resolved, or the path itself when it does not exist. */
  realpath(path: string): string
  exists(path: string): boolean
  /** The MCP server names a Claude Code config file declares (`mcpServers`, and under `projects[<key>]` for each project key given). [] only when the file does not exist; a file that cannot be read or parsed throws, naming it. */
  mcpNamesIn(path: string, projects?: readonly string[]): string[]
  /** Whether the state dir's `.env` sets this variable (to something non-blank). */
  envFileHas(name: string): boolean
  /** Whether the path is, or sits inside, a git work tree. */
  isGitWorkTree(path: string): boolean
  /** What lies under the folder that a restricted session must not be able to reach. */
  scanWorkdir(dir: string): WorkdirScan
  /** `sw_vers -productVersion` on macOS (`15.7.9`); undefined when this is not macOS. */
  macosVersion: string | undefined
  /** The chat platform this daemon runs. On `slack` the gateway holds `SLACK_GATEWAY_TOKEN_ENVS`, so no connector app may name them. */
  platform: ChatPlatform
}

/** What looking through a folder found. `truncated`: it stopped at its entry cap, so the rest is unseen. */
export type WorkdirScan = {
  /** Symlinks that resolve outside the folder (the first few); a dangling one counts. */
  escapingSymlinks: string[]
  /** `.git` entries in folders below the top one (the first few). */
  nestedGit: string[]
  truncated: boolean
}
