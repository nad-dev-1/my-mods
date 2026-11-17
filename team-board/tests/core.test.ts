import { expect, test } from 'claude-code/testing'

import * as c from '../hooks/core.js'

const members = [
  { id: 'ada', name: 'Ada', teams: ['iOS', 'Flutter'], isSenior: false, active: true, jiraAccountId: 'acc-ada' },
  { id: 'sam', name: 'Sam', teams: ['iOS'], isSenior: true, active: true },
  { id: 'ben', name: 'Ben', teams: ['Android'], isSenior: true, active: true },
]
const ctx = (today = '2026-11-17') => ({ today, nowIso: `${today}T09:00:00.000Z`, members, items: [] as any[] })
function run(item: any, changes: any[], today = '2026-11-17') {
  let it = item
  const events: any[] = []
  const warnings: string[] = []
  for (const ch of changes) {
    const r = c.applyChange(it, ch, ctx(today))
    it = { ...it, ...r.patch }
    events.push(...r.events)
    warnings.push(...r.warnings)
  }

  return { it, events, warnings }
}
const task = (f: any = {}) => c.newItem('task', 'T-0001', { title: 'Fix APN retry', projectId: 'atlas', ...f }, ctx()).item

test('in progress sets the start once; done sets the end; reopening clears it; each logs an event', () => {
  const a = run(task(), [{ status: 'in_progress' }])
  expect(a.it.startDate).toBe('2026-11-17')
  const b = run(a.it, [{ status: 'in_review' }, { status: 'in_progress' }], '2026-11-19')
  expect(b.it.startDate).toBe('2026-11-17')
  expect(b.it.reviewRequestedAt).toBe('2026-11-19')
  const d = run(b.it, [{ status: 'done' }], '2026-11-20')
  expect(d.it.endDate).toBe('2026-11-20')
  const r = run(d.it, [{ status: 'in_progress' }], '2026-11-21')
  expect(r.it.endDate).toBe(null)
  expect(r.events.map((e: any) => e.systemType)).toEqual(['status_changed', 'reopened'])
  expect([...a.events, ...b.events, ...d.events].every((e: any) => e.kind === 'system' && e.itemId === 'T-0001')).toBe(true)
})

test('changing the ETA keeps the original; slipped and overdue compute', () => {
  const { it } = run(task(), [{ eta: '2026-11-20' }, { eta: '2026-11-25' }])
  expect([it.etaOriginal, it.etaCurrent]).toEqual(['2026-11-20', '2026-11-25'])
  expect(it.etaHistory.map((h: any) => h.date)).toEqual(['2026-11-20', '2026-11-25'])
  const f = c.flagsFor(it, { today: '2026-11-26', settings: {}, blockers: new Map(), jira: {}, members })
  expect([f.overdue, f.slipped, f.slipDays]).toEqual([true, true, 5])
  const done = c.flagsFor({ ...it, status: 'done' }, { today: '2026-11-26', settings: {}, blockers: new Map(), jira: {}, members })
  expect(done.overdue).toBe(false)
})

test('reassigning keeps the history; reports count the current assignee only', () => {
  const t = c.newItem('task', 'T-0001', { title: 'A', projectId: 'atlas', assigneeId: 'ada' }, ctx()).item
  expect(t.status).toBe('assigned')
  const { it } = run(t, [{ assigneeId: 'sam' }, { status: 'in_progress' }, { status: 'done' }], '2026-11-18')
  expect(it.assignmentHistory).toEqual([
    { memberId: 'ada', from: '2026-11-17', to: '2026-11-18' },
    { memberId: 'sam', from: '2026-11-18', to: null },
  ])
  const r = c.computeReport({ items: [it], events: [], members, projects: [], today: '2026-11-18', period: 'this_week' })
  expect(r.workload.find((w: any) => w.memberId === 'sam').done).toBe(1)
  expect(r.workload.find((w: any) => w.memberId === 'ada').done).toBe(0)
})

test('the reviewer must be a senior and not the assignee; no reviewer is fine', () => {
  const t = c.newItem('task', 'T-0001', { title: 'A', projectId: 'atlas', assigneeId: 'sam' }, ctx()).item
  expect(run(t, [{ reviewedBy: 'ada' }]).it.reviewedBy).toBe(null)
  expect(run(t, [{ reviewedBy: 'sam' }]).warnings).toEqual(['The reviewer cannot be the assignee.'])
  const ok = run(t, [{ reviewedBy: 'ben', reviewNote: 'LGTM' }])
  expect([ok.it.reviewedBy, ok.it.reviewedOn, ok.it.reviewNote]).toEqual(['ben', '2026-11-17', 'LGTM'])
  expect(run(t, [{ status: 'in_progress' }, { status: 'done' }]).it.status).toBe('done')
})

test('ranks: any insertion lands strictly between its neighbours, so a drag writes one document', () => {
  let list = c.ranksAfter('', 5)
  for (let i = 0; i < 300; i++) {
    const at = (i * 7) % (list.length + 1)
    const r = c.rankBetween(at ? list[at - 1] : '', at < list.length ? list[at] : null)
    if (at) expect(r > list[at - 1]!).toBe(true)
    if (at < list.length) expect(r < list[at]!).toBe(true)
    list = [...list.slice(0, at), r, ...list.slice(at)]
  }
  expect([...list].sort()).toEqual(list)
  expect(new Set(list).size).toBe(list.length)
})

test('three Jira keys: needs closing only when all are done; Jira never changes the stage', () => {
  const { it } = run(task({ assigneeId: 'ada' }), [{ jiraAdd: ['APP-1', 'https://x.atlassian.net/browse/app-2', 'APP-3'] }, { status: 'in_progress' }])
  expect(it.jiraKeys).toEqual(['APP-1', 'APP-2', 'APP-3'])
  const snap = (key: string, cat: string, acc = 'acc-ada') => c.jiraSnapshot({ key, fields: { summary: key, status: { name: cat === 'done' ? 'Done' : 'In Progress', statusCategory: { key: cat } }, assignee: { accountId: acc } } }, '2026-11-17T09:00:00Z')
  const fx = (jira: any) => c.flagsFor(it, { today: '2026-11-17', settings: {}, blockers: new Map(), jira, members })
  const two = { 'APP-1': snap('APP-1', 'done'), 'APP-2': snap('APP-2', 'done'), 'APP-3': snap('APP-3', 'indeterminate') }
  expect(fx(two).needsClosing).toBe(false)
  const all = { ...two, 'APP-3': snap('APP-3', 'done', 'acc-other') }
  expect(fx(all).needsClosing).toBe(true)
  expect(fx(all).mismatch).toBe(true)
  expect(it.status).toBe('in_progress')
  expect(c.jiraChunks([it, { ...it, id: 'T-2', jiraKeys: ['APP-9'], archived: true }], 2)).toEqual([['APP-1', 'APP-2'], ['APP-3']])
})

test('an open blocker note flags Blocked; resolving it clears the flag', () => {
  const t = task()
  const note = c.noteEvent(t.id, 'blocker', 'Waiting on the carrier APN list', ctx())
  const f = (events: any[]) => c.flagsFor(t, { today: '2026-11-17', settings: {}, blockers: c.openBlockers(events), jira: {}, members }).blocked
  expect(f([note])).toBe(true)
  expect(f([{ ...note, resolved: true }])).toBe(false)
  expect(f([{ ...note, tag: 'decision' }])).toBe(false)
})

test('a report renders its non-empty sections only; CSV has one row per item', () => {
  const t1 = run(c.newItem('task', 'T-0001', { title: 'Ship offline cache', projectId: 'atlas', priority: 'high', assigneeId: 'ada', eta: '2026-11-18', jiraKeys: ['APP-1'] }, ctx()).item, [{ status: 'in_progress' }, { status: 'done' }], '2026-11-18').it
  const t2 = run(c.newItem('task', 'T-0002', { title: 'APN retry crash', projectId: 'atlas', assigneeId: 'sam', eta: '2026-11-16' }, ctx('2026-11-16')).item, [{ status: 'in_progress' }], '2026-11-16').it
  const idea = c.newItem('idea', 'I-0001', { title: 'Plan cache', projectId: 'atlas', ownerId: 'ben' }, ctx()).item
  const dec = { ...c.noteEvent('T-0002', 'decision', 'Retry 3 times, then fall back', ctx()), createdAt: '2026-11-17T10:00:00Z' }
  const input = { items: [t1, t2, idea], events: [dec], members, projects: [{ id: 'atlas', name: 'Atlas' }], today: '2026-11-19', period: 'this_week', scope: { kind: 'team' } }
  const r = c.computeReport(input)
  expect(r.headline).toEqual({ delivered: 1, inProgress: 1, overdue: 1, onTimeRate: 100, onTimeBase: 1, avgCycleDays: 0, totalSlipDays: 0 })
  const md = c.reportMarkdown(r, 'One shipped, one late.')
  for (const h of ['## Executive summary', '## Headline numbers', '## Delivered', '## Risks', '## Decisions', '## Workload', '## Ideas pipeline']) expect(md).toContain(h)
  expect(md).not.toContain('## Coming up')
  expect(md).toContain('T-0001 Ship offline cache · Ada · APP-1')
  const ios = c.computeReport({ ...input, scope: { kind: 'group', value: 'Android' } })
  expect(ios.headline.delivered).toBe(0)
  const { csv } = c.reportCsv(input)
  expect(csv.trim().split('\n').length).toBe(4)
  expect(c.periodRange('last_week', '2026-11-19')).toEqual({ from: '2026-11-09', to: '2026-11-15', label: 'Week of 2026-11-09' })
  expect(c.periodRange('custom', '2026-11-19', { from: '2026-11-20', to: '2026-11-01' }).from).toBe('2026-11-01')
})

test('ideas convert into tasks with a back-link; the idea moves to converted', () => {
  const idea = c.newItem('idea', 'I-0001', { title: 'Offline plan cache', projectId: 'atlas', priority: 'high', description: 'Why' }, ctx()).item
  const r = c.convertIdea({ ...idea, status: 'approved' }, [{ title: 'Cache layer', assigneeId: 'ada' }, { title: 'Sync job' }], { idea: 1, task: 4 }, ctx())
  expect(r.tasks.map((t: any) => [t.item.id, t.item.sourceIdeaId, t.item.priority, t.item.status])).toEqual([
    ['T-0005', 'I-0001', 'high', 'assigned'],
    ['T-0006', 'I-0001', 'high', 'backlog'],
  ])
  expect(r.ideaPatch.status).toBe('converted')
  expect(r.ideaPatch.convertedTaskIds).toEqual(['T-0005', 'T-0006'])
  expect(r.counters).toEqual({ idea: 1, task: 6 })
})
