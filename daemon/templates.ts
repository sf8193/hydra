import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { isKnownModel, isSessionLabel, DEFAULT_REVIEW_ROUNDS, type SessionLabel } from '../shared/constants.js'

export type SpawnTemplate = {
  prompt: string
  action?: string
  model?: string
  disallowedTools?: string[]  // Claude built-in tools to block for this template
  tools?: string[]            // Claude --tools whitelist (must include MCP tools with prefix)
  sessionType?: 'master_orchestrator'  // Grant orchestrator-level tools (default: thread_owner)
  label?: SessionLabel        // cost bucket for the sessions this template spawns
}

const BUILTIN_TEMPLATES: Record<string, SpawnTemplate> = {
  review: {
    prompt: 'You are the owner of a review session. An adversarial review protocol will start automatically — a critic will challenge your work across multiple rounds. Defend your design and fix valid issues.',
    action: 'review',
    label: 'review',
  },
}

const RESERVED = new Set(['spawn', 'kill', 'fork', 'resume', 'respawn', 'handoff', 'listen', 'pause', 'help', 'commands', 'recover', 'sessions', 'watch', 'unwatch', 'watches', 'health', 'restart', 'reconnect', 'protocols', 'templates', 'usage'])
const VALID_ACTIONS = new Set(['review'])

const HYDRA_DIR = join(import.meta.dir, '..')

type FileCache = { mtime: number; templates: Record<string, SpawnTemplate> }
let repoCache: FileCache | null = null
let localCache: FileCache | null = null

export function loadTemplateFile(path: string, cache: FileCache | null, source: string): { templates: Record<string, SpawnTemplate>; cache: FileCache | null } {
  if (!existsSync(path)) return { templates: {}, cache: null }

  try {
    const mtime = statSync(path).mtimeMs
    if (cache && cache.mtime === mtime) return { templates: cache.templates, cache }

    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    const valid: Record<string, SpawnTemplate> = {}
    for (const [name, t] of Object.entries(raw)) {
      const entry = t as Record<string, unknown>
      if (name.includes(':')) {
        process.stderr.write(`daemon: ${source}: skipping "${name}" — template names cannot contain colons\n`)
      } else if (RESERVED.has(name.toLowerCase())) {
        process.stderr.write(`daemon: ${source}: skipping "${name}" — reserved command name\n`)
      } else if (entry && typeof entry === 'object' && typeof entry.prompt === 'string') {
        const template: SpawnTemplate = { prompt: entry.prompt }
        if (typeof entry.action === 'string') {
          if (VALID_ACTIONS.has(entry.action)) {
            template.action = entry.action
          } else {
            process.stderr.write(`daemon: ${source}: "${name}" has unknown action "${entry.action}" — ignoring it\n`)
          }
        }
        if (typeof entry.label === 'string') {
          if (isSessionLabel(entry.label)) {
            template.label = entry.label
          } else {
            process.stderr.write(`daemon: ${source}: "${name}" has unknown label "${entry.label}" — ignoring it\n`)
          }
        }
        if (typeof entry.model === 'string' && entry.model.trim()) {
          template.model = entry.model.trim()
          if (!isKnownModel(template.model)) {
            process.stderr.write(`daemon: ${source}: WARNING "${name}" has unrecognized model "${template.model}" — may be new release or typo\n`)
          }
        }
        const builtin = BUILTIN_TEMPLATES[name.toLowerCase()]
        if (builtin?.action) {
          if (!template.action) {
            process.stderr.write(`daemon: ${source}: WARNING "${name}" overrides builtin but omits action "${builtin.action}" — protocol will not auto-start\n`)
          } else if (template.action !== builtin.action) {
            process.stderr.write(`daemon: ${source}: "${name}" overrides builtin action "${builtin.action}" with "${template.action}"\n`)
          }
        }
        valid[name.toLowerCase()] = template
      } else {
        process.stderr.write(`daemon: ${source}: skipping "${name}" — missing or non-string prompt\n`)
      }
    }
    const newCache = { mtime, templates: valid }
    return { templates: valid, cache: newCache }
  } catch (err) {
    process.stderr.write(`daemon: failed to load ${source}: ${err instanceof Error ? err.message : err}\n`)
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
    ...(template.sessionType && { sessionType: template.sessionType }),
    ...(template.label && { label: template.label }),
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
    case 'review': {
      const { default: reviewProto } = await import('../protocols/review.js')
      const { startProtocolRun } = await import('./protocol-runner.js')
      await startProtocolRun(reviewProto, threadId, sessionId, { rounds: DEFAULT_REVIEW_ROUNDS, topic, strike: true, autoReviewLenses: true })
      return true
    }
    default:
      return false
  }
}
