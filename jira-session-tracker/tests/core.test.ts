import { expect, test } from 'claude-code/testing'

import type { Settings, Unit } from '../types'
import {
  MIN,
  aiWords,
  buildUnits,
  buildWeeks,
  dayStart,
  fitMiddle,
  groupUnits,
  shortPath,
  jiraStarted,
  parseDuration,
  scrubAi,
  shareDays,
  timeOptions,
  weekOf,
} from '../hooks/core'
import type { RawSession } from '../hooks/core'

const OFF = 60 // +0100
const S: Settings = {
  cloudId: '',
  site: '',
  accountId: '',
  projects: [{ key: 'PROJ', folders: ['my-ios-app'], prefix: '[iOS]-', branchPattern: 'feature/{KEY}-{slug}', issueType: 'Task', template: '', usesEstimates: false, lastStatus: '' }],
  hoursPerDay: 8,
  workDays: [1, 2, 3, 4, 5],
  endOfDay: '18:00',
  idleMin: 15,
  refreshMin: 5,
  daysOff: [],
  unlinkedAlertMin: 120,
  includeHeadless: false,
  setupDone: true,
}

const at = (day: string, hhmm: string) => dayStart(day, OFF) + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3))) * MIN

function ses(id: string, segs: [string, string, string][], cwd = '/code/my-ios-app'): RawSession {
  return {
    id,
    cwd,
    title: `work ${id}`,
    segs: segs.map(([d, a, b]) => [at(d, a), at(d, b), 'feature/deeplink']),
    prompts: [],
    files: [],
    keys: [],
    human: 1,
    entry: 'cli',
  }
}

test('parallel sessions share the overlap, so a day never exceeds real time', () => {
  // A 09:00-11:00 and B 10:00-12:00 overlap for an hour: 3h passed in all.
  const out = shareDays([ses('a', [['2026-11-09', '09:00', '11:00']]), ses('b', [['2026-11-09', '10:00', '12:00']])], OFF)
  const a = out.find(x => x.sid === 'a')!
  const b = out.find(x => x.sid === 'b')!
  expect(Math.round(a.minutes)).toBe(90)
  expect(Math.round(b.minutes)).toBe(90)
  expect(Math.round(a.minutes + b.minutes)).toBe(180)
})

test('a session across midnight is attributed to each day by its activity', () => {
  const s: RawSession = { ...ses('n', []), segs: [[at('2026-11-09', '23:00'), at('2026-11-10', '01:00'), '']] }
  const out = shareDays([s], OFF)
  expect(out.map(x => [x.day, Math.round(x.minutes)])).toEqual([
    ['2026-11-09', 60],
    ['2026-11-10', 60],
  ])
})

test('units carry links and logged state; logged units are never offered again', () => {
  const base = {
    sessions: [ses('a', [['2026-11-09', '09:00', '10:00']]), ses('b', [['2026-11-10', '09:00', '10:30']])],
    off: OFF,
    repos: { '/code/my-ios-app': { root: '/code/my-ios-app', repo: 'my-ios-app' } },
    commits: {},
    links: { 'a|2026-11-09': 'PROJ-1064' },
    branchLinks: { 'my-ios-app:feature/deeplink': 'PROJ-1064' },
    splits: {},
    loggedUnits: { 'a|2026-11-09': 60 },
    ignored: [],
    labels: {},
    settings: S,
  }
  const units = buildUnits(base)
  expect(units.map(u => [u.id, u.ticket, u.isLogged, u.suggested, u.project])).toEqual([
    ['a|2026-11-09', 'PROJ-1064', true, '', 'PROJ'],
    ['b|2026-11-10', '', false, 'PROJ-1064', 'PROJ'],
  ])
  const weeks = buildWeeks(units, {}, [], S, '2026-11-11')
  expect(weeks).toHaveLength(1)
  expect(weeks[0]!.unlinked.map(u => u.id)).toEqual(['b|2026-11-10'])
  expect(weeks[0]!.days.flatMap(d => d.linked)).toHaveLength(0)
})

test('a split shares the time between its parts', () => {
  const units = buildUnits({
    sessions: [ses('a', [['2026-11-09', '09:00', '11:00']])],
    off: OFF,
    repos: {},
    commits: {},
    links: {},
    branchLinks: {},
    splits: { 'a|2026-11-09': [
      { label: 'Deeplink review', share: 0.75, ticket: 'PROJ-1', branch: '' },
      { label: 'Speedtest permissions', share: 0.25, ticket: '', branch: 'feature/speed' },
    ] },
    loggedUnits: {},
    ignored: [],
    labels: {},
    settings: S,
  })
  expect(units.map(u => [u.id, Math.round(u.minutes), u.ticket, u.branch])).toEqual([
    ['a|2026-11-09#0', 90, 'PROJ-1', 'feature/deeplink'],
    ['a|2026-11-09#1', 30, '', 'feature/speed'],
  ])
})

test('unclosed past weeks stay listed until closed', () => {
  const old = { id: 'x', day: '2026-10-28', ticket: '', isLogged: false, isIgnored: false, minutes: 60 } as Unit
  const open = buildWeeks([old], {}, [], S, '2026-11-11')
  expect(open.map(w => w.start)).toEqual([weekOf('2026-11-11'), weekOf('2026-10-28')])
  const closed = buildWeeks([old], {}, [weekOf('2026-10-28')], S, '2026-11-11')
  expect(closed.map(w => w.start)).toEqual([weekOf('2026-11-11')])
})

test('time proposals always offer A, B (with commits) and C, each with a start and duration', () => {
  const u = {
    startMs: at('2026-11-09', '09:00'),
    minutes: 100,
    files: ['a.swift', 'b.swift'],
    commits: [
      { sha: '1', at: at('2026-11-09', '09:30'), subject: 'fix deeplink crash', added: 40, removed: 10, files: 2, branch: '' },
      { sha: '2', at: at('2026-11-09', '10:30'), subject: 'tests', added: 20, removed: 0, files: 1, branch: '' },
    ],
    branch: 'feature/deeplink',
    label: 'Deeplink handling review',
    prompts: [],
  } as unknown as Unit
  const opts = timeOptions([u], OFF)
  expect(opts.map(o => o.code)).toEqual(['A', 'B', 'C'])
  for (const o of opts) {
    expect(o.minutes % 15).toBe(0)
    expect(o.minutes > 0).toBe(true)
  }
  expect(opts[1]!.startMs).toBe(at('2026-11-09', '09:10'))
})

test('ticket text never mentions AI', () => {
  expect(aiWords('[iOS]-review deeplink handling')).toEqual([])
  expect(aiWords('Generated by Claude assistant').sort()).toEqual(['assistant', 'claude', 'generated'])
  expect(aiWords(scrubAi('AI generated fix for deeplinks (Claude)'))).toEqual([])
})

test('durations and Jira start times', () => {
  expect(parseDuration('1h 30m')).toBe(90)
  expect(parseDuration('1.5h')).toBe(90)
  expect(parseDuration('45')).toBe(45)
  expect(parseDuration('1:15')).toBe(75)
  expect(Number.isNaN(parseDuration('soon'))).toBe(true)
  expect(jiraStarted(at('2026-11-09', '09:00'), OFF)).toBe('2026-11-09T09:00:00.000+0100')
})

test('ignored work leaves the lists and counts, and is grouped out of No ticket yet', () => {
  const units = buildUnits({
    sessions: [ses('a', [['2026-11-09', '09:00', '10:00']]), ses('b', [['2026-11-09', '11:00', '12:00']]), ses('c', [['2026-11-10', '09:00', '09:30']], '/code/other')],
    off: OFF,
    repos: {},
    commits: {},
    links: {},
    branchLinks: {},
    splits: {},
    loggedUnits: {},
    ignored: ['b|2026-11-09'],
    labels: {},
    settings: S,
  })
  expect(units.find(u => u.sid === 'b')!.isIgnored).toBe(true)
  const week = buildWeeks(units, {}, [], S, '2026-11-11')[0]!
  expect(week.unlinked.map(u => u.sid)).toEqual(['a', 'c'])
  expect(Math.round(week.toLogMin)).toBe(90)
  const groups = groupUnits(week.unlinked, week.start)
  expect(groups.map(g => [g.root, g.units.length])).toEqual([
    ['/code/my-ios-app', 1],
    ['/code/other', 1],
  ])
})

test('folder groups: a repo sub-folder joins its top folder, branches stay on the rows', () => {
  const u = (id: string, cwd: string, root: string, branch: string, minutes: number) => ({ id, cwd, root, branch, minutes }) as Unit
  const groups = groupUnits(
    [
      u('1', '/Users/me/repo/app', '/Users/me/repo/app', 'main', 30),
      u('2', '/Users/me/repo/app/docs', '/Users/me/repo/app', 'docs', 60),
      u('3', '/tmp/scratch', '/tmp/scratch', '', 10),
    ],
    '2026-11-09',
  )
  expect(groups.map(g => [g.id, g.units.length, g.minutes, g.branches])).toEqual([
    ['2026-11-09|/Users/me/repo/app', 2, 90, ['main', 'docs']],
    ['2026-11-09|/tmp/scratch', 1, 10, ['-']],
  ])
  expect(shortPath('/Users/me/repo/app', '/Users/me')).toBe('~/repo/app')
  expect(shortPath('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x')
  const cut = fitMiddle('~/Documents/Projects/repo/Android/my-android-app', 30)
  expect(cut).toBe('~/Documents/…id/my-android-app')
  expect(cut.length).toBe(30)
})
