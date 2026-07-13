import { protocol } from '../daemon/protocol-dsl.js'

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
    implementing: { actor: 'builder', half: 'top',    on: { owner_impl: 'reviewing', timeout: 'cancelled', cancel: 'cancelled' }, replyEvent: 'owner_impl' },
    reviewing:    { actor: 'critic',  half: 'bottom', on: { critic_lgtm: 'closing', critic_final: 'closing', critic_feedback: 'implementing', timeout: 'cancelled', cancel: 'cancelled' } },
    closing:      { actor: 'builder', half: 'top',    on: { summary_posted: 'complete', timeout: 'complete', cancel: 'cancelled' }, replyEvent: 'summary_posted' },
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
    critic: (ctx) => `You are ${ctx.name}, the critic in this thread's ${ctx.rounds}-round build review.
Your session_id is ${ctx.sessionId}.

**Orient:** fetch_messages(channel="${ctx.threadId}", limit=100) is your window into this thread.
Read every code file referenced in the implementation summary before reviewing.

**Speak:** post to the thread with reply(chat_id="${ctx.threadId}").
- Your FIRST LINE must be exactly \`[critic→builder]\` — the daemon routes on the first line only.
- To approve: call decide('approve', 'why it ships').
- To request changes: call decide('request_changes', 'what to fix').
- Untagged messages are conversational and won't advance the build.

**Wait:** after posting, WAIT. The builder's response arrives as a [system] notification.

**Task:** ${ctx.task ?? 'Review the implementation.'}

Review the implementation. Be specific — cite code lines. Focus on correctness first.`,
  },

  completion: ['thread', 'rounds', 'roundsRun', 'outcome', 'task', 'cast', 'transcript', 'approved'],
})
