import { protocol, mechanicsBlock } from '../daemon/protocol-dsl.js'

export default protocol('build', {
  emoji: '🔨',
  display: 'Build',

  owner: 'builder',
  cleanupPhase: 'closing',
  cancelPhase: 'cancelled',

  roles: {
    builder: 'The Builder',
    critic: 'The Critic',
  },

  phases: {
    implementing: { actor: 'builder', half: 'top',    on: { owner_impl: 'reviewing', timeout: 'cancelled', cancel: 'cancelled' }, replyEvent: 'owner_impl' },
    reviewing:    { actor: 'critic',  half: 'bottom', on: { critic_lgtm: 'closing', critic_final: 'closing', critic_feedback: 'implementing', timeout: 'cancelled', cancel: 'cancelled' } },
    closing:      { actor: 'builder', half: 'top',    on: { summary_posted: 'complete', timeout: 'complete', cancel: 'cancelled' }, replyEvent: 'summary_posted', onEnter: ['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'] },
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

  ownerKickoff: (params) => {
    const task = params.task ?? params.topic ?? 'Begin implementing.'
    return `[Build — starting]\n\n**Task:** ${task}\n\nYou are the builder. Implement the task, then post to the thread tagged with \`[builder→critic]\`. The critic will review.`
  },

  summaryFormat: (run) => {
    const roundArc = Array.from({ length: run.rounds }, (_, i) =>
      `**Round ${i + 1}️⃣:** Critic ... · Builder ...`)
    return [
      `**🔨 Build Summary** (${run.rounds} round${run.rounds > 1 ? 's' : ''})`,
      ``,
      `🔬 **Synthesis** — one sentence. The build in one breath.`,
      ...roundArc,
      ``,
      `---`,
      ``,
      `📋 **Dispositions**`,
      `- **What was built** — one bullet per piece, each with how to think about it`,
      `- **PRs / artifacts** — links, or "none"`,
      ``,
      `---`,
      ``,
      `⚡ **Tensions** — what the critic pushed, and what changed because of it.`,
      ``,
      `🌱 **What Emerged** — what nobody asked for that showed up anyway. "Nothing" if the build was routine.`,
      ``,
      `➡️ **What's next** — what happens now and what needs the human.`,
    ]
  },
})
