import { describe, test, expect } from 'bun:test'
import { classifyResumeFailure } from '../daemon/resume-health.js'

describe('classifyResumeFailure', () => {
  test('tmux dead, no exit marker → kill (everything gone)', () => {
    expect(classifyResumeFailure({ processAlive: false, hasExitMarker: false, hasExitFilePath: true })).toBe('kill')
  })

  test('tmux dead, exit marker present → kill (claude exited)', () => {
    expect(classifyResumeFailure({ processAlive: false, hasExitMarker: true, hasExitFilePath: true })).toBe('kill')
  })

  test('tmux alive, exit marker present → kill (claude exited, shell lingering)', () => {
    expect(classifyResumeFailure({ processAlive: true, hasExitMarker: true, hasExitFilePath: true })).toBe('kill')
  })

  test('tmux alive, no exit marker, path configured → orphan (claude running, bridge not connected)', () => {
    expect(classifyResumeFailure({ processAlive: true, hasExitMarker: false, hasExitFilePath: true })).toBe('orphan')
  })

  test('tmux alive, no exit marker, path NOT configured → kill (cannot verify liveness)', () => {
    expect(classifyResumeFailure({ processAlive: true, hasExitMarker: false, hasExitFilePath: false })).toBe('kill')
  })
})
