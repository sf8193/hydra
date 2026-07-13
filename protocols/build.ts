import { protocol } from '../daemon/protocol-dsl.js'
import { mechanicsBlock } from '../daemon/prompts/mechanics.js'

export default protocol('build', {
  emoji: '🔨',
  display: 'Build',

  owner: 'builder',
  closingPhase: 'closing',

  roles: {
    builder: 'The Builder',
    critic: 'The Critic',
  },

  phases: {
    implementing: { actor: 'builder', half: 'top',    on: { owner_impl: 'reviewing', timeout: 'cancelled', cancel: 'cancelled' }, replyEvent: 'owner_impl', onEnter: ['advanceRound'] },
    reviewing:    { actor: 'critic',  half: 'bottom', on: { critic_lgtm: 'closing', critic_final: 'closing', critic_feedback: 'implementing', timeout: 'cancelled', cancel: 'cancelled' } },
    closing:      { actor: 'builder', half: 'top',    on: { summary_posted: 'complete', timeout: 'complete', cancel: 'cancelled' }, replyEvent: 'summary_posted', onEnter: ['closing'] },
    complete:     { actor: 'builder', half: 'top',    on: {} },
    cancelled:    { actor: 'builder', half: 'top',    on: {} },
  },

  sentinels: {
    implementing: '[builder→critic]',
    reviewing: '[critic→builder]',
    closing: '[summary]',
  },

  windows: {
    implementing: '30m',
    reviewing: '20m',
    closing: '5m',
  },

  grace: {
    builder: '2m',
    critic: '30s',
  },

  decisions: {
    critic_verdict: {
      phase: 'reviewing',
      actor: 'critic',
      options: ['approve', 'request_changes'] as const,
      events: { approve: 'critic_lgtm', request_changes: 'critic_feedback' },
      finalEvent: 'critic_final',
    },
  },

  seed: {
    critic: (ctx) => mechanicsBlock({
      tmuxName: ctx.name as string,
      role: 'critic',
      protocol: `${ctx.rounds}-round build review`,
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      tag: '[critic→builder]',
      cadence: 'per-round',
      waits: true,
    }) + `\n\n**Task:** ${ctx.task ?? 'Review the implementation.'}\n\nReview the implementation. Be specific — cite code lines. Focus on correctness first.\n\nTo approve: call decide('approve', 'why it ships').\nTo request changes: call decide('request_changes', 'what to fix').`,
  },

  completion: ['thread', 'rounds', 'roundsRun', 'outcome', 'task', 'cast', 'transcript', 'approved'],
})
