import { describe, test, expect, beforeAll } from 'bun:test'

// Set env before importing — config.ts reads env at module init and calls process.exit(1) without a token
process.env.DISCORD_BOT_TOKEN ??= 'test-token'
process.env.CHAT_PLATFORM ??= 'discord'
// Use a temp state dir so the test doesn't read/write real sessions
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.HYDRA_STATE_DIR = mkdtempSync(join(tmpdir(), 'hydra-templates-test-'))

// Dynamic import so the env vars above are set before module initialization
let getTemplate: typeof import('../daemon/templates.js')['getTemplate']
let listTemplates: typeof import('../daemon/templates.js')['listTemplates']
let parseTemplateTopic: typeof import('../daemon/templates.js')['parseTemplateTopic']
let buildTemplateSpawnOpts: typeof import('../daemon/templates.js')['buildTemplateSpawnOpts']

beforeAll(async () => {
  const mod = await import('../daemon/templates.js')
  getTemplate = mod.getTemplate
  listTemplates = mod.listTemplates
  parseTemplateTopic = mod.parseTemplateTopic
  buildTemplateSpawnOpts = mod.buildTemplateSpawnOpts
})

describe('getTemplate', () => {
  test('returns all builtin templates', () => {
    expect(getTemplate('review')).not.toBeNull()
    expect(getTemplate('design')).not.toBeNull()
    expect(getTemplate('build')).not.toBeNull()
    expect(getTemplate('factory')).not.toBeNull()
  })

  test('case insensitive lookup', () => {
    expect(getTemplate('Review')).not.toBeNull()
    expect(getTemplate('FACTORY')).not.toBeNull()
    expect(getTemplate('Design')).not.toBeNull()
  })

  test('returns null for unknown template', () => {
    expect(getTemplate('nonexistent')).toBeNull()
    expect(getTemplate('spawn')).toBeNull()  // reserved name, not a template
    expect(getTemplate('')).toBeNull()
  })

  test('builtin templates have prompts', () => {
    expect(getTemplate('review')?.prompt.length).toBeGreaterThan(10)
    expect(getTemplate('design')?.prompt.length).toBeGreaterThan(10)
    expect(getTemplate('factory')?.prompt.length).toBeGreaterThan(10)
  })

  test('builtin templates have correct actions', () => {
    expect(getTemplate('review')?.action).toBe('review')
    expect(getTemplate('design')?.action).toBe('design')
    expect(getTemplate('build')?.action).toBe('build')
    // factory has no action (it's a PM template, not a protocol trigger)
    expect(getTemplate('factory')?.action).toBeUndefined()
  })
})

describe('parseTemplateTopic', () => {
  test('parses template:topic format', () => {
    const result = parseTemplateTopic('review: audit the auth module')
    expect(result).not.toBeNull()
    expect(result!.templateName).toBe('review')
    expect(result!.topic).toBe('audit the auth module')
  })

  test('returns the matched template object', () => {
    const result = parseTemplateTopic('design: redesign payment flow')
    expect(result).not.toBeNull()
    expect(result!.template).not.toBeNull()
    expect(result!.template.action).toBe('design')
  })

  test('returns null for unknown template prefix', () => {
    expect(parseTemplateTopic('unknown: some topic')).toBeNull()
    expect(parseTemplateTopic('notatemplate: do stuff')).toBeNull()
  })

  test('returns null when no colon', () => {
    expect(parseTemplateTopic('just a plain topic')).toBeNull()
    expect(parseTemplateTopic('review without colon')).toBeNull()
  })

  test('returns null when colon is first character', () => {
    expect(parseTemplateTopic(': topic with no prefix')).toBeNull()
  })

  test('trims whitespace from topic', () => {
    const result = parseTemplateTopic('factory:   build something   ')
    expect(result!.topic).toBe('build something')
  })

  test('handles multiline topics', () => {
    const result = parseTemplateTopic('review: line one\nline two')
    expect(result!.topic).toBe('line one\nline two')
  })
})

describe('listTemplates', () => {
  test('returns all builtin templates', () => {
    const all = listTemplates()
    const names = all.map(t => t.name)
    expect(names).toContain('review')
    expect(names).toContain('design')
    expect(names).toContain('build')
    expect(names).toContain('factory')
  })

  test('returns at least 4 templates (the builtins)', () => {
    expect(listTemplates().length).toBeGreaterThanOrEqual(4)
  })

  test('sorted alphabetically', () => {
    const all = listTemplates()
    const names = all.map(t => t.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(names).toEqual(sorted)
  })

  test('each entry has name and prompt', () => {
    for (const t of listTemplates()) {
      expect(t.name.length).toBeGreaterThan(0)
      expect(t.prompt.length).toBeGreaterThan(0)
    }
  })
})

describe('buildTemplateSpawnOpts', () => {
  test('includes trigger string', () => {
    const template = getTemplate('review')!
    const opts = buildTemplateSpawnOpts('review', template)
    expect(opts.trigger).toBe('review:')
  })

  test('trigger matches template name with colon', () => {
    for (const { name } of listTemplates()) {
      const t = getTemplate(name)!
      const opts = buildTemplateSpawnOpts(name, t)
      expect(opts.trigger).toBe(`${name}:`)
    }
  })

  test('factory template disallows Edit/Write/NotebookEdit', () => {
    const template = getTemplate('factory')!
    const opts = buildTemplateSpawnOpts('factory', template)
    expect(opts.disallowedTools).toContain('Edit')
    expect(opts.disallowedTools).toContain('Write')
    expect(opts.disallowedTools).toContain('NotebookEdit')
  })

  test('factory template grants main tools (spawn/kill access)', () => {
    const template = getTemplate('factory')!
    const opts = buildTemplateSpawnOpts('factory', template)
    expect(opts.allowMainTools).toBe(true)
  })

  test('review template does not grant main tools', () => {
    const template = getTemplate('review')!
    const opts = buildTemplateSpawnOpts('review', template)
    expect(opts.allowMainTools).toBeFalsy()
  })

  test('includes promptPrefix from template', () => {
    const template = getTemplate('design')!
    const opts = buildTemplateSpawnOpts('design', template)
    expect(opts.promptPrefix).toBe(template.prompt)
  })

  test('model override takes priority over template model', () => {
    const template = getTemplate('review')!
    const opts = buildTemplateSpawnOpts('review', template, 'claude-opus-5[1m]')
    expect(opts.model).toBe('claude-opus-5[1m]')
  })
})
