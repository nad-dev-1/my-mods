import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'jira-session-tracker'
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: 'jira-tracker',
  props: { title: 'Jira', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const NOW = Date.parse('2026-11-11T15:00:00Z')
const H = 3_600_000

// Three sessions on Nov 10: one already linked to PROJ-1064, two not, on one branch.
const SESSIONS = [
  {
    id: 's-linked',
    cwd: '/code/my-ios-app',
    title: 'Permissions needed for speedtest',
    segs: [[NOW - 30 * H, NOW - 29 * H, 'feature/PROJ-1064-speedtest']],
    prompts: [[NOW - 30 * H, 'check the speedtest permissions']],
    files: [],
    keys: ['PROJ-1064'],
    human: 1,
    entry: 'cli',
  },
  {
    id: 's-free',
    cwd: '/code/my-ios-app',
    title: 'Deeplink handling review',
    segs: [[NOW - 28 * H, NOW - 26.5 * H, 'fixing-deeplink']],
    prompts: [[NOW - 28 * H, 'review the deeplink handling']],
    files: [],
    keys: [],
    human: 1,
    entry: 'cli',
  },
  {
    id: 's-free2',
    cwd: '/code/my-ios-app',
    title: 'Deeplink follow-up',
    segs: [[NOW - 26 * H, NOW - 25.5 * H, 'fixing-deeplink']],
    prompts: [[NOW - 26 * H, 'one more deeplink case']],
    files: [],
    keys: [],
    human: 1,
    entry: 'cli',
  },
]

type World = { opens: string[]; mcp: string[]; clock: ReturnType<typeof mock.clock> }

function world(on: any, seed: Record<string, unknown> = {}): World {
  const w: World = { opens: [], mcp: [], clock: mock.clock(on, { now: NOW }) }
  mock.store(on, { links: { 's-linked|2026-11-10': 'PROJ-1064' }, ...seed })
  const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's-free' }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/Users/me' : undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.read', () => ({ deny: 'no file' }))
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'date') return ok('+0100\n')
    if (argv.some(a => a.endsWith('scan_sessions.py'))) return ok(JSON.stringify(SESSIONS))
    if (argv[0] === 'git' && argv.includes('--show-toplevel')) return ok('/code/my-ios-app\n')
    if (argv[0] === 'git' && argv.includes('user.email')) return ok('me@example.com\n')

    return ok('')
  })
  on('mcp.call', (_: unknown, e: any) => {
    w.mcp.push(String(e.tool))

    return { value: { content: [{ type: 'text', text: 'not connected in the test' }], isError: true } }
  })
  on('model.complete', () => ({
    value: { isAnswered: false, reason: 'aborted', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }))
  on('ui.open', (_: unknown, e: any) => {
    w.opens.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: { offset: 0 } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  return w
}

async function openJira($: any, w: World) {
  await $.session.start({ cwd: '/code/my-ios-app', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'jira' })
  await w.clock.settle()
}

const GROUP = '2026-11-09|/code/my-ios-app'

test('/jira lists linked work under its day and unlinked work grouped by folder, branch on each row', async ($, on) => {
  const w = world(on)
  await openJira($, w)

  expect(w.opens).toContain('jira-tracker')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Button', key: 'log-s-linked|2026-11-10' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `fold-${GROUP}` })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: `ign-g-${GROUP}` })).toBeTruthy()
    for (const id of ['s-free|2026-11-10', 's-free2|2026-11-10']) {
      for (const b of ['link', 'new', 'split', 'ign']) expect(await ui.find({ type: 'Button', key: `${b}-${id}` })).toBeTruthy()
    }
    expect(await ui.find({ type: 'Text', text: /No ticket · 2 · 2h/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^my-ios-app$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^\/code$/ })).toBeTruthy()
    expect((await ui.findAll({ type: 'Text', text: /^fixing-deeplink$/ })).length).toBe(2)
    await ui.unmount()
  }
})

test('Collapse all and Expand all fold every folder group of the week', async ($, on) => {
  const w = world(on)
  await openJira($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'fold-all-2026-11-09' })
  expect(await ui.find({ type: 'Button', key: 'link-s-free|2026-11-10' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: `fold-${GROUP}` })).toBeTruthy()
  await ui.press({ key: 'unfold-all-2026-11-09' })
  expect(await ui.find({ type: 'Button', key: 'link-s-free|2026-11-10' })).toBeTruthy()
  await ui.unmount()
})

test('a group collapses, and Ignore takes a session out until it is restored', async ($, on) => {
  const w = world(on)
  await openJira($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: `fold-${GROUP}` })
  expect(await ui.find({ type: 'Button', key: 'link-s-free|2026-11-10' })).toBeFalsy()
  await ui.press({ key: `fold-${GROUP}` })
  expect(await ui.find({ type: 'Button', key: 'link-s-free|2026-11-10' })).toBeTruthy()

  await ui.press({ key: 'ign-s-free2|2026-11-10' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Button', key: 'link-s-free2|2026-11-10' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /No ticket · 1 · 1h 30m/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Ignored \(1 · 30m\)/ })).toBeTruthy()

  await ui.press({ key: 'show-ign-2026-11-09' })
  await ui.press({ key: 'rest-s-free2|2026-11-10' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Button', key: 'link-s-free2|2026-11-10' })).toBeTruthy()

  await ui.press({ key: `ign-g-${GROUP}` })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /No ticket ·/ })).toBeFalsy()
  // Ignoring is local: nothing went to Jira.
  expect(w.mcp.filter(t => t === 'executeWrite' || /^(create|transition|edit)/.test(t))).toEqual([])
  await ui.unmount()
})

test('Log opens a preview, and nothing is written to Jira before Confirm', async ($, on) => {
  const w = world(on)
  await openJira($, w)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'log-s-linked|2026-11-10' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /Review before sending/ })).toBeTruthy()
  for (const code of ['A', 'C', 'D']) expect(await ui.find({ type: 'Button', key: `opt-wl:PROJ-1064|2026-11-10-${code}` })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'tr-tr:PROJ-1064-keep' })).toBeTruthy()
  expect(w.mcp.filter(t => t === 'executeWrite' || /^(create|transition|edit)/.test(t))).toEqual([])
  await ui.unmount()
})

test('Link all links every session of the group to the one ticket chosen', async ($, on) => {
  // This branch went to PROJ-1064 before, so it is the first candidate.
  const w = world(on, { branchLinks: { 'my-ios-app:fixing-deeplink': 'PROJ-1064' } })
  await openJira($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: `link-g-${GROUP}` })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /Link 2 sessions to one ticket/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /For 2 sessions in \/code\/my-ios-app \(2h in all\)/ })).toBeTruthy()
  await ui.press({ key: 'cand-PROJ-1064' })
  await w.clock.settle()

  expect(await ui.find({ type: 'Text', text: /No ticket ·/ })).toBeFalsy()
  for (const id of ['s-free|2026-11-10', 's-free2|2026-11-10']) expect(await ui.find({ type: 'Button', key: `log-${id}` })).toBeTruthy()
  expect(w.mcp.filter(t => t === 'executeWrite' || /^(create|transition|edit)/.test(t))).toEqual([])
  await ui.unmount()
})

test('One ticket for all opens the form for the whole group; a single Link covers one session', async ($, on) => {
  const w = world(on)
  await openJira($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: `new-g-${GROUP}` })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /For 2 sessions in \/code\/my-ios-app \(2h in all\)/ })).toBeTruthy()

  await ui.press({ key: 'tab-log' })
  await ui.press({ key: 'link-s-free|2026-11-10' })
  expect(await ui.find({ type: 'Text', text: /^Link to a ticket$/ })).toBeTruthy()
  await ui.unmount()
})

test('the tab counts only listed weeks; older weeks start folded; the gear opens the tools', async ($, on) => {
  // A week-old session in a week that is not this one, and a closed week further back.
  const OLD = {
    ...SESSIONS[1]!,
    id: 's-old',
    segs: [[NOW - 9 * 24 * H, NOW - 9 * 24 * H + H, 'old-branch']],
  }
  const CLOSED = {
    ...SESSIONS[1]!,
    id: 's-closed',
    segs: [[NOW - 16 * 24 * H, NOW - 16 * 24 * H + 5 * H, 'closed-branch']],
  }
  SESSIONS.push(OLD, CLOSED)
  try {
    const w = world(on, { closedWeeks: ['2026-10-26'] })
    await openJira($, w)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    // 3 this week (1h + 1h 30m + 30m) + 1 last week (1h); the closed week's 5h is not counted.
    const tabs = (await ui.findAll({ type: 'Text', text: /^Log work/ })).map((t: any) => t.text)
    expect(tabs).toEqual(['Log work 4 · 4h'])
    expect(await ui.find({ type: 'Text', text: /^This week · Nov 9$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'link-s-old|2026-11-02' })).toBeFalsy()
    await ui.press({ key: 'week-2026-11-02' })
    expect(await ui.find({ type: 'Button', key: 'link-s-old|2026-11-02' })).toBeTruthy()

    expect(await ui.find({ type: 'Button', key: 't-settings' })).toBeFalsy()
    await ui.press({ key: 'tools' })
    for (const k of ['t-add', 't-wrap', 't-standup', 't-sheet', 't-history', 't-check', 't-settings']) expect(await ui.find({ type: 'Button', key: k })).toBeTruthy()
    await ui.press({ key: 't-standup' })
    expect(await ui.find({ type: 'Text', text: /Standup notes/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 't-settings' })).toBeFalsy()
    await ui.unmount()
  } finally {
    SESSIONS.splice(3)
  }
})
