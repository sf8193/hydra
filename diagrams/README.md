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

Render `.mmd` to `.png` using Mermaid CLI or the html-diagram-rendering skill:

```bash
# Via mmdc (if installed)
npx -y @mermaid-js/mermaid-cli mmdc -i diagrams/flow-spawn.mmd -o diagrams/flow-spawn.png -t default -b white

# Or via the html-diagram-rendering skill (wraps mermaid in HTML, renders via headless Chromium)
```

Commit both the `.mmd` source and the `.png` render. The source is the authority; the PNG is for quick reference in PRs and docs.

## Catalog

### Command Flows
| Diagram | What it shows |
|---------|--------------|
| `flow-spawn` | Chat spawn: gateway → router → doSpawnSession → tmux + bridge |
| `flow-cli-spawn` | CLI spawn: unix socket → cli-handler → idempotency → doSpawnSession |
| `flow-fork` | Fork: thread command → resolve claudeSessionId → doSpawnSession with forkFrom |
| `flow-list-sessions` | List sessions: registry query → format → gateway send |
| `flow-resurrect` | Respawn: thread command → read thread history → doSpawnSession with resurrectFrom |
| `flow-recovery-cascade` | Resume/respawn tiers: --resume → fork-transcript → respawn + death detection |

### Protocol Flows
| Diagram | What it shows |
|---------|--------------|
| `flow-protocol-robustness` | Protocol lifecycle: mutual exclusion, disconnect grace, state machine transitions |

### Structural
| Diagram | What it shows |
|---------|--------------|
| `command-topology` | Two-channel routing (chat + CLI) converging on shared daemon primitives |
| `health-topology` | Runtime components, state files, and health check connections |

### Missing (candidates for future PRs)
- `flow-factory` — factory_build → fork PM → builder implements → auto-review → awaiting_pm decision loop
- `flow-review` / `flow-build` — adversarial review and build protocol phase flows
- `flow-design` — multi-persona design: spawn personas → independent → synthesis → refinement → audit → brief
- `flow-bridge-lifecycle` — bridge registration, tool delivery, disconnect handling, reconnect
- `flow-daemon-restart` — module validation probe → kill incumbent → spawn replacement → verify
