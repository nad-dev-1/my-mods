// Pure logic of the Jira Session Tracker: time and day math, the overlap split,
// building work units from sessions, ranking tickets and stories, time
// proposals, ticket-text rules and report text. No `$` here, so it is tested
// directly.

import type { Chunk, Commit, DayInfo, ProjectCfg, Settings, Story, Ticket, TimeOpt, Unit, Week } from '../types'

export const MIN = 60_000
export const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Time and days. `off` is the local UTC offset in minutes (+60 for +0100).
// ---------------------------------------------------------------------------

export function dayOf(ms: number, off: number): string {
  return new Date(ms + off * MIN).toISOString().slice(0, 10)
}

export function dayStart(day: string, off: number): number {
  return Date.parse(`${day}T00:00:00.000Z`) - off * MIN
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10)
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay()
}

/** The Monday of the day's week. */
export function weekOf(day: string): string {
  const wd = weekday(day)

  return addDays(day, wd === 0 ? -6 : 1 - wd)
}

export function clock(ms: number, off: number): string {
  return new Date(ms + off * MIN).toISOString().slice(11, 16)
}

export function offsetText(off: number): string {
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)

  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`
}

/** Jira's `started`: 2026-11-09T09:00:00.000+0100 */
export function jiraStarted(ms: number, off: number): string {
  return `${new Date(ms + off * MIN).toISOString().slice(0, 23)}${offsetText(off)}`
}

/** `Mon Nov 9` */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`)
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  const mo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]

  return `${wd} ${mo} ${d.getUTCDate()}`
}

export function fmtMin(min: number): string {
  const m = Math.max(0, Math.round(min))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r}m`

  return r === 0 ? `${h}h` : `${h}h ${r}m`
}

/** `1h 30m`, `90m`, `1.5h`, `1:30` → minutes; NaN when unreadable. */
export function parseDuration(text: string): number {
  const t = text.trim().toLowerCase()
  if (t === '') return Number.NaN
  const colon = /^(\d+):(\d{1,2})$/.exec(t)
  if (colon) return Number(colon[1]) * 60 + Number(colon[2])
  const re = /(\d+(?:\.\d+)?)\s*(h|m)/g
  let total = 0
  let hit = false
  for (let m = re.exec(t); m; m = re.exec(t)) {
    hit = true
    total += m[2] === 'h' ? Number(m[1]) * 60 : Number(m[1])
  }
  if (hit) return Math.round(total)
  if (/^\d+$/.test(t)) return Number(t)

  return Number.NaN
}

/** `09:30` on `day` → ms; NaN when unreadable. */
export function parseClock(day: string, text: string, off: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return Number.NaN
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return Number.NaN

  return dayStart(day, off) + (h * 60 + mi) * MIN
}

export function round15(min: number): number {
  return Math.max(15, Math.round(min / 15) * 15)
}

export function targetFor(day: string, s: Settings): number {
  if (s.daysOff.includes(day)) return 0
  if (!s.workDays.includes(weekday(day))) return 0

  return Math.round(s.hoursPerDay * 60)
}

// ---------------------------------------------------------------------------
// Text rules for anything written to Jira (spec §2).
// ---------------------------------------------------------------------------

const AI_RX =
  /\b(ai|a\.i\.|claude|anthropic|assistants?|chat ?gpt|gpt-?\d*|llms?|copilot|gemini|openai|language models?|(?:auto|machine|ai)[- ]?generated|generated|chatbot|bot)\b/gi

/** Words that may not reach Jira. */
export function aiWords(text: string): string[] {
  return [...new Set((text.match(AI_RX) ?? []).map(w => w.toLowerCase()))]
}

export function scrubAi(text: string): string {
  return text
    .replace(AI_RX, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
}

/** A label fit to show: no pasted blocks, image refs or tags, one line. */
export function cleanLabel(text: string, width = 70): string {
  const one = text
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content>/g, ' ')
    .replace(/\[Image #\d+\]/g, ' ')
    .replace(/\[Pasted text[^\]]*\]/g, ' ')
    .replace(/<[^>]{1,60}>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return one.length <= width ? one : `${one.slice(0, width - 1)}…`
}

export function withPrefix(prefix: string, summary: string): string {
  const s = summary.trim()
  if (prefix === '' || s.startsWith(prefix)) return s

  return `${prefix}${s}`
}

export const KEY_RX = /\b([A-Z][A-Z0-9]{1,14}-\d{1,6})\b/g

export function keysIn(text: string): string[] {
  return [...new Set(text.match(KEY_RX) ?? [])]
}

export function slugify(text: string, max = 40): string {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]-?/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
}

export function branchFor(pattern: string, key: string, slug: string): string {
  return (pattern || 'feature/{KEY}-{slug}').replace('{KEY}', key).replace('{key}', key.toLowerCase()).replace('{slug}', slug)
}

/** Does the branch already follow the project's rule for this key? */
export function branchFollows(branch: string, pattern: string, key: string): boolean {
  if (!branch.includes(key)) return false
  const head = (pattern || 'feature/{KEY}-{slug}').split('{KEY}')[0] ?? ''

  return branch.startsWith(head)
}

// ---------------------------------------------------------------------------
// Projects and repos.
// ---------------------------------------------------------------------------

function globMatch(pattern: string, text: string): boolean {
  const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i')

  return rx.test(text)
}

export function projectFor(repo: string, root: string, projects: ProjectCfg[]): string {
  for (const p of projects) {
    for (const f of p.folders) {
      if (f === '') continue
      if (globMatch(f, repo) || globMatch(f, root) || (f.includes('/') && root.startsWith(f.replace(/\*.*$/, '')))) return p.key
    }
  }

  return ''
}

export function projectOfKey(key: string): string {
  return key.split('-')[0] ?? ''
}

// ---------------------------------------------------------------------------
// Sessions → per-day minutes with the overlap split (spec §4).
// ---------------------------------------------------------------------------

export type RawSession = {
  id: string
  cwd: string
  title: string
  segs: [number, number, string][]
  prompts: [number, string][]
  files: [number, string][]
  keys: string[]
  human: number
  entry: string
}

export type DayShare = { sid: string; day: string; minutes: number; startMs: number; endMs: number; branch: string }

/**
 * Splits each session's active runs at local midnight, then shares every
 * stretch of time between the sessions active in it, so no day adds up to
 * more than the time that passed.
 */
export function shareDays(sessions: RawSession[], off: number): DayShare[] {
  type Piece = { sid: string; day: string; s: number; e: number; branch: string }
  const pieces: Piece[] = []
  for (const ses of sessions) {
    for (const [s0, e0, branch] of ses.segs) {
      let s = s0
      while (s < e0) {
        const day = dayOf(s, off)
        const end = Math.min(e0, dayStart(addDays(day, 1), off))
        if (end > s) pieces.push({ sid: ses.id, day, s, e: end, branch })
        s = end
      }
    }
  }
  const byDay = new Map<string, Piece[]>()
  for (const p of pieces) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p])
  const out: DayShare[] = []
  for (const [day, list] of byDay) {
    const points = [...new Set(list.flatMap(p => [p.s, p.e]))].sort((a, b) => a - b)
    const acc = new Map<string, { ms: number; start: number; end: number; branchMs: Map<string, number> }>()
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!
      const b = points[i + 1]!
      const active = list.filter(p => p.s <= a && p.e >= b)
      if (active.length === 0) continue
      const sids = [...new Set(active.map(p => p.sid))]
      for (const sid of sids) {
        const cur = acc.get(sid) ?? { ms: 0, start: a, end: b, branchMs: new Map() }
        const share = (b - a) / sids.length
        cur.ms += share
        cur.start = Math.min(cur.start, a)
        cur.end = Math.max(cur.end, b)
        const br = active.find(p => p.sid === sid)?.branch ?? ''
        if (br) cur.branchMs.set(br, (cur.branchMs.get(br) ?? 0) + share)
        acc.set(sid, cur)
      }
    }
    for (const [sid, v] of acc) {
      const branch = [...v.branchMs].sort((x, y) => y[1] - x[1])[0]?.[0] ?? ''
      out.push({ sid, day, minutes: v.ms / MIN, startMs: v.start, endMs: v.end, branch })
    }
  }

  return out
}

export type RepoInfo = { root: string; repo: string }

export type UnitInputs = {
  sessions: RawSession[]
  off: number
  repos: Record<string, RepoInfo>
  commits: Record<string, Commit[]>
  links: Record<string, string>
  branchLinks: Record<string, string>
  splits: Record<string, Chunk[]>
  loggedUnits: Record<string, number>
  ignored: string[]
  labels: Record<string, string>
  settings: Settings
}

export function buildUnits(x: UnitInputs): Unit[] {
  const bySid = new Map(x.sessions.map(s => [s.id, s]))
  const units: Unit[] = []
  for (const share of shareDays(x.sessions, x.off)) {
    if (share.minutes < 1) continue
    const ses = bySid.get(share.sid)
    if (!ses) continue
    const info = x.repos[ses.cwd] ?? { root: ses.cwd, repo: ses.cwd.split('/').pop() ?? ses.cwd }
    const inDay = (ms: number) => ms >= share.startMs - 5 * MIN && ms <= share.endMs + 5 * MIN
    const commits = (x.commits[info.root] ?? []).filter(c => inDay(c.at))
    const prompts = ses.prompts.filter(p => dayOf(p[0], x.off) === share.day).map(p => p[1])
    const files = [...new Set(ses.files.filter(f => dayOf(f[0], x.off) === share.day).map(f => f[1]))]
    const baseId = `${share.sid}|${share.day}`
    const branch = share.branch || ses.segs.find(s => s[2])?.[2] || ''
    const keys = [...new Set([...keysIn(branch), ...ses.keys, ...commits.flatMap(c => keysIn(c.subject))])]
    const project = projectFor(info.repo, info.root, x.settings.projects)
    const chunks = x.splits[baseId]
    const label = x.labels[baseId] ?? cleanLabel(ses.title || prompts[0] || '', 60)
    const parts = chunks && chunks.length > 1 ? chunks : [null]
    let at = share.startMs
    parts.forEach((chunk, i) => {
      const id = chunk ? `${baseId}#${i}` : baseId
      const minutes = share.minutes * (chunk ? chunk.share : 1)
      const unitBranch = chunk?.branch || branch
      const ticket = x.links[id] ?? (chunk?.ticket || '')
      const suggested = ticket === '' ? (x.branchLinks[`${info.repo}:${unitBranch}`] ?? '') : ''
      units.push({
        id,
        sid: share.sid,
        day: share.day,
        part: i,
        parts: parts.length,
        startMs: at,
        endMs: Math.min(share.endMs, at + minutes * MIN),
        minutes,
        repo: info.repo,
        root: info.root,
        cwd: ses.cwd,
        branch: unitBranch,
        label: chunk ? cleanLabel(chunk.label, 60) : label,
        keys,
        files,
        prompts,
        commits,
        project,
        ticket,
        suggested,
        loggedMin: x.loggedUnits[id] ?? 0,
        isLogged: (x.loggedUnits[id] ?? 0) > 0,
        isIgnored: x.ignored.includes(id) || x.ignored.includes(baseId),
      })
      at += minutes * MIN
    })
  }

  return units.sort((a, b) => a.startMs - b.startMs)
}

/** Still waiting for something: neither logged nor ignored. */
export function isOpen(u: Unit): boolean {
  return !u.isLogged && !u.isIgnored
}

export type UnitGroup = { id: string; root: string; units: Unit[]; minutes: number; branches: string[] }

/**
 * Unlinked work grouped by the folder it ran in, a repo's sub-folder joining
 * the repo's top folder (`root`); biggest first.
 */
export function groupUnits(units: Unit[], week: string): UnitGroup[] {
  const map = new Map<string, UnitGroup>()
  for (const u of units) {
    const root = u.root || u.cwd
    const id = `${week}|${root}`
    const g = map.get(id) ?? { id, root, units: [], minutes: 0, branches: [] }
    g.units.push(u)
    g.minutes += u.minutes
    if (!g.branches.includes(u.branch || '-')) g.branches.push(u.branch || '-')
    map.set(id, g)
  }

  return [...map.values()].sort((a, b) => b.minutes - a.minutes)
}

/** `/Users/me/code/app` → `~/code/app` */
export function shortPath(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path
}

/** Cuts the middle out of a long path so both ends stay readable. */
export function fitMiddle(text: string, width: number): string {
  if (text.length <= width) return text
  const keep = Math.max(4, width - 1)
  const head = Math.ceil(keep * 0.4)

  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/** Weeks, newest first, each kept until closed (spec §3.1). */
export function buildWeeks(
  units: Unit[],
  jiraLogged: Record<string, number>,
  closed: string[],
  s: Settings,
  today: string,
): Week[] {
  const starts = new Set<string>([weekOf(today)])
  for (const u of units) if (isOpen(u)) starts.add(weekOf(u.day))
  const weeks: Week[] = []
  for (const start of [...starts].sort().reverse()) {
    const isCurrent = start === weekOf(today)
    if (!isCurrent && closed.includes(start)) continue
    const days: DayInfo[] = []
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, i)
      if (day > today) break
      const target = targetFor(day, s)
      const linked = units.filter(u => u.day === day && u.ticket !== '' && isOpen(u))
      const logged = jiraLogged[day] ?? 0
      const pending = units.filter(u => u.day === day && isOpen(u)).reduce((a, u) => a + u.minutes, 0)
      if (target === 0 && linked.length === 0 && logged === 0 && pending === 0) {
        days.push({ day, targetMin: 0, loggedMin: 0, toLogMin: 0, isOff: true, linked: [] })
        continue
      }
      days.push({ day, targetMin: target, loggedMin: logged, toLogMin: pending, isOff: target === 0, linked })
    }
    const unlinked = units.filter(u => weekOf(u.day) === start && u.ticket === '' && isOpen(u))
    weeks.push({
      start,
      days: days.reverse(),
      unlinked,
      loggedMin: days.reduce((a, d) => a + d.loggedMin, 0),
      toLogMin: days.reduce((a, d) => a + d.toLogMin, 0),
      isClosed: closed.includes(start),
    })
  }

  return weeks
}

// ---------------------------------------------------------------------------
// Ranking (spec §5.2, §5.4).
// ---------------------------------------------------------------------------

const STOP = new Set(
  'the a an and or of to in on for with from by at is it this that be as are was fix add update use make new into not can should check review work feature bug task story test tests src lib main app'.split(
    ' ',
  ),
)

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
}

export function unitText(u: Unit): string {
  return [u.branch, u.label, ...u.prompts, ...u.commits.map(c => c.subject), ...u.files.map(f => f.split('/').slice(-2).join(' '))].join(' ')
}

export function overlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const set = new Set(a)
  let hit = 0
  for (const w of new Set(b)) if (set.has(w)) hit += 1

  return hit / Math.sqrt(new Set(b).size)
}

export function rankStories(u: Unit, stories: Story[]): Story[] {
  const mine = words(unitText(u))

  return stories
    .map(s => ({ ...s, score: overlapScore(mine, words(s.summary)) }))
    .sort((a, b) => b.score - a.score)
}

export type Candidate = { ticket: Ticket; why: string; rank: number }

export function rankCandidates(u: Unit, tickets: Ticket[], inProgress: string[], recent: string[], stories: Story[]): Candidate[] {
  const out = new Map<string, Candidate>()
  const put = (t: Ticket | undefined, why: string, rank: number) => {
    if (!t || out.has(t.key)) return
    out.set(t.key, { ticket: t, why, rank })
  }
  const byKey = new Map(tickets.map(t => [t.key, t]))
  const found = [...u.keys, ...keysIn(u.prompts.join(' '))]
  for (const k of found) put(byKey.get(k) ?? stub(k), 'key in branch, commits or prompts', 1)
  if (u.suggested) put(byKey.get(u.suggested) ?? stub(u.suggested), 'linked to this branch before', 1)
  for (const k of inProgress) put(byKey.get(k), 'in progress', 2)
  const top = rankStories(u, stories).filter(s => s.score > 0).slice(0, 2)
  for (const s of top) for (const t of tickets.filter(t => t.parentKey === s.key)) put(t, `under ${s.key}`, 3)
  for (const k of recent) put(byKey.get(k), 'touched recently', 4)
  const mine = words(unitText(u))
  const rest = tickets.filter(t => !out.has(t.key)).map(t => ({ t, sc: overlapScore(mine, words(t.summary)) }))
  for (const r of rest.filter(r => r.sc > 0).sort((a, b) => b.sc - a.sc).slice(0, 5)) put(r.t, 'similar words', 5)

  return [...out.values()].sort((a, b) => a.rank - b.rank)
}

function stub(key: string): Ticket {
  return {
    key,
    summary: '',
    status: '',
    statusCat: '',
    type: '',
    project: projectOfKey(key),
    parentKey: '',
    parentSummary: '',
    updated: '',
    remainingSec: 0,
  }
}

// ---------------------------------------------------------------------------
// Time proposals (spec §5.6).
// ---------------------------------------------------------------------------

const KIND_FACTOR: [RegExp, number, string][] = [
  [/\b(fix|bug|crash|hotfix|debug|investigat)/i, 1.25, 'debugging'],
  [/\b(refactor|migrat|upgrade)/i, 1.15, 'refactor'],
  [/\b(test|spec)/i, 0.9, 'tests'],
  [/\b(doc|readme|comment|copy|translation)/i, 0.6, 'docs'],
]

export function timeOptions(units: Unit[], off: number): TimeOpt[] {
  const start = Math.min(...units.map(u => u.startMs))
  const sessionMin = units.reduce((a, u) => a + u.minutes, 0)
  const opts: TimeOpt[] = [{ code: 'A', startMs: start, minutes: round15(sessionMin), why: 'session time, idle excluded, overlap split' }]
  const commits = units.flatMap(u => u.commits).sort((a, b) => a.at - b.at)
  if (commits.length > 0) {
    const lead = 20
    const span = (commits[commits.length - 1]!.at - commits[0]!.at) / MIN + lead
    opts.push({ code: 'B', startMs: commits[0]!.at - lead * MIN, minutes: round15(span), why: `first to last commit (${commits.length}) + ${lead}m lead-in` })
  }
  const files = new Set([...units.flatMap(u => u.files), ...[]]).size + commits.reduce((a, c) => a + c.files, 0)
  const lines = commits.reduce((a, c) => a + c.added + c.removed, 0)
  const text = units.map(unitText).join(' ')
  const kind = KIND_FACTOR.find(k => k[0].test(text))
  const factor = kind ? kind[1] : 1
  const size = (15 + files * 6 + Math.sqrt(lines) * 4) * factor
  const blended = sessionMin > 0 ? 0.5 * sessionMin + 0.5 * Math.min(size, sessionMin * 1.5) : size
  opts.push({
    code: 'C',
    startMs: start,
    minutes: round15(blended),
    why: `${files} files, ${lines} lines${kind ? `, ${kind[2]}` : ''}`,
  })
  void off

  return opts
}

// ---------------------------------------------------------------------------
// Reports (spec §7).
// ---------------------------------------------------------------------------

export function timesheetRows(units: Unit[], from: string, to: string): { day: string; key: string; minutes: number }[] {
  const acc = new Map<string, number>()
  for (const u of units) {
    if (u.day < from || u.day > to) continue
    const k = `${u.day}|${u.ticket || '(no ticket)'}`
    acc.set(k, (acc.get(k) ?? 0) + u.minutes)
  }

  return [...acc]
    .map(([k, minutes]) => ({ day: k.split('|')[0]!, key: k.split('|')[1]!, minutes }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.key.localeCompare(b.key))
}

export function timesheetCsv(rows: { day: string; key: string; minutes: number }[]): string {
  return ['date,ticket,hours', ...rows.map(r => `${r.day},${r.key},${(r.minutes / 60).toFixed(2)}`)].join('\n')
}

export function timesheetMd(rows: { day: string; key: string; minutes: number }[]): string {
  const total = rows.reduce((a, r) => a + r.minutes, 0)

  return [
    '| Date | Ticket | Time |',
    '| --- | --- | --- |',
    ...rows.map(r => `| ${dayLabel(r.day)} | ${r.key} | ${fmtMin(r.minutes)} |`),
    `| **Total** | | **${fmtMin(total)}** |`,
  ].join('\n')
}

export function standupText(yesterday: Unit[], today: Unit[], blockers: string[]): string {
  const line = (u: Unit) => `- ${u.ticket ? `${u.ticket} ` : ''}${u.label} (${fmtMin(u.minutes)})`
  const merge = (list: Unit[]) => {
    const seen = new Map<string, Unit>()
    for (const u of list) {
      const k = u.ticket || u.label
      const cur = seen.get(k)
      seen.set(k, cur ? { ...cur, minutes: cur.minutes + u.minutes } : u)
    }

    return [...seen.values()]
  }

  return [
    'Yesterday',
    ...(yesterday.length ? merge(yesterday).map(line) : ['- (nothing recorded)']),
    '',
    'Today',
    ...(today.length ? merge(today).map(line) : ['- (nothing yet)']),
    '',
    'Blockers',
    ...(blockers.length ? blockers.map(b => `- ${b}`) : ['- none']),
  ].join('\n')
}
