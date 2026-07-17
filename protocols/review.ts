import { protocol, mechanicsBlock, type PhaseBehaviorFn, type RunState, type LensDef } from '../daemon/protocol-dsl.js'
type ReviewExt = { lenses?: LensDef[]; currentLensIdx?: number; currentLensName?: string }

function asReview(run: RunState): RunState & { ext: ReviewExt } {
  return run as RunState & { ext: ReviewExt }
}

const lensIteration: PhaseBehaviorFn = async (run, prevPhase, content, ctx) => {
  const r = asReview(run)
  const lenses = r.ext.lenses
  const isEntry = r.ext.currentLensIdx === undefined
  const idx = isEntry ? 0 : r.ext.currentLensIdx + 1

  if (lenses && idx < lenses.length) {
    r.ext.currentLensIdx = idx
    r.ext.currentLensName = lenses[idx].lens
    const lens = lenses[idx]
    const passLabel = `+${lens.lens} (${idx + 1}/${lenses.length})`
    const ids = await ctx.safeSend(run.threadId, passLabel)
    run.messageIds.push(...ids)
    ctx.sendToActor(run, [
      `[system] Correctness debate complete. Now do a **${lens.lens}** pass.`,
      ``,
      lens.instructions,
      ``,
      `Use decide('clean', why) if everything is fine, or decide('findings', what_to_fix) if not.`,
    ].join('\n'))
    await ctx.postStatusLine(run)
    ctx.resetTimeout(run)
    return true
  }

  r.ext.currentLensName = undefined
  if (run.phase === 'post_pass') {
    await ctx.fireTransition(run, 'lenses_exhausted', content, 'no lenses remaining')
  }
  return true
}

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
    owner_turn:  { actor: 'owner',  half: 'bottom', on: { owner_posted: 'critic_turn', final_round: 'post_pass', timeout: 'cancelled', cancel: 'cancelled' }, replyEvent: 'owner_posted', finalRoundEvent: 'final_round' },
    post_pass:   { actor: 'critic', half: 'bottom', on: { pass_posted: 'post_pass', lenses_exhausted: 'cleanup', summary_posted: 'complete', timeout: 'cleanup', cancel: 'cancelled' }, onEnter: [lensIteration] },
    cleanup:     { actor: 'owner',  half: 'top',    on: { summary_posted: 'complete', timeout: 'complete' }, replyEvent: 'summary_posted', onEnter: ['killNonOwner', 'backstopTimer', 'notifyOwnerSummary'] },
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

  initState: (params) => ({
    lenses: params.lenses,
    currentLensIdx: undefined as number | undefined,
    currentLensName: undefined as string | undefined,
  }),

  decisionContext: (run) => {
    const r = asReview(run)
    return r.phase === 'post_pass' ? r.ext.currentLensName : undefined
  },

  summaryFormat: (run) => {
    const roundArc = Array.from({ length: run.rounds }, (_, i) =>
      `**Round ${i + 1}️⃣:** Critic ... · Owner ...`)

    const { ext } = asReview(run)
    const lenses = ext.lenses
    const lensSections = lenses && lenses.length > 0
      ? [``, `---`, ``, ...lenses.flatMap(lens => {
          const decision = run.decisions.find(d => d.context === lens.lens)
          return decision
            ? [`${decision.value === 'clean' ? '✅' : '🔍'} **Lens: ${lens.lens}** — ${decision.value}`, `> ${decision.because}`, ``]
            : [`⏳ **Lens: ${lens.lens}** — no verdict`, ``]
        })]
      : []

    return [
      `**⚔️ Review Summary** (${run.rounds} round${run.rounds > 1 ? 's' : ''})`,
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
      ...lensSections,
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
