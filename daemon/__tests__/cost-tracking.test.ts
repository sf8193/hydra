import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ---------------------------------------------------------------------------
// computeTokenCost — pure pricing logic
// ---------------------------------------------------------------------------

import { computeTokenCost, MODEL_PRICING } from '../../shared/constants.js'

describe('computeTokenCost', () => {
  it('returns undefined for unknown model', () => {
    expect(computeTokenCost('gpt-4', 1000, 500, 0, 0)).toBeUndefined()
  })

  it('computes cost for sonnet-4-6', () => {
    // $3/M input, $15/M output
    const cost = computeTokenCost('claude-sonnet-4-6', 1_000_000, 1_000_000, 0, 0)
    expect(cost).toBe(18) // $3 + $15
  })

  it('computes cost for opus-4-6', () => {
    // $15/M input, $75/M output
    const cost = computeTokenCost('claude-opus-4-6', 1_000_000, 1_000_000, 0, 0)
    expect(cost).toBe(90) // $15 + $75
  })

  it('includes cache_write and cache_read', () => {
    // sonnet: $3.75/M write, $0.30/M read
    const cost = computeTokenCost('claude-sonnet-4-6', 0, 0, 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(4.05, 5) // $3.75 + $0.30
  })

  it('strips [1m] suffix before lookup', () => {
    const withSuffix = computeTokenCost('claude-sonnet-4-6[1m]', 1_000_000, 0, 0, 0)
    const without = computeTokenCost('claude-sonnet-4-6', 1_000_000, 0, 0, 0)
    expect(withSuffix).toBe(without)
  })

  it('returns 0 for all-zero tokens', () => {
    expect(computeTokenCost('claude-sonnet-4-6', 0, 0, 0, 0)).toBe(0)
  })

  it('all main models have a pricing entry', () => {
    const mainModels = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-sonnet-4-6']
    for (const m of mainModels) {
      expect(MODEL_PRICING[m]).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// formatCostUsd
// ---------------------------------------------------------------------------

import { formatCostUsd } from '../observability.js'

describe('formatCostUsd', () => {
  it('formats sub-cent amounts with 4 decimals', () => {
    expect(formatCostUsd(0.005)).toBe('$0.0050')
    expect(formatCostUsd(0.001)).toBe('$0.0010')
  })

  it('formats amounts >= $0.01 with 2 decimals', () => {
    expect(formatCostUsd(0.42)).toBe('$0.42')
    expect(formatCostUsd(12.34)).toBe('$12.34')
    expect(formatCostUsd(0.01)).toBe('$0.01')
  })
})

// ---------------------------------------------------------------------------
// captureCost — reads transcript from ~/.claude/projects, computes cost
//
// Creates real transcript files in ~/.claude/projects/hydra-cost-test-<id>/
// and cleans them up after each test.
// ---------------------------------------------------------------------------

import { captureCost } from '../observability.js'
import type { SessionInfo } from '../sessions.js'

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')
const TEST_PROJECT_DIR = join(PROJECTS_ROOT, 'hydra-cost-test')

function makeSession(claudeSessionId: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: `test-${claudeSessionId}`,
    topic: 'test',
    threadId: 'thread-1',
    createdAt: Date.now(),
    lastActive: Date.now(),
    tmuxName: 'cedar',
    listening: true,
    claudeSessionId,
    ...overrides,
  } as SessionInfo
}

function writeTranscript(claudeId: string, entries: object[]): string {
  const path = join(TEST_PROJECT_DIR, `${claudeId}.jsonl`)
  writeFileSync(path, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return path
}

function makeEntry(model: string, inputTokens: number, outputTokens: number, cacheWrite = 0, cacheRead = 0): object {
  return {
    message: {
      model,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheWrite,
        cache_read_input_tokens: cacheRead,
      },
    },
  }
}

beforeEach(() => {
  mkdirSync(TEST_PROJECT_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_PROJECT_DIR, { recursive: true, force: true })
})

describe('captureCost', () => {
  it('does nothing when claudeSessionId is missing', () => {
    const info = makeSession('no-id', { claudeSessionId: undefined })
    captureCost(info)
    expect(info.costUsd).toBeUndefined()
  })

  it('does nothing when transcript file does not exist', () => {
    const info = makeSession('nonexistent-abc123')
    captureCost(info)
    expect(info.costUsd).toBeUndefined()
  })

  it('computes cost from transcript token usage', () => {
    // 1M input + 1M output for sonnet-4-6 = $3 + $15 = $18
    writeTranscript('cost-basic', [makeEntry('claude-sonnet-4-6', 1_000_000, 1_000_000)])
    const info = makeSession('cost-basic')
    captureCost(info)
    expect(info.costUsd).toBeCloseTo(18, 5)
  })

  it('sums tokens across multiple messages', () => {
    // Two messages, each 500k tokens — total $18
    writeTranscript('cost-multi', [
      makeEntry('claude-sonnet-4-6', 500_000, 500_000),
      makeEntry('claude-sonnet-4-6', 500_000, 500_000),
    ])
    const info = makeSession('cost-multi')
    captureCost(info)
    expect(info.costUsd).toBeCloseTo(18, 5)
  })

  it('skips unknown models but computes known-model total', () => {
    writeTranscript('cost-mixed', [
      makeEntry('claude-sonnet-4-6', 1_000_000, 0),  // $3
      makeEntry('gpt-4-turbo', 999_999, 999_999),      // unknown — ignored
    ])
    const info = makeSession('cost-mixed')
    captureCost(info)
    expect(info.costUsd).toBeCloseTo(3, 5)
  })

  it('does not set costUsd if all models are unknown', () => {
    writeTranscript('cost-allunknown', [
      makeEntry('gpt-4', 1000, 500),
    ])
    const info = makeSession('cost-allunknown')
    captureCost(info)
    expect(info.costUsd).toBeUndefined()
  })

  it('includes cache write and read costs', () => {
    // sonnet: 0 input/output, 1M cache_write=$3.75, 1M cache_read=$0.30 → $4.05
    writeTranscript('cost-cache', [makeEntry('claude-sonnet-4-6', 0, 0, 1_000_000, 1_000_000)])
    const info = makeSession('cost-cache')
    captureCost(info)
    expect(info.costUsd).toBeCloseTo(4.05, 4)
  })

  it('skips re-scan when file size has not changed', () => {
    writeTranscript('cost-cachehit', [makeEntry('claude-sonnet-4-6', 1_000_000, 0)])
    const info = makeSession('cost-cachehit')

    captureCost(info)
    expect(info.costUsd).toBeCloseTo(3, 5)

    // Corrupt costUsd and call again without changing the file — cache hit → no re-scan
    info.costUsd = 999
    captureCost(info)
    expect(info.costUsd).toBe(999)
  })

  it('ignores malformed JSON lines gracefully', () => {
    const path = join(TEST_PROJECT_DIR, 'cost-malformed.jsonl')
    writeFileSync(path, [
      JSON.stringify(makeEntry('claude-sonnet-4-6', 1_000_000, 0)),
      'NOT_JSON',
      '{"incomplete":',
    ].join('\n') + '\n')

    const info = makeSession('cost-malformed')
    captureCost(info)
    expect(info.costUsd).toBeCloseTo(3, 5)
  })

  it('handles opus pricing correctly', () => {
    // 1M input for opus-4-6 = $15
    writeTranscript('cost-opus', [makeEntry('claude-opus-4-6', 1_000_000, 0)])
    const info = makeSession('cost-opus')
    captureCost(info)
    expect(info.costUsd).toBeCloseTo(15, 5)
  })
})
