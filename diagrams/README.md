# Diagrams

The primary orientation surface for agents and humans working on hydra. These diagrams show cross-layer message flows and architectural topology that can't be derived from reading any single file — dispatch ordering, recovery tiers, protocol mutual exclusion. They make implicit structural decisions explicitly visible for review and design iteration.

**Use diagrams as design tools, not just documentation.** Drawing a flow diagram *before* implementing a cross-layer feature surfaces structural questions early — the `design.ts` audit bug (issue #194) was found by drawing a diagram, not by reading code. Draw first, implement, then verify the diagram still matches.

Each diagram has a `.mmd` source and a rendered `.png`.

## Conventions

**Naming:** `flow-{command}.mmd` for command/lifecycle flows, `{topic}-topology.mmd` for structural diagrams. Keep names lowercase-kebab.

**Structure:** Each `.mmd` file is a self-contained Mermaid diagram. Use `sequenceDiagram` for message flows through layers, `flowchart TD` for structural/topology diagrams.

**Participants:** Use the actual source file names (`session-lifecycle.ts`, `router.ts`) not abstractions. `gateways/gateway.ts` is the abstract interface — reference the concrete implementations (`gateways/{platform}.ts`, that is `gateways/discord.ts` or `gateways/slack.ts`) for message entry points. The daemon is platform-agnostic; platform names appear only in gateway implementations.

**When to create a new diagram:**
- A new command or protocol that routes through multiple daemon layers
- A new lifecycle flow (spawn variant, recovery path, protocol phase)
- A structural change that affects how components connect

**When NOT to create a diagram:**
- Single-module changes that don't affect cross-layer flow
- Bug fixes that don't change the message path
- Config or env changes

**One question per picture.** A picture that needs paragraphs inside its shapes is two pictures. Labels are a few words; a list a reader needs goes in a side note (a grey box on a dotted line), not inside a gate. The routing and Slack pictures are sourced: each name means one thing across the set, a `<name>.sources.md` puts a `path:line` behind every box, and a reviewer who did not draw it checks the raw `.mmd` against the code before it is rendered. Their legend: orange diamond = a numbered gate, red = refused, unrouted or dropped, grey = held or still owed, green = delivered or done, plain = any other outcome. Their first line is an `%%{init}%%` that sets a white theme and a wider wrap, so any render command draws them the same.

**Names are checked.** CI fails when a diagram shows a `.ts` file or a camelCase name that no longer exists in the code (`__tests__/core-abstractions.test.ts`). It checks names only, so a move that keeps the name never fails it, and it cannot tell whether the flow drawn is still true. When it fails, redraw that part from the code, or delete the diagram if all it draws is removed code.

**Quality discipline:** Diagrams are authored with intent — what to emphasize, what level of abstraction serves the reader. Use adversarial review (`/review`) to verify diagram claims against code. Reference actual source file names, not abstractions.

## Rendering

Render `.mmd` to `.png` using Mermaid CLI at 3x scale for crisp output:
```bash
# Render one
npx -y -p @mermaid-js/mermaid-cli mmdc -i diagrams/flow-spawn.mmd -o diagrams/flow-spawn.png -t default -b white -s 3

# Render all
for f in diagrams/*.mmd; do npx -y -p @mermaid-js/mermaid-cli mmdc -i "$f" -o "${f%.mmd}.png" -t default -b white -s 3; done
```

Commit both the `.mmd` source and the `.png` render. Verify no source is unrendered:

```bash
for f in diagrams/*.mmd; do [ -f "${f%.mmd}.png" ] || { echo "unrendered: $f"; exit 1; }; done
```

## Catalog

### Command Flows
| Diagram | What it shows |
|---------|--------------|
| `flow-spawn` | Chat spawn: gateway → router → doSpawnSession → tmux + bridge |
| `flow-cli-spawn` | CLI spawn: unix socket → cli-handler → idempotency → doSpawnSession |
| `flow-fork` | Fork: thread command → resolve claudeSessionId → doSpawnSession with forkFrom |
| `flow-list-sessions` | List sessions: registry query → format → gateway send |
| `flow-respawn` | Respawn: thread command → read thread history → doSpawnSession with resurrectFrom |
| `flow-recovery-cascade` | Resume/respawn tiers: --resume → fork-transcript → respawn + death detection |
| `flow-revive` | **Who is home, putting a session back, and where a message goes**: `occupancy()`'s decision; every revive under one lock per target through `reviveThread()`; `deliver --revive`; and every target (`to`, `spawn`) resolving to a session that lands through `deliverToSession` (stuck → exit 5) |
| `flow-destroy` | Destroy: delete thread + anchor message (Discord only, dead/orphan threads), plus the `kill +d` composite that kills first |
| `flow-destroy-ended` | `kill --destroy` by name or thread id when no live session answers: who may, the `[threads] allow_destroy` gate, the guards |
| `flow-slack-edit` | `edit_message` / `delete_message` on a Slack conversation: the conversation rule, whose message it is picks the token, the main-only operator path, the missing-scope refusal |
| `flow-reply` | **A post's text on its way out**: a session's reply or send_to_thread, and the daemon's own safeSend/safeEdit, all through `withOutbound` → the gateway's `shapeOutbound` (Discord: tables drawn as PNGs by sips, else code blocks; box art fenced) → chunks, files on the first → `gateways/discord.ts`; the drawn files removed once the send settles |
| `flow-deliver` | **Whisper channel**: CLI deliver → reachability → sendToBridge (default) or sendOrQueue (`--queue`). Codex sessions route through adapter. Delivery proof in response. |
| `flow-dialog-dismiss` | Stuck dialog: pane-probe → re-read screen → Esc (or alert only on "No, exit" screens) → thread alert → notification to the session |
| `flow-jobs-dispatch` | Jobs: the clock's tick or `jobs run` → synchronous reserve → detached attempt → result file → apply on a later tick (or "ended without a result", or the guarded kill) |

### Routing and the Slack connector
One question per picture, read in this order. Each has a `<name>.sources.md` beside it: every box's `path:line`.

| Diagram | The question it answers |
|---------|--------------|
| `flow-route-owning-app` | Which app answers a message that several Slack apps heard? |
| `flow-route` | Which target hears a message, and may its sender reach it? (`routing/route.ts`: binding, `messages = "all"`, `[[rules]]`, the operator's DM to main, then `reachable_by`) |
| `flow-slack-hear` | How does each Slack app connect, and how does a live message reach the connector? |
| `flow-slack-catchup` | What does a catch-up pass read, and when does it hold or give up? |
| `flow-slack-accept` | Which Slack messages does an app take up and hand to routing? |
| `flow-slack-fate` | What does the Slack connector do with each fate routing returns (🚫, caps, owed)? |
| `flow-slack-deliver` | How does an owed Slack message reach its target (the guard, redirects, the answer)? |
| `flow-slack-owed` | How long may a Slack message stay owed, and what ends it? |
| `flow-slack-alert` | When a message is dropped or a connection goes wrong, who is told, where, and how often? |

A bold name in these pictures is one of README's [core abstractions](../README.md#core-abstractions), or one of these:

| Name | Question | Sentence |
|---|---|---|
| Owning app | Which app answers, when several heard it? | The one app that answers a message several apps heard; the others ignore it. |
| Serves | Can this app deliver to that target? | An app serves a specialist pinned to it, or an unpinned one when no specialist is pinned to that app; it always serves main and a session's own thread. |
| Binding | Which target does this conversation already have? | The target a conversation was bound to when it opened; it holds while hydra.toml declares that target and this app serves it. |
| Operator | Whose hydra is it? | The person `operator` names: always reaches every target, and is the only one who reaches main. |
| Reach | May this sender reach that target? | Only through an app that serves the target; then the operator reaches every target; anyone reaches a session's own thread; anyone else reaches a specialist only through a role in its `reachable_by`. |
| Fate | What does routing decide? | deliver, refused, unrouted or ignored: a decision the connector then acts on. |
| Guard | May this sender's message go through? | The optional command that judges a message from anyone but the operator before it is sent. |
| Catch-up | What did the live stream miss? | A pass, per app, that rereads Slack from each cursor and hands what it finds on as if it came live. |
| Cursor | Where has hydra read up to? | Per app and channel (or a thread a session listens in), the newest message read; held while a catch-up pass is incomplete. |
| Owed | What does hydra still owe a session? | A message accepted and not yet delivered or dropped, saved so catch-up replays it. |
| Drop | Why will an accepted message never arrive? | A message given up for one named kind: logged, counted, and alerted unless its kind is exempt. |
| Alert | Who is told that something went wrong? | A plain post, not a session turn, to the specialist it concerns, else the app's Slack specialists, else main, else the daemon log. |

### Protocol Flows
| Diagram | What it shows |
|---------|--------------|
| `flow-protocol-robustness` | Protocol phases with loops, mutual exclusion, disconnect/auto-resume handling, grace periods |
| `flow-review-fallback` | **Owner-driven subagent review** — how the owner fans out to fresh, independent subagents (one per material-driven lens, *not* forks), runs them in parallel, and synthesizes into the closing summary. Identical whichever door it came through: a critic that died or went silent, or a direct `review +subagent`. The engine triggers (`canFallbackOnDeath` / `enterDirectSubagentPhase` → `subagent_review`) live in `flow-protocol-robustness`. |

### Daemon Internals
| Diagram | What it shows |
|---------|--------------|
| `flow-tool-scoping` | **Three-tier tool model** + runtime `tools/list_changed` re-push. Why `advance` appears and disappears between protocol phases. |
| `flow-bridge-lifecycle` | Bridge registration, tool delivery, disconnect handling, reconnect, death detection |

### Structural
| Diagram | What it shows |
|---------|--------------|
| `command-topology` | Two-channel routing (chat + CLI) converging on shared daemon primitives |
| `health-topology` | Runtime components, state files, and health check connections |

### Missing (candidates for future PRs)
- `flow-daemon-restart` — module validation probe → kill incumbent → spawn replacement → verify
