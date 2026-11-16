// Pure logic of the Jira Team Dashboard: days, filters, and every report the
// pane draws, built from daily snapshots. No `$` here, so it is tested
// directly.

import type { Filters, Hygiene, Issue, Member, Move, Snapshot, StoryInfo, TeamCfg, WL } from '../types'

export const MIN = 60_000
export const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Days (`off` is the local UTC offset in minutes)
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

export function weekday(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay()
}

export function weekOf(day: string): string {
  const wd = weekday(day)

  return addDays(day, wd === 0 ? -6 : 1 - wd)
}

export function clock(ms: number, off: number): string {
  return new Date(ms + off * MIN).toISOString().slice(11, 16)
}

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

export function rangeDays(end: string, range: number): string[] {
  return Array.from({ length: Math.max(1, range) }, (_, i) => addDays(end, -(range - 1 - i)))
}

export function isWorkDay(day: string, cfg: TeamCfg): boolean {
  return cfg.workDays.includes(weekday(day))
}

export function isOnLeave(email: string, day: string, cfg: TeamCfg): boolean {
  return (cfg.leave[email.toLowerCase()] ?? []).includes(day)
}

/** Minutes a member is expected to log on a day: 0 off-days, leave and future. */
export function expectedMin(email: string, day: string, cfg: TeamCfg, today: string): number {
  if (day > today || !isWorkDay(day, cfg) || isOnLeave(email, day, cfg)) return 0

  return Math.round(cfg.hoursPerDay * 60)
}

// ---------------------------------------------------------------------------
// Members and filters
// ---------------------------------------------------------------------------

/** `Name, Email, Team` lines (a header line is skipped) → members; one per email. */
export function parseRoster(text: string): Member[] {
  const byEmail = new Map<string, Member>()
  for (const raw of text.split('\n')) {
    const parts = raw.split(',').map(p => p.trim())
    if (parts.length < 2 || !/@/.test(parts[1] ?? '')) continue
    const email = parts[1]!.toLowerCase()
    const teams = parts.slice(2).filter(Boolean).map(teamName)
    const cur = byEmail.get(email)
    if (cur) cur.teams = [...new Set([...cur.teams, ...teams])]
    else byEmail.set(email, { name: parts[0]!, email, accountId: '', teams })
  }

  return [...byEmail.values()]
}

/** `iOS Team` → `iOS` */
export function teamName(text: string): string {
  return text.replace(/\s+team$/i, '').trim()
}

export function membersIn(cfg: TeamCfg, f: Filters): Member[] {
  return cfg.members.filter(m => (f.team ? m.teams.includes(f.team) : true) && (f.dev ? m.email === f.dev : true))
}

export function firstName(m: Member): string {
  return m.name.split(/\s+/)[0] || m.name
}

export function isFlutterWork(x: { project: string; summary: string; labels?: string[] }, cfg: TeamCfg): boolean {
  const hay = `${x.project} ${x.summary} ${(x.labels ?? []).join(' ')}`.toLowerCase()

  return cfg.flutterMatch.some(w => w.trim() !== '' && (x.project.toLowerCase() === w.trim().toLowerCase() || hay.includes(w.trim().toLowerCase())))
}

const BACK_FROM = /qa|test|review|verif|done|resolved|closed|ready|accept|uat/i
const BACK_TO = /progress|reopen|to ?do|open|backlog|dev|fix|rework/i

/** A move back from QA / review / done to work. */
export function isBounce(from: string, to: string): boolean {
  return BACK_FROM.test(from) && BACK_TO.test(to) && !BACK_FROM.test(to)
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export type DevTicket = { key: string; summary: string; min: number; moves: string[] }
export type DevRow = {
  member: Member
  loggedMin: number
  expectedMin: number
  tickets: DevTicket[]
  moves: number
  leaveDays: number
  daysWithNothing: string[]
}
export type StoryRow = { key: string; summary: string; min: number; progress: StoryInfo | null }
export type ProjectRow = { project: string; min: number; stories: StoryRow[] }
export type Gap = { member: Member; loggedMin: number; expectedMin: number; kind: 'none' | 'under'; days: string[] }
export type Stuck = { issue: Issue; reason: string }
export type Bounce = { member: Member; count: number; keys: string[] }
export type View = {
  days: string[]
  members: Member[]
  cards: { hours: number; moved: number; created: number; under: number }
  live: { member: Member; issues: Issue[] }[]
  devs: DevRow[]
  projects: ProjectRow[]
  flutter: { member: Member; nativeMin: number; flutterMin: number }[]
  attention: {
    gaps: Gap[]
    stuck: Stuck[]
    noTime: Move[]
    estimate: Issue[]
    hygiene: Hygiene[]
    bounces: Bounce[]
  }
  timeline: { at: number; email: string; text: string }[]
  trends: { day: string; perMember: Record<string, number>; total: number }[]
  workload: { member: Member; open: number; estimateMin: number }[]
  missingDays: string[]
  errors: string[]
}

/**
 * Builds every section from the snapshots of `days`, for the members and
 * project the filters keep. Each person's hours count once, whatever teams
 * they are in; a day of leave expects nothing.
 */
export function buildView(cfg: TeamCfg, snaps: Snapshot[], days: string[], f: Filters, today: string, now: number): View {
  const members = membersIn(cfg, f)
  const emails = new Set(members.map(m => m.email))
  const byEmail = new Map(cfg.members.map(m => [m.email, m]))
  const inProject = (p: string) => (f.project ? p === f.project : true)
  const have = new Map(snaps.map(s => [s.day, s]))
  const inRange = days.map(d => have.get(d)).filter((s): s is Snapshot => s !== undefined)
  const latest = [...inRange].sort((a, b) => b.takenAt - a.takenAt)[0]
  // Only days with a snapshot expect hours: a day not pulled yet is unknown, not a gap.
  const known = days.filter(d => have.has(d))

  const wls = inRange.flatMap(s => s.worklogs).filter(w => emails.has(w.email) && inProject(w.project))
  const moves = inRange.flatMap(s => s.moves).filter(m => emails.has(m.email) && inProject(m.project))
  const created = dedupe(inRange.flatMap(s => s.created).filter(i => inProject(i.project) && (emails.has(i.reporter) || emails.has(i.assignee))))
  const sumMin = (list: WL[]) => list.reduce((a, w) => a + w.seconds / 60, 0)

  const devs: DevRow[] = members.map(m => {
    const mine = wls.filter(w => w.email === m.email)
    const myMoves = moves.filter(x => x.email === m.email)
    const keys = [...new Set([...mine.map(w => w.key), ...myMoves.map(x => x.key)])]
    const tickets = keys
      .map(key => {
        const any = mine.find(w => w.key === key) ?? myMoves.find(x => x.key === key)!
        return {
          key,
          summary: any.summary,
          min: sumMin(mine.filter(w => w.key === key)),
          moves: myMoves.filter(x => x.key === key).map(x => `${x.from} → ${x.to}`),
        }
      })
      .sort((a, b) => b.min - a.min)
    const exp = known.reduce((a, d) => a + expectedMin(m.email, d, cfg, today), 0)
    const daysWithNothing = known.filter(d => expectedMin(m.email, d, cfg, today) > 0 && !mine.some(w => w.started && dayOfLocal(w, inRange) === d))

    return {
      member: m,
      loggedMin: sumMin(mine),
      expectedMin: exp,
      tickets,
      moves: myMoves.length,
      leaveDays: known.filter(d => isOnLeave(m.email, d, cfg) && isWorkDay(d, cfg)).length,
      daysWithNothing,
    }
  })

  const gaps: Gap[] = devs
    .filter(d => d.expectedMin > 0 && d.loggedMin < d.expectedMin * 0.75)
    .map(d => ({ member: d.member, loggedMin: d.loggedMin, expectedMin: d.expectedMin, kind: d.loggedMin === 0 ? 'none' : 'under', days: d.daysWithNothing }))

  // Projects → stories, with progress from the latest snapshot of the range.
  const projects = new Map<string, ProjectRow>()
  for (const w of wls) {
    const p = projects.get(w.project) ?? { project: w.project, min: 0, stories: [] }
    p.min += w.seconds / 60
    const sk = w.story || '(no story)'
    let st = p.stories.find(s => s.key === sk)
    if (!st) {
      st = { key: sk, summary: w.story ? w.storySummary : 'Work with no parent story', min: 0, progress: latest?.stories.find(s => s.key === w.story) ?? null }
      p.stories.push(st)
    }
    st.min += w.seconds / 60
    projects.set(w.project, p)
  }
  const projectRows = [...projects.values()].sort((a, b) => b.min - a.min).map(p => ({ ...p, stories: p.stories.sort((a, b) => b.min - a.min) }))

  const flutterTeam = cfg.flutterTeam
  const flutter = members
    .filter(m => m.teams.includes(flutterTeam) && m.teams.some(t => t !== flutterTeam))
    .map(m => {
      const mine = wls.filter(w => w.email === m.email)

      return { member: m, flutterMin: sumMin(mine.filter(w => w.isFlutter)), nativeMin: sumMin(mine.filter(w => !w.isFlutter)) }
    })

  const open = (latest?.open ?? []).filter(i => emails.has(i.assignee) && inProject(i.project))
  const inProgress = (latest?.inProgress ?? []).filter(i => emails.has(i.assignee) && inProject(i.project))
  const stuck: Stuck[] = []
  for (const i of inProgress) {
    const days = i.statusSince ? Math.floor((now - i.statusSince) / DAY_MS) : 0
    if (days >= cfg.stuckDays) stuck.push({ issue: i, reason: `in "${i.status}" for ${days} days` })
    else if (i.spentSec === 0) stuck.push({ issue: i, reason: 'in progress with no time logged' })
  }
  const noTime = dedupeMoves(moves.filter(x => !wls.some(w => w.key === x.key && w.email === x.email)))
  const estimate = open.filter(i => i.estimateSec > 0 && (i.spentSec > i.estimateSec * 1.5 || (i.statusCat === 'done' && i.spentSec < i.estimateSec * 0.5)))
  const hygiene = (latest?.hygiene ?? []).filter(h => inProject(h.project) && (h.assignee === '' || emails.has(h.assignee) || f.team === '' && f.dev === ''))
  const bounces: Bounce[] = members
    .map(m => {
      const b = moves.filter(x => x.email === m.email && x.isBounce)

      return { member: m, count: b.length, keys: [...new Set(b.map(x => x.key))] }
    })
    .filter(b => b.count > 0)

  const timeline = [
    ...wls.map(w => ({ at: w.started, email: w.email, text: `logged ${fmtMin(w.seconds / 60)} on ${w.key}` })),
    ...moves.map(x => ({ at: x.at, email: x.email, text: `moved ${x.key} ${x.from} → ${x.to}` })),
  ].sort((a, b) => a.at - b.at)

  const trends = days.map(d => {
    const s = have.get(d)
    const perMember: Record<string, number> = {}
    for (const w of (s?.worklogs ?? []).filter(w => emails.has(w.email) && inProject(w.project))) perMember[w.email] = (perMember[w.email] ?? 0) + w.seconds / 60

    return { day: d, perMember, total: Object.values(perMember).reduce((a, v) => a + v, 0) }
  })
  const workload = members.map(m => {
    const mine = open.filter(i => i.assignee === m.email)

    return { member: m, open: mine.length, estimateMin: mine.reduce((a, i) => a + (i.remainingSec || i.estimateSec) / 60, 0) }
  })

  return {
    days,
    members,
    cards: {
      hours: sumMin(wls) / 60,
      moved: new Set(moves.map(x => x.key)).size,
      created: created.length,
      under: gaps.length,
    },
    live: members.map(m => ({ member: m, issues: inProgress.filter(i => i.assignee === m.email) })),
    devs,
    projects: projectRows,
    flutter,
    attention: { gaps, stuck, noTime, estimate, hygiene, bounces },
    timeline,
    trends,
    workload,
    missingDays: days.filter(d => d <= today && !have.has(d)),
    errors: inRange.flatMap(s => s.errors),
  }

  function dayOfLocal(w: WL, list: Snapshot[]): string {
    return list.find(s => s.worklogs.includes(w))?.day ?? ''
  }
  void byEmail
}

function dedupe(list: Issue[]): Issue[] {
  const seen = new Map<string, Issue>()
  for (const i of list) seen.set(i.key, i)

  return [...seen.values()]
}

function dedupeMoves(list: Move[]): Move[] {
  const seen = new Map<string, Move>()
  for (const m of list) seen.set(`${m.email}|${m.key}`, m)

  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// Words: reminders, exports, the weekly digest (spec §5)
// ---------------------------------------------------------------------------

export function reminderText(g: Gap, days: string[]): string {
  const when = g.days.length === 1 ? dayLabel(g.days[0]!) : g.days.length > 1 ? `${dayLabel(g.days[0]!)} to ${dayLabel(g.days[g.days.length - 1]!)}` : days.length === 1 ? dayLabel(days[0]!) : 'the last few days'
  const what = g.kind === 'none' ? `I don't see any time logged in Jira for ${when}` : `I see ${fmtMin(g.loggedMin)} logged in Jira for ${when}, out of ${fmtMin(g.expectedMin)}`

  return `Hi ${firstName(g.member)}, a quick reminder: ${what}. Could you log your time when you get a moment? Thanks!`
}

function csvCell(v: string | number): string {
  const s = String(v)

  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The view as CSV: one row per developer and ticket. */
export function viewCsv(v: View): string {
  const rows: (string | number)[][] = [['from', 'to', 'developer', 'email', 'teams', 'ticket', 'summary', 'hours', 'status moves', 'logged hours (total)', 'expected hours (total)']]
  const from = v.days[0] ?? ''
  const to = v.days[v.days.length - 1] ?? ''
  for (const d of v.devs) {
    const base = [from, to, d.member.name, d.member.email, d.member.teams.join(' / ')]
    if (d.tickets.length === 0) rows.push([...base, '', '', 0, '', (d.loggedMin / 60).toFixed(2), (d.expectedMin / 60).toFixed(2)])
    for (const t of d.tickets) rows.push([...base, t.key, t.summary, (t.min / 60).toFixed(2), t.moves.join('; '), (d.loggedMin / 60).toFixed(2), (d.expectedMin / 60).toFixed(2)])
  }

  return rows.map(r => r.map(csvCell).join(',')).join('\n')
}

function rangeTitle(days: string[]): string {
  return days.length === 1 ? dayLabel(days[0]!) : `${dayLabel(days[0]!)} – ${dayLabel(days[days.length - 1]!)}`
}

/** The view as Markdown: the same numbers the pane shows. */
export function viewMd(v: View, filterText: string): string {
  const out: string[] = [`# Team report · ${rangeTitle(v.days)}`, '', filterText ? `Filters: ${filterText}` : 'All teams', '']
  out.push(`- **Hours logged:** ${v.cards.hours.toFixed(1)}h`, `- **Tickets moved:** ${v.cards.moved}`, `- **Tickets created:** ${v.cards.created}`, `- **Under expected hours:** ${v.cards.under}`, '')
  out.push('## Per developer', '', '| Developer | Logged / expected | Tickets | Moves |', '| --- | --- | --- | --- |')
  for (const d of v.devs) out.push(`| ${d.member.name} | ${fmtMin(d.loggedMin)} / ${fmtMin(d.expectedMin)} | ${d.tickets.length} | ${d.moves} |`)
  out.push('', '## Per project and story', '')
  for (const p of v.projects) {
    out.push(`### ${p.project} · ${fmtMin(p.min)}`, '')
    for (const s of p.stories) out.push(`- ${s.key === '(no story)' ? 'No story' : `${s.key} ${s.summary}`}: ${fmtMin(s.min)}${s.progress ? ` · ${progressText(s.progress)}` : ''}`)
    out.push('')
  }
  out.push('## Attention', '')
  for (const line of attentionLines(v)) out.push(`- ${line}`)

  return out.join('\n')
}

export function progressText(s: StoryInfo): string {
  const parts = Object.entries(s.byStatus).map(([k, n]) => `${n} ${k}`)
  const est = s.estimateSec > 0 ? ` · ${fmtMin(s.spentSec / 60)} of ${fmtMin(s.estimateSec / 60)} estimated` : ''

  return `${parts.join(', ') || 'no tasks'}${est}`
}

export function attentionLines(v: View): string[] {
  const a = v.attention
  const lines: string[] = []
  for (const g of a.gaps) lines.push(`Logging gap: ${g.member.name}, ${g.kind === 'none' ? 'nothing logged' : `${fmtMin(g.loggedMin)} of ${fmtMin(g.expectedMin)}`}`)
  for (const s of a.stuck) lines.push(`Stuck: ${s.issue.key} ${s.issue.summary} (${s.reason})`)
  for (const m of a.noTime) lines.push(`Moved with no time: ${m.key} by ${m.email}`)
  for (const i of a.estimate) lines.push(`Estimate vs actual: ${i.key} ${fmtMin(i.spentSec / 60)} spent of ${fmtMin(i.estimateSec / 60)}`)
  for (const h of a.hygiene) lines.push(`Sprint hygiene: ${h.key} (${h.reasons.join(', ')})`)
  for (const b of a.bounces) lines.push(`Bounce-backs: ${b.member.name} ${b.count} (${b.keys.join(', ')})`)

  return lines.length ? lines : ['Nothing needs attention.']
}

/** One page for management: the week's hours per team and person, stories, attention. */
export function digestMd(cfg: TeamCfg, v: View): string {
  const out: string[] = [`# Weekly digest · ${rangeTitle(v.days)}`, '']
  out.push('## Hours per team', '', '| Team | Hours |', '| --- | --- |')
  for (const t of cfg.teams) {
    const mins = v.devs.filter(d => d.member.teams.includes(t)).reduce((a, d) => a + d.loggedMin, 0)
    out.push(`| ${t} | ${fmtMin(mins)} |`)
  }
  out.push(`| **All (each person once)** | **${fmtMin(v.devs.reduce((a, d) => a + d.loggedMin, 0))}** |`, '')
  out.push('## Hours per person', '', '| Person | Logged / expected |', '| --- | --- |')
  for (const d of v.devs) out.push(`| ${d.member.name} | ${fmtMin(d.loggedMin)} / ${fmtMin(d.expectedMin)} |`)
  out.push('', '## Story progress', '')
  const stories = v.projects.flatMap(p => p.stories.filter(s => s.progress).map(s => ({ p: p.project, s })))
  if (stories.length === 0) out.push('- No story activity.')
  for (const { s } of stories) out.push(`- ${s.key} ${s.summary}: ${progressText(s.progress!)} · ${fmtMin(s.min)} this week`)
  out.push('', '## Key attention items', '')
  for (const line of attentionLines(v).slice(0, 12)) out.push(`- ${line}`)

  return out.join('\n')
}
