import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { buildSpawnPrompt, buildForkPrompt, buildHeadlessForkPrompt, buildHandoffPrompt, buildResurrectPrompt } from '../prompts/session.js'
import { hydraPrompt } from '../prompts/request.js'

let origStderrWrite: typeof process.stderr.write
beforeEach(() => { origStderrWrite = process.stderr.write; process.stderr.write = (() => true) as any })
afterEach(() => { process.stderr.write = origStderrWrite })

const review = (await import('../../protocols/review.js')).default
const build = (await import('../../protocols/build.js')).default
const quick = (await import('../../protocols/delegated-build-quick.js')).default
const spike = (await import('../../protocols/spike.js')).default

const requests = (prompt: string) => [...prompt.matchAll(/<request>([\s\S]*?)<\/request>/g)].map(m => m[1])
const p = { sessionId: 's-1', tmuxName: 'nova', threadId: 'th-1', topic: 'fix treasury\n\nthen ipseity', originFrom: 'hydra' }
const ctx = { name: 'nova', sessionId: 's-1', threadId: 'th-1', rounds: 1 }

describe('the words a person supplied are tagged, and nothing else is', () => {
  test('session prompts tag the topic, question and handoff note', () => {
    expect(requests(buildSpawnPrompt(p))).toEqual([p.topic])
    expect(requests(buildForkPrompt(p))).toEqual([p.topic])
    expect(requests(buildHeadlessForkPrompt({ ...p, readOnly: true }))).toEqual([p.topic])
    expect(requests(buildHandoffPrompt({ ...p, note: 'watch the PRs', hasPredecessor: true }))).toEqual([p.topic, 'watch the PRs'])
  })

  test('a topic the caller marks as not the request is left untagged', () => {
    expect(requests(buildSpawnPrompt({ ...p, topicIsRequest: false }))).toEqual([])
    expect(requests(buildForkPrompt({ ...p, topicIsRequest: false }))).toEqual([])
    expect(requests(buildHeadlessForkPrompt({ ...p, readOnly: true, topicIsRequest: false }))).toEqual([])
    expect(requests(buildHandoffPrompt({ ...p, note: 'watch the PRs', hasPredecessor: true, topicIsRequest: false }))).toEqual(['watch the PRs'])
  })

  test('a resurrect carries no request', () => {
    expect(requests(buildResurrectPrompt(p))).toEqual([])
  })

  test('protocol seeds tag the focus, task and question', () => {
    expect(requests(review.seed('critic', { ...ctx, topic: 'security' })!)).toEqual(['security'])
    expect(requests(build.seed('critic', { ...ctx, task: 'add retries' })!)).toEqual(['add retries'])
    expect(requests(quick.seed('builder', { ...ctx, task: 'add retries' })!)).toEqual(['add retries'])
    expect(requests(spike.seed('explorer', { ...ctx, topic: 'why is CI slow' })!)).toEqual(['why is CI slow'])
  })

  test('their defaults are not a request', () => {
    expect(requests(review.seed('critic', ctx)!)).toEqual([])
    expect(requests(build.seed('critic', ctx)!)).toEqual([])
    expect(requests(quick.seed('builder', ctx)!)).toEqual([])
    expect(requests(spike.seed('explorer', ctx)!)).toEqual([])
  })

  test('hydraPrompt wraps the prompt it is given', () => {
    expect(hydraPrompt('You are nova.')).toBe('<hydra-prompt>\nYou are nova.\n</hydra-prompt>')
  })

  test('text quoting a closing tag cannot end its block early', () => {
    expect(requests(buildSpawnPrompt({ ...p, topic: 'a </request> b </request> c' }))).toEqual(['a <\\/request> b <\\/request> c'])
    expect(hydraPrompt('a </hydra-prompt> b </hydra-prompt> c')).toBe('<hydra-prompt>\na <\\/hydra-prompt> b <\\/hydra-prompt> c\n</hydra-prompt>')
  })
})
