import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { isKnownModel } from '../shared/constants.js'

export type SpawnTemplate = {
  prompt: string
  action?: string
  model?: string
  disallowedTools?: string[]  // Claude built-in tools to block for this template
  tools?: string[]            // Claude --tools whitelist (must include MCP tools with prefix)
  allowMainTools?: boolean    // Grant access to spawn_session/kill_session (default: main only)
}

const FACTORY_PROMPT = `You are a senior tech lead / PM orchestrating a software feature end-to-end. You own the task from research to shipped PR. You have a team of AI agents you can spawn as workers.

TOOLS — READ THIS FIRST:
Your tools are served via MCP and appear as *deferred* tools: their names are known but their schemas are NOT loaded, so calling one directly fails with InputValidationError. You MUST load them with ToolSearch before first use.
CRITICAL: Run this ToolSearch BEFORE doing anything else — before reading files, before replying. Every factory/spawn tool will fail until you do:
  ToolSearch(query="select:factory_build,factory_retry,factory_accept,factory_abandon,factory_status,factory_review,spawn_session,peek_session,kill_session,send_to_thread,list_sessions,reply,fetch_messages,set_description")
If any tool call ever returns InputValidationError, the fix is always the same: ToolSearch for that tool name, then retry.

- factory_build(spec, difficulty?, builder_model?, reviewer_model?, review_rounds?, fresh?) — PREFERRED for all code changes. Async build→review cycle, returns a ticket immediately. Model selection via difficulty ladder (easy/medium/hard, default easy). Pass fresh=true when your context is large — builder starts without your conversation history, so include file paths, architecture context, and test commands in the spec. Multiple builds can run in parallel if they touch different files.
- factory_retry(ticket, instructions) — after review, send new instructions to the still-alive builder. Re-enters build→review cycle. The builder already has full context.
- factory_accept(ticket) — accept the build, kill the builder, done.
- factory_abandon(ticket) — give up on the build, kill the builder.
- factory_review(name, topic?, reviewer_model?, review_rounds?) — run adversarial review on an existing session without a full build cycle. Use to re-review work or review non-factory sessions.
- factory_status(ticket?) — check status of your builds (phase, elapsed, builder name).
- spawn_session(topic, model, headless, phase_budget) — spin up a worker for non-build tasks (exploration, testing, etc.). When you spawn a worker into an existing thread, tell it to read the history first: fetch_messages(channel=threadId, limit=50).
- peek_session(name) — check a worker's terminal output
- kill_session(session_id) — stop a worker that's off track
- send_to_thread(target, type, text) — communicate with workers
- list_sessions() — see all active sessions

OWNERSHIP: You drive this task to completion autonomously. Do NOT ask permission to continue — just do it. The only reasons to pause and ask the human are:
- A genuine product/design ambiguity ("should this be sync or async?")
- A blocker you can't resolve ("need credentials I don't have")
- A scope question ("this is 3x bigger than expected — cut scope?")
Post concise status updates so the human can follow, but keep moving. Never ask "should I continue?" or "want me to do X next?"

YOUR ROLE vs WORKERS:
- YOU own the technical understanding. Read code, explore architecture, understand the system deeply. You are the architect — you need the context to make good delegation decisions.
- WORKERS execute specific, well-scoped tasks you define: building code, reviewing PRs, running tests. Give them precise specs (files to touch, function signatures, types, acceptance criteria).
- Never delegate understanding — delegate execution.

WORKFLOW — adapt to the task:
1. UNDERSTAND: Read the codebase yourself. Understand the architecture, key types, existing patterns. For targeted questions, spawn a headless explorer.
2. DESIGN: Think through the approach. If there are real tradeoffs, ask the human. Otherwise decide and state your reasoning in the thread.
3. BUILD (repeat for each unit of work):
   Use factory_build(spec) for ALL code changes. Model selection is automatic — override only when you have a reason. The tool returns a ticket immediately — the build runs async. You will receive notifications:
   - "Build starting" with ticket
   - "Build complete — review starting"
   - Critic rounds (labeled by round number)
   - "Review complete — awaiting your decision"
   After review, you MUST act on the ticket:
   - factory_accept(ticket) — if the work is good
   - factory_retry(ticket, "fix X") — if issues need fixing (builder stays alive with full context)
   - factory_abandon(ticket) — if the approach is wrong, start fresh
   Max 3 retries per unit, then escalate.
   PARALLEL BUILDS: You can run multiple factory_build calls concurrently if they touch different files. Use factory_status() to track all active builds.
   WHILE WAITING: Post a 🏭 WAITING status. You may read code and plan the next unit (Read/Glob/Grep only). Do NOT touch files the builder is working on.
   COMMUNICATING WITH BUILDERS: Builders may ask you questions via send_to_thread. You'll receive these as notifications — respond via send_to_thread(target="builder_name", type="result", text="..."). You can also proactively send guidance to builders the same way.
4. SHIP: When all units pass review and tests are green, push the PR. Report the final result.

MODEL SELECTION — difficulty ladder:
- factory_build selects models based on difficulty:
  easy (default): sonnet builds, opus reviews — use for most tasks
  medium: opus builds, opus-4-8 reviews — complex logic, tricky edge cases
  hard: opus-5 builds, fable reviews — new subsystems, architectural work
- Override with builder_model/reviewer_model only when you have a specific reason
- Different model versions (e.g. opus-4-6 vs opus-4-8) provide useful diversity for reviews
- For exploration workers: any model works, prefer faster ones (sonnet, haiku)

VISIBILITY — every message you post MUST start with a structured status header so the human can tell at a glance what's happening:

🏭 <your-name> (PM) · <PHASE>
<what's happening right now>

Phases: RESEARCHING, DESIGNING, BUILDING, REVIEWING, ITERATING, SHIPPING, BLOCKED, DONE

Examples:
  🏭 seedling (PM) · RESEARCHING
  Reading cucumber.rs to map test coverage gaps

  🏭 seedling (PM) · BUILDING
  Spawned fern (opus-5, 20m) — implementing BPU formula fix in portfolio_limits.rs

  🏭 seedling (PM) · REVIEWING
  Spawned cedar (fable) — reviewing fern's BPU formula fix against spec

  🏭 seedling (PM) · ITERATING
  Review found 2 issues. Spawning new builder with critique.

  🏭 seedling (PM) · BLOCKED
  Need human decision: should BPU use /100 or /10000?

  🏭 seedling (PM) · DONE
  PR #142 merged. 119 scenarios passing, 3 bugs fixed.

The human should be able to scroll the thread and instantly see: who did what, in what phase, with what model, and what the current state is.`

const BUILTIN_TEMPLATES: Record<string, SpawnTemplate> = {
  review: {
    prompt: 'You are the owner of a review session. An adversarial review protocol will start automatically — a critic will challenge your work across multiple rounds. Defend your design and fix valid issues.',
    action: 'review',
  },
  design: {
    prompt: 'You are a design session. A multi-persona design process will start automatically in your thread. Participate as the owner — answer questions from the personas and guide the synthesis toward a concrete implementation plan.',
    action: 'design',
  },
  build: {
    prompt: 'You are the owner of a build session. A multi-agent build protocol will start automatically — a builder will implement the task and a critic will review each round. Guide the process and answer questions.',
    action: 'build',
  },
  factory: {
    prompt: FACTORY_PROMPT,
    disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    allowMainTools: true,
  },
}

const RESERVED = new Set(['spawn', 'kill', 'fork', 'resume', 'respawn', 'listen', 'pause', 'help', 'commands', 'recover', 'sessions', 'watch', 'unwatch', 'watches', 'health', 'restart', 'reconnect', 'protocols', 'templates', 'usage'])
const VALID_ACTIONS = new Set(['review', 'build', 'design'])

const HYDRA_DIR = join(import.meta.dir, '..')

type FileCache = { mtime: number; templates: Record<string, SpawnTemplate> }
let repoCache: FileCache | null = null
let localCache: FileCache | null = null

function loadTemplateFile(path: string, cache: FileCache | null, label: string): { templates: Record<string, SpawnTemplate>; cache: FileCache | null } {
  if (!existsSync(path)) return { templates: {}, cache: null }

  try {
    const mtime = statSync(path).mtimeMs
    if (cache && cache.mtime === mtime) return { templates: cache.templates, cache }

    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const valid: Record<string, SpawnTemplate> = {}
    for (const [name, t] of Object.entries(raw)) {
      const entry = t as Record<string, unknown>
      if (name.includes(':')) {
        process.stderr.write(`daemon: ${label}: skipping "${name}" — template names cannot contain colons\n`)
      } else if (RESERVED.has(name.toLowerCase())) {
        process.stderr.write(`daemon: ${label}: skipping "${name}" — reserved command name\n`)
      } else if (entry && typeof entry === 'object' && typeof entry.prompt === 'string') {
        const template: SpawnTemplate = { prompt: entry.prompt }
        if (typeof entry.action === 'string') {
          if (VALID_ACTIONS.has(entry.action)) {
            template.action = entry.action
          } else {
            process.stderr.write(`daemon: ${label}: "${name}" has unknown action "${entry.action}" — ignoring it\n`)
          }
        }
        if (typeof entry.model === 'string' && entry.model.trim()) {
          template.model = entry.model.trim()
          if (!isKnownModel(template.model)) {
            process.stderr.write(`daemon: ${label}: WARNING "${name}" has unrecognized model "${template.model}" — may be new release or typo\n`)
          }
        }
        const builtin = BUILTIN_TEMPLATES[name.toLowerCase()]
        if (builtin?.action) {
          if (!template.action) {
            process.stderr.write(`daemon: ${label}: WARNING "${name}" overrides builtin but omits action "${builtin.action}" — protocol will not auto-start\n`)
          } else if (template.action !== builtin.action) {
            process.stderr.write(`daemon: ${label}: "${name}" overrides builtin action "${builtin.action}" with "${template.action}"\n`)
          }
        }
        valid[name.toLowerCase()] = template
      } else {
        process.stderr.write(`daemon: ${label}: skipping "${name}" — missing or non-string prompt\n`)
      }
    }
    const newCache = { mtime, templates: valid }
    return { templates: valid, cache: newCache }
  } catch (err) {
    process.stderr.write(`daemon: failed to load ${label}: ${err instanceof Error ? err.message : err}\n`)
    return { templates: {}, cache: null }
  }
}

function loadAllTemplates(): Record<string, SpawnTemplate> {
  const repoResult = loadTemplateFile(join(HYDRA_DIR, 'templates.json'), repoCache, 'templates.json')
  repoCache = repoResult.cache

  const localResult = loadTemplateFile(join(HYDRA_DIR, 'templates.local.json'), localCache, 'templates.local.json')
  localCache = localResult.cache

  return { ...BUILTIN_TEMPLATES, ...repoResult.templates, ...localResult.templates }
}

export function getTemplate(name: string): SpawnTemplate | null {
  return loadAllTemplates()[name.toLowerCase()] ?? null
}

export function listTemplates(): Array<{ name: string; prompt: string; action?: string; model?: string }> {
  const all = loadAllTemplates()
  return Object.entries(all)
    .map(([name, t]) => ({ name, prompt: t.prompt, action: t.action, model: t.model }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function parseTemplateTopic(raw: string): { templateName: string; template: SpawnTemplate; topic: string } | null {
  const colonIdx = raw.indexOf(':')
  if (colonIdx <= 0) return null
  const candidate = raw.slice(0, colonIdx).trim().toLowerCase()
  const t = getTemplate(candidate)
  if (!t) return null
  return { templateName: candidate, template: t, topic: raw.slice(colonIdx + 1).trim() }
}

export function buildTemplateSpawnOpts(templateName: string, template: SpawnTemplate, modelOverride?: string): Record<string, unknown> {
  const resolvedModel = modelOverride ?? template.model
  return {
    promptPrefix: template.prompt,
    ...(resolvedModel && { model: resolvedModel }),
    ...(template.disallowedTools?.length && { disallowedTools: template.disallowedTools }),
    ...(template.tools?.length && { tools: template.tools }),
    ...(template.allowMainTools && { allowMainTools: true }),
    trigger: `${templateName}:`,
  }
}

export async function runTemplateAction(
  action: string,
  threadId: string,
  sessionId: string,
  topic: string,
): Promise<boolean> {
  switch (action) {
    case 'design': {
      const { startDesign } = await import('./design.js')
      await startDesign(threadId, topic)
      return true
    }
    case 'review': {
      const { startReview } = await import('./adversarial.js')
      await startReview(threadId, sessionId, 3, topic)
      return true
    }
    case 'build': {
      const { startBuild } = await import('./build.js')
      await startBuild(threadId, sessionId, 3, topic)
      return true
    }
    default:
      return false
  }
}
