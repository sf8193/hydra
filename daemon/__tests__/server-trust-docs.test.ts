// The trust statement is one sentence (restricted.ts SERVER_TRUST_SENTENCE), said the same in the load log and in every place an operator reads it.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { SERVER_TRUST_SENTENCE } from '../restricted.js'

const root = join(import.meta.dir, '..', '..')

describe('the trust statement', () => {
  test.each(['docs/specialists.md', 'hydra.example.toml'])('%s says it, word for word', file => {
    // hydra.example.toml wraps its comments: compare without comment markers and line breaks.
    const text = readFileSync(join(root, file), 'utf8').replace(/\n# ?/g, ' ').replace(/\s+/g, ' ')
    expect(text).toContain(SERVER_TRUST_SENTENCE)
  })
})
