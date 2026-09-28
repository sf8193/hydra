import { describe, test, expect } from 'bun:test'
import { sanitizeFilename } from '../../gateway.js'

describe('sanitizeFilename', () => {
  test('normal filename passes through', () => {
    expect(sanitizeFilename('report.pdf', 'fallback')).toBe('report.pdf')
  })

  test('strips leading dots', () => {
    expect(sanitizeFilename('...hidden.txt', 'fallback')).toBe('hidden.txt')
    expect(sanitizeFilename('.env', 'fallback')).toBe('env')
  })

  test('replaces special characters with underscore', () => {
    expect(sanitizeFilename('my file (1).pdf', 'fallback')).toBe('my_file__1_.pdf')
  })

  test('preserves extension when truncating', () => {
    const long = 'a'.repeat(250) + '.pdf'
    const result = sanitizeFilename(long, 'fallback', 200)
    expect(result.endsWith('.pdf')).toBe(true)
    expect(result.length).toBeLessThanOrEqual(200)
  })

  test('truncates without extension', () => {
    const long = 'a'.repeat(250)
    const result = sanitizeFilename(long, 'fallback', 200)
    expect(result.length).toBe(200)
  })

  test('falls back to id when result is empty', () => {
    expect(sanitizeFilename('...', 'abc123')).toBe('abc123')
    expect(sanitizeFilename('', 'fallback-id')).toBe('fallback-id')
  })

  test('non-ascii characters replaced', () => {
    // Characters outside [a-zA-Z0-9._-] get replaced with underscore
    const result = sanitizeFilename('file[1](2).pdf', 'fallback')
    expect(result).toBe('file_1__2_.pdf')
  })

  test('allowed characters preserved', () => {
    expect(sanitizeFilename('my-file_v2.tar.gz', 'f')).toBe('my-file_v2.tar.gz')
  })
})
