import { protocol } from '../daemon/protocol-dsl.js'

export default protocol('review', {
  emoji: '⚔️',
  display: 'Adversarial Review',

  owner: 'owner',
  closingPhase: 'cleanup',

  roles: {
    critic: 'The Critic',
    owner: 'The Owner',
  },

  phases: {
    critic_turn: { actor: 'critic', half: 'top',    on: { critic_posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' } },
    owner_turn:  { actor: 'owner',  half: 'bottom', on: { owner_posted: 'critic_turn', final_round: 'post_pass', timeout: 'cancelled', cancel: 'cancelled' } },
    post_pass:   { actor: 'critic', half: 'bottom', on: { pass_posted: 'post_pass', summary_posted: 'complete', timeout: 'cleanup', cancel: 'cancelled' } },
    cleanup:     { actor: 'owner',  half: 'top',    on: { summary_posted: 'complete', timeout: 'complete' } },
    complete:    { actor: 'owner',  half: 'top',    on: {} },
    cancelled:   { actor: 'owner',  half: 'top',    on: {} },
  },

  sentinels: {
    critic_turn: '[critic→owner]',
    owner_turn: '[owner→critic]',
    post_pass: '[critic→owner]',
    cleanup: '[summary]',
  },

  windows: {
    critic_turn: '10m',
    owner_turn: '30m',
    post_pass: '10m',
    cleanup: '5m',
  },

  grace: {
    critic: '30s',
    owner: '2m',
  },

  decisions: {
    pass_verdict: {
      phase: 'post_pass',
      actor: 'critic',
      options: ['clean', 'findings'] as const,
      events: { clean: 'pass_posted', findings: 'pass_posted' },
    },
  },

  seed: {
    critic: (ctx) => `You are ${ctx.name}, the critic in this thread's ${ctx.rounds}-round adversarial review.
Your session_id is ${ctx.sessionId}.

**Orient:** fetch_messages(channel="${ctx.threadId}", limit=100) is your window into this thread.
Read every code file, wiki article, config, or document it references before forming a view.

**Speak:** post to the thread with reply(chat_id="${ctx.threadId}").
- Your FIRST LINE must be exactly \`[critic→owner]\` — the daemon routes on the first line only.
- Untagged messages are conversational and won't advance the review.
- One protocol message per round.

**Wait:** after posting, WAIT. Phase advances arrive as [system] notifications.

${ctx.topic
  ? `**Your focus:** ${ctx.topic}\nFind weaknesses, challenge assumptions, and identify risks related to this focus. Be specific — cite code lines, data, or logical gaps.`
  : `**Your mandate:** Find weaknesses, challenge assumptions, identify risks, and argue AGAINST the design.\nBe specific — cite code lines, data, or logical gaps. Concede strong points but push hard on weak ones.`}

Post your opening critique after orienting. The owner will tag their defenses with \`[owner→critic]\` — when a defense arrives, post your counter-argument. Repeat for ${ctx.rounds} rounds.

Format with clear headers. Be substantive and focused.`,
  },

  completion: ['thread', 'rounds', 'roundsRun', 'outcome', 'topic', 'cast', 'transcript', 'struck'],
})
