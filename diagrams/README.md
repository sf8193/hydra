# Diagrams

Mermaid sequence and flow diagrams documenting hydra's key flows. Each diagram has a `.mmd` source and a rendered `.png`.

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

## Rendering

Render `.mmd` to `.png` using Mermaid CLI:

```bash
# Render one
npx -y -p @mermaid-js/mermaid-cli mmdc -i diagrams/flow-spawn.mmd -o diagrams/flow-spawn.png -t default -b white

# Render all
for f in diagrams/*.mmd; do npx -y -p @mermaid-js/mermaid-cli mmdc -i "$f" -o "${f%.mmd}.png" -t default -b white; done
```

Commit both the `.mmd` source and the `.png` render.

**Prefer generated diagrams over hand-drawn** when the source is machine-readable. `scripts/gen-topology.ts` is the model — it derives `docs/topology.mmd` from actual `import` statements and is provably fresh. The v2 protocol DSL (`protocols/*.ts`) is similarly machine-readable; a `gen-protocol-diagrams.ts` walking `protocol()` specs would eliminate the staleness problem for protocol diagrams.

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

### Protocol Flows
| Diagram | What it shows |
|---------|--------------|
| `protocol-engines` | **v1/v2 engine split** — dispatch ordering, phase sets, shared infrastructure. The most important structural diagram for protocol work. |
| `flow-protocol-robustness` | Protocol phases with loops, mutual exclusion, disconnect/auto-resume handling, grace periods |

### Structural
| Diagram | What it shows |
|---------|--------------|
| `command-topology` | Two-channel routing (chat + CLI) converging on shared daemon primitives |
| `health-topology` | Runtime components, state files, and health check connections |

### Missing (candidates for future PRs)
- `flow-factory` — factory_build → fork PM → builder implements → auto-review → awaiting_pm decision loop
- `flow-bridge-lifecycle` — bridge registration, tool delivery, disconnect handling, reconnect
- `flow-daemon-restart` — module validation probe → kill incumbent → spawn replacement → verify
- **`gen-protocol-diagrams.ts`** — highest priority: auto-generate v2 protocol phase diagrams from `protocol()` DSL specs, same pattern as `gen-topology.ts`. Would make protocol diagram staleness structurally impossible.
- `flow-daemon-restart` — module validation probe → kill incumbent → spawn replacement → verify
