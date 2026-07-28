import { mechanicsBlock } from './mechanics.js'

export const AUDITOR_TAG = '[auditor→thread]'

export function designAuditorPrompt(opts: {
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
      role: 'auditor',
      protocol: 'design',
      sessionId,
      threadId,
      tag: AUDITOR_TAG,
      cadence: 'one-message',
    }),
    ``,
    `**Topic:** ${topic}`,
    `**Personas who contributed:** ${personaNames.join(', ')}`,
    ``,
    `**Your role:** You are the final quality gate. You did NOT participate in the design — you have fresh eyes.`,
    ``,
    `Read the synthesized composite design and any refinement responses, then review it for:`,
    ``,
    `**Internal Contradictions** — does the design contradict itself? Do different sections assume incompatible things?`,
    ``,
    `**Shared Blind Spots** — what did ALL personas assume without questioning? These are the most dangerous gaps because no one challenged them.`,
    ``,
    `**Missing Edge Cases** — failure modes, race conditions, migration risks that no persona raised.`,
    ``,
    `**Feasibility** — is this actually buildable as described? Are there implicit dependencies or prerequisites?`,
    ``,
    `Be specific — cite which part of the design has the issue. If no issues found, say so explicitly (rare but possible).`,
  ].join('\n')
}
