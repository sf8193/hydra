import { protocol, protocolSeed } from '../daemon/protocol-dsl.js'

// The original delegated-build graph, preserved as the explicitly quick path.
export default protocol('delegated-build-quick', {
  emoji: '⚡', display: 'Delegated Build Quick', owner: 'pm', roundPhase: 'building',
  cleanupPhase: 'closing', cancelPhase: 'cancelled', fallbackDegradation: 'PM self-build (no delegation)',
  roles: { pm: 'The PM', builder: 'The Builder' },
  phases: {
    clarifying: { actor: 'pm', half: 'top', on: { spec_ready: 'building', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'spec_ready' },
    building: { actor: 'builder', half: 'bottom', on: { build_done: 'reviewing', timeout: 'cancelled', cancel: 'cancelled', fallback: 'pm_build' }, advanceEvent: 'build_done' },
    reviewing: { actor: 'pm', half: 'top', on: { pm_approve: 'closing', pm_changes: 'building', timeout: 'cancelled', cancel: 'cancelled' } },
    pm_build: { actor: 'pm', half: 'top', on: { summary_posted: 'complete', timeout: 'cancelled', cancel: 'cancelled' }, advanceEvent: 'summary_posted' },
    closing: { actor: 'pm', half: 'top', on: { summary_posted: 'complete', timeout: 'complete', cancel: 'cancelled' }, advanceEvent: 'summary_posted' },
    complete: { actor: 'pm', half: 'top', on: {} }, cancelled: { actor: 'pm', half: 'top', on: {} },
  },
  windows: { clarifying: '15m', building: '30m', reviewing: '15m', pm_build: '30m', closing: '5m' },
  grace: { pm: '2m', builder: '30s' },
  decisions: { pm_verdict: { phase: 'reviewing', actor: 'pm', options: ['approve', 'request_changes'] as const, descriptions: { approve: 'why it ships', request_changes: 'what to fix' }, events: { approve: 'pm_approve', request_changes: 'pm_changes' }, finalEvent: 'pm_approve' } },
  roleConfig: { builder: { cadence: 'per-round', waits: true } },
  seed: { builder: (ctx) => protocolSeed(ctx.protocol, 'builder', ctx) + `\n\n${ctx.task ? `**Task:** ${ctx.task}` : `Read this thread for context — the PM's conversation describes what needs to be done.`}\n\nImplement the task. When done, call \`advance({ content: "summary of what you built" })\`.\n\nUse \`fetch_messages\` to read the thread if you need more context.` },
  notifications: {
    onKickoff: { pm: () => null, builder: () => null },
    onFallback: { pm: () => `[system] The builder died and couldn't be recovered. Implement the task yourself, then call \`advance({ content: "summary" })\`.` },
  },
  summaryFormat: (run) => [`**⚡ Delegated Build Quick Summary** (${run.rounds} round${run.rounds > 1 ? 's' : ''})`, ``, `🔬 **Synthesis** — one sentence.`, ``, `📋 **What was built** — include artifacts and review findings.`, ``, `➡️ **What's next** — what needs the human.`],
})
