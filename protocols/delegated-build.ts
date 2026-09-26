import { protocol, protocolSeed } from '../daemon/protocol-dsl.js'

export default protocol('delegated-build', {
  emoji: '📋', display: 'Delegated Build', owner: 'pm', initialPhase: 'planning', roundPhase: 'building',
  cleanupPhase: 'closing', cancelPhase: 'cancelled',
  fallbackDegradation: 'delegation and independent authorship lost; fresh review and commit sequencing retained',
  roles: { pm: 'The PM', builder: 'The Builder' },
  phases: {
    planning: { actor: 'pm', half: 'top', on: { plan_ready: 'building', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'plan_ready' },
    building: {
      actor: 'builder', half: 'bottom',
      on: { build_done: 'verifying', timeout: 'cancelled', cancel: 'cancelled', fallback: 'pm_build' },
      advanceEvent: 'build_done',
      // A real fallback retires the builder permanently. Later retries and
      // steps still enter roundPhase so they consume the same turn budget, but
      // immediately redirect to the PM-owned build phase before notifying.
      onEnter: [async (run, _prev, content, ctx) => {
        if (!run._enteredFallback) return false
        await ctx.fireTransition(run, 'fallback', content, 'PM self-build redirect failed')
        return true
      }],
    },
    pm_build: { actor: 'pm', half: 'top', on: { build_done: 'verifying', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'build_done' },
    verifying: { actor: 'pm', half: 'top', capabilities: ['protocol_spawn'], on: { request_changes: 'building', cap_request_changes: 'cap_exhausted', step_passed: 'committing', timeout: 'cancelled', cancel: 'cancelled' } },
    committing: { actor: 'pm', half: 'top', on: { next_step: 'building', cap_next_step: 'cap_exhausted', complete: 'closing', timeout: 'cancelled', cancel: 'cancelled' } },
    cap_exhausted: { actor: 'pm', half: 'top', on: { cancel: 'cancelled' }, onEnter: [async (run, _prev, _content, ctx) => { await ctx.fireTransition(run, 'cancel', '', 'builder-turn budget exhausted'); return true }] },
    closing: { actor: 'pm', half: 'top', on: { summary_posted: 'complete', timeout: 'complete', cancel: 'cancelled' }, advanceEvent: 'summary_posted' },
    complete: { actor: 'pm', half: 'top', on: {} }, cancelled: { actor: 'pm', half: 'top', on: {} },
  },
  windows: { planning: '15m', building: '30m', pm_build: '30m', verifying: '30m', committing: '10m', cap_exhausted: '1m', closing: '5m' },
  grace: { pm: '2m', builder: '30s' },
  decisions: {
    verification: { phase: 'verifying', actor: 'pm', options: ['step_passed', 'request_changes'] as const, descriptions: { step_passed: 'mechanical checks and fresh review passed', request_changes: 'bounded fixes required' }, events: { step_passed: 'step_passed', request_changes: 'request_changes' }, finalEvents: { step_passed: 'step_passed', request_changes: 'cap_request_changes' } },
    commit_result: { phase: 'committing', actor: 'pm', options: ['next_step', 'complete'] as const, descriptions: { next_step: 'commit succeeded; hand off the next atomic step', complete: 'commit succeeded; all planned steps are done' }, events: { next_step: 'next_step', complete: 'complete' }, finalEvents: { next_step: 'cap_next_step', complete: 'complete' } },
  },
  roleConfig: { builder: { cadence: 'per-round', waits: true } },
  seed: { builder: (ctx) => protocolSeed(ctx.protocol, 'builder', ctx) + `\n\nYou may read the full plan, but you are authorized to edit only the current numbered step in the latest PM handoff. Do not commit, amend, rebase, or push. Preserve unrelated work. Run the step's requested checks and report changed files, commands, and results with \`advance({ content: "..." })\`.` },
  notifications: {
    onKickoff: { pm: (run) => `[system] **Delegated Build** — planning\n\n**Task:** ${run.params.task ?? 'Read the thread for the requested task.'}\n\nWrite a numbered atomic plan. For every step specify allowed files, exclusions, and executable exit criteria. Then hand off only step 1 with \`advance({ content: "plan plus current-step brief" })\`.`, builder: () => null },
    onTurn: (run, content) => {
      if (run.phase === 'building') return `[system] Build only the current authorized step. Do not commit. PM handoff:\n\n${content}`
      if (run.phase === 'pm_build') return `[system] Continue in PM self-build mode. Build only the current authorized step without committing, then report changed files and checks with \`advance({ content: "..." })\`.\n\nCurrent brief or requested fixes:\n${content}`
      if (run.phase === 'verifying') return `[system] Verify the exact current-step diff. Run the specified mechanical checks. Spawn a fresh headless reviewer with \`read_thread=true\` and a bounded \`phase_budget\`; require PASS / PASS WITH FIXES / FAIL with evidence returned via \`send_to_thread\`. Record commands, reviewer name, verdict, and evidence. Use request_changes unless clean; use step_passed only with that evidence.\n\nBuilder report:\n${content}`
      if (run.phase === 'committing') return `[system] Commit exactly the reviewed current-step diff — no extra files or edits. Then choose complete, or next_step with the next bounded step brief.\n\nVerification evidence:\n${content}`
      return content
    },
    onFallback: () => `[system] The builder died and could not be recovered. Delegation and independent authorship are lost, but fresh review and commit sequencing remain. Self-build only the currently authorized step without committing, then call \`advance({ content: "changed files and mechanical checks" })\`; it will enter verifying.`,
  },
  summaryFormat: (run) => [`**📋 Delegated Build Summary** (${run.currentRound} builder turn${run.currentRound > 1 ? 's' : ''})`, ``, `🔬 **Synthesis** — one sentence.`, ``, `🧪 **Verification** — mechanical checks and fresh reviewer verdicts.`, ``, `📦 **Commits / artifacts** — exact reviewed step commits.`, ``, `➡️ **What's next** — what needs the human.`],
})
