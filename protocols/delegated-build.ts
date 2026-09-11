import { protocol, protocolSeed } from '../daemon/protocol-dsl.js'

export default protocol('delegated-build', {
  emoji: '📋',
  display: 'Delegated Build',

  owner: 'pm',
  roundPhase: 'building',
  cleanupPhase: 'closing',
  cancelPhase: 'cancelled',

  roles: {
    pm: 'The PM',
    builder: 'The Builder',
  },

  phases: {
    clarifying:   { actor: 'pm',      half: 'top',    on: { spec_ready: 'building', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'spec_ready' },
    building:     { actor: 'builder', half: 'bottom', on: { build_done: 'reviewing', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'build_done' },
    reviewing:    { actor: 'pm',      half: 'top',    on: { pm_approve: 'closing', pm_changes: 'building', timeout: 'cancelled', cancel: 'cancelled' } },
    closing:      { actor: 'pm',      half: 'top',    on: { summary_posted: 'complete', timeout: 'complete', cancel: 'cancelled' }, advanceEvent: 'summary_posted' },
    complete:     { actor: 'pm',      half: 'top',    on: {} },
    cancelled:    { actor: 'pm',      half: 'top',    on: {} },
  },

  windows: {
    clarifying: '15m',
    building: '30m',
    reviewing: '15m',
    closing: '5m',
  },

  grace: {
    pm: '2m',
    builder: '30s',
  },

  decisions: {
    pm_verdict: {
      phase: 'reviewing',
      actor: 'pm',
      options: ['approve', 'request_changes'] as const,
      descriptions: { approve: 'why it ships', request_changes: 'what to fix' },
      events: { approve: 'pm_approve', request_changes: 'pm_changes' },
      finalEvent: 'pm_approve',
    },
  },

  roleConfig: {
    builder: { cadence: 'per-round', waits: true },
  },

  seed: {
    builder: (ctx) => {
      const quick = ctx.skipClarify
      const taskLine = ctx.task
        ? `**Task:** ${ctx.task}`
        : `Read this thread for context — the PM's conversation describes what needs to be done.`
      return protocolSeed(ctx.protocol, 'builder', ctx)
        + `\n\n${quick ? taskLine : `**Spec from PM:** ${ctx.task ?? 'Implement the spec provided in the handoff.'}`}`
        + `\n\nImplement the task. When done, call \`advance({ content: "summary of what you built" })\`.`
        + (quick ? `\n\nUse \`fetch_messages\` to read the thread if you need more context.` : '')
    },
  },

  notifications: {
    onKickoff: {
      pm: (run) => {
        if (run.params.skipClarify) return null
        const task = (run.params.task ?? run.params.topic ?? 'Clarify what needs to be built.') as string
        return [
          `[system] **Delegated Build** — clarification phase`,
          ``,
          `**Task:** ${task}`,
          ``,
          `You are the PM. Read the relevant code, ask yourself clarifying questions, and write a clear spec for the builder. When your spec is ready, call \`advance({ content: "your spec" })\` — the spec will be handed to the builder verbatim.`,
          ``,
          `Use \`reply()\` for conversation only — it does not advance the protocol.`,
        ].join('\n')
      },
      builder: () => null,
    },
  },

  summaryFormat: (run) => {
    return [
      `**📋 Delegated Build Summary** (${run.rounds} round${run.rounds > 1 ? 's' : ''})`,
      ``,
      `🔬 **Synthesis** — one sentence.`,
      ``,
      `---`,
      ``,
      `📋 **Dispositions**`,
      `- **Spec** — what the PM asked for`,
      `- **What was built** — what the builder delivered`,
      `- **PRs / artifacts** — links, or "none"`,
      ``,
      `---`,
      ``,
      `⚡ **Review findings** — what the PM caught and what changed.`,
      ``,
      `➡️ **What's next** — what happens now and what needs the human.`,
    ]
  },
})
