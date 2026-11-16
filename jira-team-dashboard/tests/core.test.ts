import { expect, test } from 'claude-code/testing'

import type { Snapshot, TeamCfg, WL } from '../types'
import { buildView, dayStart, digestMd, isBounce, parseRoster, reminderText, viewCsv, viewMd } from '../hooks/core'

const OFF = 60
const H = 3_600_000
const CFG: TeamCfg = {
  cloudId: 'c',
  site: '',
  members: [
    { name: 'Ada Lane', email: 'ada@example.com', accountId: 'a1', teams: ['iOS', 'Flutter'] },
    { name: 'Ben Ray', email: 'ben@example.com', accountId: 'b1', teams: ['iOS'] },
    { name: 'Cy Moss', email: 'cy@example.com', accountId: 'c1', teams: ['Android'] },
  ],
  teams: ['iOS', 'Android', 'Flutter'],
  projects: [],
  hoursPerDay: 8,
  workDays: [1, 2, 3, 4, 5],
  endOfDay: '18:00',
  leave: { 'cy@example.com': ['2026-11-10'] },
  stuckDays: 5,
  flutterTeam: 'Flutter',
  flutterMatch: ['flutter'],
}

const T0 = dayStart('2026-11-10', OFF)
const wl = (email: string, key: string, hours: number, isFlutter = false, project = 'APP'): WL => ({
  id: `${email}-${key}`,
  key,
  summary: `${key} work`,
  project,
  story: 'APP-1',
  storySummary: 'Login revamp',
  email,
  seconds: hours * 3600,
  started: T0 + 9 * H,
  comment: '',
  isFlutter,
})

const SNAP: Snapshot = {
  day: '2026-11-10',
  takenAt: T0 + 18 * H,
  worklogs: [wl('ada@example.com', 'APP-2', 5), wl('ada@example.com', 'APP-3', 3, true), wl('ben@example.com', 'APP-4', 2)],
  moves: [
    { key: 'APP-4', summary: 'APP-4 work', project: 'APP', email: 'ben@example.com', from: 'In QA', to: 'In Progress', at: T0 + 10 * H, isBounce: true },
    { key: 'APP-9', summary: 'APP-9 work', project: 'APP', email: 'ben@example.com', from: 'To Do', to: 'In Progress', at: T0 + 11 * H, isBounce: false },
  ],
  created: [],
  inProgress: [
    { key: 'APP-9', summary: 'Old one', project: 'APP', type: 'Task', status: 'In Progress', statusCat: 'indeterminate', assignee: 'ben@example.com', reporter: '', parent: '', parentSummary: '', estimateSec: 0, spentSec: 0, remainingSec: 0, statusSince: T0 - 10 * 24 * H, created: 0, labels: [] },
  ],
  open: [],
  stories: [{ key: 'APP-1', summary: 'Login revamp', project: 'APP', type: 'Story', children: 3, byStatus: { Done: 1, 'In Progress': 2 }, estimateSec: 20 * 3600, spentSec: 10 * 3600 }],
  hygiene: [],
  errors: [],
}

const ALL = { team: '', dev: '', project: '' }

test('a person in two teams is counted once; leave is not a logging gap', () => {
  const v = buildView(CFG, [SNAP], ['2026-11-10'], ALL, '2026-11-10', T0 + 18 * H)
  expect(v.cards.hours).toBe(10)
  expect(v.devs.map(d => [d.member.name, d.loggedMin / 60, d.expectedMin / 60])).toEqual([
    ['Ada Lane', 8, 8],
    ['Ben Ray', 2, 8],
    ['Cy Moss', 0, 0],
  ])
  // Ben is under; Cy logged nothing but was on leave.
  expect(v.attention.gaps.map(g => [g.member.name, g.kind])).toEqual([['Ben Ray', 'under']])
  const ios = buildView(CFG, [SNAP], ['2026-11-10'], { ...ALL, team: 'iOS' }, '2026-11-10', T0 + 18 * H)
  const flutter = buildView(CFG, [SNAP], ['2026-11-10'], { ...ALL, team: 'Flutter' }, '2026-11-10', T0 + 18 * H)
  expect(ios.cards.hours).toBe(10)
  expect(flutter.cards.hours).toBe(8)
})

test('filters, the Flutter split, stuck tickets, work with no time and bounce-backs', () => {
  const v = buildView(CFG, [SNAP], ['2026-11-10'], ALL, '2026-11-10', T0 + 18 * H)
  expect(v.flutter.map(f => [f.member.name, f.nativeMin / 60, f.flutterMin / 60])).toEqual([['Ada Lane', 5, 3]])
  expect(v.attention.stuck.map(s => s.issue.key)).toEqual(['APP-9'])
  expect(v.attention.noTime.map(m => m.key)).toEqual(['APP-9'])
  expect(v.attention.bounces.map(b => [b.member.name, b.count])).toEqual([['Ben Ray', 1]])
  expect(v.projects[0]!.stories[0]!.progress?.byStatus).toEqual({ Done: 1, 'In Progress': 2 })
  const ben = buildView(CFG, [SNAP], ['2026-11-10'], { ...ALL, dev: 'ben@example.com' }, '2026-11-10', T0 + 18 * H)
  expect(ben.devs.map(d => d.member.name)).toEqual(['Ben Ray'])
  expect(ben.cards.hours).toBe(2)
  const other = buildView(CFG, [SNAP], ['2026-11-10'], { ...ALL, project: 'OTHER' }, '2026-11-10', T0 + 18 * H)
  expect(other.cards.hours).toBe(0)
})

test('a range with a missing day says so; exports match the view', () => {
  const v = buildView(CFG, [SNAP], ['2026-11-09', '2026-11-10'], ALL, '2026-11-10', T0 + 18 * H)
  expect(v.missingDays).toEqual(['2026-11-09'])
  const csv = viewCsv(v)
  expect(csv.split('\n')[0]).toBe('from,to,developer,email,teams,ticket,summary,hours,status moves,logged hours (total),expected hours (total)')
  const total = csv
    .split('\n')
    .slice(1)
    .map(r => r.split(','))
    .reduce((a, r) => a + Number(r[7]), 0)
  expect(total).toBe(v.cards.hours)
  expect(viewMd(v, '')).toContain('| Ben Ray | 2h / 8h | 2 | 2 |')
  expect(digestMd(CFG, v)).toContain('| **All (each person once)** | **10h** |')
})

test('roster lines, bounce detection and reminder wording', () => {
  expect(parseRoster('Name, Email, Team\nAda Lane, ADA@example.com, iOS Team\nAda Lane, ada@example.com, Flutter Team')).toEqual([
    { name: 'Ada Lane', email: 'ada@example.com', accountId: '', teams: ['iOS', 'Flutter'] },
  ])
  expect(isBounce('In QA', 'In Progress')).toBe(true)
  expect(isBounce('Done', 'Reopened')).toBe(true)
  expect(isBounce('To Do', 'In Progress')).toBe(false)
  expect(isBounce('In Progress', 'In Review')).toBe(false)
  const v = buildView(CFG, [SNAP], ['2026-11-10'], ALL, '2026-11-10', T0 + 18 * H)
  expect(reminderText(v.attention.gaps[0]!, v.days)).toBe(
    'Hi Ben, a quick reminder: I see 2h logged in Jira for Tue Nov 10, out of 8h. Could you log your time when you get a moment? Thanks!',
  )
})
