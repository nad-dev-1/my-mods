import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'jira-team-dashboard',
  component: 'Pane',
  requestId: 'jira-team',
  props: { title: 'Team', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
} as const

const NOW = Date.parse('2026-11-10T17:00:00Z')
const CFG = {
  cloudId: 'cloud',
  site: 'https://example.atlassian.net',
  members: [
    { name: 'Ada Lane', email: 'ada@example.com', accountId: '', teams: ['iOS'] },
    { name: 'Cy Moss', email: 'cy@example.com', accountId: 'c1', teams: ['Android'] },
  ],
  teams: ['iOS', 'Android', 'Flutter'],
  projects: [],
  hoursPerDay: 8,
  workDays: [1, 2, 3, 4, 5],
  endOfDay: '18:00',
  leave: {},
  stuckDays: 5,
  flutterTeam: 'Flutter',
  flutterMatch: ['flutter'],
}

const user = (accountId: string, email: string, name: string) => ({ accountId, emailAddress: email, displayName: name })
const issue = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  fields: {
    summary: `${key} summary`,
    status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Task' },
    project: { key: 'APP' },
    assignee: user('a1', 'ada@example.com', 'Ada Lane'),
    ...extra,
  },
})

type World = { files: Record<string, string>; tools: string[]; ops: string[]; clock: ReturnType<typeof mock.clock> }

function world(on: any): World {
  const w: World = { files: { '/Users/me/.claude/jira-team-dashboard/team.json': JSON.stringify(CFG) }, tools: [], ops: [], clock: mock.clock(on, { now: NOW }) }
  mock.store(on)
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/Users/me' : undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '+0100\n', stderr: '' } }))
  on('fs.read', (_: unknown, e: any) => (e.path in w.files ? { value: w.files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', (_: unknown, e: any) => {
    w.files[e.path] = e.text

    return { value: undefined }
  })
  on('mcp.call', (_: unknown, e: any) => {
    w.tools.push(String(e.tool))
    const args = e.args ?? {}
    const text = (v: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(v) }], isError: false } })
    if (e.tool === 'searchJiraIssuesUsingJql') {
      const jql: string = args.jql
      if (jql.startsWith('assignee = "ada@example.com"')) return text({ issues: { nodes: [issue('APP-1')] } })
      if (jql.includes('worklogDate')) return text({ issues: { nodes: [issue('APP-2')] } })
      if (jql.includes('statusCategory != Done')) return text({ issues: { nodes: [issue('APP-2')] } })

      return text({ issues: { nodes: [] } })
    }
    if (e.tool === 'executeRead') {
      w.ops.push(String(args.name))
      if (args.name === 'listJiraIssueWorklogs') {
        return text({ data: { total: 1, isLast: true, worklogs: [{ id: '9', author: { accountId: 'a1' }, started: '2026-11-10T10:00:00.000+0100', timeSpentSeconds: 3 * 3600 }] } })
      }

      return text({ data: { total: 0, values: [] } })
    }

    return text({})
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: { offset: 0 } }))
  on('ui.toast', () => ({ value: undefined }))

  return w
}

test('/team pulls today from Jira, read-only, and draws every section', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'team' } as never)
  await w.clock.settle()

  // Ada's account was found and kept; the snapshot was written locally.
  expect(JSON.parse(w.files['/Users/me/.claude/jira-team-dashboard/team.json']!).members[0].accountId).toBe('a1')
  expect(Object.keys(w.files).some(p => p.endsWith('/snapshots/2026-11-10.json'))).toBe(true)
  // Only reads: search, read operations, the site lookup.
  expect([...new Set(w.tools)].every(t => ['searchJiraIssuesUsingJql', 'executeRead', 'getAccessibleAtlassianResources'].includes(t))).toBe(true)
  expect(w.ops.every(o => o.startsWith('list') || o.startsWith('get'))).toBe(true)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const key of ['sec-cards', 'sec-live', 'sec-devs', 'sec-projects', 'sec-flutter', 'sec-attention', 'sec-timeline']) expect(await ui.find({ type: 'Button', key })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^3\.0h$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Ada Lane$/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('team filter, the leave calendar and a reminder draft', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'team' } as never)
  await w.clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Cy logged nothing: a gap with a reminder draft.
  expect(await ui.find({ type: 'Button', key: 'agr-cy@example.com' })).toBeTruthy()
  await ui.press({ key: 't-iOS' })
  expect(await ui.find({ type: 'Button', key: 'devx-cy@example.com' })).toBeFalsy()
  await ui.press({ key: 't-all' })
  await ui.press({ key: 'agr-cy@example.com' })
  expect(await ui.find({ type: 'Text', text: /Hi Cy, a quick reminder: I don't see any time logged/ })).toBeTruthy()
  await ui.press({ key: 'tx-back' })

  // Put Cy on leave today: the gap goes.
  await ui.press({ key: 'setup' })
  await ui.select({ key: 'lv-who', value: 'cy@example.com' })
  await ui.input({ key: 'lv-day', text: '2026-11-10' })
  await ui.press({ key: 'su-save' })
  expect(await ui.find({ type: 'Button', key: 'agr-cy@example.com' })).toBeFalsy()
  expect(JSON.parse(w.files['/Users/me/.claude/jira-team-dashboard/team.json']!).leave).toEqual({ 'cy@example.com': ['2026-11-10'] })
  await ui.unmount()
})
