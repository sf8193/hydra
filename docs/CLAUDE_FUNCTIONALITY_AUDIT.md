# Claude functionality and refactor test matrix

Audit baseline: `sf/codex-command-parity`, `1bbc2ad` (PR #331, stacked on #329). This is an inventory of **Hydra's Claude integration**, including its native CLI boundary, not a claim to enumerate every feature of Anthropic's product. Working-tree prompt edits in `daemon/prompts/review-critic.ts` and `protocols/review.ts` are an uncommitted overlay; freeze/review those separately before establishing golden prompt expectations.

Use this with [the refactor handoff](CODEX_ENGINE_REFACTOR_HANDOFF.md). The companion [test catalogue](CLAUDE_TEST_CATALOGUE.md) records individual test titles and source locations. A suite listed below is evidence for the described subset, **not full coverage of the row**. Tests using fake processes cannot establish live provider parity.

## Conclusions

The best reusable assets are the protocol runner/scenario tests, registry and thread-state tests, factory tests, transport tests, and small policy helpers. Parameterize their lifecycle/delivery dependencies against a semantic runtime contract. Keep Claude pane parsing and native CLI mechanics in Claude adapter tests; retain Codex queue, socket-generation, home-ownership, and retirement regressions separately.

The largest missing asset is an actual lifecycle contract suite: successful Claude launch, failed-launch rollback, native resume/fork, reconnect after daemon restart, and permission/notification delivery through a real bridge. Many current tests validate helpers or mocked orchestration rather than those boundaries. A full three-round live protocol/restart/cancel soak remains a release gate.

Specific findings:

1. `router-commands.test.ts` copies regexes. Its listen/pause and build-wt expectations differ from the live router. Replace these with actual router dispatch tests before using them as parity evidence.
2. `observability.test.ts` contains a resume-count calculation explicitly described as mirroring lifecycle logic. It does not exercise that lifecycle path.
3. `spawn_session` exposes a model but no engine selector, and its dispatcher does not supply an engine. A Codex caller does not automatically imply a Codex child. Decide the intended contract explicitly.
4. `peek_session` still obtains context through Claude pane parsing. Provider context and interactive UI must be independent capabilities.
5. Chat `!` interruption sends Escape and waits 50 ms. This is not an acknowledged retirement boundary.
6. Fresh Claude spawn includes native tool restrictions; resume/fork argument branches omit those flags. Verify whether persisted Claude state preserves the intended restrictions before promising equivalent role isolation.
7. Claude protocol keepalives are real channel notifications. There is no measured evidence here that they are free or consume no model turns. Preserve existing behavior during extraction; measure any future redesign.
8. `get_session_info` is a bridge-local tool in addition to the 25 daemon-defined tools. Inventorying only `shared/tool-definitions.ts` misses it.
9. Factory worktree tests use real temporary files but fake git. CLI peek tests mock child_process globally; suite-wide mock interactions limit conclusions about subprocess behavior.
10. `hydra attach` is currently Codex-only. Native Claude tmux attachment is a different surface; authentication switching was removed from the proposed Hydra command feature and is not a parity requirement to silently restore.

## Reading the matrix

Owners: **R** shared SessionRuntime; **C** ClaudeAdapter; **T** transport/bridge; **O** orchestration or product logic outside adapters; **X** CodexAdapter.

Test actions: **Share** parameterize meaningful semantics across providers; **Keep** retain existing shared behavior tests; **Claude** keep provider-specific mechanics; **Rewrite** replace weak/copied checks; **Add** no direct behavioral evidence identified for the full path. `unit` means real helper under test; `mock` means orchestration with fake external dependencies; `structural` means text/schema checks. Additions after a semicolon are missing assertions, not existing coverage.

Suite names below resolve to exact files and test declarations in the companion catalogue. Implementation paths are relative to the repository root. Where several features share a handler, rows separate observable behavior rather than pretending every branch has an independent test.

## Session creation, identity, and lifecycle

| ID | Feature / trigger | Current Claude mechanism and implementation | Existing evidence → refactor action | Owner |
|---|---|---|---|---|
| L01 | Chat spawn, model spawn | `daemon/router.ts`, `session-lifecycle.ts`: parse topic/model, allocate native UUID and tmux process, create/register thread | router-commands copied; session-provider unit → Rewrite dispatch; Add real successful spawn | R/C |
| L02 | Spawn modifiers and templates | `modifiers.ts`, `templates.ts`, router: parse modifiers, merge configured template values and prompt | modifiers, templates unit → Keep; Add precedence through actual spawn | O/R |
| L03 | Model defaults and aliases | `shared/constants.ts`, lifecycle: late-bound environment defaults and alias resolution | constants, factory-model-resolution unit → Keep; Share resolved-model contract | O/R |
| L04 | Worktree spawn | `worktree-manager.ts`, lifecycle: validate repository, lock repo mutation, create worktree/branch, change cwd | factory-worktree fake git, factory-channel unit → Add real temporary git repo integration | R |
| L05 | Worktree reuse / reattach | worktree-manager, recovery: reattach saved branch/path before recovering | recovery-dedup does not exercise git → Add detached/missing path and conflicting registration cases | R |
| L06 | Native launch environment | lifecycle `buildSpawnEnv`, `shared/tmux-env.ts`: explicit Hydra identity, Claude config, socket and tmux environment | plugin-manifest structural; session-provider partial → Claude argument/env capture tests | C |
| L07 | Fresh native session and restrictions | lifecycle: `--session-id`, `--model`, `--channels`, bypass permission mode; fresh-only tools/disallowedTools | no full command-construction coverage identified → Claude; assert restrictions for every launch mode | C |
| L08 | Fork native history | `fork-strategy.ts`, lifecycle: same-engine native ID permits `--resume --fork-session`; separate Hydra identity | fork-strategy unit, factory-channel cwd unit → Share lineage contract; Claude native-history test | R/C |
| L09 | Fork without native history / cross engine | fork-strategy, `commands/thread.ts`: fallback prompt/thread context; model can select another engine | fork-strategy, recovery-selection unit → Share; assert no fabricated native history | R |
| L10 | Fork cwd and worktree prompt | lifecycle: resume from parent's cwd, add target worktree instructions | factory-channel unit → Keep; Claude subprocess cwd assertion | C/R |
| L11 | Ephemeral fork | thread command, `bridge-server.ts`: guest registration, TTL and delayed kill on line `[done]` | auto-resume covers guest map policy only → Add timer/reply-hook/parent survival contract | R/O |
| L12 | Fork list and lineage | commands/thread, sessions: parent and sibling identities presented | orchestration-tools mock list lineage → Keep; Share parent survives child death | R/O |
| L13 | Explicit resume | thread command, lifecycle: native `--resume`, preserve metadata and verify startup health | resume-health unit, session-provider mock → Share result contract; Claude real continuation | R/C |
| L14 | Resume health grace / orphan | `resume-health.ts`: distinguish tmux+exit-marker combinations; grace rather than blind replay | resume-health unit → Claude; Add real exit-marker lifecycle timing | C/R |
| L15 | Explicit respawn | recovery-selection, thread command: fresh native session, read thread, preserve/override model and template | recovery-selection unit → Share; assert model, history prompt, artifacts and overrides end to end | R |
| L16 | Live resume/respawn guards | thread command and provider: existing engine ownership prevents duplicate launch; UI loss is distinct | session-provider, session-health-provider mock; Codex live harness → Share | R/C/X |
| L17 | Automatic recovery ladder | `recovery.ts`: native resume → fork → fresh thread-context spawn | auto-resume policy and recovery-dedup unit → Add actual ladder with injected adapter failures | R |
| L18 | Recovery selection / dedup | recovery: skip guest/builder/suppressed/live identities; PR/ticket key, latest winner | recovery-dedup, recovery-selection unit → Keep; Share selection across engine history | R |
| L19 | Recovery metadata carry-over | recovery, sessions: descriptions, artifacts, contexts, watch cursors, thread ownership | recovery-dedup watch transfer; sessions maps → Share complete successor snapshot | R |
| L20 | Kill session | lifecycle: deduplicate concurrent kill, disconnect provider, terminate tmux, record history and cleanup maps/events | kill-destroy mock; sessions unit → Share idempotent retirement and late callbacks | R/C |
| L21 | Kill with cascade | commands/thread and factory: dependent builds/participants cleaned up | kill-destroy, factory-resilience mock → Share parent/child cleanup; ensure sibling isolation | R/O |
| L22 | Destroy thread / anchor deletion | router and commands/thread: authorize initiator, kill, optionally delete chat; plain kill preserves it | kill-destroy mock → Keep; Share runtime cleanup | O/R |
| L23 | Worktree destruction / unpushed commits | worktree-manager, lifecycle: inspect unpushed work before branch/worktree cleanup | no real git cleanup suite identified → Add real local repo cases, never remote | R |
| L24 | Registry boot and persistence | `sessions.ts`: persisted session/thread identities, backward defaults, reconstruct ownership, skip guests as owners | sessions unit/temp files → Share; restart contract with provider references | R |
| L25 | Spawn transaction rollback | lifecycle currently interleaves reservation, thread, process and registry operations | no full failure-boundary matrix → Add fault at every await; zero leaked identity/process/thread ownership | R/C |
| L26 | Durable retirement | `retirement-journal.ts`, lifecycle: pending cleanup persisted and replayed with generations | retirement-journal temp-file tests; Codex regressions → Share journal semantics, retain X mechanics | R/X |
| L27 | Phase budget | `phase-budget.ts`: deadline checkpoint, grace then reap, restore timers | no dedicated suite identified → Add fake-clock restart/checkpoint/reap tests | O/R |
| L28 | Headless / joined thread / channel choice | lifecycle, `resolveSpawnChannel` helpers: ownership and destination differ from fresh standalone thread | resolve-spawn-channel unit; sessions membership → Share launch variants and rollback | R/O |

## Chat routing and interactive controls

All rows originate in `daemon/router.ts`; command modules implement the indicated action. Copied regex tests alone are weak evidence for every routing row.

| ID | Feature / trigger | Mechanism | Evidence → action | Owner |
|---|---|---|---|---|
| U01 | Normal thread message | owner/listen/mention/name/reply rules choose target then transport notification | listen-state unit, router copied → Add actual gateway-event dispatch | O/T |
| U02 | DM and group access | `access.ts`: pairing/allowlist/disabled, group allowFrom and mention rules; privileged commands use global allowFrom | no dedicated access suite → Add authorization boundary tests | O |
| U03 | Pairing and approval files | access: expiring codes, file persistence, approved watcher; static mode disables mutation | no direct behavioral suite → Add expiry, corrupt file, static and approval-consumption tests | O |
| U04 | Auto thread replies | router: group threadReply creates/routes threads with archive policy | resolve-spawn-channel only helper evidence → Add platform event integration | O |
| U05 | `listen` / `unlisten` | session and thread override persisted; inheritance from channel/parent/anchor/global | listen-state unit → Keep; Rewrite live command routing test | O/R |
| U06 | `pause` / `unpause` | visual/session state; active protocol refuses pause; keys suppressed while paused | stale router copy → Add actual pause semantics, persistence, protocol guard | O |
| U07 | `keys` / terminal input | collapse input, named-key vs literal dispatch, ensure UI, auto peek; Codex may queue while working | router copied; codex-key-queue unit → Claude native input tests; Share capability/error result | C/R |
| U08 | `! message` interrupt | send tmux Escape, delay 50 ms, deliver remaining text | copied prefix test → Add real dispatch; distinguish interrupt request from proven retirement | C/R |
| U09 | `peek` / `screenshot` | status command captures provider interactive pane and renders screenshot | session-provider partial → Share surface repair/absence; Claude screenshot mechanics | C/R/O |
| U10 | `usage` | status command obtains provider context/usage | session-health-provider and state-line subsets → Share known/unknown context contract | C/X/O |
| U11 | `list` | global command lists sessions and status | list-display unit → Keep; Share health inputs | O |
| U12 | `health` / `status` | global command reports daemon/session health | cli-handler mock health; gateway-health unit → Keep, Add chat dispatch | O/R |
| U13 | `templates` | global command lists template definitions | templates unit only → Add output/dispatch smoke | O |
| U14 | `protocols` and `history` | global command formats protocol state and saved history | protocol tests do not prove command output → Add chat command smoke | O |
| U15 | `commands` / help aliases | global help documents available commands | router copied → Add route/help consistency check | O |
| U16 | `reconnect` | global command reconnects gateway | gateway-health helper tests → Add command success/failure response | O |
| U17 | `recover [name]` | global command invokes recovery selection and cascade | recovery-selection/dedup helper tests → Share runtime call and reported result | O/R |
| U18 | `restart` | global command initiates daemon restart with acknowledgment | no full restart test → Add disposable daemon restart and queued delivery | O/T/R |
| U19 | Knife reaction / deleted replies | router: authorized deletion; clear stale lastReplyId on deletion | reaction-reconcile unit is not full handler test → Add event dispatch/authorization | O |
| U20 | Attachments and audio inbound | notification builder downloads files; transcription extracts voice text | transcription, sanitize-filename unit → Keep; Add gateway→notification attachment integration | O/T |
| U21 | Slack links / contextual metadata | notification builder includes cached conversation context and message identity | no complete inbound assembly test identified → Add platform fixtures | O/T |
| U22 | Plan approve/reject | pane-probe intercepts chat approval, rechecks screen, sends native keys | pane-probe fake IO behavior → Claude; Share user-visible intercept contract | C/O |
| U23 | Permission allow/deny/text/buttons | permission and bridge-server maps pending request to originating session; global allowlist gates buttons; cleanup on death | router regex only → Add actual request→decision→same bridge test and stale request case | T/O |
| U24 | Login / resume-menu stall detection | pane-probe: idle-confirmed tail parsing, cooldown/caps, opt-in auto-login, OAuth URL forwarding, dismiss success/menu | pane-probe fake IO → Claude; do not transplant terminal regex to X | C |

## MCP tool surface (25 daemon tools plus one bridge-local tool)

Definitions: `shared/tool-definitions.ts`. Dispatch: `daemon/bridge-dispatch.ts`. `tool-filtering` proves role/schema composition, not each tool's execution.

| ID | Tool | Behavior | Execution evidence → action | Owner |
|---|---|---|---|---|
| M01 | `reply` | access checks, chunking, files, retry/partial failure reporting, reply IDs, artifacts, post-reply hooks | util/artifacts units; no complete relay→gateway suite → Add | O/T |
| M02 | `react` | gateway reaction; Slack no-op; settles reply guard only when actually posted | reply-guard unit → Add platform-specific dispatch settlement | O |
| M03 | `edit_message` | gateway edit with retry | no direct handler evidence → Add validation and retry | O |
| M04 | `delete_message` | gateway delete | no direct handler evidence → Add access/error response | O |
| M05 | `download_attachment` | resolve attachment, download into inbox with safe name | sanitize-filename unit → Add download/error/size integration | O |
| M06 | `create_thread` | name length and archive policy, gateway create | no full dispatch evidence → Add gateway fixture | O |
| M07 | `fetch_messages` | bounded history, normalized author/time/attachment formatting | no direct complete evidence → Add bounds and platform fixtures | O |
| M08 | `spawn_session` | lifecycle call with model/worktree/budget/headless/read_thread; engine absent from schema | tool-filtering structural → Share; decide child-engine selection explicitly | R/O |
| M09 | `list_sessions` | alive filter, lineage and context presentation | orchestration-tools mock → Keep; provider-neutral health/context | O/R |
| M10 | `send_to_thread` | resolve successor by name, validate progress/question/result, post chat and deliver to engine | orchestration-tools mock, resolve-send-target unit → Share delivery contract | O/T/R |
| M11 | `peek_session` | child-only unless main; bounded tmux capture; Claude pane context | orchestration-tools mock → Share permission semantics; replace context dependency with adapter | O/C/R |
| M12 | `kill_session` | main orchestration role, lifecycle kill | role filtering + kill-destroy mock → Share handler→retirement outcomes | O/R |
| M13 | `factory_build` | validate ticket/spec/worktree/models, spawn builder asynchronously | factory suites mock → Keep; Share lifecycle seam | O/R |
| M14 | `factory_retry` | PM-thread authorization and retry state validation | factory-resilience/qol mock → Keep | O |
| M15 | `factory_accept` | require review unless explicit unreviewed override | factory-qol mock → Keep | O |
| M16 | `factory_abandon` | authorize, terminate build and cleanup | factory-resilience mock → Keep; Share retirement | O/R |
| M17 | `factory_status` | thread-scoped build summaries | factory suites partial → Keep; Add tool envelope assertions | O |
| M18 | `factory_review` | external review with completion routing; cannot bypass acceptance gate | factory-qol mock → Keep | O |
| M19 | `set_description` | update session metadata, rename/render thread, persist | format-thread-name unit → Add ownership and gateway failure behavior | O/R |
| M20 | `watch_pr` | register PR poll watch | pr-watch unit/mock → Keep | O |
| M21 | `unwatch_pr` | remove watch | pr-watch unit/mock → Keep | O |
| M22 | `list_watches` | format active watches | pr-watch subset → Add dispatcher output | O |
| M23 | `advance` | validate phase/caller/verdict/content, atomic post+transition | protocol-registry/scenarios mock → Share protocol dependencies | O/R |
| M24 | `extend_phase` | caller/phase validation, clamp minutes; actual runner resets phase window | protocol-runner/scenarios mock → Keep; document actual timing contract | O |
| M25 | `factory_done` | builder-only completion, kick review/diff/PR flow | factory suites mock → Keep; Share lifecycle seam | O/R |
| M26 | `get_session_info` | bridge-local identity/metadata fallback, never daemon-dispatched | no direct bridge test identified → Add MCP stdio contract | T |

## Bridge, transport, delivery, and permissions

| ID | Feature | Mechanism / source | Evidence → action | Owner |
|---|---|---|---|---|
| T01 | Bridge identity and socket discovery | `bridge.ts`: explicit session ID, main role, inert stray ID; daemon socket platform/file/env precedence | main-guard/plugin-manifest subsets → Claude bridge boot fixture | C/T |
| T02 | Native vs Hydra identity | bridge registration reports Claude native ID separately from Hydra session ID | sessions/session-provider units → Share identity invariant; Claude handshake | R/C/T |
| T03 | Channel notifications | bridge queues until registered then `notifications/claude/channel` | bridge-transport fake socket, no actual MCP recipient → Claude stdio test | C/T |
| T04 | Reconnect and pending failures | bridge retries in 5 s; socket close rejects pending tool calls; strays do not reconnect | transport unit only → Add real local socket closure/replacement | C/T |
| T05 | Dynamic tool sets | bridge-tools/tool-surface compose role base+capabilities+phase schemas; daemon rejects unavailable tools | tool-filtering unit, protocol schemas mock → Keep; Add dispatch enforcement | O/T |
| T06 | Tool refresh and fallback | bridge emits list_changed, pull refresh after notification; 2 s refresh/cache, initial wait then local-only surface | no direct MCP bridge test → Add lost-push/pull/cache timing | T |
| T07 | Tool request timeout | bridge correlates UUID request/result, 60 s timeout, disconnected error | no direct relay test → Add late/duplicate result and disconnect | T |
| T08 | Main bridge ownership / flapping | bridge-server, main-guard/main-bridge-cycle reject invalid replacement and track lifetime/gap | main-guard/main-bridge-cycle unit → Keep; Add actual competing socket registrations | T/R |
| T09 | Queue persistence / flush | bridge-transport bounded queue (50), JSON persistence, reconnect flush and failure retention | bridge-transport fake sockets/temp state → Share observable delivery, retain provider-specific queues | T |
| T10 | Socket backpressure | bridge-transport treats write(false) as accepted buffered write, exceptions enqueue | bridge-transport unit → Keep; no exactly-once processing claim | T |
| T11 | Tool-call activity and reply completion | bridge-server reconciles working/waiting, clears reply guard before async hooks | reply-guard unit → Add actual post-reply hook failures | O/T |
| T12 | Permission notifications | bridge forwards native permission notification, buttons/text route decision to origin | no native permission loop test → Claude integration, shared authorization tests | C/T/O |
| T13 | Session death / bridge grace | bridge-server probes disconnect; auto-resume/recovery distinguish grace/reconnected/exhausted | auto-resume, resume-health helper units → Share fake adapter sequence; Claude process test | R/C/T |
| T14 | Codex control bridge isolation | separate control map and role; tools updates routed to sidecars without replacing session | bridge-transport/session-provider/Codex tests → Keep X-specific; shared registration role contract | T/X |

## Protocols and factory orchestration

Source: `daemon/protocol-{dsl,registry,runner}.ts`, `protocols/{review,build,spike}.ts`, `daemon/commands/*`, `daemon/factory.ts`.

| ID | Feature | Current behavior | Evidence → action | Owner |
|---|---|---|---|---|
| P01 | Review start / aliases / rounds / model | parse review/review_v2 modifiers, choose critic model, start registered run | review-command mock, router copied → Keep handler; Rewrite event routing | O/R |
| P02 | Review cooperative rounds | owner/critic turn order, phase schema, round counter and closing summary | protocol-scenarios mock → Share adapter seam; live three-round gate | O/R |
| P03 | Review lenses | loader selects/configures review lens prompts | protocol-dsl/modifiers subsets → Add loader failure/selection tests | O |
| P04 | Review subagent / fallback controls | explicit mode, no-fallback override, degraded provenance, fallback after participant loss | protocol-scenarios mock → Share death/delivery seam | O/R |
| P05 | Build / build_v2 | review→approve/changes loops, correct verdict actor, closing | protocol-dsl/scenarios mock → Share | O/R |
| P06 | Spike / spike_v2 | repeated checkpoints and completion, phase-specific input schema | protocol-runner/scenarios mock → Share | O/R |
| P07 | Cancel review/build/spike | registry lookup, cancellation notification, retire participants, completion event once | protocol-runner/scenarios/registry mock → Share terminal outcome contract | O/R |
| P08 | Mutual exclusion per thread | registry enforces one protocol; routing chooses active run | protocol-registry/robustness mock → Keep | O |
| P09 | Advance validation and atomic posting | correct caller/phase/verdict, duplicate/reentrant protection; reply alone cannot advance | protocol-registry/scenarios mock → Keep | O |
| P10 | Missing advance nudge | detect qualifying reply lacking transition and nudge | advance-nudge unit → Keep | O |
| P11 | Deadlines / activity defer / warnings | fake-clock-tested phases, strike/decision context and behavior chains | protocol-runner/scenarios mock → Keep; Share activity source | O/R |
| P12 | Extend phase / backstop | phase window reset, extension chains and max bounds; disconnect timers preserved | protocol-runner/scenarios mock → Keep | O |
| P13 | Disconnect grace / resume races | pause/fallback/reconnect transitions, cancel during resume, stale events | protocol-scenarios mock → Share; add actual daemon restart | O/R |
| P14 | Participant start and retirement | spawn participants, publish role capabilities, kill on terminal state | protocol-runner mock → Share spawn rollback and acknowledged retirement | O/R |
| P15 | Prompts and role mechanics | seed rendering, orient constraints, critique/summary prompts | prompt-mechanics/review-summary unit → Keep; freeze dirty prompt overlay separately | O |
| P16 | Completion notifications / provenance | round completion count, outcome/via note, subscriber cleanup | protocol-notifications/scenarios, event-bus, factory-improvements → Keep | O |
| P17 | Claude keepalive | runner periodically delivers notification; X filtered at scheduler and transport | protocol-runner/bridge-transport unit → Claude preservation; measure live cost separately | C/O/T |
| F01 | Factory build validation | spec/ticket/worktree/cwd, difficulty model ladder and overrides | factory-worktree fake git; factory-model-resolution unit → Keep; Add real repo fixture | O |
| F02 | Builder spawn / channel / capabilities | builder identity, worktree and PM relationship, factory tool surface | factory-channel unit; factory suites mock → Share lifecycle transaction | O/R |
| F03 | Builder done → diff/PR/review | factory_done initiates asynchronous capture, PR and protocol flow | factory suites mocked dependencies → Add temp git and fake remote API boundary integration | O/R |
| F04 | Retry and review gate | state-specific retry, acceptance requires own review provenance unless override | factory-qol/resilience mock → Keep | O |
| F05 | PM ownership / adoption / cascade | authorize by PM thread, adopt successor, cascade on explicit kill | factory-resilience/improvements mock → Share successor identity | O/R |
| F06 | Builder death / gentle PM death | distinguish crash/cancel/PM disappearance; waiting state | factory-resilience mock → Share engine death input | O/R |
| F07 | Awaiting PM TTL | expiry timer and cleanup | factory-resilience mock → Keep; Add restart timing where needed | O |
| F08 | Progress boards | one per PM thread, serialized edits, retries, rounds, terminal retirement | factory-qol/improvements mock → Keep | O |
| F09 | Orphan sweep | startup identifies stranded builders and converges cleanup | factory-resilience subset → Add disposable startup recovery integration | O/R |
| F10 | Admin CLI factory actions | list/accept/abandon by ticket separate from PM-scoped tools | factory-improvements, cli-handler mock → Keep; Add CLI subprocess envelope | O |

## CLI, service operations, background behavior, presentation

| ID | Feature | Mechanism / source | Evidence → action | Owner |
|---|---|---|---|---|
| B01 | CLI spawn | `cli/hydra.ts`, cli-handler: parse options, socket request, prompt/initiator/idempotency validation | cli-handler mock validates failures → Add successful CLI→runtime path | O/R |
| B02 | CLI list / status / health | socket request, formatting and exit status | cli-handler mock → Keep; subprocess output tests | O |
| B03 | CLI kill | socket handler lifecycle call | cli-handler missing-name tests → Share success/failure retirement result | O/R |
| B04 | CLI check-key / clear-key | idempotency lookup/reset | idempotency unit, cli-handler mock → Keep | O |
| B05 | CLI factory | list/accept/abandon management | factory-improvements mock → Keep | O |
| B06 | CLI peek | `cli/peek.ts`: filtered sessions and tmux viewer windows | cli/peek child_process mocks → Claude terminal checks; Share target selection | O/C |
| B07 | CLI attach | explicit Codex remote resume; no named Claude attach implementation | no full subprocess test identified → X; do not mislabel as Claude capability | X |
| B08 | CLI install / uninstall | `cli/lifecycle.ts`: manage platform service configuration | no dedicated suite identified → Add temporary service-manager IO fixture | O |
| B09 | CLI up / down / restart | lifecycle service control; restart validates module unless --fast | no end-to-end service test → Add disposable daemon test, never stop production | O |
| B10 | CLI watchdog / preflight | lifecycle startup health/preflight checks | no dedicated suite identified → Add missing binary/config/service cases | O |
| B11 | Daemon singleton / socket ownership | `daemon.ts`: PID/socket checks, authoritative process startup; boot-probe separately validates module load and scratch health socket | main-guard is bridge-only → Add competing daemon boot fixture | O |
| B12 | Startup plugin synchronization | daemon/plugin-manifest: synchronize bridge/server/config/manifest into plugin cache | plugin-manifest structural → Keep; add temp-cache integration | C/O |
| B13 | Gateway retry / reconnect health | daemon and gateway-health: reconnect retries, outage heartbeat, summaries | gateway-health unit → Keep; fake gateway boot failure/recovery | O |
| B14 | Startup recovery ordering | registry boot, retirement replay, X reconnect, factory sweep before optional auto-recover | helper suites do not cover whole order → Add orchestration-order test | R/O |
| B15 | Shutdown persistence | cancel runs bounded by 1.5 s, persist registry/queues, close sockets/gateway, force exit 2 s | no full shutdown subprocess test → Add journal/queue restart fixture | R/T/O |
| B16 | Reply guard | track pending user expectation, activity/backstop, same-chat reply/react settlement, escalation | reply-guard fake IO unit → Keep; Share activity signals | O/R |
| B17 | Native pane monitoring | `pane-probe.ts`: idle detection, plan/login/menu handling, capped nudges and heartbeat | pane-probe fake IO → Claude | C |
| B18 | Idle/bridgeless builder supervision | pane-probe: 90 s idle nudges, 120 s bridgeless abort, caps | pane-probe fake IO → Share semantic stuck-worker signal; retain Claude observation | C/O/R |
| B19 | PR watch lifecycle | `pr-watch.ts`: poll CI/reviews, cursors, notifications, watch migration/kill cleanup | pr-watch, pr-watch-ci, recovery-dedup → Keep | O |
| B20 | Artifacts / titles / backfill | artifacts: extract own reply PR/ticket data, persistence and startup backfill/title hydration | artifacts unit → Keep; Add startup and gateway integration | O/R |
| B21 | Thread name / state / reactions | anchor-state, dashboard, util: status emoji/name/context presentation and reconciliation | format-thread-name, state-line, reaction-reconcile, list-display unit → Keep; Share health data | O |
| B22 | Slack Home / dashboard | daemon callbacks spawn/list/action handling and cached contextual data | no dedicated Home event suite → Add fake Slack event tests | O |
| B23 | Logs / crash autopsy / vitals | observability and transcript-dump: trim logs, crash notices, transcript export | observability/transcript-dump unit → Keep actual behavior; Rewrite copied resumeCount | O/C |
| B24 | Markdown/chunking/platform limits | gateway/util and table formatting: safeSend chunking, attachments and errors | util, discord-table-format units; raw-send-ratchet structural → Keep; add real dispatcher limits | O |
| B25 | Event bus / throttling | event-bus and util queue: listeners, once cleanup, ordering/error handling | event-bus, throttled-queue unit → Keep outside adapter | O |
| B26 | Configuration and persistence helpers | config, shared/env-parse, atomic file writes and filename sanitation | env-parse, util, sanitize-filename → Keep | O |
| B27 | Legacy state-machine helpers | state-machine module and tests; not evidence for every current DSL transition | state-machine unit → preserve only callers still live; prefer current DSL suites for parity | O |
| B28 | Import topology ratchet | topology generator and freshness check | topology-freshness structural → regenerate after import changes, not behavior coverage | O |
| B29 | Main Claude bot startup | `cli/lifecycle.ts` startByte: explicit main role/config/socket/cwd, greet-or-silent prompt, plugin cache bridge link, caffeinate + native Claude launch | no dedicated launch suite → Claude argv/env fixture and disposable main handshake | C/O |
| B30 | Main authentication provisioning | lifecycle: token env/file, Slack fallback token, opt-in keychain copy into config; copied credential removed on down | no dedicated test → Claude temporary files + mocked keychain; never use real credentials in tests | C/O |
| B31 | Watchdog revival and network gating | lifecycle: missing process or heartbeat older than 300 s; network check before stale restart; defer main revival until later tick; compile before restart | no dedicated watchdog suite → Add fake clock/process/network cases | O/R |
| B32 | Transcription sidecar lifecycle | lifecycle and start-transcribe.sh: opt-in/idempotent autostart, failure does not block daemon; shared sidecar survives other platform shutdown | transcription tests cover content, not service lifecycle → Add fake subprocess tests | O |
| B33 | Orphan main cleanup | cli/helpers: find processes tied to socket, TERM then KILL on shutdown; up refuses detected orphans | main-guard tests do not exercise OS discovery → Add scoped process fixtures | C/O |
| B34 | Preflight onboarding/auth/channel readiness | lifecycle: binaries, plugin/config, token presence, managed channel setting, onboarding flags and native auth availability | no dedicated suite → Add synthetic config/files with secret-free diagnostics | C/O |
| B35 | Socket selection / multi-daemon CLI | cli/helpers: discover platform sockets, explicit selection, request timeout and JSON/plain formatting | cli-handler tests are server-side → Add actual client socket fixtures | O/T |
| B36 | `/discord:configure` skill | `skills/configure/SKILL.md`: status, token save/clear, access guidance; native skill executes file operations | documentation workflow, no executable test suite → Preserve documented intent; test config reader independently | O/C |
| B37 | `/discord:access` skill | `skills/access/SKILL.md`: status, pair, allow/remove, policy, group add/rm, delivery settings; terminal-origin restriction | documentation workflow, no executable suite → Retain boundary; add access policy tests U02/U03 | O/C |
| B38 | Deprecated shell launch/control entrypoints | start-byte/start-daemon/stop-byte/restart-daemon/watchdog/preflight and platform wrappers remain in repo; some duplicate CLI mechanics | no shell integration suite identified → Explicitly deprecate or test compatibility; do not silently delete during adapter extraction | O/C |

## Native Claude boundary

Hydra launches interactive Claude and can send arbitrary terminal input. Native slash commands, installed plugins/skills/MCP servers, project instructions, coding tools, permission modes, model behavior, and account authentication belong to Claude. A raw `keys` passthrough makes them reachable but does not make Hydra their implementation or give Codex equivalent semantics. Refactor tests should establish transparent input/environment/identity preservation; vendor behavior needs a separate provider smoke test where relevant.

Installed Claude Code **2.1.80** (`claude --version`, inspected 2026-09-09) and local `claude --help` define this native-boundary snapshot. Its advertised option inventory includes: add-dir; agent/agents; allow-dangerously-skip-permissions; allowedTools/allowed-tools; append-system-prompt; betas; brief; chrome/no-chrome; continue; dangerously-skip-permissions; debug/debug-file; disable-slash-commands; disallowedTools/disallowed-tools; effort; fallback-model; file; fork-session; from-pr; help; ide; include-partial-messages; input-format; json-schema; max-budget-usd; mcp-config; mcp-debug; model; name; no-session-persistence; output-format; permission-mode; plugin-dir; print; replay-user-messages; resume; session-id; setting-sources; settings; strict-mcp-config; system-prompt; tmux; tools; verbose; version; worktree. Advertised subcommands: agents, auth, doctor, install, mcp, plugin/plugins, setup-token, update/upgrade. Print/stream-only flags are not Hydra interactive-session features. Hydra also uses `--channels`, which was absent from this help output.

Do not reimplement or assert cross-provider parity for these flags. For Hydra-owned native uses, test exact argv/env/cwd, saved native history, channel/MCP handshake, tool restrictions, terminal input, context observation and termination. Account switching remains native/operational work, separate from this refactor.

## Port plan and acceptance gates

1. **Freeze the baseline.** Preserve #331 regressions; decide the prompt overlay separately. Record isolated full-suite results and all three entry-point builds. A green count is a regression baseline, not measured feature coverage.
2. **Replace copied parser tests.** Drive actual router events through a fake gateway; assert one intended runtime operation, model/engine/flags, authorization, and no operation on invalid input. Generate cases from the surface catalogue rather than another copied regex table.
3. **Create shared runtime contracts.** Run against Claude and Codex adapter fixtures: spawn commit/rollback, native identity, explicit capability failure, resume vs fresh respawn, fork lineage, carried metadata, UI loss vs engine death, idempotent retirement, and successor/sibling isolation. Inject failures at asynchronous boundaries.
4. **Port orchestration tests without flattening providers.** Keep real protocol definitions, factory state transitions and registry logic. Replace process hooks with runtime fixtures. Preserve fake-clock scenarios, exact event counts, post-before-transition order and verdict provenance. Do not duplicate these suites per adapter unless the adapter seam is actually exercised.
5. **Add provider boundary integration.** Claude: real local socket + MCP stdio, native launch/resume/fork and permission loops. Codex: retain queue unknown-outcome, generations, fencing, control bridge, home reservation, durable cleanup and sibling-server tests. Use disposable HOME/state/tmux names. Fake socket tests remain valuable but are labelled as such.
6. **Prove restart and protocol behavior live.** Disposable three-round review; cancel while critic is active; restart at owner/critic handoff; recover queue and pending retirement; ensure exactly the intended participant stops; verify a reply reaches chat. For Codex verify waiting generates no synthetic model turns. Claude keepalive cost is a separate measurement, not an assumed property.

Priority backlog: P0 lifecycle rollback/ownership, actual router dispatch, delivery unknown-outcome and retirement/restart; P1 native Claude bridge/resume/fork/restrictions, permissions/access, real-git worktree cleanup; P2 CLI/service-manager and platform presentation smoke coverage. No runtime bug fixes are included in this documentation audit.

## Limits and maintenance

Fresh verification for this audit: **1,223 pass, 0 fail, 3,069 assertions across 69 files**, with both state-directory environment variables set to a new temporary directory. Daemon, CLI and bridge bundle checks passed. No production restart or new live model/protocol experiment was performed for this audit. Earlier #331's opt-in recovery harness is additional limited evidence: its gateway is stubbed and it is not the full Discord protocol soak.

This matrix inventories integration behaviors and explicit surfaces, not a line/branch coverage report. The catalogue inventories every discovered `.test.ts` declaration; dynamic titles are listed as source expressions. It also records the current router match declarations, CLI switch cases and tool names so newly added surfaces are visible. Source inventory completeness does not prove execution coverage. When the refactor changes ownership, update source references and attach the actual new contract test names to these stable feature IDs.
