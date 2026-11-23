// Session instructions (#908): built from the session's actual tools and gateway profile so
// no line claims a tool or formatting capability the session does not have.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { BASE_TOOLS, CONFINED_TOOLS } from '../constants.js'
import { GATEWAY_PLATFORMS, gatewayProfile } from '../gateways/index.js'
import { UNIVERSAL_TOOLS } from '../tool-definitions.js'
import { buildSessionInstructions, initialToolsForBridgeEnv, parseChatPlatform } from '../session-instructions.js'

const ALL_TOOL_NAMES = UNIVERSAL_TOOLS.map(t => t.name)

const SESSION_TOOL_SETS = [
  ['master_orchestrator', BASE_TOOLS.master_orchestrator],
  ['thread_owner', BASE_TOOLS.thread_owner],
  ['thread_guest', BASE_TOOLS.thread_guest],
  ['restricted', BASE_TOOLS.restricted],
  ['confined', CONFINED_TOOLS],
  ['reply_only', new Set(['reply'])],
] as const

function mentionedTools(text: string): string[] {
  return ALL_TOOL_NAMES.filter(name => new RegExp(`\\b${name}\\b`).test(text))
}

describe('buildSessionInstructions (#908)', () => {
  test.each(SESSION_TOOL_SETS)('%s: every tool named in instructions is actually in the session tool set (both platforms)', (_kind, tools) => {
    for (const platform of GATEWAY_PLATFORMS) {
      const text = buildSessionInstructions({ tools, platform })
      for (const named of mentionedTools(text)) {
        expect(tools.has(named as never), `${named} mentioned for ${_kind} on ${platform} but not in tool set`).toBe(true)
      }
      if (!gatewayProfile(platform).postsReactions) {
        expect(mentionedTools(text)).not.toContain('react')
      }
    }
  })

  test('create_thread appears only for sessions that have it (master_orchestrator, not thread_owner/guest/restricted/confined)', () => {
    expect(buildSessionInstructions({ tools: BASE_TOOLS.master_orchestrator, platform: 'discord' })).toContain('create_thread')
    expect(buildSessionInstructions({ tools: BASE_TOOLS.thread_owner, platform: 'discord' })).not.toContain('create_thread')
    expect(buildSessionInstructions({ tools: BASE_TOOLS.thread_guest, platform: 'discord' })).not.toContain('create_thread')
    expect(buildSessionInstructions({ tools: BASE_TOOLS.restricted, platform: 'discord' })).not.toContain('create_thread')
    expect(buildSessionInstructions({ tools: CONFINED_TOOLS, platform: 'discord' })).not.toContain('create_thread')
  })

  test('spawn_session / list_sessions / kill_session appear only for sessions with spawn_session, using spawn: syntax', () => {
    const ownerText = buildSessionInstructions({ tools: BASE_TOOLS.thread_owner, platform: 'discord' })
    expect(ownerText).toContain('spawn: <topic>')
    expect(ownerText).not.toContain('new session: <topic>')
    expect(ownerText).toContain('spawn_session')
    expect(ownerText).toContain('list_sessions')
    expect(ownerText).toContain('kill_session')

    for (const tools of [BASE_TOOLS.thread_guest, BASE_TOOLS.restricted, CONFINED_TOOLS]) {
      const text = buildSessionInstructions({ tools, platform: 'discord' })
      expect(text).not.toContain('spawn_session')
      expect(text).not.toContain('list_sessions')
      expect(text).not.toContain('kill_session')
    }
  })

  test('react is mentioned on Discord (postsReactions=true) and omitted on Slack (postsReactions=false)', () => {
    expect(buildSessionInstructions({ tools: BASE_TOOLS.thread_owner, platform: 'discord' })).toContain('react to add emoji reactions')
    expect(buildSessionInstructions({ tools: BASE_TOOLS.thread_owner, platform: 'slack' })).not.toContain('react')
  })

  test('restricted sessions are not told reply accepts files; write-confined and normal sessions are', () => {
    const restricted = buildSessionInstructions({ tools: BASE_TOOLS.restricted, platform: 'discord', replyAcceptsFiles: false })
    expect(restricted).not.toContain('reply accepts file paths')
    expect(restricted).not.toContain('files:')

    const confined = buildSessionInstructions({ tools: CONFINED_TOOLS, platform: 'discord', replyAcceptsFiles: true })
    expect(confined).toContain('reply accepts file paths')

    const owner = buildSessionInstructions({ tools: BASE_TOOLS.thread_owner, platform: 'discord' })
    expect(owner).toContain('reply accepts file paths')
  })

  test('access guidance points to /hydra:access on Discord (with real mod/skills/access/SKILL.md) and omits it on Slack', () => {
    const discordText = buildSessionInstructions({ tools: BASE_TOOLS.thread_owner, platform: 'discord' })
    expect(discordText).toContain('/hydra:access')
    expect(discordText).not.toContain('/discord:access')

    const slackText = buildSessionInstructions({ tools: BASE_TOOLS.thread_owner, platform: 'slack' })
    expect(slackText).toContain('by hand')
    expect(slackText).not.toContain('/hydra:access')
    expect(slackText).not.toContain('/discord:access')

    const skillPath = join(import.meta.dir, '../../mod/skills/access/SKILL.md')
    expect(existsSync(skillPath)).toBe(true)
    const skill = readFileSync(skillPath, 'utf8')
    expect(skill).toContain('/hydra:access')
    expect(skill).toContain('there is no pairing')
  })

  test('initialToolsForBridgeEnv & parseChatPlatform map env flags to the exact base tool sets', () => {
    expect(initialToolsForBridgeEnv({ isMain: true })).toBe(BASE_TOOLS.master_orchestrator)
    expect(initialToolsForBridgeEnv({ writeConfined: true })).toBe(CONFINED_TOOLS)
    expect(initialToolsForBridgeEnv({ restricted: true })).toBe(BASE_TOOLS.restricted)
    expect(initialToolsForBridgeEnv({ sessionType: 'thread_guest' })).toBe(BASE_TOOLS.thread_guest)
    expect(initialToolsForBridgeEnv({ sessionType: 'thread_owner' })).toBe(BASE_TOOLS.thread_owner)
    expect(initialToolsForBridgeEnv({})).toBe(BASE_TOOLS.thread_owner)

    expect(parseChatPlatform('slack')).toBe('slack')
    expect(parseChatPlatform('discord')).toBe('discord')
    expect(parseChatPlatform(undefined)).toBe('discord')
  })

  test('consumers wire buildSessionInstructions consistently (bridge.ts, agy-engine.ts, omp/hydra-bridge.ts)', () => {
    const root = join(import.meta.dir, '../..')
    const bridgeSrc = readFileSync(join(root, 'bridge.ts'), 'utf8')
    expect(bridgeSrc).toContain('buildSessionInstructions(')
    expect(bridgeSrc).toContain("replyAcceptsFiles: process.env.HYDRA_RESTRICTED !== '1'")
    expect(bridgeSrc).not.toContain("HYDRA_WRITE_CONFINED !== '1'")

    const agySrc = readFileSync(join(root, 'engines/agy-engine.ts'), 'utf8')
    expect(agySrc).toContain('buildSessionInstructions(')
    expect(agySrc).not.toContain('replyAcceptsFiles')

    const ompSrc = readFileSync(join(root, 'omp/hydra-bridge.ts'), 'utf8')
    expect(ompSrc).toContain('buildSessionInstructions({ tools: liveTools, platform: activePlatform })')
    expect(ompSrc).not.toContain('replyAcceptsFiles')

    // Full-structure pin for the canonical Discord thread_owner session
    const owner = buildSessionInstructions({ tools: BASE_TOOLS.thread_owner, platform: 'discord' })
    const paragraphs = owner.split('\n\n')
    expect(paragraphs).toHaveLength(7)
    expect(paragraphs[0]).toContain('The sender reads chat, not this session.')
    expect(paragraphs[1]).toContain('<channel source=')
    expect(paragraphs[2]).toContain('reply accepts file paths')
    expect(paragraphs[3]).toContain('GitHub-flavored')
    expect(paragraphs[4]).toContain('fetch_messages pulls real chat history.')
    expect(paragraphs[5]).toContain('/hydra:access')
    expect(paragraphs[6]).toContain('Session management:')
  })
})
