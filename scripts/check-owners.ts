// One owner per dangerous primitive: CI fails when one appears outside the files allowed to
// use it (Sep 28, 2026: a raw `tmux kill-server` killed every live session). Lexical, not proof.
//   bun scripts/check-owners.ts
// Adding a file to an allowlist claims it owns that primitive — say why in the PR.
// Rule 2 names git's delete verbs only; rmSync of a worktree or `git update-ref -d` are not covered.

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

type Rule = {
  name: string
  // Matched against the normalized text (see normalize): quotes/brackets/commas/parens are spaces,
  // `//` comments are gone, and consecutive lines are joined, so wrapped calls still match.
  // When `codeOnly` is true, matched line-by-line against comment- and string-stripped code instead
  // (preserving template `${...}` expressions) so English prose in strings never triggers false positives.
  pattern: RegExp
  codeOnly?: boolean
  allowed: string[]
  // Optional per-file match ceilings so adding a new call site fails even inside a sanctioned file.
  max?: Record<string, number>
  skipLine?: (normalizedLine: string) => boolean
  okAt?: (flat: string, index: number) => boolean   // a match that is fine in context
  tests: boolean   // does the rule also apply to test files?
  ts: boolean      // .ts only (true) or every scanned file type (false)
  why: string
}

export const RULES: Rule[] = [
  {
    name: 'tmux kill-server without -S',
    // Fine only if a -S sits between the nearest preceding tmux token (tmux, tmuxBin, …) and
    // kill-server — hydra has no semicolons, so "the same statement" means "this tmux call".
    pattern: /\bkill-server\b/g,
    okAt: (flat, i) => {
      const before = flat.slice(Math.max(0, i - 200), i)
      const calls = [...before.matchAll(/(?:^|\s)tmux\w*(?=\s)/g)]
      const call = calls.length ? before.slice(calls.at(-1)!.index!) : before.slice(-60)
      return /(?:^|\s)-S\s/.test(call)
    },
    allowed: [], tests: true, ts: false,
    why: 'address a server only by exact socket (-S): a missing TMUX_TMPDIR dir silently targets the real server',
  },
  {
    name: 'git branch delete / worktree remove|prune',
    pattern: /\bgit\b[^;]{0,60}?\b(?:branch\b[^;]{0,40}?(?:\s-[dD]|--delete)\b|worktree\s+(?:remove|prune)\b)/g,
    allowed: ['infra/worktree-manager.ts'], tests: false, ts: false,
    why: 'deleting work goes through workAtRisk in worktree-manager',
  },
  {
    name: 'raw tmux liveness (tmuxHasSession, tmuxSessionState)',
    pattern: /\btmux(?:HasSession|SessionState)\b/g,
    skipLine: l => /^import\b/.test(l) || /\bfunction tmux(?:HasSession|SessionState)\b/.test(l),
    // Existing owners. New code asks occupancy() (session-reachability.ts, rules in occupancy.ts): for Codex, tmux is only an anchor.
    // bridge-server, cli-handler and sessions ask tmux itself: a death check, `hydra status`'s tmux line, and
    // restoring records at load, before occupancy can be asked.
    allowed: [
      'daemon.ts', 'infra/tmux.ts', 'app/bridge-dispatch.ts', 'app/commands/thread.ts',
      'engines/claude-engine.ts', 'engines/codex-engine-adapter.ts', 'app/recovery.ts',
      'app/session-lifecycle.ts', 'sessions/occupancy.ts', 'app/bridge-server.ts', 'app/cli-handler.ts',
      'sessions/registry.ts',
    ],
    tests: false, ts: true,
    why: 'liveness is occupancy() (sessions/occupancy.ts; the adapter decides)',
  },
  {
    name: 'tmux has-session outside infra/tmux.ts',
    pattern: /\bhas-session\b/g,
    // The daemon asks whether a session exists only through infra/tmux.ts (tmuxSessionState and its readers),
    // so a slow tmux reads the same everywhere. The CLI files and the recovery script are their own processes.
    allowed: ['infra/tmux.ts', 'cli/helpers.ts', 'scripts/check-codex-recovery.ts'],
    tests: false, ts: true,
    why: 'ask tmuxSessionState / tmuxHasSession (infra/tmux.ts) or occupancy, not has-session',
  },
  {
    name: 'raw tmux kill-session|window|pane exec',
    pattern: /\btmux\b[^;]{0,40}?\b(?:kill-session|kill-window|kill-pane)\b/g,
    allowed: ['infra/tmux.ts', 'cli/helpers.ts', 'cli/peek.ts', 'scripts/check-codex-recovery.ts'],
    tests: false, ts: true,
    why: "kill through tmuxSync or the adapter's stop, not another exec site",
  },
  {
    name: 'raw sync tmux exec',
    pattern: /\b(?:execFileSync|execSync|spawnSync)\s+tmux\b/g,
    // The daemon runs tmux synchronously only through tmuxSync (infra/tmux.ts): killed at its timeout, so a hung
    // server can't hold the loop. Session creation has its own owner, tmuxNewSession (infra/tmux-session.ts), which bounds
    // itself. The CLI files and the recovery script are their own processes; test-setup kills the suite's server.
    allowed: [
      'infra/tmux.ts', 'cli/helpers.ts', 'cli/peek.ts', 'cli/lifecycle.ts', 'cli/hydra.ts',
      'scripts/check-codex-recovery.ts', 'test-setup.ts',
    ],
    tests: false, ts: true,
    why: 'run tmux through tmuxSync in infra/tmux.ts (bounded, SIGKILL), not a raw sync exec',
  },
  {
    name: 'raw gateway.send() outside safeSend',
    pattern: /\bgateway(?:\s*[!?]?\s*\.send|\s+as\s+\w+\s*\.send)\b/g,
    // infra/util.ts owns safeSend. Every other file below is pinned to its exact sanctioned count so no new raw send can enter
    // and removals tighten the cap. Lexical (aliases like `const { send } = gateway` aren't tracked); `gateway.sendDM` is out of scope (user IDs, not threads):
    // - app/bridge-dispatch.ts (3): MCP reply, loud send_to_thread, and quiet-send subtext helper (all wrap raw gateway.send in retrySend and propagate errors/IDs)
    // - app/session-lifecycle.ts (1): thread anchor creation must throw on failure and return anchor.id
    // - connectors/slack/runtime.ts (1): bindNotice catches failure to fall back to toOperatorDm
    // - app/reply-guard.ts (1): defaultDeps.gatewaySend seam for screenshot fallback on throw
    // - app/home-actions.ts (2): Slack Home spawn errors sent to Slack userId (U..., not a thread ID)
    allowed: ['infra/util.ts'],
    max: {
      'app/bridge-dispatch.ts': 3,
      'app/session-lifecycle.ts': 1,
      'connectors/slack/runtime.ts': 1,
      'app/reply-guard.ts': 1,
      'app/home-actions.ts': 2,
    },
    tests: false, ts: true,
    why: 'send through safeSend (infra/util.ts) so messages are chunked, shaped, address-checked and logged',
  },
  {
    name: 'explicit `any` in production code',
    // Standalone `any` type keyword in comment/string/regex-stripped code, excluding property access
    // (single `.any`, while allowing `...any[]`), variable declarations (`const/let/var any`),
    // object/param keys (`any:` unless in a conditional/ternary `? any :`), calls (`any(`),
    // optional chaining (`any?`), and identifier prefixes/suffixes.
    pattern: /(?<=\?\s*)any(?![\w$])|(?<![\w$]|\b(?:const|let|var)\s+)(?:(?<!\.)|(?<=\.\.\.))any(?![\w$]|\s*[:(?])/g,
    codeOnly: true,
    // Self-tightening prod `any` ratchet: new prod files may not introduce `any`, and every legacy file
    // below is pinned to its exact count so removals tighten the cap toward zero.
    allowed: [],
    max: {
      'cli/boot-refusal-alert.ts': 1,
      'cli/helpers.ts': 2,
      'cli/lifecycle.ts': 1,
      'connectors/slack/listener.ts': 1,
      'daemon.ts': 4,
      'infra/config.ts': 1,
      'infra/event-bus.ts': 1,
      'omp/hydra-bridge.ts': 6,
      'scripts/check-codex-recovery.ts': 10,
      'sessions/occupancy.ts': 1,
      'sessions/registry.ts': 1,
    },
    tests: false, ts: true,
    why: 'type the boundary or narrow `unknown` instead of introducing `any`',
  },
]

const isTest = (path: string) => /(^|\/)__tests__\//.test(path) || /\.test\.ts$/.test(path)

const REGEX_PREV_CHAR = new Set('(,=: [!&|?{};+-*%<>~^'.split(''))
const REGEX_PREV_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'throw', 'yield', 'await', 'new', 'delete', 'void', 'else'])

function startsRegex(out: string): boolean {
  let j = out.length - 1
  while (j >= 0 && /\s/.test(out[j])) j--
  if (j < 0) return true
  const ch = out[j]
  if (REGEX_PREV_CHAR.has(ch)) return true
  if (/[A-Za-z0-9_$]/.test(ch)) {
    let k = j
    while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k--
    return REGEX_PREV_KEYWORDS.has(out.slice(k + 1, j + 1))
  }
  return false
}

/**
 * Blank comments (`//`, `/* ... *\/`), string literals (single, double, and template
 * chunks outside `${...}`), and regex literals, preserving newlines and `${...}` code
 * so line numbers stay exact and expressions inside template interpolations are still checked.
 */
export function stripCommentsAndStrings(src: string): string {
  let out = ''
  let i = 0
  const n = src.length
  const tplDepths: number[] = []
  let braceDepth = 0

  const scanTemplateChunk = (): void => {
    while (i < n) {
      if (src[i] === '\\') {
        out += src[i + 1] === '\n' ? ' \n' : '  '
        i += 2
        continue
      }
      if (src[i] === '`') {
        out += ' '
        i++
        return
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        out += '${'
        i += 2
        tplDepths.push(braceDepth)
        braceDepth++
        return
      }
      out += src[i] === '\n' ? '\n' : ' '
      i++
    }
  }

  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && next === '*') {
      out += '  '; i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) { out += '  '; i += 2 }
    } else if (c === '/' && startsRegex(out)) {
      out += ' '; i++
      let inClass = false
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { out += '  '; i += 2; continue }
        if (src[i] === '[') { inClass = true; out += ' '; i++; continue }
        if (src[i] === ']') { inClass = false; out += ' '; i++; continue }
        if (src[i] === '/' && !inClass) { out += ' '; i++; break }
        out += ' '; i++
      }
    } else if (c === "'" || c === '"') {
      const q = c
      out += ' '; i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          out += src[i + 1] === '\n' ? ' \n' : '  '
          i += 2
          continue
        }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) { out += ' '; i++ }
    } else if (c === '`') {
      out += ' '; i++
      scanTemplateChunk()
    } else if (c === '{') {
      braceDepth++; out += c; i++
    } else if (c === '}') {
      braceDepth--
      if (tplDepths.length > 0 && tplDepths[tplDepths.length - 1] === braceDepth) {
        tplDepths.pop()
        out += '}'; i++
        scanTemplateChunk()
      } else {
        out += c; i++
      }
    } else {
      out += c; i++
    }
  }
  return out
}

// One line per source line (so offsets map back), each with tokens separated by single spaces.
export function normalize(text: string): { flat: string; lines: string[]; lineAt: (offset: number) => number } {
  // Strip // and /* ... */ comments in one left-to-right pass (anchored to start-of-line/whitespace so URLs and string globs like 'a/**/*.ts' stay intact), keeping newlines for line numbers.
  const noComments = text.replace(/(^|\s)(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)/gm, (m, pre: string) => pre + m.slice(pre.length).replace(/[^\n]/g, ' '))
  const lines = noComments.split('\n').map(l => l.replace(/['"`,()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim())
  const starts: number[] = []
  let flat = ''
  for (const l of lines) { starts.push(flat.length); flat += l + ' ' }
  return { flat, lines, lineAt: off => { let i = 0; while (i + 1 < starts.length && starts[i + 1] <= off) i++; return i + 1 } }
}

export function violations(files: Array<{ path: string; text: string }>, rules: readonly Rule[] = RULES): string[] {
  const out: string[] = []
  for (const { path, text } of files) {
    if (path === 'scripts/check-owners.ts' || path === 'daemon/__tests__/check-owners.test.ts') continue // its own fixtures
    const { flat, lines, lineAt } = normalize(text)
    const raw = text.split('\n')
    let codeLines: string[] | undefined
    for (const r of rules) {
      if (r.allowed.includes(path) || (!r.tests && isTest(path)) || (r.ts && !path.endsWith('.ts'))) continue
      let hitLines: number[]
      if (r.codeOnly) {
        codeLines ??= stripCommentsAndStrings(text).split('\n')
        hitLines = []
        for (let idx = 0; idx < codeLines.length; idx++) {
          const line = codeLines[idx]
          if (r.skipLine?.(line)) continue
          r.pattern.lastIndex = 0
          for (const _ of line.matchAll(r.pattern)) hitLines.push(idx + 1)
        }
      } else {
        hitLines = [...new Set([...flat.matchAll(r.pattern)].filter(m => !r.okAt?.(flat, m.index!)).map(m => lineAt(m.index!)).filter(n => !r.skipLine?.(lines[n - 1])))]
      }
      const limit = r.max?.[path]
      if (limit !== undefined) {
        if (hitLines.length > limit) {
          out.push(`${path}: ${hitLines.length} occurrences of ${r.name} (max ${limit}, lines ${hitLines.join(', ')}) — ${r.why}`)
        } else if (hitLines.length < limit) {
          out.push(`${path}: ${hitLines.length} occurrences of ${r.name} (cap is ${limit} — lower the cap in scripts/check-owners.ts to ${hitLines.length})`)
        }
        continue
      }
      for (const n of hitLines) out.push(`${path}:${n}: ${r.name} — ${r.why}\n    ${raw[n - 1]?.trim()}`)
    }
  }
  return out
}

if (import.meta.main) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  const cwd = fileURLToPath(new URL('../', import.meta.url))
  const paths = execFileSync('git', ['ls-files', '*.ts', '*.sh', '*.yml', '*.json'], { cwd, env, encoding: 'utf8' }).split('\n').filter(Boolean)
  const found = violations(paths.map(path => ({ path, text: readFileSync(join(cwd, path), 'utf8') })))
  if (found.length) {
    console.error(`check-owners: ${found.length} violation(s)\n${found.join('\n')}`)
    process.exit(1)
  }
}
