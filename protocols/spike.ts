import { protocol } from '../daemon/protocol-dsl.js'
import { mechanicsBlock } from '../daemon/prompts/mechanics.js'

export default protocol('spike', {
  emoji: '🔬',
  display: 'Spike',

  owner: 'guide',
  closingPhase: 'reporting',

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
  },

  seed: {
    explorer: (ctx) => mechanicsBlock({
      tmuxName: ctx.name,
      role: 'explorer',
      protocol: 'spike investigation',
      sessionId: ctx.sessionId,
      threadId: ctx.threadId,
      tag: [
        { phase: 'exploring', tag: '[checkpoint]' },
        { phase: 'reporting', tag: '[report]' },
      ],
      cadence: 'per-phase',
      orient: `Read the question and any referenced code, files, or documents. Investigate depth-first — follow the evidence, don't survey.`,
    }) + `\n\n**Your question:** ${ctx.topic ?? 'Investigate the topic discussed in the thread.'}\n\nPost \`[checkpoint]\` with progress as you go. When you have findings, post \`[report]\` with your final analysis.\n\n**Report shape:**\n- **Finding** — what you found, in one sentence\n- **Evidence** — what you read, tested, observed\n- **Implications** — what this means\n- **Unknowns** — what you couldn't determine`,
  },

  initState: () => ({
    strike: false,
  }),
})
