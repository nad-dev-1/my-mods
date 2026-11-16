import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DashUi, Filters, Hygiene, Issue, Member, Move, Section, Snapshot, StoryInfo, TeamCfg, WL } from '../types'
import {
  DAY_MS,
  addDays,
  attentionLines,
  buildView,
  clock,
  dayLabel,
  dayOf,
  dayStart,
  digestMd,
  firstName,
  fmtMin,
  isBounce,
  isFlutterWork,
  isWorkDay,
  parseRoster,
  progressText,
  rangeDays,
  reminderText,
  teamName,
  viewCsv,
  viewMd,
  weekOf,
} from './core'
import type { View } from './core'
import { FIELDS, findUser as jiraFindUser, search as jiraSearch, site as jiraSite, statusMoves as jiraStatusMoves, worklogs as jiraWorklogs } from './jira'
import type { RawIssue } from './jira'
import { statusGrid } from './status-grid'

// Jira Team Dashboard: a pane for the team lead with what the team moved and
// logged in Jira each day. Read-only: it never writes to Jira.

type E$ = EngineInterface

const PANE = 'jira-team'
const C = { accent: '#4C9AFF', green: '#57D9A3', amber: '#FFAB00', red: '#FF5630', muted: '#8993A4', violet: '#998DD9' }

const DEFAULT_CFG: TeamCfg = {
  cloudId: '',
  site: '',
  members: [],
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

const EMPTY_UI: DashUi = {
  day: '',
  range: 1,
  filters: { team: '', dev: '', project: '' },
  folded: [],
  expanded: [],
  view: 'main',
  textTitle: '',
  text: '',
  textFile: '',
  setupDraft: '',
  newMember: '',
  leaveFor: '',
  leaveDay: '',
}

const ui = atom({ plugin: 'jira-team-dashboard', key: 'ui' } as const, EMPTY_UI, { shape: 'dash-ui-1' })
const busy = atom({ plugin: 'jira-team-dashboard', key: 'busy' } as const, '')
const note = atom({ plugin: 'jira-team-dashboard', key: 'note' } as const, '')
const snapVersion = atom({ plugin: 'jira-team-dashboard', key: 'snapVersion' } as const, 0)

let home = ''
let off = 0
let nowMs = 0
let paneOpen = false
let pulling: Promise<void> | null = null
let cfgCache: TeamCfg | null = null
const snapCache = new Map<string, Snapshot | null>()

const dir = () => `${home}/.claude/jira-team-dashboard`
const now = () => nowMs || Date.now()
const today = () => dayOf(now(), off)

// ---------------------------------------------------------------------------
// Local files: the team config and the daily snapshots (never shared)
// ---------------------------------------------------------------------------

async function initEnv($: E$): Promise<void> {
  home = (await $.env.get('HOME')) ?? home
  nowMs = await $.clock.now().catch(() => Date.now())
  try {
    const r = await $.process.run(['date', '+%z'], { timeoutMs: 3_000 })
    const m = /([+-])(\d\d)(\d\d)/.exec(r.stdout)
    if (m) off = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  } catch {
    off = 0
  }
}

/** The settings file's change time when last read: a change made elsewhere is read again. */
let cfgStamp = -1

async function loadCfg($: E$): Promise<TeamCfg> {
  const stamp = await $.fs
    .stat(`${dir()}/team.json`)
    .then(s => s.mtimeMs)
    .catch(() => 0)
  if (cfgCache && stamp === cfgStamp) return cfgCache
  cfgStamp = stamp
  try {
    const raw = JSON.parse(String(await $.fs.read(`${dir()}/team.json`))) as Partial<TeamCfg>
    cfgCache = { ...DEFAULT_CFG, ...raw, leave: raw.leave ?? {}, members: (raw.members ?? []).map(m => ({ ...m, email: m.email.toLowerCase(), teams: m.teams ?? [] })) }
  } catch {
    cfgCache = { ...DEFAULT_CFG }
  }

  return cfgCache
}

async function saveCfg($: E$, cfg: TeamCfg): Promise<void> {
  cfgCache = cfg
  await $.fs.write(`${dir()}/team.json`, `${JSON.stringify(cfg, null, 2)}\n`)
  cfgStamp = await $.fs
    .stat(`${dir()}/team.json`)
    .then(s => s.mtimeMs)
    .catch(() => -1)
  await update($, snapVersion, v => v + 1)
}

async function loadSnap($: E$, day: string): Promise<Snapshot | null> {
  if (snapCache.has(day)) return snapCache.get(day) ?? null
  try {
    const s = JSON.parse(String(await $.fs.read(`${dir()}/snapshots/${day}.json`))) as Snapshot
    snapCache.set(day, s)

    return s
  } catch {
    snapCache.set(day, null)

    return null
  }
}

async function saveSnap($: E$, s: Snapshot): Promise<void> {
  await $.fs.write(`${dir()}/snapshots/${s.day}.json`, JSON.stringify(s))
  snapCache.set(s.day, s)
  await update($, snapVersion, v => v + 1)
}

async function say($: E$, text: string): Promise<void> {
  await update($, note, () => text)
}

// ---------------------------------------------------------------------------
// Pulling a day from Jira (spec §3)
// ---------------------------------------------------------------------------

function quoteList(list: string[]): string {
  return list.map(x => `"${x.replace(/"/g, '')}"`).join(', ')
}

async function inBatches<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))

  return out
}

/** Finds each member's Jira account once; kept in the config. */
async function resolveMembers($: E$, cfg: TeamCfg): Promise<TeamCfg> {
  let changed = false
  let c = cfg
  if (!c.cloudId) {
    const s = await jiraSite($)
    c = { ...c, cloudId: s.cloudId, site: s.url }
    changed = true
  }
  const members: Member[] = []
  for (const m of c.members) {
    if (m.accountId) {
      members.push(m)
      continue
    }
    const u = await jiraFindUser($, c.cloudId, m.email, m.name).catch(() => null)
    members.push(u ? { ...m, accountId: u.accountId } : m)
    if (u) changed = true
  }
  c = { ...c, members }
  if (changed) await saveCfg($, c)

  return c
}

function toPlain(i: RawIssue, byAccount: Map<string, string>): Issue {
  const assignee = i.assigneeUser ? byAccount.get(i.assigneeUser.accountId) ?? i.assigneeUser.email ?? i.assigneeUser.name : ''
  const reporter = i.reporterUser ? byAccount.get(i.reporterUser.accountId) ?? i.reporterUser.email ?? i.reporterUser.name : ''

  return {
    key: i.key,
    summary: i.summary,
    project: i.project,
    type: i.type,
    status: i.status,
    statusCat: i.statusCat,
    assignee,
    reporter,
    parent: i.parent,
    parentSummary: i.parentSummary,
    estimateSec: i.estimateSec,
    spentSec: i.spentSec,
    remainingSec: i.remainingSec,
    statusSince: i.statusSince,
    created: i.created,
    labels: i.labels,
  }
}

/** Jira calls that time out or hit a rate limit usually pass on a second try. */
const PASSING = /timed out|timeout|ETIMEDOUT|ECONNRESET|socket hang up|rate limit|too many requests|429|503|502/i

async function retry<T>($: E$, fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (i >= tries || !PASSING.test(msg)) throw err
      await $.clock.sleep(1500 * i)
    }
  }
}

async function collectDay($: E$, day: string, progress: (text: string) => Promise<void>): Promise<Snapshot> {
  await progress('finding the team in Jira')
  const cfg = await resolveMembers($, await loadCfg($))
  const cloud = cfg.cloudId
  const errors: string[] = []
  const step = async <T,>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200))

      return fallback
    }
  }
  const byAccount = new Map(cfg.members.filter(m => m.accountId).map(m => [m.accountId, m.email]))
  const who = quoteList(cfg.members.map(m => m.accountId || m.email))
  const pc = cfg.projects.length ? `project in (${cfg.projects.join(', ')}) AND ` : ''
  const s0 = dayStart(day, off)
  const s1 = s0 + DAY_MS
  const d2 = addDays(day, 1)
  if (cfg.members.length === 0) throw new Error('No team members yet: add them in ⚙ Setup.')
  const unresolved = cfg.members.filter(m => !m.accountId)
  if (unresolved.length) errors.push(`Not found in Jira yet: ${unresolved.map(m => m.name).join(', ')} (check the email in ⚙ Setup)`)
  const scope = cfg.projects.length ? '' : ` AND (assignee in (${who}) OR reporter in (${who}) OR worklogAuthor in (${who}))`
  const none: RawIssue[] = []

  // The four searches of the day, side by side.
  await progress('searching worklogs, moves, new and open tickets')
  const [logged, changed, createdRaw, openRaw] = await Promise.all([
    step('worklogs', () => retry($, () => jiraSearch($, cloud, `${pc}worklogAuthor in (${who}) AND worklogDate = "${day}"`, 200, { fields: FIELDS.plain, page: 50 })), none),
    step('status moves', () => retry($, () => jiraSearch($, cloud, `${pc}status CHANGED DURING ("${day}", "${d2}")${scope}`, 150, { fields: FIELDS.plain, page: 50 })), none),
    step('created', () => retry($, () => jiraSearch($, cloud, `${pc}created >= "${day}" AND created < "${d2}" AND (reporter in (${who}) OR assignee in (${who}))`, 100, { fields: FIELDS.all, page: 10 })), none),
    step('open tickets', () => retry($, () => jiraSearch($, cloud, `${pc}assignee in (${who}) AND statusCategory != Done ORDER BY updated DESC`, 600, { fields: FIELDS.open, page: 25 })), none),
  ])
  const open = openRaw.map(i => toPlain(i, byAccount))

  // Each ticket's worklogs and history, a few at a time.
  let done = 0
  const total = logged.length + changed.length
  const tick = async () => {
    done += 1
    if (done % 5 === 0 || done === total) await progress(`reading worklogs and history (${done} of ${total} tickets)`)
  }
  const worklogs: WL[] = []
  const moves: Move[] = []
  await Promise.all([
    inBatches(logged, 3, async issue => {
      const list = await step(`worklogs of ${issue.key}`, () => retry($, () => jiraWorklogs($, cloud, issue.key, s0, s1)), [])
      for (const w of list) {
        const email = byAccount.get(w.accountId)
        if (!email || w.started < s0 || w.started >= s1) continue
        worklogs.push({
          id: w.id,
          key: issue.key,
          summary: issue.summary,
          project: issue.project,
          story: issue.parent,
          storySummary: issue.parentSummary,
          email,
          seconds: w.seconds,
          started: w.started,
          comment: w.comment,
          isFlutter: isFlutterWork(issue, cfg),
        })
      }
      await tick()
    }),
    inBatches(changed, 3, async issue => {
      const list = await step(`history of ${issue.key}`, () => retry($, () => jiraStatusMoves($, cloud, issue.key)), [])
      for (const m of list) {
        const email = byAccount.get(m.accountId)
        if (!email || m.at < s0 || m.at >= s1) continue
        moves.push({ key: issue.key, summary: issue.summary, project: issue.project, email, from: m.from, to: m.to, at: m.at, isBounce: isBounce(m.from, m.to) })
      }
      await tick()
    }),
  ])

  // Story progress and sprint hygiene, side by side.
  await progress('story progress and sprint checks')
  const parents = [...new Set([...logged.map(i => i.parent), ...openRaw.map(i => i.parent)].filter(Boolean))].slice(0, 60)
  const projects = cfg.projects.length ? cfg.projects : [...new Set(openRaw.map(i => i.project))].slice(0, 10)
  const base = `project in (${projects.join(', ')}) AND sprint in openSprints()`
  const checks: [string, string][] = projects.length
    ? [
        ['no assignee', `${base} AND assignee is EMPTY`],
        ['no estimate', `${base} AND originalEstimate is EMPTY AND issuetype not in (Epic)`],
        ['no parent story', `${base} AND parent is EMPTY AND issuetype not in (Epic, Story)`],
      ]
    : []
  const [children, ...checked] = await Promise.all([
    parents.length ? step('stories', () => retry($, () => jiraSearch($, cloud, `parent in (${parents.join(', ')})`, 400, { fields: FIELDS.progress, page: 100 })), none) : Promise.resolve(none),
    ...checks.map(([reason, jql]) => step(`sprint check (${reason})`, () => retry($, () => jiraSearch($, cloud, jql, 60, { fields: [...FIELDS.plain, 'assignee'], page: 20 })), none)),
  ])
  const stories: StoryInfo[] = parents.map(key => {
    const kids = children.filter(c => c.parent === key)
    const any = [...logged, ...openRaw].find(i => i.parent === key)
    const byStatus: Record<string, number> = {}
    for (const k of kids) byStatus[k.status] = (byStatus[k.status] ?? 0) + 1

    return {
      key,
      summary: any?.parentSummary ?? '',
      project: key.split('-')[0] ?? '',
      type: any?.parentType ?? '',
      children: kids.length,
      byStatus,
      estimateSec: kids.reduce((a, k) => a + k.estimateSec, 0),
      spentSec: kids.reduce((a, k) => a + k.spentSec, 0),
    }
  })
  const hygiene = new Map<string, Hygiene>()
  checks.forEach(([reason], i) => {
    for (const h of checked[i] ?? []) {
      const p = toPlain(h, byAccount)
      const cur = hygiene.get(h.key) ?? { key: h.key, summary: h.summary, project: h.project, assignee: p.assignee, reasons: [] }
      cur.reasons.push(reason)
      hygiene.set(h.key, cur)
    }
  })

  return {
    day,
    takenAt: await $.clock.now().catch(() => Date.now()),
    worklogs,
    moves,
    created: createdRaw.map(i => toPlain(i, byAccount)),
    inProgress: open.filter(i => i.statusCat === 'indeterminate'),
    open,
    stories,
    hygiene: [...hygiene.values()],
    errors,
  }
}

/** Days waiting to be pulled; a press while a pull runs adds to it. */
const queue: string[] = []
/** The day being pulled right now, so a press for it is not queued twice. */
let pullingDay = ''

/** Pulls days from Jira and snapshots each; the pane keeps the last snapshot if Jira is down. */
async function pull($: E$, days: string[]): Promise<void> {
  const fresh = days.filter(d => !queue.includes(d) && d !== pullingDay)
  queue.push(...fresh)
  if (pulling) {
    if (fresh.length) await say($, `${fresh.map(dayLabel).join(', ')} will be pulled next.`)

    return pulling
  }
  pulling = (async () => {
    nowMs = await $.clock.now().catch(() => Date.now())
    let done = 0
    let failed = false
    while (queue.length > 0) {
      const day = queue.shift()!
      pullingDay = day
      const progress = (text: string) => update($, busy, () => `Pulling ${dayLabel(day)}${queue.length ? ` (${queue.length} more after)` : ''}: ${text}…`).then(() => undefined)
      try {
        await saveSnap($, await collectDay($, day, progress))
        done += 1
      } catch (err) {
        failed = true
        queue.length = 0
        await say($, `Jira did not answer for ${dayLabel(day)}: ${err instanceof Error ? err.message : String(err)}. Showing the last snapshot.`)
      }
    }
    if (!failed) await say($, `Pulled ${done} day${done === 1 ? '' : 's'} at ${clock(now(), off)}.`)
  })().finally(async () => {
    pulling = null
    pullingDay = ''
    await update($, busy, () => '')
  })

  return pulling
}

async function endOfDayTick($: E$): Promise<void> {
  const cfg = await loadCfg($)
  nowMs = await $.clock.now().catch(() => Date.now())
  if (clock(now(), off) !== cfg.endOfDay || !isWorkDay(today(), cfg) || cfg.members.length === 0) return
  const last = await $.store.get('eodDay').catch(() => undefined)
  if (last === today()) return
  await $.store.set('eodDay', today())
  await pull($, [today()])
}

// ---------------------------------------------------------------------------
// Pane: open, navigate
// ---------------------------------------------------------------------------

async function openPane($: E$): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: 'Team', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) {
    $.ui.toast(`The Team pane could not open: ${opened.reason}`)

    return false
  }
  paneOpen = true
  nowMs = await $.clock.now().catch(() => Date.now())
  await update($, ui, x => ({ ...x, day: x.day || today() }))
  const cfg = await loadCfg($)
  if (cfg.members.length > 0 && !(await loadSnap($, today()))) $.clock.after(0, () => void pull($, [today()]))

  return true
}

async function setUi($: E$, patch: Partial<DashUi>): Promise<void> {
  await update($, ui, x => ({ ...x, ...patch }))
}

async function showText($: E$, title: string, text: string, file: string): Promise<void> {
  await setUi($, { view: 'text', textTitle: title, text, textFile: file })
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

async function currentView($: E$): Promise<{ cfg: TeamCfg; v: View; x: DashUi }> {
  const x = await read($, ui)
  const cfg = await loadCfg($)
  const days = rangeDays(x.day || today(), x.range)
  const snaps = (await Promise.all(days.map(d => loadSnap($, d)))).filter((s): s is Snapshot => s !== null)

  return { cfg, x, v: buildView(cfg, snaps, days, x.filters, today(), now()) }
}

function filterText(f: Filters, cfg: TeamCfg): string {
  const dev = cfg.members.find(m => m.email === f.dev)

  return [f.team && `team ${f.team}`, dev && `developer ${dev.name}`, f.project && `project ${f.project}`].filter(Boolean).join(', ')
}

async function exportView($: E$, kind: 'csv' | 'md'): Promise<void> {
  const { cfg, v, x } = await currentView($)
  const stamp = v.days.length === 1 ? v.days[0]! : `${v.days[0]}_${v.days[v.days.length - 1]}`
  const text = kind === 'csv' ? viewCsv(v) : viewMd(v, filterText(x.filters, cfg))
  await showText($, kind === 'csv' ? 'Export · CSV' : 'Export · Markdown', text, `team-${stamp}.${kind}`)
}

async function digest($: E$): Promise<void> {
  const x = await read($, ui)
  const end = x.day || today()
  const start = weekOf(end)
  const days = rangeDays(addDays(start, 6) > today() ? today() : addDays(start, 6), Math.min(7, Math.round((Date.parse(end > today() ? today() : addDays(start, 6)) - Date.parse(start)) / DAY_MS) + 1))
  const cfg = await loadCfg($)
  const missing: string[] = []
  for (const d of days) if (!(await loadSnap($, d))) missing.push(d)
  if (missing.length) await pull($, missing)
  const snaps = (await Promise.all(days.map(d => loadSnap($, d)))).filter((s): s is Snapshot => s !== null)
  const v = buildView(cfg, snaps, days, { team: '', dev: '', project: '' }, today(), now())
  await showText($, `Weekly digest · week of ${dayLabel(start)}`, digestMd(cfg, v), `digest-${start}.md`)
}

/** `/team-report [date|range] [team|dev]` */
async function applyReportArgs($: E$, args: string): Promise<string> {
  const cfg = await loadCfg($)
  const patch: Partial<DashUi> = { view: 'main' }
  const filters: Filters = { team: '', dev: '', project: '' }
  const said: string[] = []
  for (const word of args.split(/\s+/).filter(Boolean)) {
    const w = word.toLowerCase()
    const range = /^(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)$/.exec(word)
    if (range) {
      patch.day = range[2]
      patch.range = Math.max(1, Math.min(31, Math.round((Date.parse(range[2]!) - Date.parse(range[1]!)) / DAY_MS) + 1))
    } else if (/^\d{4}-\d\d-\d\d$/.test(word)) {
      patch.day = word
      patch.range = 1
    } else if (w === 'today') Object.assign(patch, { day: today(), range: 1 })
    else if (w === 'yesterday') Object.assign(patch, { day: addDays(today(), -1), range: 1 })
    else if (w === 'week' || w === '7d') Object.assign(patch, { day: today(), range: 7 })
    else if (w === 'month' || w === '30d') Object.assign(patch, { day: today(), range: 30 })
    else {
      const team = cfg.teams.find(t => t.toLowerCase() === teamName(w).toLowerCase())
      const dev = cfg.members.find(m => m.email === w || firstName(m).toLowerCase() === w || m.name.toLowerCase().replace(/\s+/g, '') === w)
      if (team) filters.team = team
      else if (dev) filters.dev = dev.email
      else said.push(`"${word}" is not a date, range, team or developer`)
    }
  }
  patch.filters = filters
  await setUi($, patch)

  return said.join('; ')
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await initEnv($)
    // A pull a reload cut short leaves its message behind: clear it.
    await update($, busy, () => '')
    const cmds: [string, string, string?][] = [
      ['team', 'Open the Jira team dashboard'],
      ['team-refresh', 'Pull today from Jira and snapshot it'],
      ['team-report', 'Open the dashboard on a day, range, team or developer', '[date|from..to|week|month] [team|developer]'],
      ['team-digest', 'Weekly digest for management (Markdown)'],
      ['team-setup', 'Team members, projects, hours and the leave calendar'],
    ]
    for (const [name, description, argumentHint] of cmds) await $.command.register(argumentHint ? { name, description, argumentHint } : { name, description })
    $.clock.every(60_000, () => void endOfDayTick($))

    return r
  })

  on('command.run', { command: 'team' }, async $ => {
    await openPane($)

    return { text: 'Opened the team dashboard.' }
  })

  on('command.run', { command: 'team-refresh' }, async $ => {
    nowMs = await $.clock.now().catch(() => Date.now())
    await pull($, [today()])
    const err = await read($, note)

    return { text: err || 'Pulled today from Jira.' }
  })

  on('command.run', { command: 'team-report' }, async ($, e) => {
    if (!(await openPane($))) return { text: 'The Team pane could not open.' }
    const problem = await applyReportArgs($, e.args)

    return { text: problem ? `Opened the dashboard. ${problem}.` : 'Opened the dashboard with those filters.' }
  })

  on('command.run', { command: 'team-digest' }, async $ => {
    if (!(await openPane($))) return { text: 'The Team pane could not open.' }
    $.clock.after(0, () => void digest($))

    return { text: 'Preparing the weekly digest.' }
  })

  on('command.run', { command: 'team-setup' }, async $ => {
    if (!(await openPane($))) return { text: 'The Team pane could not open.' }
    await openSetup($)

    return { text: 'Opened team setup.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const x = await read($, ui)
    if (e.origin.kind === 'person' && x.view !== 'main') {
      await setUi($, { view: 'main' })

      return { value: undefined }
    }
    paneOpen = false

    return next(e)
  })

  // The status-bar button: opens or closes the pane.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const fill = paneOpen ? '#B3D4FF' : C.violet

    return statusGrid(
      { Box, Text },
      below,
      e.props.modes,
      <Button
        key="open-team"
        plain
        onPress={async () => {
          if (paneOpen) await $.ui.close({ id: PANE })
          else await openPane($)
        }}
      >
        <Text color={fill}>▐</Text>
        <Text backgroundColor={fill} color="#091E42" bold>
          ▦ Team
        </Text>
        <Text color={fill}>▌</Text>
      </Button>,
    ) as never
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    await read($, snapVersion)
    const x = await read($, ui)
    const working = await read($, busy)
    const last = await read($, note)
    const cfg = await loadCfg($)
    const W = Math.max(50, e.props.bodyColumns ?? 100)
    if (x.view === 'setup') return drawSetup($, el, x, cfg, W, working || last)
    if (x.view === 'text') return drawText($, el, x)

    return drawMain($, el, x, cfg, W, working, last)
  })
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

type El = ReturnType<E$['ui']['resolve']>

function fit(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length <= width ? one : `${one.slice(0, Math.max(1, width - 1))}…`
}

function bar(value: number, max: number, width: number): string {
  const n = max > 0 ? Math.round((Math.min(value, max) / max) * width) : 0

  return '█'.repeat(n) + '░'.repeat(Math.max(0, width - n))
}

function name(cfg: TeamCfg, email: string): string {
  return cfg.members.find(m => m.email === email)?.name ?? email
}

async function drawMain($: E$, el: El, x: DashUi, cfg: TeamCfg, W: number, working: string, last: string) {
  const { Box, Text, Button } = el
  const Select = 'Select' in el ? el.Select : undefined
  const day = x.day || today()
  const days = rangeDays(day, x.range)
  const snaps = (await Promise.all(days.map(d => loadSnap($, d)))).filter((s): s is Snapshot => s !== null)
  const v = buildView(cfg, snaps, days, x.filters, today(), now())
  const takenAt = snaps.length ? Math.max(...snaps.map(s => s.takenAt)) : 0

  const link = (key: string, label: string, onPress: () => unknown, color: string = C.accent, isOn = false) => (
    <Button key={key} plain onPress={() => void onPress()}>
      <Text color={isOn ? C.accent : color} bold={isOn} underline={isOn} dimColor={!isOn && color === C.muted}>
        {label}
      </Text>
    </Button>
  )
  const links = (items: [string, string, () => unknown, boolean?][]) => (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {items.flatMap(([key, label, onPress, isOn], i) => [...(i > 0 ? [<Text dimColor>·</Text>] : []), link(key, label, onPress, C.muted, isOn === true)])}
    </Box>
  )
  const section = (id: Section, title: string, right: string, body: () => unknown) => {
    const isFolded = x.folded.includes(id)

    return (
      <Box key={`s-${id}`} flexDirection="column" marginTop={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button key={`sec-${id}`} plain onPress={() => void setUi($, { folded: isFolded ? x.folded.filter(f => f !== id) : [...x.folded, id] })}>
            <Text color={C.accent}>{isFolded ? '▸' : '▾'}</Text> <Text bold>{title}</Text>
          </Button>
          <Text dimColor>{right}</Text>
        </Box>
        {!isFolded && <Box flexDirection="column" paddingLeft={2}>{body() as never}</Box>}
      </Box>
    )
  }
  const setFilter = (patch: Partial<Filters>) => setUi($, { filters: { ...x.filters, ...patch } })
  const projectsSeen = [...new Set(snaps.flatMap(s => [...s.worklogs.map(w => w.project), ...s.open.map(i => i.project)]))].filter(Boolean).sort()
  const title = x.range === 1 ? dayLabel(day) : `${dayLabel(days[0]!)} – ${dayLabel(day)}`
  const maxLogged = Math.max(1, ...v.devs.map(d => Math.max(d.loggedMin, d.expectedMin)))
  const barW = Math.max(6, Math.min(16, W - 60))

  if (cfg.members.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color={C.accent}>
          Team dashboard
        </Text>
        <Text>No team members yet.</Text>
        {links([['setup-first', 'Set up the team', () => openSetup($)]])}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {/* Top bar: dates and range on the left, refresh and setup on the right */}
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Button key="prev" plain hotkey="h" onPress={() => void setUi($, { day: addDays(day, -1) })}>
            <Text color={C.accent}>◀</Text>
          </Button>
          <Text bold>{title}</Text>
          <Button key="next" plain hotkey="l" onPress={() => void setUi($, { day: day >= today() ? day : addDays(day, 1) })}>
            <Text color={day >= today() ? C.muted : C.accent}>▶</Text>
          </Button>
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button key="refresh" plain hotkey="r" onPress={() => void $.clock.after(0, () => void pull($, x.range === 1 ? [day] : [...new Set([...v.missingDays, today()])].filter(d => days.includes(d))))}>
            <Text color={working ? C.amber : undefined}>⟳</Text>
          </Button>
          <Button key="setup" plain hotkey="s" onPress={() => void openSetup($)}>
            <Text>⚙</Text>
          </Button>
        </Box>
      </Box>
      {links([
        ['r-today', 'Today', () => setUi($, { day: today() }), day === today() && x.range === 1],
        ['r-day', 'Day', () => setUi($, { range: 1 }), x.range === 1],
        ['r-week', '7 days', () => setUi($, { range: 7 }), x.range === 7],
        ['r-month', '30 days', () => setUi($, { range: 30 }), x.range === 30],
      ])}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text dimColor>Team</Text>
        {links([['t-all', 'All', () => setFilter({ team: '', dev: '' }), x.filters.team === '' && x.filters.dev === ''], ...cfg.teams.map(t => [`t-${t}`, t, () => setFilter({ team: t, dev: '' }), x.filters.team === t] as [string, string, () => unknown, boolean])])}
      </Box>
      {Select && (
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Select
            key="f-dev"
            label="Developer"
            value={x.filters.dev}
            options={[{ value: '', label: 'Everyone' }, ...cfg.members.filter(m => (x.filters.team ? m.teams.includes(x.filters.team) : true)).map(m => ({ value: m.email, label: m.name }))]}
            onSelect={(val: string) => void setFilter({ dev: val })}
          />
          <Select
            key="f-project"
            label="Project"
            value={x.filters.project}
            options={[{ value: '', label: 'All projects' }, ...projectsSeen.map(p => ({ value: p, label: p }))]}
            onSelect={(val: string) => void setFilter({ project: val })}
          />
        </Box>
      )}
      <Text dimColor>{'─'.repeat(Math.max(10, W - 1))}</Text>
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor wrap="truncate-end">
          {working || last || ' '}
        </Text>
        <Text dimColor>{takenAt ? `Snapshot ${clock(takenAt, off)}` : 'No snapshot'}</Text>
      </Box>
      {v.missingDays.length > 0 && (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text color={C.amber}>
            ⚠ No snapshot for {v.missingDays.length === 1 ? dayLabel(v.missingDays[0]!) : `${v.missingDays.length} days`}.
          </Text>
          {link('pull-missing', 'Pull from Jira', () => $.clock.after(0, () => void pull($, v.missingDays)))}
        </Box>
      )}
      {(() => {
        // Errors are saved with the snapshot: say which pull they came from, and offer to pull again.
        const withErrors = snaps.filter(s => s.errors.length > 0)
        if (withErrors.length === 0) return null
        const lines = withErrors.flatMap(s => s.errors.map(err => `${x.range > 1 ? `${dayLabel(s.day)} · ` : ''}${err}`))

        return (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Text color={C.red}>
                ⚠ {lines.length} problem{lines.length === 1 ? '' : 's'} in the pull of {withErrors.length === 1 ? clock(withErrors[0]!.takenAt, off) : `${withErrors.length} days`}; those numbers may be short.
              </Text>
              {link('pull-again', 'Pull again', () => $.clock.after(0, () => void pull($, withErrors.map(s => s.day))))}
            </Box>
            {lines.slice(0, 3).map((line, i) => (
              <Text key={`err-${i}`} color={C.red} dimColor wrap="truncate-end">
                {'  '}
                {line}
              </Text>
            ))}
            {lines.length > 3 && <Text dimColor>  and {lines.length - 3} more</Text>}
          </Box>
        )
      })()}
      {links([
        ['x-csv', 'Export CSV', () => exportView($, 'csv')],
        ['x-md', 'Export Markdown', () => exportView($, 'md')],
        ['x-digest', 'Weekly digest', () => $.clock.after(0, () => void digest($))],
      ])}

      {section('cards', 'Summary', '', () => (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {[
            ['Hours logged', `${v.cards.hours.toFixed(1)}h`, C.accent],
            ['Tickets moved', String(v.cards.moved), C.green],
            ['Tickets created', String(v.cards.created), C.violet],
            ['Under expected', String(v.cards.under), v.cards.under > 0 ? C.amber : C.green],
          ].map(([label, value, color]) => (
            <Box key={`card-${label}`} borderStyle="round" borderColor={color} paddingX={1} flexDirection="column" minWidth={16}>
              <Text bold color={color}>
                {value}
              </Text>
              <Text dimColor>{label}</Text>
            </Box>
          ))}
        </Box>
      ))}

      {section('live', "Who's on what", 'in progress now', () =>
        v.live.map(l => (
          <Box key={`live-${l.member.email}`} flexDirection="column">
            <Text bold>{l.member.name}</Text>
            {l.issues.length === 0 && <Text dimColor>  nothing in progress</Text>}
            {l.issues.slice(0, 5).map(i => (
              <Text key={`li-${i.key}`}>
                {'  '}
                <Text color={C.accent}>{i.key}</Text> <Text color={C.green}>{i.status}</Text> <Text dimColor>{fit(i.summary, W - 30)}</Text>
              </Text>
            ))}
          </Box>
        )),
      )}

      {section('devs', 'Per developer', 'logged / expected', () =>
        v.devs.map(d => {
          const isOpen = x.expanded.includes(d.member.email)
          const gap = v.attention.gaps.find(g => g.member.email === d.member.email)
          const color = d.expectedMin === 0 ? C.muted : d.loggedMin >= d.expectedMin * 0.75 ? C.green : d.loggedMin === 0 ? C.red : C.amber

          return (
            <Box key={`dev-${d.member.email}`} flexDirection="column">
              <Button
                key={`devx-${d.member.email}`}
                plain
                onPress={() => void setUi($, { expanded: isOpen ? x.expanded.filter(z => z !== d.member.email) : [...x.expanded, d.member.email] })}
              >
                <Text color={C.accent}>{isOpen ? '▾' : '▸'}</Text> <Text bold>{fit(d.member.name, 22)}</Text> <Text color={color}>{bar(d.loggedMin, maxLogged, barW)}</Text>{' '}
                {fmtMin(d.loggedMin)} / {fmtMin(d.expectedMin)}{' '}
                <Text dimColor>
                  · {d.tickets.length} ticket{d.tickets.length === 1 ? '' : 's'} · {d.moves} move{d.moves === 1 ? '' : 's'}
                  {d.leaveDays ? ` · ${d.leaveDays}d leave` : ''}
                </Text>
              </Button>
              {isOpen && (
                <Box flexDirection="column" paddingLeft={4}>
                  <Text dimColor>{d.member.teams.join(' · ') || 'no team'}</Text>
                  {d.tickets.length === 0 && <Text dimColor>No tickets touched.</Text>}
                  {d.tickets.map(t => (
                    <Box key={`dt-${d.member.email}-${t.key}`} flexDirection="column">
                      <Text>
                        <Text color={C.accent}>{t.key}</Text> {fmtMin(t.min)} <Text dimColor>{fit(t.summary, W - 30)}</Text>
                      </Text>
                      {t.moves.map((mv, i) => (
                        <Text key={`dtm-${t.key}-${i}`} dimColor>
                          {'    '}
                          {mv}
                        </Text>
                      ))}
                    </Box>
                  ))}
                  {gap && links([[`rem-${d.member.email}`, 'Draft a reminder', () => showText($, `Reminder for ${d.member.name}`, reminderText(gap, v.days), '')]])}
                </Box>
              )}
            </Box>
          )
        }),
      )}

      {section('projects', 'Per project → story', `${v.projects.length} project${v.projects.length === 1 ? '' : 's'}`, () => [
        ...(v.projects.length === 0 ? [<Text dimColor>No time logged.</Text>] : []),
        ...v.projects.map(p => (
          <Box key={`p-${p.project}`} flexDirection="column">
            <Text>
              <Text bold>{p.project}</Text> {fmtMin(p.min)}
            </Text>
            {p.stories.map(s => (
              <Box key={`ps-${p.project}-${s.key}`} flexDirection="column" paddingLeft={2}>
                <Text>
                  {s.key === '(no story)' ? <Text dimColor>No story</Text> : <Text color={C.accent}>{s.key}</Text>} {fmtMin(s.min)}{' '}
                  <Text dimColor>{s.key === '(no story)' ? '' : fit(s.summary, W - 30)}</Text>
                </Text>
                {s.progress && (
                  <Text dimColor>
                    {'  '}
                    {s.progress.estimateSec > 0 ? `${bar(s.progress.spentSec, s.progress.estimateSec, 10)} ` : ''}
                    {fit(progressText(s.progress), W - 20)}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )),
      ])}

      {section('flutter', 'Flutter split', 'native · Flutter', () =>
        v.flutter.length === 0 ? (
          <Text dimColor>No one is in both a native team and {cfg.flutterTeam}. Add {cfg.flutterTeam} to members in ⚙ Setup.</Text>
        ) : (
          v.flutter.map(f => {
            const total = f.nativeMin + f.flutterMin

            return (
              <Text key={`fl-${f.member.email}`}>
                {fit(f.member.name, 22)} <Text color={C.accent}>{bar(f.nativeMin, total, 12)}</Text> native {fmtMin(f.nativeMin)} · {cfg.flutterTeam} {fmtMin(f.flutterMin)}
              </Text>
            )
          })
        ),
      )}

      {section('attention', 'Attention', `${attentionLines(v)[0] === 'Nothing needs attention.' ? 0 : attentionLines(v).length} item${attentionLines(v).length === 1 ? '' : 's'}`, () => {
        const a = v.attention
        const part = (key: string, label: string, rows: unknown[]) =>
          rows.length === 0 ? null : (
            <Box key={`a-${key}`} flexDirection="column">
              <Text color={C.amber}>
                {label} ({rows.length})
              </Text>
              {rows as never}
            </Box>
          )

        return [
          part(
            'gaps',
            'Logging gaps',
            a.gaps.map(g => (
              <Box key={`ag-${g.member.email}`} flexDirection="row" gap={1}>
                <Text>
                  {'  '}
                  {g.member.name} · {g.kind === 'none' ? 'nothing logged' : `${fmtMin(g.loggedMin)} of ${fmtMin(g.expectedMin)}`}
                </Text>
                {link(`agr-${g.member.email}`, 'Draft a reminder', () => showText($, `Reminder for ${g.member.name}`, reminderText(g, v.days), ''))}
              </Box>
            )),
          ),
          part('stuck', 'Stuck tickets', a.stuck.map(s => <Text key={`as-${s.issue.key}`}>  <Text color={C.accent}>{s.issue.key}</Text> {name(cfg, s.issue.assignee)} <Text dimColor>· {s.reason}</Text></Text>)),
          part('notime', 'Work but no time', a.noTime.map(m => <Text key={`an-${m.email}-${m.key}`}>  <Text color={C.accent}>{m.key}</Text> moved by {name(cfg, m.email)} <Text dimColor>· {m.from} → {m.to}</Text></Text>)),
          part('est', 'Estimate vs actual', a.estimate.map(i => <Text key={`ae-${i.key}`}>  <Text color={C.accent}>{i.key}</Text> {fmtMin(i.spentSec / 60)} spent of {fmtMin(i.estimateSec / 60)} <Text dimColor>· {name(cfg, i.assignee)}</Text></Text>)),
          part('hyg', 'Sprint hygiene', a.hygiene.map(h => <Text key={`ah-${h.key}`}>  <Text color={C.accent}>{h.key}</Text> <Text dimColor>{h.reasons.join(', ')} · {fit(h.summary, W - 40)}</Text></Text>)),
          part('bounce', 'Bounce-backs (a gentle signal, not a score)', a.bounces.map(b => <Text key={`ab-${b.member.email}`}>  {b.member.name} {b.count} <Text dimColor>· {b.keys.join(', ')}</Text></Text>)),
          attentionLines(v)[0] === 'Nothing needs attention.' ? <Text dimColor>Nothing needs attention.</Text> : null,
        ]
      })}

      {x.range === 1 &&
        section('timeline', 'Activity timeline', `${v.timeline.length} event${v.timeline.length === 1 ? '' : 's'}`, () =>
          v.timeline.length === 0 ? (
            <Text dimColor>No activity.</Text>
          ) : (
            v.timeline.map((t, i) => (
              <Text key={`tl-${i}`}>
                <Text dimColor>{clock(t.at, off)}</Text> <Text bold>{fit(name(cfg, t.email), 18)}</Text> {fit(t.text, W - 30)}
              </Text>
            ))
          ),
        )}

      {x.range > 1 &&
        section('trends', 'Trends', `${v.days.length} days`, () => {
          const max = Math.max(1, ...v.trends.map(t => t.total))
          const people = v.members.filter(m => v.trends.some(t => (t.perMember[m.email] ?? 0) > 0))

          return [
            <Text key="tr-h" bold>
              Daily hours
            </Text>,
            ...v.trends.map(t => (
              <Text key={`tr-${t.day}`}>
                {dayLabel(t.day).padEnd(10)} <Text color={C.accent}>{bar(t.total, max, Math.max(8, Math.min(30, W - 30)))}</Text> {fmtMin(t.total)}
              </Text>
            )),
            <Text key="tr-p" bold>
              Per person
            </Text>,
            ...people.map(m => (
              <Text key={`trp-${m.email}`}>
                {fit(m.name, 20).padEnd(20)} <Text color={C.violet}>{v.trends.map(t => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor(((t.perMember[m.email] ?? 0) / Math.max(1, cfg.hoursPerDay * 60)) * 7))]).join('')}</Text>
              </Text>
            )),
            <Text key="tr-w" bold>
              Workload (open tickets · remaining estimate)
            </Text>,
            ...v.workload.map(w => (
              <Text key={`trw-${w.member.email}`}>
                {fit(w.member.name, 20).padEnd(20)} {String(w.open).padStart(3)} open · {fmtMin(w.estimateMin)}
              </Text>
            )),
          ]
        })}
    </Box>
  )
}

function drawText($: E$, el: El, x: DashUi) {
  const { Box, Text, Button } = el
  const save = async () => {
    const path = `${dir()}/exports/${x.textFile}`
    await $.fs.write(path, x.text)
    await setUi($, { view: 'main' })
    await say($, `Saved ${path.replace(home, '~')}`)
  }

  return (
    <Box flexDirection="column">
      <Text bold color={C.accent}>
        {x.textTitle}
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button key="tx-copy" plain onPress={ev => void $.ui.copy({ text: x.text, surface: ev.surface }).then(() => say($, 'Copied.'))}>
          <Text color={C.accent}>Copy</Text>
        </Button>
        {x.textFile !== '' && <Text dimColor>·</Text>}
        {x.textFile !== '' && (
          <Button key="tx-save" plain onPress={() => void save()}>
            <Text color={C.accent}>Save as {x.textFile}</Text>
          </Button>
        )}
        <Text dimColor>·</Text>
        <Button key="tx-back" plain hotkey="b" onPress={() => void setUi($, { view: 'main' })}>
          <Text color={C.accent}>Back</Text>
        </Button>
      </Box>
      <Text dimColor>The mod never sends anything: copy it and send it yourself.</Text>
      <Text wrap="wrap">{x.text}</Text>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Setup (spec §2): members, teams, projects, hours, leave calendar
// ---------------------------------------------------------------------------

async function openSetup($: E$): Promise<void> {
  const cfg = await loadCfg($)
  await setUi($, { view: 'setup', setupDraft: JSON.stringify(cfg), newMember: '', leaveFor: cfg.members[0]?.email ?? '', leaveDay: '' })
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

async function patchDraft($: E$, fn: (c: TeamCfg) => TeamCfg): Promise<void> {
  await update($, ui, x => ({ ...x, setupDraft: JSON.stringify(fn(JSON.parse(x.setupDraft || '{}') as TeamCfg)) }))
}

async function saveSetup($: E$): Promise<void> {
  const d = JSON.parse((await read($, ui)).setupDraft || '{}') as TeamCfg
  const teams = [...new Set([...d.teams, ...d.members.flatMap(m => m.teams)])].filter(Boolean)
  await saveCfg($, { ...d, teams })
  await setUi($, { view: 'main' })
  await say($, 'Team settings saved.')
}

function drawSetup($: E$, el: El, x: DashUi, saved: TeamCfg, W: number, status: string) {
  const { Box, Text, Button } = el
  const Input = 'Input' in el ? el.Input : undefined
  const Select = 'Select' in el ? el.Select : undefined
  let d: TeamCfg
  try {
    d = JSON.parse(x.setupDraft || '{}') as TeamCfg
  } catch {
    return <Text color={C.red}>Settings could not be read.</Text>
  }
  if (!d.members) return <Text dimColor>Loading…</Text>
  const num = (v: string, f: number) => (v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : f)
  const link = (key: string, label: string, onPress: () => unknown, color: string = C.accent) => (
    <Button key={key} plain onPress={() => void onPress()}>
      <Text color={color}>{label}</Text>
    </Button>
  )
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  void saved

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={C.accent}>
          Team setup
        </Text>
        <Box flexDirection="row" gap={1}>
          {link('su-save', 'Save', () => saveSetup($))}
          <Text dimColor>·</Text>
          {link('su-back', 'Back', () => setUi($, { view: 'main' }), C.muted)}
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">
        {status || 'Kept on this machine only, in ~/.claude/jira-team-dashboard/team.json.'}
      </Text>

      <Text bold>Members ({d.members.length})</Text>
      {d.members.map(m => (
        <Box key={`m-${m.email}`} flexDirection="column" paddingLeft={2}>
          <Text>
            <Text bold>{m.name}</Text> <Text dimColor>{fit(m.email, W - 40)}</Text> {m.accountId ? <Text color={C.green}>✓ in Jira</Text> : <Text color={C.amber}>not looked up yet</Text>}
          </Text>
          <Box flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={2}>
            {d.teams.flatMap((t, i) => [
              ...(i > 0 ? [<Text dimColor>·</Text>] : []),
              <Button
                key={`mt-${m.email}-${t}`}
                plain
                onPress={() =>
                  void patchDraft($, c => ({
                    ...c,
                    members: c.members.map(z => (z.email === m.email ? { ...z, teams: z.teams.includes(t) ? z.teams.filter(q => q !== t) : [...z.teams, t] } : z)),
                  }))
                }
              >
                <Text color={m.teams.includes(t) ? C.accent : C.muted} bold={m.teams.includes(t)}>
                  {m.teams.includes(t) ? `✓ ${t}` : t}
                </Text>
              </Button>,
            ])}
            <Text dimColor>·</Text>
            {link(`mr-${m.email}`, 'Remove', () => patchDraft($, c => ({ ...c, members: c.members.filter(z => z.email !== m.email) })), C.red)}
          </Box>
        </Box>
      ))}
      {Input && (
        <Input
          key="su-add"
          label="Add"
          placeholder="Name, email, Team (one per line or comma separated)"
          value={x.newMember}
          onInput={(v: string) => void setUi($, { newMember: v })}
          onSubmit={(v: string) =>
            void (async () => {
              const added = parseRoster(v)
              if (added.length === 0) {
                await say($, 'Use: Name, email, Team')

                return
              }
              await patchDraft($, c => ({
                ...c,
                teams: [...new Set([...c.teams, ...added.flatMap(a => a.teams)])],
                members: [...c.members.filter(z => !added.some(a => a.email === z.email)), ...added],
              }))
              await setUi($, { newMember: '' })
            })()
          }
        />
      )}

      <Text bold>Teams</Text>
      {Input && (
        <Input
          key="su-teams"
          label="Teams"
          value={d.teams.join(', ')}
          onSubmit={(v: string) => void patchDraft($, c => ({ ...c, teams: v.split(',').map(t => teamName(t)).filter(Boolean) }))}
        />
      )}
      {Input && (
        <Input
          key="su-flutter"
          label="Flutter work is"
          placeholder="project keys or words, e.g. flutter, FLT"
          value={d.flutterMatch.join(', ')}
          onSubmit={(v: string) => void patchDraft($, c => ({ ...c, flutterMatch: v.split(',').map(t => t.trim()).filter(Boolean) }))}
        />
      )}

      <Text bold>Work</Text>
      {Input && (
        <Box flexDirection="column">
          <Input key="su-projects" label="Projects" placeholder="empty = every project the team works in" value={d.projects.join(', ')} onSubmit={(v: string) => void patchDraft($, c => ({ ...c, projects: v.split(/[\s,]+/).map(p => p.toUpperCase()).filter(Boolean) }))} />
          <Input key="su-hours" label="Hours per day" value={String(d.hoursPerDay)} onSubmit={(v: string) => void patchDraft($, c => ({ ...c, hoursPerDay: num(v, c.hoursPerDay) }))} />
          <Input key="su-eod" label="End of day" placeholder="18:00" value={d.endOfDay} onSubmit={(v: string) => void patchDraft($, c => ({ ...c, endOfDay: /^\d\d:\d\d$/.test(v.trim()) ? v.trim() : c.endOfDay }))} />
          <Input key="su-stuck" label="Stuck after (days)" value={String(d.stuckDays)} onSubmit={(v: string) => void patchDraft($, c => ({ ...c, stuckDays: num(v, c.stuckDays) }))} />
        </Box>
      )}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text>Working days</Text>
        {dayNames.flatMap((n, i) => [
          ...(i > 0 ? [<Text dimColor>·</Text>] : []),
          <Button key={`wd-${i}`} plain onPress={() => void patchDraft($, c => ({ ...c, workDays: c.workDays.includes(i) ? c.workDays.filter(z => z !== i) : [...c.workDays, i].sort() }))}>
            <Text color={d.workDays.includes(i) ? C.accent : C.muted} bold={d.workDays.includes(i)}>
              {n}
            </Text>
          </Button>,
        ])}
      </Box>

      <Text bold>Leave calendar</Text>
      <Text dimColor>Days off do not count as logging gaps.</Text>
      {Select && Input && (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Select key="lv-who" label="Who" value={x.leaveFor} options={d.members.map(m => ({ value: m.email, label: m.name }))} onSelect={(v: string) => void setUi($, { leaveFor: v })} />
          <Input
            key="lv-day"
            label="Day off"
            placeholder="YYYY-MM-DD or from..to"
            value={x.leaveDay}
            onInput={(v: string) => void setUi($, { leaveDay: v })}
            onSubmit={(v: string) =>
              void (async () => {
                const days = leaveDays(v.trim())
                if (!x.leaveFor || days.length === 0) {
                  await say($, 'Pick a person and type a day (YYYY-MM-DD) or a range (from..to).')

                  return
                }
                await patchDraft($, c => ({ ...c, leave: { ...c.leave, [x.leaveFor]: [...new Set([...(c.leave[x.leaveFor] ?? []), ...days])].sort() } }))
                await setUi($, { leaveDay: '' })
              })()
            }
          />
        </Box>
      )}
      {d.members
        .filter(m => (d.leave[m.email] ?? []).length > 0)
        .map(m => (
          <Box key={`lv-${m.email}`} flexDirection="row" gap={1} flexWrap="wrap" paddingLeft={2}>
            <Text>{m.name}</Text>
            {(d.leave[m.email] ?? []).flatMap(day => [
              <Button
                key={`lvd-${m.email}-${day}`}
                plain
                onPress={() => void patchDraft($, c => ({ ...c, leave: { ...c.leave, [m.email]: (c.leave[m.email] ?? []).filter(z => z !== day) } }))}
              >
                <Text color={C.violet}>{dayLabel(day)} ✕</Text>
              </Button>,
            ])}
          </Box>
        ))}
      <Box flexDirection="row" gap={1} marginTop={1}>
        {link('su-save2', 'Save', () => saveSetup($))}
        <Text dimColor>·</Text>
        {link('su-back2', 'Back', () => setUi($, { view: 'main' }), C.muted)}
      </Box>
    </Box>
  )
}

/** `2026-12-24` or `2026-12-24..2026-12-31` → days (at most 60). */
function leaveDays(text: string): string[] {
  const one = /^\d{4}-\d\d-\d\d$/.exec(text)
  if (one) return [text]
  const range = /^(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)$/.exec(text)
  if (!range || range[2]! < range[1]!) return []
  const out: string[] = []
  for (let d = range[1]!; d <= range[2]! && out.length < 60; d = addDays(d, 1)) out.push(d)

  return out
}
