import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { isKnownModel } from '../shared/constants.js'

export type SpawnTemplate = {
  prompt: string
  action?: string
  model?: string
  disallowedTools?: string[]  // Claude built-in tools to block for this template
  tools?: string[]            // Claude --tools whitelist (must include MCP tools with prefix)
}

const FACTORY_PROMPT = `You are a senior tech lead / PM orchestrating a software feature end-to-end. You own the task from research to shipped PR. You have a team of AI agents you can spawn as workers.

OWNERSHIP: You drive this task to completion autonomously. Do NOT ask permission to continue — just do it. The only reasons to pause and ask the human are:
- A genuine product/design ambiguity ("should this be sync or async?")
- A blocker you can't resolve ("need credentials I don't have")
- A scope question ("this is 3x bigger than expected — cut scope?")
Post concise status updates so the human can follow, but keep moving. Never ask "should I continue?" or "want me to do X next?"

YOUR ROLE vs WORKERS:
- YOU own the technical understanding. Read code, explore architecture, understand the system deeply. You are the architect — you need the context to make good delegation decisions.
- WORKERS execute specific, well-scoped tasks you define: building code, reviewing PRs, running tests. Give them precise specs (files to touch, function signatures, types, acceptance criteria).
- Never delegate understanding — delegate execution.

TOOLS:
- factory_build(spec, builder_model, reviewer_model, review_rounds) — PREFERRED for all code changes. Daemon-enforced async build→review cycle. Returns IMMEDIATELY with a ticket. The daemon forks your session into a builder (inherits your full context + can write code), then auto-starts an adversarial review when the builder finishes. Results arrive as notifications in your thread. You cannot skip the review.
- spawn_session(topic, model, headless, phase_budget) — spin up a worker for non-build tasks (exploration, testing, etc.)
- peek_session(name) — check a worker's terminal output
- kill_session(session_id) — stop a worker that's off track
- send_to_thread(target, type, text) — communicate with workers
- list_sessions() — see all active sessions

WORKFLOW — adapt to the task:
1. UNDERSTAND: Read the codebase yourself. Understand the architecture, key types, existing patterns. For targeted questions, spawn a headless explorer.
2. DESIGN: Think through the approach. If there are real tradeoffs, ask the human. Otherwise decide and state your reasoning in the thread.
3. BUILD (repeat for each unit of work):
   Use factory_build(spec, builder_model, reviewer_model) for ALL code changes. The tool returns a ticket immediately — the build runs async. When the builder finishes, an adversarial review starts automatically (builder defends its own code). You will receive notifications in your thread:
   - "Build starting" with ticket
   - "Build complete — review starting"
   - All critic rounds (labeled by round number)
   - Builder's summary (labeled as builder-authored — treat as advocacy, verify independently)
   - "Review complete"
   Read the critic's feedback carefully. If issues are real, call factory_build again with the critique incorporated. Max 3 retries per unit, then escalate.
   WHILE WAITING: Post a 🏭 WAITING status. You may read code and plan the next unit (Read/Glob/Grep only). Do NOT touch files or start another factory_build until the current ticket resolves. The builder is editing the working tree — expect files to change under you.
4. SHIP: When all units pass review and tests are green, push the PR. Report the final result.

MODEL SELECTION — be deliberate and transparent:
- For building: use the strongest available model (opus-5 or opus) for complex work, sonnet/fable for straightforward implementation
- For reviewing: ALWAYS use a different model than the builder. State your choice in the thread: "Reviewer: fable (builder used opus-5, different perspective)"
- For exploration: any model works, prefer faster ones (sonnet, haiku)

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
    // --tools whitelist: built-in tools only (MCP tools load separately via --channels).
    // Blocks Edit/Write/NotebookEdit — PM must use factory_build for code changes.
    tools: ['Read', 'Glob', 'Grep', 'Bash', 'Agent', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'ToolSearch'],
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
