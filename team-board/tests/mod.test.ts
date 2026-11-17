import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-19T07:00:00Z')
const URL = 'https://claude.ai/artifact/AbcDEF123'
const CACHE = '/Users/me/.team-board/cache'
const PLAN = 'mcp__team-board__board_plan'

type World = { opened: string[]; files: Record<string, string>; prompts: string[]; status: (string | undefined)[]; toasts: string[]; clock: ReturnType<typeof mock.clock> }

const members = [
  { id: 'ada', name: 'Ada Lane', teams: ['iOS'], isSenior: false, active: true },
  { id: 'sam', name: 'Sam Lee', teams: ['iOS'], isSenior: true, active: true },
]
const item = (id: string, f: any) => ({ id, type: 'task', title: id, description: '', projectId: 'atlas', priority: 'medium', rank: 'i', status: 'backlog', archived: false, createdAt: '2026-11-10T08:00:00Z', updatedAt: '2026-11-18T08:00:00Z', lastActivityAt: '2026-11-18T08:00:00Z', assigneeId: null, collaboratorIds: [], assignmentHistory: [], queueRank: '', jiraKeys: [], etaOriginal: null, etaCurrent: null, etaHistory: [], startDate: null, reviewRequestedAt: null, reviewedBy: null, reviewedOn: null, reviewNote: '', endDate: null, manualDateFlags: [], ...f })

function world(on: any, opts: { connected?: boolean; board?: boolean } = {}): World {
  const w: World = { opened: [], files: {}, prompts: [], status: [], toasts: [], clock: mock.clock(on, { now: NOW }) }
  mock.store(on)
  const put = (coll: string, doc: any) => (w.files[`${CACHE}/${coll}/${doc.id}.json`] = JSON.stringify(doc))
  if (opts.connected !== false) w.files['/Users/me/.team-board/config.json'] = JSON.stringify({ adapter: 'artifact-db', artifactUrl: URL, artifactSlug: 'AbcDEF123', lastToastDate: null, lastFlagged: [] })
  if (opts.board !== false) {
    put('config', { id: 'settings', timezone: 'Asia/Beirut', staleDays: 5, wipLimit: 3, recentlyDoneDays: 14, jira: {}, reports: {} })
    put('config', { id: 'counters', idea: 0, task: 2 })
    members.forEach(m => put('members', m))
    put('members', { id: 'lead', name: 'Lee Lead', teams: ['Lead'], isSenior: true, active: true, isOwner: true })
    put('projects', { id: 'atlas', name: 'Atlas', jiraProjectKeys: ['APP'] })
    put('items', item('T-0001', { title: 'Fix APN retry crash', assigneeId: 'ada', status: 'in_progress', startDate: '2026-11-12', etaOriginal: '2026-11-17', etaCurrent: '2026-11-17', queueRank: 'i' }))
    put('items', item('T-0002', { title: 'Offline plan cache', assigneeId: 'ada', status: 'assigned', queueRank: 'r', priority: 'high' }))
    put('events', { id: 'E-1', itemId: 'T-0002', kind: 'note', tag: 'blocker', body: 'Waiting on the API', createdAt: '2026-11-18T09:00:00Z', resolved: false })
  }
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: e.name } }))
  on('tool.register', () => ({ value: undefined }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? '/Users/me' : undefined }))
  on('fs.read', (_: unknown, e: any) => (e.path in w.files ? { value: w.files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', (_: unknown, e: any) => {
    w.files[e.path] = e.text

    return { value: undefined }
  })
  on('fs.stat', (_: unknown, e: any) => (e.path in w.files ? { value: { kind: 'file', size: 1, mtimeMs: NOW - 60_000, isLink: false } } : { deny: 'ENOENT' }))
  on('fs.list', (_: unknown, e: any) => {
    const dir = e.path.replace(/\/$/, '') + '/'
    const names = Object.keys(w.files).filter(p => p.startsWith(dir) && !p.slice(dir.length).includes('/')).map(p => p.slice(dir.length))
    if (!names.length) return { deny: 'ENOENT' }

    return { value: names.map(name => ({ name, kind: 'file', size: 1 })) }
  })
  on('prompt.submit', (_: unknown, e: any) => {
    w.prompts.push(String(e.text))

    return { text: e.text }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.scroll', () => ({ value: { offset: 0 } }))
  on('ui.render', ($: any, e: any, next: any) => next(e))
  on('process.run', (_: unknown, e: any) => {
    w.opened.push(e.argv.join(' '))

    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.status', (_: unknown, e: any) => {
    w.status.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', (_: unknown, e: any) => {
    w.toasts.push(String(e.text))

    return { value: undefined }
  })
  // The mod's own refresh of the cache: refused here, as when the tool is not callable.
  on('tool.call', { tool: 'ArtifactData' }, () => ({ deny: 'not allowed' }))

  return w
}

async function tool($: any, name: string, input: any): Promise<string> {
  const r: any = await $.tool.call({ tool: name, ...input })

  return String(r.result ?? r.text ?? JSON.stringify(r))
}

test('session start: the status line counts overdue and blocked; the daily toast comes once', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(w.status.at(-1)).toBe('📋 1 overdue · 1 blocked')
  expect(w.toasts).toEqual(['Team Board: T-0001 now overdue. /board for details.'])
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(w.toasts.length).toBe(1)
})

test('commands: not set up says so; a capture hands Claude the procedure with the board link and today', async ($, on) => {
  const w = world(on, { connected: false })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const r1 = await $.command.run({ command: 'task', args: 'Ada, high: fix it' } as never)
  expect((r1 as any).text).toBe('Team Board is not set up yet: run /board-setup.')
  const r2 = await $.command.run({ command: 'board-setup', args: URL } as never)
  expect(w.prompts.length).toBe(0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await w.clock.advance(10)
  expect(w.prompts.at(-1)).toContain('The board is connected to ' + URL)
  expect((r2 as any).text).toContain('connected')
  expect(JSON.parse(w.files['/Users/me/.team-board/config.json']!).artifactUrl).toBe(URL)
  await $.command.run({ command: 'task', args: 'Ada, high, ETA Fri, project Atlas: fix APN retry crash' } as never)
  expect(w.prompts.length).toBe(1)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as never)
  await w.clock.advance(10)
  const p = w.prompts.at(-1)!
  expect(p).toContain(URL)
  expect(p).toContain('Today is 2026-11-19')
  expect(p).toContain('op "create_task"')
  expect(p).toContain('Write nothing before they say yes')
  const r3 = await $.command.run({ command: 'eta', args: '' } as never)
  expect((r3 as any).text).toBe('Usage: /eta <item> <date>')
})

test('board_plan: a new task gets the next id, the rules, its events and if_version on the counters', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const no = await tool($, PLAN, { op: 'create_task', fields: { title: 'Crash', projectId: 'atlas' } })
  expect(no).toContain('versions {"config/counters"')
  const out = await tool($, PLAN, { op: 'create_task', fields: { title: 'Fix SIM toggle', projectId: 'atlas', priority: 'high', assigneeId: 'sam', eta: '2026-11-21', jiraKeys: ['app-7'] }, versions: { 'config/counters': 4 } })
  expect(out).toContain('Create task T-0003:')
  const writes = JSON.parse(out.split('\n').find(l => l.startsWith('['))!)
  expect(writes[0]).toEqual({ op: 'set', collection: 'config', doc_id: 'counters', data: { idea: 0, task: 3 }, if_version: 4 })
  const t = writes[1].data
  expect([t.id, t.status, t.assigneeId, t.etaOriginal, t.jiraKeys]).toEqual(['T-0003', 'assigned', 'sam', '2026-11-21', ['APP-7']])
  expect(writes.slice(2).map((x: any) => x.data.systemType)).toEqual(['created', 'assigned', 'status_changed', 'eta_changed', 'jira_key_added'])
  const bad = await tool($, PLAN, { op: 'create_task', fields: { title: 'X', projectId: 'nope' }, versions: { 'config/counters': 4 } })
  expect(bad).toContain('projectId "nope" is not a project id. Projects: atlas (Atlas)')
})

test('board_plan: a stage change applies the date rules; a non-senior reviewer is refused', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const out = await tool($, PLAN, { op: 'change', itemId: 't-0002', change: { status: 'in_progress' }, versions: { 'items/T-0002': 7 } })
  const writes = JSON.parse(out.split('\n').find(l => l.startsWith('['))!)
  expect(writes[0]).toMatchObject({ op: 'update', collection: 'items', doc_id: 'T-0002', if_version: 7, data: { status: 'in_progress', startDate: '2026-11-19' } })
  expect(out).toContain('Assigned → In progress')
  expect(await tool($, PLAN, { op: 'change', itemId: 'T-0002', change: { reviewedBy: 'ada' }, versions: { 'items/T-0002': 7 } })).toContain('Ada Lane is not marked as senior')
  const note = await tool($, PLAN, { op: 'note', itemId: 'T-0001', tag: 'decision', body: 'Retry 3 times', versions: { 'items/T-0001': 2 } })
  expect(note).toContain('tagged decision')
})

test('board_summary and board_report read the cache; the report saves Markdown and CSV, then its write', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const s = await tool($, 'mcp__team-board__board_summary', {})
  expect(s).toContain('Ada Lane')
  expect(s).toContain('▸ T-0001 Fix APN retry crash (ETA 2026-11-17) [overdue] · In progress')
  expect(s).toContain('Attention: 1 overdue · 1 blocked')
  expect(s).toContain(URL)
  const first = await tool($, 'mcp__team-board__board_report', { scope: { kind: 'group', value: 'iOS' }, period: 'this_week' })
  expect(first).toContain('# Team Board report: iOS team')
  expect(first).toContain('FACTS for the summary')
  const id = /reportId: (R-\w+)/.exec(first)![1]
  const second = await tool($, 'mcp__team-board__board_report', { scope: { kind: 'group', value: 'iOS' }, period: 'this_week', summary: 'Two tasks open; one is late.', reportId: id })
  const saved = Object.keys(w.files).filter(p => p.startsWith('/Users/me/.team-board/reports/'))
  expect(saved.length).toBe(2)
  expect(saved.some(p => p.endsWith('.md')) && saved.some(p => p.endsWith('.csv'))).toBe(true)
  const writes = JSON.parse(second.split('\n').find(l => l.startsWith('['))!)
  expect(writes[0].collection).toBe('reports')
  expect(writes[0].data.markdown).toContain('## Executive summary\n\nTwo tasks open; one is late.')
})

test('the ▤ Board button opens a pane: you first, who is on what, attention, and its buttons work', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const bar = await $.ui.mount({ plugin: 'team-board', component: 'SessionMode', props: { modes: [] }, surface: 'terminal' } as never)
  expect(await bar.find({ type: 'Text', text: /▤ Board/ })).toBeTruthy()
  await bar.press({ key: 'open-board' })
  const ui = await $.ui.mount({ plugin: 'team-board', component: 'Pane', requestId: 'team-board', props: { title: 'Team Board', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }, surface: 'terminal' } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  expect(texts.indexOf('Lee Lead (you)')).toBeLessThan(texts.indexOf('Ada Lane'))
  expect(await ui.find({ type: 'Text', text: 'Attention: 1 overdue · 1 blocked' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: 'T-0001' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /next: T-0002 Offline plan cache/ })).toBeTruthy()
  await ui.press({ key: 'open-dashboard' })
  await w.clock.advance(10)
  expect(w.opened).toEqual([`open ${URL}`])
  await ui.press({ key: 'refresh' })
  await w.clock.advance(10)
  expect(w.prompts.at(-1)).toContain('board_summary')
  expect(await ui.find({ type: 'Text', text: 'Asked Claude to read the board again…' })).toBeTruthy()
  await ui.unmount()
  await bar.unmount()
})
