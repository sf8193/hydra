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
      on: { checkpoint: 'steering', timeout: 'reporting', cancel: 'cancelled' },
      advanceEvent: 'checkpoint',
    },
    steering: {
      actor: 'guide', half: 'bottom',
      on: { continue: 'exploring', redirect: 'exploring', wrap_up: 'reporting', timeout: 'exploring', cancel: 'cancelled' },
    },
    reporting: {
      actor: 'explorer', half: 'top',
      on: { report_posted: 'complete', timeout: 'complete' },
      advanceEvent: 'report_posted',
      onEnter: [],
    },
    complete:  { actor: 'explorer', half: 'top', on: {} },
    cancelled: { actor: 'explorer', half: 'top', on: {} },
  },

  windows: {
    exploring: '60m',
    steering: '5m',
    reporting: '10m',
  },

  grace: {
    explorer: '2m',
    guide: '2m',
  },

  decisions: {
    guide_steer: {
      phase: 'steering',
      actor: 'guide',
      options: ['continue', 'redirect', 'wrap_up'] as const,
      descriptions: {
        continue: 'keep investigating the current line',
        redirect: 'change focus — your content becomes the new direction',
        wrap_up: 'enough investigation, move to final report',
      },
      events: {
        continue: 'continue',
        redirect: 'redirect',
        wrap_up: 'wrap_up',
      },
    },
  },

  roleConfig: {
    explorer: { cadence: 'per-phase', orient: `Read the question and any referenced code, files, or documents. Investigate depth-first — follow the evidence, don't survey.` },
    guide: { cadence: 'per-round', waits: true },
  },

  seed: {
    explorer: (ctx) => protocolSeed(ctx.protocol, 'explorer', ctx)
      + `\n\n**Your question:** ${ctx.topic ?? 'Investigate the topic discussed in the thread.'}`
      + `\n\nInvestigate depth-first. Post checkpoints via \`advance({ content: "..." })\` as you make progress — the guide will review each checkpoint and may redirect your focus. When the guide decides you have enough, you'll be asked to write a final report.`
      + `\n\n**Checkpoint format:** One paragraph — what you found so far, what you're pursuing next, what's uncertain.`
      + `\n\n**Report format** (for the reporting phase):\n- **Finding** — what you found, in one sentence\n- **Evidence** — what you read, tested, observed\n- **Implications** — what this means\n- **Unknowns** — what you couldn't determine`,
  },

  notifications: {
    onKickoff: {
      guide: (run) => {
        const topic = (run.params.topic ?? 'the topic discussed in the thread') as string
        return [
          `[system] **Spike** — starting`,
          ``,
          `**Question:** ${topic}`,
          ``,
          `You are **The Guide**. The Explorer will investigate and post checkpoints. After each checkpoint, you'll be asked to steer: continue the current line, redirect to a new focus, or wrap up.`,
        ].join('\n')
      },
      explorer: () => null,
    },
    onTurn: (run, prevContent) => {
      if (run.phase === 'steering') {
        return [
          `[Spike — checkpoint]`,
          ``,
          `The Explorer reports:`,
          ``,
          prevContent,
          ``,
          `---`,
          `Steer the investigation:`,
          `- \`advance({ content: "...", verdict: "continue" })\` — keep investigating this line`,
          `- \`advance({ content: "new focus", verdict: "redirect" })\` — change direction (your content becomes the new focus)`,
          `- \`advance({ content: "...", verdict: "wrap_up" })\` — enough, move to final report`,
        ].join('\n')
      }
      if (run.phase === 'exploring') {
        const lastSteer = [...run.decisions].reverse().find(d =>
          d.phase === 'steering' && ['continue', 'redirect', 'wrap_up'].includes(d.value),
        )
        if (lastSteer?.value === 'redirect') {
          return [
            `[Spike — redirected]`,
            ``,
            `The Guide redirected your investigation:`,
            ``,
            prevContent,
            ``,
            `---`,
            `Shift your focus to the above. Call \`advance({ content: "checkpoint update" })\` when you have progress to report.`,
          ].join('\n')
        }
        if (!prevContent) {
          return [
            `[Spike — continue]`,
            ``,
            `Steering timed out — continuing your investigation.`,
            ``,
            `---`,
            `Keep investigating. Call \`advance({ content: "checkpoint update" })\` when you have progress to report.`,
          ].join('\n')
        }
        return [
          `[Spike — continue]`,
          ``,
          `The Guide says continue:`,
          ``,
          prevContent,
          ``,
          `---`,
          `Keep investigating. Call \`advance({ content: "checkpoint update" })\` when you have progress to report.`,
        ].join('\n')
      }
      if (run.phase === 'reporting') {
        return [
          `[Spike — reporting]`,
          ``,
          `Investigation complete. Post your final report.`,
          ``,
          `---`,
          `Use \`advance({ content: "your report" })\` to submit. Structure it as:`,
          `- **Finding** — what you found, in one sentence`,
          `- **Evidence** — what you read, tested, observed`,
          `- **Implications** — what this means`,
          `- **Unknowns** — what you couldn't determine`,
        ].join('\n')
      }
      return `[Spike] ${prevContent}`
    },
  },

  summaryFormat: (run) => [
    `**🔬 Spike Report**`,
    ``,
    `- **Finding** — what you found, in one sentence`,
    `- **Evidence** — what you read, tested, observed`,
    `- **Implications** — what this means`,
    `- **Unknowns** — what you couldn't determine`,
  ],
})
