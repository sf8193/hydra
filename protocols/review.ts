import { protocol, protocolSeed } from '../daemon/protocol-dsl.js'

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
    critic_turn: { actor: 'critic', half: 'top',    on: { critic_posted: 'owner_turn', timeout: 'cancelled', cancel: 'cancelled', fallback: 'fallback_review' }, advanceEvent: 'critic_posted' },
    owner_turn:  { actor: 'owner',  half: 'bottom', on: { owner_posted: 'critic_turn', final_round: 'cleanup', timeout: 'cancelled', cancel: 'cancelled', fallback: 'fallback_review' }, advanceEvent: 'owner_posted', finalAdvanceEvent: 'final_round' },
    cleanup:     { actor: 'owner',  half: 'top',    on: { summary_posted: 'complete', timeout: 'complete' }, advanceEvent: 'summary_posted' },
    // Critic-death fallback: when auto-resume is exhausted, the owner runs the
    // review itself (via fresh subagents) instead of the run being cancelled.
    // Not the cleanupPhase, so the runner drives entry manually and sends the
    // onFallback instructions below — see enterFallbackPhase in protocol-runner.
    fallback_review: { actor: 'owner', half: 'top', on: { summary_posted: 'complete', timeout: 'complete', cancel: 'cancelled' }, advanceEvent: 'summary_posted' },
    complete:    { actor: 'owner',  half: 'top',    on: {} },
    cancelled:   { actor: 'owner',  half: 'top',    on: {} },
  },

  windows: {
    critic_turn: '10m',
    owner_turn: '30m',
    cleanup: '5m',
    fallback_review: '30m',
  },

  grace: {
    critic: '30s',
    owner: '2m',
  },

  roleConfig: {
    critic: { cadence: 'per-round', waits: true },
  },

  notifications: {
    onKickoff: {
      owner: (run) => {
        const topic = run.params.topic as string | undefined
        const lines = [
          `[system] **Adversarial Review** — ${run.rounds} round${run.rounds > 1 ? 's' : ''}`,
          ``,
          `You are **The Owner**. The Critic was spawned and is reading the thread to orient.`,
        ]
        if (topic) lines.push(`The Critic was given the following prompt: '${topic}'`)
        lines.push(``, `When their critique is ready, you'll be notified with the full post and instructions on how to respond.`)
        return lines.join('\n')
      },
      critic: () => null,
    },

    // Critic died and auto-resume is exhausted — the owner runs the review
    // itself with fresh subagents. Lenses are suggestions, not a checklist:
    // what's being reviewed drives the choice, and the subagents orient
    // independently rather than inheriting the owner's context.
    onFallback: (run, { deadLabel, resumeAttempts, completedRounds }) => {
      const topic = run.params.topic as string | undefined
      return [
        `[system] **${deadLabel} died** after ${resumeAttempts} resume attempt${resumeAttempts === 1 ? '' : 's'}. Falling back to subagent review — you run it yourself.`,
        ``,
        completedRounds > 0
          ? `${completedRounds} round${completedRounds === 1 ? '' : 's'} completed before it died — read the thread for the findings so far.`
          : `No rounds completed before it died.`,
        ``,
        `**Your task:** review the work with fresh Claude Code subagents.`,
        ``,
        `1. **Pick the lenses that fit what you're reviewing.** These are suggestions, not a checklist — the material drives the choice. Code? Maybe correctness/edge cases, import & layering boundaries, conventions/golden patterns, test quality, security, resource lifecycle. A design doc or plan? More likely hidden assumptions, alternatives not considered, failure modes, second-order effects. Add lenses the material calls for; drop ones that don't apply.`,
        `2. **Spawn one fresh subagent per chosen lens.** Tell each to re-read this thread and the specifics (the diff / doc / spec) and orient on its own — do not fork your own context into them; independence is the point. Run them in parallel.`,
        `3. **Synthesize** their findings yourself — resolve conflicts, drop the noise, keep what's real.`,
        topic ? `\n**Focus:** ${topic} — weight your lens choices toward this.` : '',
        ``,
        `When done, post your closing \`advance({ content: "..." })\` using the review summary format.`,
      ].filter(Boolean).join('\n')
    },
  },

  seed: {
    critic: (ctx) => protocolSeed(ctx.protocol, 'critic', ctx)
      + '\n\n' + (ctx.topic
        ? `**Your focus:** ${ctx.topic}\nFind weaknesses, challenge assumptions, and identify risks related to this focus. Be specific — cite code lines, data, or logical gaps.`
        : `**Your mandate:** Find weaknesses, challenge assumptions, identify risks, and argue AGAINST the design.\nBe specific — cite code lines, data, or logical gaps. Concede strong points but push hard on weak ones.`
      ) + `\n\nPost your opening critique after orienting. The owner will defend — when a defense arrives, post your counter-argument. Repeat for ${ctx.rounds} rounds.\n\nFormat with clear headers. Be substantive and focused.`,
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
