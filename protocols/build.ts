import { protocol, protocolSeed } from '../daemon/protocol-dsl.js'

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
    implementing: { actor: 'builder', half: 'top',    on: { owner_impl: 'reviewing', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'owner_impl' },
    reviewing:    { actor: 'critic',  half: 'bottom', on: { critic_lgtm: 'closing', critic_final: 'closing', critic_feedback: 'implementing', timeout: 'cancelled', cancel: 'cancelled' } },
    closing:      { actor: 'builder', half: 'top',    on: { summary_posted: 'complete', timeout: 'complete', cancel: 'cancelled' }, advanceEvent: 'summary_posted' },
    complete:     { actor: 'builder', half: 'top',    on: {} },
    cancelled:    { actor: 'builder', half: 'top',    on: {} },
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
      descriptions: { approve: 'why it ships', request_changes: 'what to fix' },
      events: { approve: 'critic_lgtm', request_changes: 'critic_feedback' },
      finalEvent: 'critic_final',
    },
  },

  roleConfig: {
    critic: { cadence: 'per-round', waits: true },
  },

  seed: {
    critic: (ctx) => protocolSeed(ctx.protocol, 'critic', ctx)
      + `\n\n**Task:** ${ctx.task ?? 'Review the implementation.'}\n\nReview the implementation. Be specific — cite code lines. Focus on correctness first.`,
  },

  ownerKickoff: (params) => {
    const task = params.task ?? params.topic ?? 'Begin implementing.'
    return `[system] **Build** — starting\n\n**Task:** ${task}\n\nYou are the builder. Implement the task, then call \`advance({ content: "your implementation summary" })\` when ready for review. Use \`reply()\` for conversation only — it does not advance the protocol.`
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
