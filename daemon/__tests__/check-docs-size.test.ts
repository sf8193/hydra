import { describe, expect, test } from 'bun:test'
import { capOf, DOC_CAP, oversize, README_CAP } from '../../scripts/check-docs-size.js'

describe('check-docs-size', () => {
  test('a README or a guide over its cap is refused, naming the file and the cap', () => {
    const v = oversize([{ path: 'README.md', bytes: README_CAP + 1 }, { path: 'docs/slack.md', bytes: DOC_CAP + 1 }, { path: 'docs/ok.md', bytes: DOC_CAP }])
    expect(v).toHaveLength(2)
    expect(v[0]).toContain('README.md')
    expect(v[1]).toContain(`over its ${DOC_CAP}`)
  })
  test('only the README, ACCESS.md and the guides directly under docs/ are capped', () => {
    expect(capOf('README.md')).toBe(README_CAP)
    expect(capOf('ACCESS.md')).toBe(DOC_CAP)
    expect(capOf('docs/specialists.md')).toBe(DOC_CAP)
    expect(capOf('skills/access/SKILL.md')).toBeUndefined()
    expect(capOf('transcribe-server/README.md')).toBeUndefined()
    expect(capOf('docs/images/notes.md')).toBeUndefined()
  })
})
