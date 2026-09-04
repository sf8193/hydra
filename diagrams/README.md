# Diagrams

The primary orientation surface for agents and humans working on hydra. These diagrams show cross-layer message flows and architectural topology that can't be derived from reading any single file — dispatch ordering, recovery tiers, protocol mutual exclusion, the v1/v2 engine split. They make implicit structural decisions explicitly visible for review and design iteration.

**Use diagrams as design tools, not just documentation.** Drawing a flow diagram *before* implementing a cross-layer feature surfaces structural questions early — the `design.ts` audit bug (issue #194) was found by drawing a diagram, not by reading code. Draw first, implement, then verify the diagram still matches.

Each diagram has a `.mmd` source and a rendered `.png`.

## Conventions

**Naming:** `flow-{command}.mmd` for command/lifecycle flows, `{topic}-topology.mmd` for structural diagrams. Keep names lowercase-kebab.

**Structure:** Each `.mmd` file is a self-contained Mermaid diagram. Use `sequenceDiagram` for message flows through layers, `flowchart TD` for structural/topology diagrams.

**Participants:** Use the actual source file names (`session-lifecycle.ts`, `router.ts`) not abstractions. `gateway.ts` is the abstract interface — reference the concrete implementations (`{platform}-gateway.ts` or `discord-gateway.ts` / `slack-gateway.ts`) for message entry points. The daemon is platform-agnostic; platform names appear only in gateway implementations.

**When to create a new diagram:**
- A new command or protocol that routes through multiple daemon layers
- A new lifecycle flow (spawn variant, recovery path, protocol phase)
- A structural change that affects how components connect

**When NOT to create a diagram:**
- Single-module changes that don't affect cross-layer flow
- Bug fixes that don't change the message path
- Config or env changes

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
| `flow-destroy` | Destroy: delete thread + anchor message (Discord only, dead/orphan threads) |

### Protocol Flows
| Diagram | What it shows |
|---------|--------------|
| `protocol-engines` | **v1/v2 engine split** — dispatch ordering, phase sets, shared infrastructure. The most important structural diagram for protocol work. |
| `flow-protocol-robustness` | Protocol phases with loops, mutual exclusion, disconnect/auto-resume handling, grace periods |
| `flow-factory` | Factory build→review cycle: PM dispatches, builder forks, daemon enforces review, PM decides |
| `flow-factory-resilience` | **PM rotation** — gentle death, the PM-less gap, auto-adopt on bridge registration, thread-scoped authorization, `kill --cascade`, the 24h `awaiting_pm` TTL, and the `send_to_thread` name redirect. Why the PM thread, not the PM session, owns a build. |
| `flow-factory-board` | **The PM's status board** — one edited message per PM thread. What arms the ticker and what stops it, why a nudge may sharpen a board but never create one, and the three answers to a failed edit. |

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
