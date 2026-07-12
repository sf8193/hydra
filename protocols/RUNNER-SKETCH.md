# Generic Protocol Runner — what the daemon needs

> Working backwards from the three-layer document to the daemon that runs it.

## What dies in the existing TypeScript

If the document governs, these become unnecessary:

| Current code | Replaced by | Why |
|---|---|---|
| `reviewMachine` (adversarial.ts:84–91) | `createStateMachine('review', toTransitionTable(def))` | Transition table is declared in the skeleton |
| `CRITIC_SENTINEL` etc (adversarial.ts:22–24) | `def.sentinels[phase]` | Sentinels declared in skeleton |
| `CRITIC_TIMEOUT_MS` etc (adversarial.ts:104–105) | `windowMs(def, phase)` | Windows declared in skeleton |
| `reviewHalf()` (adversarial.ts:122–124) | `def.phases[phase].half` | Half declared per phase |
| `reviewCriticPrompt()` (prompts/review-critic.ts) | Seed block in the document, template-injected | The prompt IS the protocol data |
| `reviewSummaryFormat()` (prompts/review-summary.ts) | Owner cleanup seed in the document | The format IS the protocol data |
| `POST_PASS_INSTRUCTIONS` | Lens documents (already wired) | Compose by writing |
| `secondLine === '**LGTM**'` (build.ts:303) | `decide('approve' \| 'changes', because)` tool call | Decision declared in document |
| `onReviewReply` dispatch logic (~100 lines) | Generic: check sentinel → route to decision handler | The document declares what to check |

## What stays in the daemon permanently

| Code | Why it can't move to documents |
|---|---|
| State machine engine (`state-machine.ts`) | Pure runtime — executes the table, doesn't define it |
| `safeSend`, `chunk`, transport | Delivery infrastructure |
| `doSpawnSession`, `killSession` | Session lifecycle primitives |
| `dumpTranscript`, preserve-then-strike | Completion mechanics |
| `editOrSendStatus`, `formatStateLine` | Presentation grammar |
| `sentinel-nudge.ts` | Liveness check — reads sentinel data from document |
| `phase-budget.ts` | Session lifespan enforcement |
| Protocol registry (`protocol-registry.ts`) | The hub — loads and routes to documents |
| The `decide()` tool implementation | The primitive — documents declare decisions, daemon provides the tool |

## The runner shape

```typescript
// daemon/protocol-runner.ts — the generic runner

import { loadProtocolDef, toTransitionTable, expectedTag, windowMs, graceMs } from './protocol-def.js'
import { createStateMachine } from './state-machine.js'

export async function createProtocolRun(
  protocolPath: string,
  threadId: string,
  ownerSessionId: string,
  params: { rounds: number; topic?: string; lenses?: string[]; model?: string }
) {
  const def = await loadProtocolDef(protocolPath)
  const machine = createStateMachine(def.protocol, toTransitionTable(def))

  // Spawn roles from seeds
  for (const [roleId, roleSpec] of Object.entries(def.roles)) {
    if (roleId === 'owner') continue  // owner already exists
    const seed = renderSeed(def, roleId, params)
    await spawnRole(roleId, roleSpec, seed, threadId, params.model)
  }

  return {
    def,
    machine,
    phase: def.initialPhase,

    // The reply handler — replaces onReviewReply / onBuildReply
    onReply(sessionId: string, text: string, sentMessageIds: string[]) {
      const role = resolveRole(sessionId)
      const firstLine = text.split('\n')[0].trim()
      const sentinel = def.sentinels[this.phase]

      // Sentinel check
      if (sentinel && !firstLine.startsWith(sentinel)) return

      // Check for decide() tool calls in the message
      const decision = extractDecision(text, def.decisions, this.phase)
      if (decision) {
        const event = decision.event
        const result = machine.transition(this.phase, event)
        if (result.ok) {
          this.phase = result.to
          narrate(threadId, decision)  // post the because to the thread
        }
        return
      }

      // Default: phase's actor posted → fire the phase's default event
      const events = Object.keys(def.phases[this.phase].on ?? {})
      const defaultEvent = events[0]  // first event is the "posted" event
      const result = machine.transition(this.phase, defaultEvent)
      if (result.ok) this.phase = result.to
    },

    // Timer management — from windows
    resetTimeout() {
      const ms = windowMs(def, this.phase)
      if (!ms) return
      // ... set timeout, on fire: transition 'timeout', handle per phase
    },

    // expectedTag — for sentinel-nudge
    expectedTag(sessionId: string) {
      const role = resolveRole(sessionId)
      return expectedTag(def, this.phase, role)
    },
  }
}
```

## The decide() tool

```typescript
// Added to bridge-tools.ts — available to all protocol participants

{
  name: 'decide',
  description: 'Make a protocol decision. The machine routes on value; prose rides because.',
  inputSchema: {
    type: 'object',
    properties: {
      value: {
        type: 'string',
        description: 'The decision value — one of the options declared by the protocol.',
      },
      because: {
        type: 'string',
        description: 'Why. The daemon narrates this to the thread.',
      },
    },
    required: ['value', 'because'],
  },
}
```

The daemon dynamically sets the `enum` on `value` based on the current phase's decision options. `computeToolsForSession` already filters tools per session — it would also parameterize `decide()` with the available options.

## The seed template engine

Not a template engine — just string replacement. The document's seed blocks use `{thread_id}`, `{session_id}`, `{tmux_name}`, `{rounds}`, `{topic}`, `{lens_instructions}`, `{mandate}`, `{round_arc}`. The runner replaces them at spawn time.

The mandate selection (default vs focused) is a conditional in the seed block. The runner picks based on whether `topic` is set.

## What this buys

1. **To add a protocol:** write a document. The runner loads it.
2. **To modify a protocol:** edit the document. Restart the daemon. The runner loads the new version.
3. **To add a lens:** write a lens file. (Already works.)
4. **To change a prompt:** edit the seed in the document. No TypeScript.
5. **To add a decision point:** declare it in the decisions block. The runner provides the tool.

The 700-line `adversarial.ts` becomes ~50 lines of generic runner + a document. The 700-line `build.ts` becomes the same runner + a different document. The daemon's complexity moves from N×700 lines (one file per protocol) to one runner + N documents.

## Migration path

1. `decide()` tool — build it at the build.ts LGTM site (the bug site from PR #123). One decision, one protocol, proves the primitive.
2. Flip sentinels + windows + grace to read from the document (review first). The parity tests become the acceptance tests — they already assert equality.
3. Move seeds to the document. `reviewCriticPrompt` becomes a template render of the seed block.
4. The runner crystallizes from the common shape of adversarial.ts and build.ts after steps 1–3 strip their protocol-specific data.

Each step is a PR. Each step leaves the daemon running identically. The parity tests catch drift at every point.
