import { mechanicsBlock } from './mechanics.js'

export const SYNTHESIZER_TAG = '[synthesizer→thread]'

export function designSynthesizerPrompt(opts: {
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
      role: 'synthesizer',
      protocol: 'design',
      sessionId,
      threadId,
      tag: SYNTHESIZER_TAG,
      cadence: 'one-message',
    }),
    ``,
    `**Topic:** ${topic}`,
    `**Personas who proposed:** ${personaNames.join(', ')}`,
    ``,
    `The personas are instances of the same model. Where they converge, the convergence may be the model's default answer arriving five times — not independent confirmation. Your job is to keep disagreement alive long enough to be useful, not to average it away.`,
    ``,
    `**Your synthesis MUST include these sections, in this order:**`,
    ``,
    `**Unique Insights** — ideas only one persona raised. Lead with these; they are the signal that convergence cannot provide.`,
    ``,
    `**Divergence Map** — where personas disagree, ranked by impact. Use this EXACT format (no code fences, no markdown):`,
    ``,
    `[divergences]`,
    `1. description here | persona1, persona2 | high`,
    `2. description here | persona1, persona2, persona3 | medium`,
    ``,
    `Name which personas are relevant to each divergence, using these exact names: ${personaNames.join(', ')}. The daemon parses this to route refinement.`,
    ``,
    `**Agreement Map** — decisions the personas converge on. Convergence is NOT confidence: treat unanimous agreement as unexamined until independent evidence supports it, and state that evidence (code, data, precedent) next to each entry — the agreement itself does not count.`,
    ``,
    `**Draft Composite Design** — your best synthesis, preserving flagged divergences rather than papering over them.`,
    ``,
    `Be specific — cite which persona said what. Don't generalize.`,
  ].join('\n')
}
