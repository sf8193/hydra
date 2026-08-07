# Diagrams

Mermaid sequence and flow diagrams documenting hydra's key flows. Each diagram has a `.mmd` source and a rendered `.png`.

## Conventions

**Naming:** `flow-{command}.mmd` for command/lifecycle flows, `{topic}-topology.mmd` for structural diagrams. Keep names lowercase-kebab.

**Structure:** Each `.mmd` file is a self-contained Mermaid diagram. Use `sequenceDiagram` for message flows through layers, `flowchart TD` for structural/topology diagrams.

**Participants:** Use the actual source file names (`session-lifecycle.ts`, `router.ts`) not abstractions. `gateway.ts` is the abstract interface — reference the concrete implementations (`{platform}-gateway.ts` or `discord-gateway.ts` / `slack-gateway.ts`) for message entry points. The daemon is platform-agnostic; platform names appear only in gateway implementations.

**When to hand-draw a diagram:**
- A new cross-layer message flow (spawn variant, recovery path) with no declarative source
- A structural/editorial topology change (command routing, health monitors)

**When NOT to hand-draw:**
- Protocol phase mechanics — these should be **generated** from `protocol()` DSL specs or `createStateMachine()` tables. Hand-drawn protocol diagrams have a measured ~44% staleness rate and produce fictional references at a rate attention does not fix. See "Generated vs Hand-Drawn" below.
- Single-module changes, bug fixes, config changes

## Rendering

Two pipelines exist. The HTML wrapper is primary — it reads `%%` header lines as title/subtitle and produces styled output. `mmdc` is a quick fallback that discards those headers.

**HTML wrapper (primary):** Wrap the `.mmd` in an HTML shell that loads Mermaid, render via headless Chromium. This is what produced the original June diagrams with titles and styled participant boxes. Use the `html-diagram-rendering` skill (user-global, not in this repo) or build the wrapper manually.

**mmdc (fallback):** Quick renders without titles. The `%%` header lines become dead comments.
```bash
# Render one
npx -y -p @mermaid-js/mermaid-cli mmdc -i diagrams/flow-spawn.mmd -o diagrams/flow-spawn.png -t default -b white

# Render all
for f in diagrams/*.mmd; do npx -y -p @mermaid-js/mermaid-cli mmdc -i "$f" -o "${f%.mmd}.png" -t default -b white; done
```

Commit both the `.mmd` source and the `.png` render. Verify no source is unrendered:

```bash
for f in diagrams/*.mmd; do [ -f "${f%.mmd}.png" ] || { echo "unrendered: $f"; exit 1; }; done
```

## Generated vs Hand-Drawn

**Generated diagrams are the standard** when the source is machine-readable. `scripts/gen-topology.ts` is the model — it derives `docs/topology.mmd` from actual `import` statements and is provably fresh (0% staleness over its lifetime).

Hand-drawn diagrams have a measured ~44% staleness rate over 5.5 weeks and produce fictional references at a rate that attention does not fix. They are appropriate only for cross-layer message flows with no single declarative source (spawn, fork, recovery cascade).

**Prerequisite for protocol diagrams:** `scripts/gen-protocol-diagrams.ts` walking `protocol()` DSL specs would make phase/loop/grace errors structurally impossible. The v2 protocol DSL is already machine-readable. Until this generator exists, hand-drawn protocol diagrams should be treated as provisional and verified against code before citing.

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
