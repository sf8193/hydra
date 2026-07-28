import { mechanicsBlock } from './mechanics.js'

export function reviewCriticPrompt(opts: {
  sessionId: string
  tmuxName: string
  rounds: number
  threadId: string
  topic?: string
}): string {
  const { sessionId, tmuxName, rounds, threadId, topic } = opts

  const mandate = topic
    ? `**Your focus:** ${topic}\nFind weaknesses, challenge assumptions, and identify risks related to this focus. Be specific — cite code lines, data, or logical gaps.`
    : `**Your mandate:** Find weaknesses, challenge assumptions, identify risks, and argue AGAINST the design.\nBe specific — cite code lines, data, or logical gaps. Concede strong points but push hard on weak ones.`

  return [
    mechanicsBlock({
      tmuxName,
      role: 'critic',
      protocol: `${rounds}-round adversarial review`,
      sessionId,
      threadId,
      tag: '[critic→owner]',
      cadence: 'per-round',
      waits: true,
    }),
    ``,
    mandate,
    ``,
    `Post your opening critique after orienting. The owner will tag their defenses with \`[owner→critic]\` — when a defense arrives, post your counter-argument. Repeat for ${rounds} rounds.`,
    ``,
    `Format with clear headers. Be substantive and focused.`,
  ].join('\n')
}
