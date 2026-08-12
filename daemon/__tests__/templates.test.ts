import { describe, test, expect, beforeEach } from 'bun:test'
import { getTemplate, listTemplates, parseTemplateTopic, buildTemplateSpawnOpts } from '../templates.js'

// Suppress stderr (template loader writes warnings when .json files are missing)
process.stderr.write = (() => true) as any

// ---------------------------------------------------------------------------
// getTemplate
// ---------------------------------------------------------------------------

describe('getTemplate', () => {
  test('returns builtin review template', () => {
    const t = getTemplate('review')
    expect(t).not.toBeNull()
    expect(t!.prompt).toContain('adversarial review')
    expect(t!.action).toBe('review')
  })

  test('returns builtin design template', () => {
    const t = getTemplate('design')
    expect(t).not.toBeNull()
    expect(t!.prompt).toContain('design session')
    expect(t!.action).toBe('design')
  })

  test('returns builtin build template', () => {
    const t = getTemplate('build')
    expect(t).not.toBeNull()
    expect(t!.prompt).toContain('build session')
    expect(t!.action).toBe('build')
  })

  test('returns builtin factory template', () => {
    const t = getTemplate('factory')
    expect(t).not.toBeNull()
    expect(t!.prompt).toContain('senior tech lead')
    expect(t!.disallowedTools).toContain('Edit')
    expect(t!.disallowedTools).toContain('Write')
    expect(t!.allowMainTools).toBe(true)
  })

  test('factory prompt leads with the ToolSearch instruction (before OWNERSHIP)', () => {
    const t = getTemplate('factory')!
    const toolSearchIdx = t.prompt.indexOf('ToolSearch(query="select:factory_build')
    const ownershipIdx = t.prompt.indexOf('OWNERSHIP:')
    const workflowIdx = t.prompt.indexOf('WORKFLOW')
    expect(toolSearchIdx).toBeGreaterThan(-1)
    expect(ownershipIdx).toBeGreaterThan(-1)
    // ToolSearch must come first so a deferred-tool agent loads its tools before acting.
    expect(toolSearchIdx).toBeLessThan(ownershipIdx)
    expect(t.prompt).toContain('READ THIS FIRST')
    expect(t.prompt).toContain('InputValidationError')
    // And the tool block is not duplicated (it was moved, not copied).
    const firstToolSearch = t.prompt.indexOf('ToolSearch(query="select:factory_build')
    const lastToolSearch = t.prompt.lastIndexOf('ToolSearch(query="select:factory_build')
    expect(firstToolSearch).toBe(lastToolSearch)
    expect(workflowIdx).toBeGreaterThan(toolSearchIdx)
  })

  test('returns null for unknown template', () => {
    expect(getTemplate('nonexistent-template-xyz')).toBeNull()
  })

  test('returns null for empty string', () => {
    expect(getTemplate('')).toBeNull()
  })

  test('is case-insensitive — "Review" finds "review"', () => {
    const lower = getTemplate('review')
    const upper = getTemplate('Review')
    const mixed = getTemplate('REVIEW')
    expect(upper).toEqual(lower)
    expect(mixed).toEqual(lower)
  })

  test('is case-insensitive — "FACTORY" finds factory', () => {
    const t = getTemplate('FACTORY')
    expect(t).not.toBeNull()
    expect(t!.allowMainTools).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

describe('listTemplates', () => {
  test('contains all 4 builtin templates', () => {
    const list = listTemplates()
    const names = list.map(t => t.name)
    expect(names).toContain('review')
    expect(names).toContain('design')
    expect(names).toContain('build')
    expect(names).toContain('factory')
  })

  test('is sorted alphabetically', () => {
    const list = listTemplates()
    const names = list.map(t => t.name)
    const sorted = [...names].sort((a, b) => a.localeCompare(b))
    expect(names).toEqual(sorted)
  })

  test('each entry has name and prompt', () => {
    const list = listTemplates()
    for (const t of list) {
      expect(typeof t.name).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(typeof t.prompt).toBe('string')
      expect(t.prompt.length).toBeGreaterThan(0)
    }
  })

  test('review has action=review', () => {
    const list = listTemplates()
    const review = list.find(t => t.name === 'review')
    expect(review?.action).toBe('review')
  })

  test('design has action=design', () => {
    const list = listTemplates()
    const design = list.find(t => t.name === 'design')
    expect(design?.action).toBe('design')
  })

  test('build has action=build', () => {
    const list = listTemplates()
    const build = list.find(t => t.name === 'build')
    expect(build?.action).toBe('build')
  })

  test('factory has no action (uses disallowedTools instead)', () => {
    const list = listTemplates()
    const factory = list.find(t => t.name === 'factory')
    expect(factory).toBeDefined()
    expect(factory?.action).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// parseTemplateTopic
// ---------------------------------------------------------------------------

describe('parseTemplateTopic', () => {
  test('happy path: "review: check the code"', () => {
    const result = parseTemplateTopic('review: check the code')
    expect(result).not.toBeNull()
    expect(result!.templateName).toBe('review')
    expect(result!.topic).toBe('check the code')
    expect(result!.template).not.toBeNull()
  })

  test('trims whitespace from topic', () => {
    const result = parseTemplateTopic('review:   lots of spaces   ')
    expect(result!.topic).toBe('lots of spaces')
  })

  test('unknown template name returns null', () => {
    const result = parseTemplateTopic('notreal: do something')
    expect(result).toBeNull()
  })

  test('no colon returns null', () => {
    const result = parseTemplateTopic('review check the code')
    expect(result).toBeNull()
  })

  test('colon at position 0 (":something") returns null', () => {
    const result = parseTemplateTopic(': something')
    expect(result).toBeNull()
  })

  test('empty string returns null', () => {
    const result = parseTemplateTopic('')
    expect(result).toBeNull()
  })

  test('case-insensitive template name — "Review: topic"', () => {
    const lower = parseTemplateTopic('review: topic')
    const upper = parseTemplateTopic('Review: topic')
    expect(upper).not.toBeNull()
    expect(upper!.templateName).toBe('review')
    expect(upper!.topic).toBe(lower!.topic)
  })

  test('topic with internal colons preserved — "review: check foo: bar"', () => {
    const result = parseTemplateTopic('review: check foo: bar')
    expect(result).not.toBeNull()
    expect(result!.topic).toBe('check foo: bar')
  })

  test('factory template parses correctly', () => {
    const result = parseTemplateTopic('factory: build the auth module')
    expect(result).not.toBeNull()
    expect(result!.templateName).toBe('factory')
    expect(result!.topic).toBe('build the auth module')
  })

  test('empty topic after colon is allowed (trimmed to empty string)', () => {
    const result = parseTemplateTopic('review:')
    expect(result).not.toBeNull()
    expect(result!.topic).toBe('')
  })
})

// ---------------------------------------------------------------------------
// buildTemplateSpawnOpts
// ---------------------------------------------------------------------------

describe('buildTemplateSpawnOpts', () => {
  test('always includes promptPrefix', () => {
    const t = getTemplate('review')!
    const opts = buildTemplateSpawnOpts('review', t)
    expect(typeof opts.promptPrefix).toBe('string')
    expect((opts.promptPrefix as string).length).toBeGreaterThan(0)
  })

  test('always includes trigger', () => {
    const t = getTemplate('review')!
    const opts = buildTemplateSpawnOpts('review', t)
    expect(opts.trigger).toBe('review:')
  })

  test('trigger matches template name with colon', () => {
    for (const name of ['review', 'design', 'build', 'factory']) {
      const t = getTemplate(name)!
      const opts = buildTemplateSpawnOpts(name, t)
      expect(opts.trigger).toBe(`${name}:`)
    }
  })

  test('model override takes priority over template.model', () => {
    const t: ReturnType<typeof getTemplate> = { prompt: 'test', model: 'claude-opus-4-6[1m]' }
    const opts = buildTemplateSpawnOpts('test', t!, 'claude-sonnet-4-6[1m]')
    expect(opts.model).toBe('claude-sonnet-4-6[1m]')
  })

  test('template model used when no override', () => {
    const t = { prompt: 'test', model: 'claude-opus-4-6[1m]' }
    const opts = buildTemplateSpawnOpts('test', t)
    expect(opts.model).toBe('claude-opus-4-6[1m]')
  })

  test('no model field when neither template nor override provides one', () => {
    const t = { prompt: 'test prompt' }
    const opts = buildTemplateSpawnOpts('test', t)
    expect(opts.model).toBeUndefined()
  })

  test('factory template includes disallowedTools', () => {
    const t = getTemplate('factory')!
    const opts = buildTemplateSpawnOpts('factory', t)
    expect(Array.isArray(opts.disallowedTools)).toBe(true)
    expect((opts.disallowedTools as string[])).toContain('Edit')
    expect((opts.disallowedTools as string[])).toContain('Write')
  })

  test('factory template includes allowMainTools=true', () => {
    const t = getTemplate('factory')!
    const opts = buildTemplateSpawnOpts('factory', t)
    expect(opts.allowMainTools).toBe(true)
  })

  test('non-factory template does not include disallowedTools', () => {
    const t = getTemplate('review')!
    const opts = buildTemplateSpawnOpts('review', t)
    expect(opts.disallowedTools).toBeUndefined()
  })

  test('non-factory template does not include allowMainTools', () => {
    const t = getTemplate('review')!
    const opts = buildTemplateSpawnOpts('review', t)
    expect(opts.allowMainTools).toBeUndefined()
  })

  test('promptPrefix matches template prompt', () => {
    const t = getTemplate('review')!
    const opts = buildTemplateSpawnOpts('review', t)
    expect(opts.promptPrefix).toBe(t.prompt)
  })
})
