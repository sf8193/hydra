import { protocol, protocolSeed } from '../daemon/protocol-dsl.js'

export default protocol('review', {
  emoji: '⚔️',
  display: 'Adversarial Review',

  owner: 'owner',
  cleanupPhase: 'cleanup',
  cancelPhase: 'cancelled',

  // What `subagent_review` costs, whichever way it was reached. Rides on the
  // CompletionEvent so a consumer can tell its caller the review was owner-run.
  fallbackDegradation: 'subagent self-review (no adversarial tension)',

  roles: {
    critic: 'The Critic',
    owner: 'The Owner',
  },

  phases: {
    critic_turn: { actor: 'critic', half: 'top', on: { critic_approve: 'cleanup', critic_feedback: 'owner_turn', critic_conditional: 'apply_changes', timeout: 'cancelled', cancel: 'cancelled', fallback: 'subagent_review' } },
    owner_turn:  { actor: 'owner', half: 'bottom', on: { owner_posted: 'critic_turn', final_round: 'unresolved', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'owner_posted', finalAdvanceEvent: 'final_round' },
    apply_changes: { actor: 'owner', half: 'bottom', on: { changes_applied: 'critic_turn', unable: 'critic_turn', final_round: 'unresolved', timeout: 'cancelled', cancel: 'cancelled' } },
    cleanup:     { actor: 'owner',  half: 'top',    on: { summary_posted: 'complete', timeout: 'complete' }, advanceEvent: 'summary_posted' },
    // The owner runs the review itself, via fresh subagents. Reached two ways,
    // both through this phase's `fallback` transition: the critic died and
    // auto-resume is exhausted, or the caller asked for it up front with
    // `review +subagent`. Named for what the owner does here, not for which
    // door it came through.
    // Not the cleanupPhase, so the runner drives entry manually and sends the
    // onFallback instructions below — see enterFallbackPhase in protocol-runner.
    // timeout → cancelled (not complete): unlike cleanup, hitting the window here
    // means the review never produced a result, so it's a failure, not a success.
    subagent_review: { actor: 'owner', half: 'top', on: { summary_posted: 'complete', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'summary_posted' },
    complete:    { actor: 'owner',  half: 'top',    on: {} },
    unresolved:  { actor: 'owner',  half: 'top',    on: {} },
    cancelled:   { actor: 'owner',  half: 'top',    on: {} },
  },

  windows: {
    critic_turn: '10m',
    owner_turn: '30m',
    apply_changes: '30m',
    cleanup: '5m',
    // Heavier than a single owner turn — spawn N subagents, wait, synthesize —
    // so the default fits the work rather than forcing extend_phase. The
    // unconditional backstop is 3x this (135m).
    subagent_review: '45m',
  },

  grace: {
    critic: '30s',
    owner: '2m',
  },

  roleConfig: {
    critic: { cadence: 'per-round', waits: true },
  },

  decisions: {
    critic_verdict: {
      phase: 'critic_turn', actor: 'critic',
      options: ['approve', 'request_changes', 'approve_with_changes'] as const,
      descriptions: {
        approve: 'no remaining changes; state what was checked',
        request_changes: 'blocking issues and evidence; owner fixes before re-review',
        approve_with_changes: 'specific bounded fixes to apply, then you recheck',
      },
      events: { approve: 'critic_approve', request_changes: 'critic_feedback', approve_with_changes: 'critic_conditional' },
    },
    owner_changes: {
      phase: 'apply_changes', actor: 'owner',
      options: ['applied', 'unable'] as const,
      descriptions: { applied: 'list fixes and checks for critic re-review', unable: 'explain why fixes could not be applied' },
      events: { applied: 'changes_applied', unable: 'unable' },
      finalEvent: 'final_round',
    },
  },

  notifications: {
    onExit: (run, outcome, reason) => outcome === 'cancelled'
      ? `[system] Adversarial Review cancelled: ${reason}`
      : run.phase === 'unresolved'
        ? run.decisions.at(-1)?.phase === 'apply_changes' && run.decisions.at(-1)?.value === 'applied'
          ? `[system] Adversarial Review finished after ${run.currentRound} critic round${run.currentRound === 1 ? '' : 's'}: the requested fixes were applied but not rechecked because the review reached its cap. Return the findings and fix report to the caller; do not report approval.`
          : `[system] Adversarial Review finished with changes unresolved after ${run.currentRound} critic round${run.currentRound === 1 ? '' : 's'}. Return the findings to the caller; do not report approval.`
        : `[system] Adversarial Review finished after ${run.currentRound} round${run.currentRound === 1 ? '' : 's'}. Check the recorded verdict and review path.`,
    onKickoff: {
      owner: (run) => {
        const topic = run.params.topic as string | undefined
        const lines = [
          `[system] **Adversarial Review** — up to ${run.rounds} critic round${run.rounds > 1 ? 's' : ''}; approval may close early`,
          ``,
          `You are **The Owner**. The Critic was spawned and is reading the thread to orient.`,
        ]
        if (topic) lines.push(`The Critic was given the following prompt: '${topic}'`)
        lines.push(``, `When their critique is ready, you'll be notified with the full post and instructions on how to respond.`)
        return lines.join('\n')
      },
      critic: () => null,
    },

    // The owner runs the review itself with fresh subagents. Lenses are
    // suggestions, not a checklist: what's being reviewed drives the choice, and
    // the subagents orient independently rather than inheriting the owner's
    // context. Only the preamble differs by mode — a death is news the owner has
    // to absorb (which critic, how many rounds survive), while a direct request
    // is something the owner already knows it asked for. The task is identical,
    // so it is written once.
    onFallback: (run, ctx) => {
      const topic = run.params.topic as string | undefined

      // Lens modifiers (`+security`, …) were written for the critic's seed. On
      // this path there is no critic to carry them — it died, or was never
      // spawned — so hand them to the owner instead. Without this,
      // `review +subagent +security` quietly loses the +security.
      const lenses = ((run.params.modifiers ?? []) as Array<{ name: string; instructions?: string }>)
        .filter(m => !!m.instructions)
      const lensBlock = lenses.length > 0
        ? [
            `\n**Requested lenses** (${lenses.map(m => `+${m.name}`).join(' ')}) — apply these on top of the ones the material suggests:`,
            ...lenses.map(m => `\n${m.instructions}`),
          ]
        : []

      // The opening line is the thread's record of why this run changed shape,
      // so it has to name the actual event. A critic that timed out did not die:
      // it was alive and idle, and the daemon retired it. Saying "died" there
      // would put a false cause in the one message a human reads later.
      const preamble = ctx.mode === 'direct'
        ? [
            `[system] **Subagent review** — you asked for this directly (\`+subagent\`), so no critic was spawned. There is no adversary to argue with: you run the review and you post the result.`,
          ]
        : [
            ctx.cause === 'death'
              ? `[system] **${ctx.deadLabel} died** after ${ctx.resumeAttempts} resume attempt${ctx.resumeAttempts === 1 ? '' : 's'}. Falling back to subagent review — you run it yourself.`
              : `[system] **${ctx.deadLabel} went silent** — its phase window elapsed with nothing posted, so it was retired. Falling back to subagent review — you run it yourself.`,
            ``,
            ctx.completedRounds > 0
              ? `The critic posted findings for ${ctx.completedRounds} of ${run.rounds} round${run.rounds === 1 ? '' : 's'} — read them before choosing your lenses. Focus your subagents on what the critic *didn't* cover.`
              : ctx.cause === 'death'
                ? `No rounds completed before it died.`
                : `No rounds completed before it stalled.`,
          ]
      return [
        ...preamble,
        ``,
        `**Your task:** review the work with fresh Claude Code subagents.`,
        ``,
        `1. **Pick the lenses that fit what you're reviewing.** These are suggestions, not a checklist — the material drives the choice. Code? Maybe correctness/edge cases, import & layering boundaries, conventions/golden patterns, test quality, security, resource lifecycle. A design doc or plan? More likely hidden assumptions, alternatives not considered, failure modes, second-order effects. Add lenses the material calls for; drop ones that don't apply.`,
        `2. **Spawn one fresh subagent per chosen lens.** Tell each to re-read this thread and the specifics (the diff / doc / spec) and orient on its own — do not fork your own context into them; independence is the point. Run them in parallel.`,
        `3. **Synthesize** their findings yourself — resolve conflicts, drop the noise, keep what's real.`,
        topic ? `\n**Focus:** ${topic} — weight your lens choices toward this.` : '',
        ...lensBlock,
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
      ) + `\n\nPost a verdict with evidence after orienting. Use approve only when no changes remain. Use approve_with_changes for bounded fixes you will recheck after the owner applies them; use request_changes for blocking work. Recheck every fix and issue another verdict. You may close early by approving. This review has a hard cap of ${ctx.rounds} critic turns; at the cap, a non-approval result stays unresolved.\n\nFormat with clear headers. Be substantive and focused.`,
  },

  summaryFormat: (run) => {
    const roundArc = Array.from({ length: run.currentRound }, (_, i) =>
      `**Round ${i + 1}️⃣:** Critic ... · Owner ...`)

    const modifiers = run.params.modifiers as Array<{ name: string }> | undefined
    const modNote = modifiers?.length
      ? ` · ${modifiers.map(m => `+${m.name}`).join(' ')}`
      : ''

    return [
      `**⚔️ Review Summary** (${run.currentRound} of ${run.rounds} maximum rounds${modNote})`,
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
