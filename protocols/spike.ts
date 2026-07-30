import { protocol, protocolSeed } from '../daemon/protocol-dsl.js'

export default protocol('spike', {
  emoji: '🔬',
  display: 'Spike',

  owner: 'guide',
  cleanupPhase: 'reporting',
  cancelPhase: 'cancelled',

  roles: {
    explorer: 'The Explorer',
    guide: 'The Guide',
  },

  phases: {
    exploring: {
      actor: 'explorer', half: 'top',
      on: { checkpoint: 'exploring', wrap_up: 'reporting', timeout: 'reporting', cancel: 'cancelled' },
      replyEvent: 'checkpoint',
    },
    reporting: {
      actor: 'explorer', half: 'bottom',
      on: { report_posted: 'complete', timeout: 'complete' },
      replyEvent: 'report_posted',
      onEnter: ['backstopTimer'],
    },
    complete:  { actor: 'explorer', half: 'top', on: {} },
    cancelled: { actor: 'explorer', half: 'top', on: {} },
  },

  sentinels: {
    exploring: '[checkpoint]',
    reporting: '[report]',
  },

  windows: {
    exploring: '60m',
    reporting: '10m',
  },

  grace: {
    explorer: '2m',
    guide: '2m',
  },

  decisions: {
    explorer_done: {
      phase: 'exploring',
      actor: 'explorer',
      options: ['done'] as const,
      descriptions: { done: 'your summary' },
      events: { done: 'wrap_up' },
    },
  },

  roleConfig: {
    explorer: { cadence: 'per-phase', orient: `Read the question and any referenced code, files, or documents. Investigate depth-first — follow the evidence, don't survey.` },
  },

  seed: {
    explorer: (ctx) => protocolSeed(ctx.protocol, 'explorer', ctx)
      + `\n\n**Your question:** ${ctx.topic ?? 'Investigate the topic discussed in the thread.'}\n\nPost your final \`[report]\` in the reporting phase.\n\n**Report shape:**\n- **Finding** — what you found, in one sentence\n- **Evidence** — what you read, tested, observed\n- **Implications** — what this means\n- **Unknowns** — what you couldn't determine`,
  },

  turnNotification: (_run, prevContent) =>
    `[Spike — investigation]\n\n${prevContent}\n\n---\nContinue your investigation. Post \`[checkpoint]\` with progress, or call \`decide('done', summary)\` when complete.`,
})
