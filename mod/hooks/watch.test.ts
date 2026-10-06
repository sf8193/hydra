import { expect, test } from 'claude-code/testing'

const GT_OUT = `🥞 Pushed sf/a (created)
sf/a: https://app.graphite.com/github/pr/sf8193/hydra/431 (created)
sf/b: https://app.graphite.dev/github/pr/sf8193/hydra/432 (updated)
sf/a: https://app.graphite.com/github/pr/sf8193/hydra/431 (created)`
const W = (n: number) => `plugin:discord:discord watch_pr https://github.com/sf8193/hydra/pull/${n}`

async function run($: any, on: any, command: string, text: string, failOn?: number): Promise<string[]> {
  const watched: string[] = []
  on('tool.call', () => ({ result: { stdout: text }, text }))
  on('mcp.call', ($: any, e: any) => {
    if (failOn && e.args?.pr_url.endsWith(`/${failOn}`)) throw new Error('refused')
    watched.push(`${e.server} ${e.tool} ${e.args?.pr_url}`)
    return { value: { content: [] } }
  })
  const r = await $.tool.call({ tool: 'Bash', command })
  expect(r.text).toBe(text) // the model still sees the command's own output
  return watched.sort()
}

test('gt submit: watches each PR it created or updated once, as github.com URLs', async ($, on) => {
  expect(await run($, on, 'cd ~/x && gt submit --stack', GT_OUT)).toEqual([W(431), W(432)])
})

test('gt ss is a submit', async ($, on) => {
  expect(await run($, on, 'gt ss', GT_OUT)).toEqual([W(431), W(432)])
})

test('gt s is a submit', async ($, on) => {
  expect(await run($, on, 'gt s --no-interactive', GT_OUT)).toEqual([W(431), W(432)])
})

test('gh pr create: watches the printed PR', async ($, on) => {
  expect(await run($, on, 'gh pr create --fill', 'https://github.com/sf8193/hydra/pull/433\n')).toEqual([W(433)])
})

test('one refused watch does not skip the others', async ($, on) => {
  expect(await run($, on, 'gt submit', GT_OUT, 431)).toEqual([W(432)])
})

test('gh pr view prints a PR URL and watches nothing', async ($, on) => {
  expect(await run($, on, 'gh pr view 431', 'https://github.com/sf8193/hydra/pull/431')).toEqual([])
})

test('a grep that mentions gt submit watches nothing', async ($, on) => {
  expect(await run($, on, 'grep -rn "gt submit" ~/.claude/projects', GT_OUT)).toEqual([])
})

test('gt log prints graphite URLs and watches nothing', async ($, on) => {
  expect(await run($, on, 'gt log short', GT_OUT)).toEqual([])
})
