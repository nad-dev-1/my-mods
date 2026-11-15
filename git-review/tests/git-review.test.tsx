import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'git-review'
const HOME = '/Users/me'
const STATUS_BAR = { plugin: PLUGIN, component: 'SessionMode', props: { modes: [] } } as const
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: PLUGIN,
  props: { title: 'Git Review', isFocused: true, bodyColumns: 96, placement: 'dock', scroll: { offset: 1, bodyRows: 40 }, view: {} },
} as const

const BASE = 'https://gitlab.com/example-group/example-subgroup'
function raw(path: string, iid: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    iid,
    project_id: path.length,
    title,
    draft: false,
    has_conflicts: false,
    source_branch: `feature-${iid}`,
    target_branch: 'main',
    web_url: `${BASE}/${path}/-/merge_requests/${iid}`,
    created_at: `2026-11-0${(iid % 9) + 1}T10:00:00Z`,
    updated_at: `2026-11-1${iid % 2}T10:00:00Z`,
    author: { username: `dev${iid}` },
    ...extra,
  }
}

const ANDROID = raw('android/app-android', 11, 'Add login screen')
const IOS_A = raw('ios/app-ios', 21, 'Fix crash on launch')
const IOS_B = raw('ios/app-ios', 22, 'Draft: new settings', { draft: true, has_conflicts: true })
const MINE = raw('web/portal', 31, 'Review me please')
const PIPES: Record<number, string> = { 11: 'success', 21: 'failed', 22: 'running', 31: 'success' }

type World = {
  clock: ReturnType<typeof mock.clock>
  calls: string[][]
  opens: string[]
  toasts: string[]
  files: Record<string, string>
}

function world(on: any, opts: { clones?: Record<string, string>; env?: Record<string, string>; files?: Record<string, string>; terminals?: Record<string, { labels: Record<string, string>; where?: string; state?: string }> } = {}): World {
  const w: World = { clock: mock.clock(on, { now: Date.parse('2026-11-11T12:00:00Z') }), calls: [], opens: [], toasts: [], files: { ...(opts.files ?? {}) } }
  mock.store(on)
  const clones = opts.clones ?? {}
  const env: Record<string, string> = { HOME, ...(opts.env ?? {}) }
  const ok = (stdout: unknown) => ({ value: { exitCode: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' } })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'git-review' } }))
  on('env.get', (_: unknown, e: any) => ({ value: env[e.name] }))
  on('fs.exists', (_: unknown, e: any) => ({ value: e.path in w.files || Object.keys(w.files).some(f => f.startsWith(`${e.path}/`)) || Object.values(clones).some(d => e.path === d || e.path === `${d}/.git`) || e.path === `${HOME}/.local/bin/herdr-core` }))
  on('fs.list', (_: unknown, e: any) => ({
    value: Object.keys(w.files)
      .filter(p => p.startsWith(`${e.path}/`))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_: unknown, e: any) => {
    if (e.path === `${HOME}/.claude.json` && !(e.path in w.files)) return { value: JSON.stringify({ projects: Object.fromEntries(Object.values(clones).map(d => [d, { hasTrustDialogAccepted: true }])) }) }

    return { value: w.files[e.path] }
  })
  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv
    w.calls.push(argv)
    if (argv[0] === 'glab') {
      const path = argv[2]!
      if (path === 'user') return ok({ username: 'me' })
      if (path.includes('scope=assigned_to_me')) return ok([ANDROID])
      if (path.includes('reviewer_username=me')) return ok([MINE])
      if (path.startsWith('groups/')) return ok([ANDROID, IOS_A, IOS_B])
      const pm = /merge_requests\/(\d+)\/pipelines/.exec(path)
      if (pm) return ok([{ status: PIPES[Number(pm[1])] }])
    }
    if (argv[0]!.endsWith('herdr-core') && (argv[1] === 'get' || argv[1] === 'ls')) {
      const terms = (opts as any).terminals ?? {}
      if (argv[1] === 'ls') return ok({ terminals: Object.entries(terms).map(([address, t]: any) => ({ address, state: t.state ?? 'live', where: t.where })) })

      // A review terminal just started (by name): Herdr has placed it.
      if (argv[2]!.startsWith('mr-')) return ok({ address: 't99', labels: { where: 'Work / 1' } })

      return ok({ address: argv[2], labels: terms[argv[2]!]?.labels ?? {} })
    }
    if (argv[0] === '/bin/sh') {
      return ok(Object.entries(clones).map(([project, dir]) => `git@gitlab.com:example-group/example-subgroup/${project}.git\t${dir}`).join('\n'))
    }
    if (argv[0] === 'git' && argv[3] === 'remote') {
      const project = Object.entries(clones).find(([, d]) => d === argv[2])?.[0]

      return project ? ok(`git@gitlab.com:example-group/example-subgroup/${project}.git\n`) : { value: { exitCode: 2, stdout: '', stderr: 'no remote' } }
    }

    return ok('')
  })
  on('ui.open', (_: unknown, e: any) => {
    w.opens.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.toast', (_: unknown, e: any) => {
    w.toasts.push(e.text ?? String(e))

    return { value: undefined }
  })

  return w
}

async function start($: any) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

async function openDialog($: any, w: World) {
  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' })
  await bar.press({ key: 'open-git-review' })
  await w.clock.settle()
  await bar.unmount()

  return await $.ui.mount({ ...PANE, surface: 'terminal' })
}

test('the status-bar button opens the dialog and lists open MRs grouped by project', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openDialog($, w)

  expect(w.opens).toContain(PLUGIN)
  for (const g of ['app-android', 'app-ios', 'portal']) expect(await ui.find({ type: 'Button', key: `grp#example-group/example-subgroup/${g.startsWith('app-a') ? 'android' : g.startsWith('app-i') ? 'ios' : 'web'}/${g}` })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'mr#example-group/example-subgroup/ios/app-ios!21' })).toBeTruthy()
  // Assigned to me and in the group: listed once.
  expect((await ui.findAll({ type: 'Button' })).filter((b: any) => b.key === 'mr#example-group/example-subgroup/android/app-android!11').length).toBe(1)
  // Conflict and pipeline marks.
  expect(await ui.find({ type: 'Text', text: / ⚠ / })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^✗$/ })).toBeTruthy()
  await ui.unmount()
})

test('filters: Mine, pipeline, drafts and search', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openDialog($, w)
  const has = async (iid: number) => Boolean((await ui.findAll({ type: 'Button' })).find((b: any) => String(b.key).endsWith(`!${iid}`)))

  await ui.press({ key: 'scope-mine' })
  expect(await has(11)).toBe(true)
  expect(await has(31)).toBe(true)
  expect(await has(21)).toBe(false)

  await ui.press({ key: 'scope-all' })
  await ui.press({ key: 'pipe-failed' })
  expect(await has(21)).toBe(true)
  expect(await has(11)).toBe(false)

  await ui.press({ key: 'pipe-any' })
  await ui.press({ key: 'drafts' })
  expect(await has(22)).toBe(false)

  await ui.input({ key: 'search', text: 'login', kind: 'change' })
  expect(await has(11)).toBe(true)
  expect(await has(21)).toBe(false)
  await ui.unmount()
})

test('a project group folds and unfolds', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openDialog($, w)
  const group = 'grp#example-group/example-subgroup/ios/app-ios'

  await ui.press({ key: group })
  expect(await ui.find({ type: 'Button', key: 'mr#example-group/example-subgroup/ios/app-ios!21' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: group })).toBeTruthy()
  await ui.press({ key: group })
  expect(await ui.find({ type: 'Button', key: 'mr#example-group/example-subgroup/ios/app-ios!21' })).toBeTruthy()
  await ui.unmount()
})

test('picking an MR with a local clone opens a Herdr terminal running the review skill', async ($, on) => {
  const w = world(on, {
    clones: { 'ios/app-ios': `${HOME}/Documents/Projects/repo/iOS/app-ios` },
    env: { HC_TERMINAL_SOCKET: '/sock' },
  })
  await start($)
  const ui = await openDialog($, w)

  await ui.press({ key: 'mr#example-group/example-subgroup/ios/app-ios!21' })
  await w.clock.settle()

  const run = w.calls.find(c => c[0] === `${HOME}/.local/bin/herdr-core` && c[1] === 'run')
  expect(run).toBeTruthy()
  expect(run).toContain('--cwd')
  expect(run![run!.indexOf('--cwd') + 1]).toBe(`${HOME}/Documents/Projects/repo/iOS/app-ios`)
  expect(run).toContain('--permission-mode')
  expect(run![run!.length - 1]).toBe(`/git-review:review-mr ${BASE}/ios/app-ios/-/merge_requests/21`)
  expect(w.toasts.some(t => /Review of app-ios !21 started/.test(t))).toBe(true)
  await ui.unmount()
})

test('without a local clone the dialog asks for the folder, then uses it', async ($, on) => {
  const clones: Record<string, string> = {}
  const w = world(on, { clones, env: { HC_TERMINAL_SOCKET: '/sock' } })
  await start($)
  const ui = await openDialog($, w)

  await ui.press({ key: 'mr#example-group/example-subgroup/web/portal!31' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /Where is portal on this Mac/ })).toBeTruthy()

  // Not a clone yet: says so.
  await ui.input({ key: 'path', text: '/elsewhere/portal' })
  expect(await ui.find({ type: 'Text', text: /No such folder/ })).toBeTruthy()

  // The clone is there now.
  clones['web/portal'] = '/elsewhere/portal'
  await ui.input({ key: 'path', text: '/elsewhere/portal' })
  await w.clock.settle()
  const run = w.calls.find(c => c[1] === 'run' && c.includes('--cwd'))
  expect(run![run!.indexOf('--cwd') + 1]).toBe('/elsewhere/portal')
  await ui.unmount()
})

test('a finished review shows its verdict on the MR row and says so', async ($, on) => {
  const dir = `${HOME}/.claude/git-review/status`
  const w = world(on, { files: { [`${dir}/.keep`]: '' } })
  await start($)
  const ui = await openDialog($, w)

  w.files[`${dir}/example-group__example-subgroup__ios__app-ios__21.json`] = JSON.stringify({ stage: 'done', verdict: 'Changes needed', report: '/r.md', at: '' })
  await w.clock.advance(61_000)

  expect(w.toasts.some(t => /app-ios!21: Changes needed/.test(t))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /\[Changes needed\]/ })).toBeTruthy()
  await ui.unmount()
})

test('the action buttons stay drawn when the list is longer than the dialog', async ($, on) => {
  const w = world(on)
  await start($)
  const short = { ...PANE, props: { ...PANE.props, scroll: { offset: 1, bodyRows: 18 } } }
  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  await bar.press({ key: 'open-git-review' })
  await w.clock.settle()
  const ui = await $.ui.mount({ ...short, surface: 'terminal' } as any)

  for (const key of ['review', 'open-web', 'refresh', 'close']) expect(await ui.find({ type: 'Button', key })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /↓ \d+ more lines/ })).toBeTruthy()
  await ui.unmount()
  await bar.unmount()
})

test('the project filter is a dropdown that narrows the list to one project', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openDialog($, w)

  const select = (await ui.find({ type: 'Select', key: 'project' })) as any
  expect(select).toBeTruthy()
  const options = select.options ?? select.props?.options
  if (!options) throw new Error(`Select shape: ${Object.keys(select).join(',')}`)
  expect(options.map((o: any) => o.label)).toEqual(['All projects (4)', 'app-android (1)', 'app-ios (2)', 'portal (1)'])

  await ui.select({ key: 'project', value: 'example-group/example-subgroup/ios/app-ios' })
  expect(await ui.find({ type: 'Button', key: 'mr#example-group/example-subgroup/ios/app-ios!21' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'mr#example-group/example-subgroup/web/portal!31' })).toBeFalsy()

  await ui.select({ key: 'project', value: '' })
  expect(await ui.find({ type: 'Button', key: 'mr#example-group/example-subgroup/web/portal!31' })).toBeTruthy()
  await ui.unmount()
})

test('the review terminal is seated in the Herdr tab this session is in, and the dialog closes', async ($, on) => {
  const w = world(on, {
    clones: { 'ios/app-ios': `${HOME}/repo/app-ios` },
    env: { HC_TERMINAL_SOCKET: '/sock', HC_TERMINAL_ID: 't6' },
    terminals: { t6: { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' }, where: 'Work / 1' } },
  })
  await start($)
  const ui = await openDialog($, w)
  await ui.press({ key: 'mr#example-group/example-subgroup/ios/app-ios!21' })
  await w.clock.settle()

  const run = w.calls.find(c => c[1] === 'run')!
  expect(run).toContain('herdr.space=sp1')
  expect(run).toContain('herdr.tab=tb1')
  expect(w.calls.some(c => c[0] === `${HOME}/.local/bin/herdr-core` && c[1] === 'run' && c.includes('--no-parent'))).toBe(true)
  await ui.unmount()
})

test('a second Review of an MR already under review does not start another', async ($, on) => {
  const key = 'example-group/example-subgroup/ios/app-ios!21'
  const w = world(on, {
    clones: { 'ios/app-ios': `${HOME}/repo/app-ios` },
    env: { HC_TERMINAL_SOCKET: '/sock', HC_TERMINAL_ID: 't6' },
    terminals: {
      t6: { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' }, where: 'Work / 1' },
      t11: { labels: { 'git-review': key }, where: 'Work / 1' },
    },
  })
  await start($)
  const ui = await openDialog($, w)
  await ui.press({ key: `mr#${key}` })
  await w.clock.settle()

  expect(w.calls.some(c => c[1] === 'run')).toBe(false)
  expect(w.toasts.some(t => /already running in terminal t11/.test(t))).toBe(true)
  await ui.unmount()
})

test('a review in a folder Claude has not trusted yet says to answer the trust question', async ($, on) => {
  const w = world(on, {
    clones: { 'ios/app-ios': `${HOME}/repo/app-ios` },
    env: { HC_TERMINAL_SOCKET: '/sock', HC_TERMINAL_ID: 't6' },
    terminals: { t6: { labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tb1' }, where: 'Work / 1' } },
    files: { [`${HOME}/.claude.json`]: JSON.stringify({ projects: {} }) },
  })
  await start($)
  const ui = await openDialog($, w)
  await ui.press({ key: 'mr#example-group/example-subgroup/ios/app-ios!21' })
  await w.clock.settle()

  expect(w.toasts.some(t => /started in a new Herdr terminal in Work \/ 1/.test(t))).toBe(true)
  expect(w.toasts.some(t => /trust/.test(t))).toBe(true)
  await ui.unmount()
})

test('the Allowed paths setting is passed to the review skill', { options: { allowedPaths: 'google-services.json, GoogleService-Info.plist' } }, async ($, on) => {
  const w = world(on, {
    clones: { 'ios/app-ios': `${HOME}/Documents/Projects/repo/iOS/app-ios` },
    env: { HC_TERMINAL_SOCKET: '/sock' },
  })
  await start($)
  const ui = await openDialog($, w)

  await ui.press({ key: 'mr#example-group/example-subgroup/ios/app-ios!21' })
  await w.clock.settle()

  const run = w.calls.find(c => c[0] === `${HOME}/.local/bin/herdr-core` && c[1] === 'run')
  expect(run![run!.length - 1]).toBe(`/git-review:review-mr ${BASE}/ios/app-ios/-/merge_requests/21 --allowed google-services.json,GoogleService-Info.plist`)
  await ui.unmount()
})
