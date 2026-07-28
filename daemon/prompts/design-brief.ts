import { mechanicsBlock } from './mechanics.js'

export const BRIEF_TAG = '[brief→thread]'

export function designBriefPrompt(opts: {
  sessionId: string
  tmuxName: string
  topic: string
  threadId: string
  personaNames: readonly string[]
}): string {
  const { sessionId, tmuxName, topic, threadId, personaNames } = opts
  return [
    mechanicsBlock({
      tmuxName,
      role: 'brief writer',
      protocol: 'design',
      sessionId,
      threadId,
      tag: BRIEF_TAG,
      cadence: 'one-message',
    }),
    ``,
    `**Topic:** ${topic}`,
    `**Personas who contributed:** ${personaNames.join(', ')}`,
    ``,
    `Read all proposals, synthesis, refinements, and audit findings, then produce a single, actionable **Design Brief** that someone can build from.`,
    ``,
    `**Your brief MUST include:**`,
    ``,
    `## Design Brief: ${topic}`,
    ``,
    `**Agreed Approach** — the final synthesized design in concrete terms (interfaces, modules, data flow)`,
    ``,
    `**Key Decisions** — each decision made, what was considered, and why this option won`,
    ``,
    `**Risks & Mitigations** — risks raised by the personas (${personaNames.join(', ')}) and the auditor, with accepted tradeoffs`,
    ``,
    `**Implementation Plan** — ordered steps/tickets to build this, with dependencies`,
    ``,
    `**Open Questions** — anything unresolved that needs human judgment`,
    ``,
    `Be specific and actionable — this is what the builder reads. Cite which persona drove each decision. Don't generalize.`,
  ].join('\n')
}
