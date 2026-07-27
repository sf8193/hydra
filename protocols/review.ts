import { protocol, mechanicsBlock } from '../daemon/protocol-dsl.js'

export default protocol('review', {
  emoji: '⚔️',
  display: 'Adversarial Review',

  owner: 'owner',
  cleanupPhase: 'cleanup',
  cancelPhase: 'cancelled',

  roles: {
    critic: 'The Critic',
    owner: 'The Owner',
  },

  phases: {
    critic_turn: { actor: 'critic', half: 'top',    on: { critic_posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled' }, replyEvent: 'critic_posted' },
    owner_turn:  { actor: 'owner',  half: 'bottom', on: { owner_posted: 'critic_turn', final_round: 'cleanup', timeout: 'cancelled', cancel: 'cancelled' }, replyEvent: 'owner_posted', finalRoundEvent: 'final_round' },
    cleanup:     { actor: 'owner',  half: 'top',    on: { summary_posted: 'complete', timeout: 'complete' }, replyEvent: 'summary_posted', onEnter: ['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'] },
    complete:    { actor: 'owner',  half: 'top',    on: {} },
    cancelled:   { actor: 'owner',  half: 'top',    on: {} },
  },

  sentinels: {
    critic_turn: '[critic→owner]',
    owner_turn: '[owner→critic]',
    cleanup: '[summary]',
  },

  windows: {
    critic_turn: '10m',
    owner_turn: '30m',
    cleanup: '5m',
  },

  grace: {
    critic: '30s',
    owner: '2m',
  },

  seed: {
    critic: (ctx) => mechanicsBlock({
      tmuxName: ctx.name as string,
      role: 'critic',
      protocol: `${ctx.rounds}-round adversarial review`,
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      tag: '[critic→owner]',
      cadence: 'per-round',
      waits: true,
    }) + '\n\n' + (ctx.topic
      ? `**Your focus:** ${ctx.topic}\nFind weaknesses, challenge assumptions, and identify risks related to this focus. Be specific — cite code lines, data, or logical gaps.`
      : `**Your mandate:** Find weaknesses, challenge assumptions, identify risks, and argue AGAINST the design.\nBe specific — cite code lines, data, or logical gaps. Concede strong points but push hard on weak ones.`
    ) + `\n\nPost your opening critique after orienting. The owner will tag their defenses with \`[owner→critic]\` — when a defense arrives, post your counter-argument. Repeat for ${ctx.rounds} rounds.\n\nFormat with clear headers. Be substantive and focused.`,
  },

  summaryFormat: (run) => {
    const roundArc = Array.from({ length: run.rounds }, (_, i) =>
      `**Round ${i + 1}️⃣:** Critic ... · Owner ...`)

    const modifiers = run.params.modifiers as Array<{ name: string }> | undefined
    const modNote = modifiers?.length
      ? ` · ${modifiers.map(m => `+${m.name}`).join(' ')}`
      : ''

    return [
      `**⚔️ Review Summary** (${run.rounds} round${run.rounds > 1 ? 's' : ''}${modNote})`,
      ``,
      `🔬 **Synthesis** — one sentence. The review in one breath.`,
      ...roundArc,
      ``,
      `---`,
      ``,
      `📋 **Dispositions**`,
      `- ✅ issue — fixed/will fix`,
      `- ⚠️ issue — acknowledged, deferred`,
      `- ❌ issue — rebutted`,
      ``,
      `---`,
      ``,
      `⚡ **Tensions** — what was actually contested, not just flagged. Name the disagreement and who moved.`,
      ``,
      `🌱 **What Emerged** — what nobody asked for that showed up anyway. "Nothing" if the review was routine.`,
      ``,
      `➡️ **What's next** — what happens now and what needs the human.`,
    ]
  },
})
