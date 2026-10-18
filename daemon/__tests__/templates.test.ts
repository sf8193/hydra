import { describe, test, expect, beforeEach } from 'bun:test'
import { getTemplate, listTemplates, parseTemplateTopic, buildTemplateSpawnOpts, loadTemplateFile } from '../templates.js'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

})

// ---------------------------------------------------------------------------
// listTemplates
// ---------------------------------------------------------------------------

describe('listTemplates', () => {
  test('contains builtin templates', () => {
    const list = listTemplates()
    const names = list.map(t => t.name)
    expect(names).toContain('review')
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

  test('empty topic after colon is allowed (trimmed to empty string)', () => {
    const result = parseTemplateTopic('review:')
    expect(result).not.toBeNull()
    expect(result!.topic).toBe('')
  })
})

// ---------------------------------------------------------------------------
// buildTemplateSpawnOpts
// ---------------------------------------------------------------------------

describe('loadTemplateFile: the declared label', () => {
  test('a valid label is loaded and an unknown one is refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hydra-tmpl-'))
    try {
      const path = join(dir, 'templates.local.json')
      writeFileSync(path, JSON.stringify({
        audit: { prompt: 'p', label: 'investigate' },
        bogus: { prompt: 'p', label: 'acme-corp-diligence' },
        plain: { prompt: 'p' },
      }))
      const { templates } = loadTemplateFile(path, null, 'templates.local.json')
      expect(templates.audit.label).toBe('investigate')
      expect(templates.bogus.label, 'not one of the three buckets').toBeUndefined()
      expect(templates.bogus.prompt, 'but the rest of the template still loads').toBe('p')
      expect(templates.plain.label).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('buildTemplateSpawnOpts', () => {
  // Declared, not inferred from the name: a template renamed or added under a
  // different name used to lose its cost bucket with no warning anywhere.
  test('a template carries the label it declares, whatever it is called', () => {
    const t = getTemplate('review')!
    expect(t.label, 'the builtin has to declare one').toBe('review')
    expect(buildTemplateSpawnOpts('review', t).label).toBe('review')
    expect(buildTemplateSpawnOpts('code-review', t).label, 'the name is not the source').toBe('review')
  })

  test('a template that declares no label sets none', () => {
    const t = { prompt: 'test prompt' }
    expect(buildTemplateSpawnOpts('custom', t).label).toBeUndefined()
    // And a name that happens to spell a bucket does not conjure one.
    expect(buildTemplateSpawnOpts('build', t).label).toBeUndefined()
  })

  test('trigger matches template name with colon', () => {
    for (const name of ['review']) {
      const t = getTemplate(name)!
      const opts = buildTemplateSpawnOpts(name, t)
      expect(opts.trigger).toBe(`${name}:`)
    }
  })

  test('model override takes priority over template.model', () => {
    const t: ReturnType<typeof getTemplate> = { prompt: 'test', model: 'claude-opus-4-6[1m]' }
    const opts = buildTemplateSpawnOpts('test', t!, 'claude-sonnet-5[1m]')
    expect(opts.model).toBe('claude-sonnet-5[1m]')
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



  test('a template carries its disallowedTools and sessionType; one without them sets neither', () => {
    const opts = buildTemplateSpawnOpts('custom', { prompt: 'p', disallowedTools: ['Edit'], sessionType: 'master_orchestrator' })
    expect(opts.disallowedTools).toEqual(['Edit'])
    expect(opts.sessionType).toBe('master_orchestrator')
    const plain = buildTemplateSpawnOpts('review', getTemplate('review')!)
    expect(plain.disallowedTools).toBeUndefined()
    expect(plain.sessionType).toBeUndefined()
  })

  test('promptPrefix matches template prompt', () => {
    const t = getTemplate('review')!
    const opts = buildTemplateSpawnOpts('review', t)
    expect(opts.promptPrefix).toBe(t.prompt)
  })
})
