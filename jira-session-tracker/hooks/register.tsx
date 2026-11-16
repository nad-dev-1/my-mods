import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Action,
  Chunk,
  LooseEnd,
  Model,
  NewForm,
  ProjectCfg,
  Settings,
  Snapshot,
  Story,
  Tab,
  Ticket,
  TimeOpt,
  Ui,
  Unit,
  View,
  WriteRec,
} from '../types'
import {
  DAY_MS,
  MIN,
  addDays,
  aiWords,
  branchFollows,
  branchFor,
  buildUnits,
  buildWeeks,
  cleanLabel,
  clock,
  dayLabel,
  dayOf,
  dayStart,
  fmtMin,
  fitMiddle,
  groupUnits,
  isOpen,
  jiraStarted,
  keysIn,
  parseClock,
  parseDuration,
  projectOfKey,
  rankCandidates,
  rankStories,
  scrubAi,
  shortPath,
  slugify,
  standupText,
  targetFor,
  timeOptions,
  timesheetCsv,
  timesheetMd,
  timesheetRows,
  weekOf,
  weekday,
  withPrefix,
} from './core'
import type { RawSession, RepoInfo } from './core'
import { statusGrid } from './status-grid'
import { authorEmail as gitAuthorEmail, commitsSince as gitCommitsSince, hasMergeRequest as gitHasMergeRequest, isPushed as gitIsPushed, renameBranch as gitRenameBranch, repoOf as gitRepoOf, uncommitted as gitUncommitted, unpushed as gitUnpushed } from './git'
import { createIssue as jiraCreateIssue, issueTypes as jiraIssueTypes, myAccountId as jiraMyAccountId, putWorklog as jiraPutWorklog, search as jiraSearch, setParent as jiraSetParent, site as jiraSite, transition as jiraTransition, transitions as jiraTransitions, worklogs as jiraWorklogs } from './jira'

// Jira Session Tracker: a pane beside the chat that follows every Claude Code
// session on this machine, links the work to Jira tickets, proposes time and
// status moves, and writes to Jira only after the person confirms a preview.

type E$ = EngineInterface

const PLUGIN = 'jira-session-tracker'
const PANE = 'jira-tracker'
const LOOKBACK_DAYS = 35
const MODEL = 'haiku'

const C = {
  accent: '#4C9AFF',
  green: '#57D9A3',
  amber: '#FFAB00',
  red: '#FF5630',
  muted: '#8993A4',
  violet: '#998DD9',
}

const DEFAULT_SETTINGS: Settings = {
  cloudId: '',
  site: '',
  accountId: '',
  projects: [],
  hoursPerDay: 8,
  workDays: [1, 2, 3, 4, 5],
  endOfDay: '18:00',
  idleMin: 15,
  refreshMin: 5,
  daysOff: [],
  unlinkedAlertMin: 120,
  includeHeadless: false,
  setupDone: false,
}

const EMPTY_FORM: NewForm = {
  unitId: '',
  project: '',
  issueType: '',
  types: [],
  parent: '',
  stories: [],
  summary: '',
  description: '',
  labels: '',
  assignee: 'me',
  rename: true,
}

const EMPTY_MODEL: Model = { loadedAt: 0, weeks: [], units: [], tickets: [], inProgress: [], recent: [], error: '', currentSid: '' }

const EMPTY_UI: Ui = {
  tab: 'log',
  view: 'main',
  unitId: '',
  projectFilter: '',
  search: '',
  searchHits: [],
  form: EMPTY_FORM,
  chunks: [],
  actions: [],
  backTo: 'main',
  check: [],
  text: '',
  dashDay: '',
  dashRange: 1,
  dashProject: '',
  dashRepo: '',
  setupDraft: '',
  addTime: { key: '', date: '', start: '09:00', dur: '1h', comment: '' },
  collapsed: [],
  showIgnored: [],
  groupIds: [],
  weekToggled: [],
  toolsOpen: false,
}

const model = atom({ plugin: 'jira-session-tracker', key: 'model' } as const, EMPTY_MODEL, { shape: 'model-2' })
const ui = atom({ plugin: 'jira-session-tracker', key: 'ui' } as const, EMPTY_UI, { shape: 'ui-4' })
const busy = atom({ plugin: 'jira-session-tracker', key: 'busy' } as const, '')
const note = atom({ plugin: 'jira-session-tracker', key: 'note' } as const, '')
const queueSize = atom({ plugin: 'jira-session-tracker', key: 'queueSize' } as const, 0)

// Module memory: rebuilt on reload, never drawn from directly.
let off = 0
let home = ''
let email = ''
let paneOpen = false
let timer: { cancel: () => void } | null = null
let minuteTick: { cancel: () => void } | null = null
let refreshing: Promise<void> | null = null
const repoCache = new Map<string, RepoInfo>()
const typeCache = new Map<string, string[]>()
const storyCache = new Map<string, { at: number; list: Story[] }>()
let ticketIndex = new Map<string, Ticket>()

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const dataDir = () => `${home}/.claude/jira-session-tracker`

async function getStore<T>($: E$, key: string, fallback: T): Promise<T> {
  const v = await $.store.get(key).catch(() => undefined)

  return (v === undefined || v === null ? fallback : (v as T))
}

async function setStore($: E$, key: string, value: unknown): Promise<void> {
  await $.store.set(key, value).catch(err => $.ui.log(`${PLUGIN}: could not save ${key}: ${String(err)}`))
}

async function loadSettings($: E$): Promise<Settings> {
  const s = await getStore<Partial<Settings>>($, 'settings', {})

  return { ...DEFAULT_SETTINGS, ...s, projects: (s.projects ?? []).map(p => ({ ...blankProject(p.key ?? ''), ...p })) }
}

function blankProject(key: string): ProjectCfg {
  return { key, folders: [], prefix: '', branchPattern: 'feature/{KEY}-{slug}', issueType: 'Task', template: '', usesEstimates: false, lastStatus: '' }
}

async function writes($: E$): Promise<WriteRec[]> {
  return getStore<WriteRec[]>($, 'writes', [])
}

async function addWrite($: E$, rec: Omit<WriteRec, 'id' | 'at'>): Promise<void> {
  const list = await writes($)
  list.push({ ...rec, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: Date.now() })
  await setStore($, 'writes', list.slice(-2000))
}

async function say($: E$, text: string): Promise<void> {
  await update($, note, () => text)
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

async function initEnv($: E$): Promise<void> {
  home = (await $.env.get('HOME')) ?? home
  try {
    const r = await $.process.run(['date', '+%z'], { timeoutMs: 3_000 })
    const m = /([+-])(\d\d)(\d\d)/.exec(r.stdout)
    if (m) off = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
  } catch {
    off = 0
  }
}

/** The time the last refresh read from the clock (the engine's, so tests can set it). */
let nowMs = 0

function today(): string {
  return dayOf(nowMs || Date.now(), off)
}

/** Work still listed: open weeks only, so closed weeks never inflate a count. */
function listedUnits(m: Model): Unit[] {
  return m.weeks.flatMap(w => [...w.unlinked, ...w.days.flatMap(d => d.linked)])
}

// ---------------------------------------------------------------------------
// Refresh: sessions, git, Jira → the model
// ---------------------------------------------------------------------------

async function scanSessions($: E$, s: Settings, sinceMs: number): Promise<RawSession[]> {
  const script = `${$.plugin.root}/scripts/scan_sessions.py`
  const args = [script, `${home}/.claude/projects`, `${dataDir()}/scan-cache.json`, String(sinceMs), String(s.idleMin * MIN)]
  for (const py of ['/usr/bin/python3', '/opt/homebrew/bin/python3', 'python3']) {
    try {
      const r = await $.process.run([py, '-I', ...args], { timeoutMs: 120_000 })
      if (r.exitCode !== 0) continue
      const list = JSON.parse(r.stdout || '[]') as RawSession[]

      return list.filter(x => s.includeHeadless || x.human > 0 || !x.entry.startsWith('sdk'))
    } catch {
      continue
    }
  }
  throw new Error('Could not read the session transcripts (python3 not found)')
}

async function refresh($: E$, withJira = true): Promise<void> {
  if (refreshing) return refreshing
  refreshing = doRefresh($, withJira).finally(() => {
    refreshing = null
  })

  return refreshing
}

async function doRefresh($: E$, withJira: boolean): Promise<void> {
  await update($, busy, () => 'Refreshing…')
  const prev = await read($, model)
  let error = ''
  try {
    let s = await loadSettings($)
    const now = await $.clock.now().catch(() => Date.now())
    nowMs = now
    const sinceMs = dayStart(addDays(today(), -LOOKBACK_DAYS), off)
    const sessions = await scanSessions($, s, sinceMs)

    for (const cwd of new Set(sessions.map(x => x.cwd))) {
      if (!repoCache.has(cwd)) repoCache.set(cwd, await gitRepoOf($, cwd))
    }
    const repos = Object.fromEntries(repoCache)
    if (!email && sessions[0]) email = await gitAuthorEmail($, sessions[0].cwd)
    const commits: Record<string, Awaited<ReturnType<typeof gitCommitsSince>>> = {}
    for (const root of new Set([...repoCache.values()].map(r => r.root))) {
      commits[root] = await gitCommitsSince($, root, sinceMs, email)
    }

    const wl = await writes($)
    const loggedUnits: Record<string, number> = {}
    for (const w of wl) {
      if (w.kind !== 'worklog') continue
      for (const id of w.unitIds) loggedUnits[id] = (loggedUnits[id] ?? 0) + w.minutes / Math.max(1, w.unitIds.length)
    }

    let tickets = prev.tickets
    let inProgress = prev.inProgress
    let recent = prev.recent
    let jiraLogged: Record<string, number> = (await getStore<Record<string, number>>($, 'jiraLogged', {})) ?? {}
    if (withJira) {
      try {
        if (!s.cloudId) {
          const site = await jiraSite($)
          s = { ...s, cloudId: site.cloudId, site: site.url }
          await setStore($, 'settings', s)
        }
        if (!s.accountId) {
          s = { ...s, accountId: await jiraMyAccountId($) }
          await setStore($, 'settings', s)
        }
        tickets = await jiraSearch($, s.cloudId, 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', 200)
        inProgress = tickets.filter(t => t.statusCat === 'indeterminate').map(t => t.key)
        const touched = await jiraSearch(
          $,
          s.cloudId,
          '(assignee = currentUser() OR worklogAuthor = currentUser() OR reporter = currentUser()) AND updated >= -14d ORDER BY updated DESC',
          40,
        )
        recent = touched.map(t => t.key)
        const have = new Set(tickets.map(t => t.key))
        tickets = [...tickets, ...touched.filter(t => !have.has(t.key))]
        jiraLogged = await loggedByDay($, s, sinceMs, now)
        await setStore($, 'jiraLogged', jiraLogged)
      } catch (err) {
        error = `Jira: ${err instanceof Error ? err.message : String(err)}`.slice(0, 240)
      }
    }
    ticketIndex = new Map(tickets.map(t => [t.key, t]))

    const units = buildUnits({
      sessions,
      off,
      repos,
      commits,
      links: await getStore($, 'links', {}),
      branchLinks: await getStore($, 'branchLinks', {}),
      splits: await getStore($, 'splits', {}),
      loggedUnits,
      ignored: await getStore<string[]>($, 'ignored', []),
      labels: await getStore($, 'labels', {}),
      settings: s,
    })
    // Linked tickets the open-tickets query does not hold (done, someone else's).
    const missing = [...new Set(units.map(u => u.ticket).filter(k => k && !ticketIndex.has(k)))]
    if (withJira && s.cloudId && missing.length > 0) {
      try {
        const extra = await jiraSearch($, s.cloudId, `key in (${missing.slice(0, 80).join(',')})`, 80)
        tickets = [...tickets, ...extra]
        ticketIndex = new Map(tickets.map(t => [t.key, t]))
      } catch {
        // a key that no longer exists makes the whole query fail; leave them out
      }
    }
    const closed = await getStore<string[]>($, 'closedWeeks', [])
    const weeks = buildWeeks(units, jiraLogged, closed, s, today())
    const currentSid = await $.session.id().catch(() => '')
    await update($, model, () => ({ loadedAt: now, weeks, units, tickets, inProgress, recent, error, currentSid }))
    await snapshotDays($, units, jiraLogged, s)
    await statusLine($, units, currentSid)
    await alertUnlinked($, units, s)
    if (withJira && s.cloudId) void retryQueue($)
    void labelUnits($, units)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    await update($, model, m => ({ ...m, error }))
  } finally {
    await update($, busy, () => '')
  }
}

/** Minutes I logged in Jira per day since `sinceMs`. */
async function loggedByDay($: E$, s: Settings, sinceMs: number, now: number): Promise<Record<string, number>> {
  const days = Math.ceil((now - sinceMs) / DAY_MS)
  const issues = await jiraSearch($, s.cloudId, `worklogAuthor = currentUser() AND worklogDate >= -${days}d ORDER BY updated DESC`, 60, ['summary'])
  const out: Record<string, number> = {}
  for (let i = 0; i < issues.length; i += 6) {
    const batch = issues.slice(i, i + 6)
    const lists = await Promise.all(batch.map(t => jiraWorklogs($, s.cloudId, t.key, sinceMs, now + DAY_MS).catch(() => [])))
    for (const w of lists.flat()) {
      if (s.accountId && w.accountId !== s.accountId) continue
      const d = dayOf(w.startedMs, off)
      out[d] = (out[d] ?? 0) + w.seconds / 60
    }
  }

  return out
}

/** Short, plain labels for session-days, written by the model once and kept. */
async function labelUnits($: E$, units: Unit[]): Promise<void> {
  const labels = await getStore<Record<string, string>>($, 'labels', {})
  const todo = units.filter(u => u.part === 0 && !labels[`${u.sid}|${u.day}`] && u.prompts.length > 0).slice(0, 15)
  if (todo.length === 0) return
  const lines = todo.map((u, i) => `${i + 1}. repo ${u.repo}, branch ${u.branch || '-'}; requests: ${u.prompts.slice(0, 4).join(' | ').slice(0, 500)}`)
  const r = await $.model
    .complete({
      model: MODEL,
      maxTokens: 900,
      timeoutMs: 45_000,
      system:
        'You name pieces of software work for a timesheet. For each numbered item answer one line "N. label": 3 to 8 plain words in sentence case, what the work was about (e.g. "Deeplink handling review"). No quotes, no ticket keys, never mention AI, assistants or tools.',
      prompt: lines.join('\n'),
    })
    .catch(() => null)
  if (!r || !r.isAnswered) return
  for (const line of r.text.split('\n')) {
    const m = /^(\d+)[.)]\s*(.+)$/.exec(line.trim())
    const u = m ? todo[Number(m[1]) - 1] : undefined
    if (u && m) labels[`${u.sid}|${u.day}`] = cleanLabel(scrubAi(m[2]!), 60)
  }
  await setStore($, 'labels', labels)
  const byId = new Map(Object.entries(labels))
  await update($, model, m => ({
    ...m,
    units: m.units.map(u => (u.part === 0 && u.parts === 1 && byId.has(`${u.sid}|${u.day}`) ? { ...u, label: byId.get(`${u.sid}|${u.day}`)! } : u)),
    weeks: m.weeks.map(w => ({
      ...w,
      unlinked: w.unlinked.map(u => (u.parts === 1 && byId.has(`${u.sid}|${u.day}`) ? { ...u, label: byId.get(`${u.sid}|${u.day}`)! } : u)),
      days: w.days.map(d => ({ ...d, linked: d.linked.map(u => (u.parts === 1 && byId.has(`${u.sid}|${u.day}`) ? { ...u, label: byId.get(`${u.sid}|${u.day}`)! } : u)) })),
    })),
  }))
}

// ---------------------------------------------------------------------------
// Notifications (spec §9)
// ---------------------------------------------------------------------------

async function statusLine($: E$, units: Unit[], sid: string): Promise<void> {
  const mine = units.filter(u => u.sid === sid)
  const key = mine.map(u => u.ticket || u.suggested).find(Boolean)
  if (mine.length === 0) {
    $.ui.status(undefined)

    return
  }
  $.ui.status(key ? `⏱ ${key}` : '⏱ no ticket')
}

async function alertUnlinked($: E$, units: Unit[], s: Settings): Promise<void> {
  const d = today()
  const unlinked = units.filter(u => u.day === d && !u.ticket && isOpen(u)).reduce((a, u) => a + u.minutes, 0)
  if (unlinked < s.unlinkedAlertMin) return
  const last = await getStore<string>($, 'alertedDay', '')
  if (last === d) return
  await setStore($, 'alertedDay', d)
  $.ui.toast(`${fmtMin(unlinked)} of today's work has no Jira ticket yet. /jira to link it.`, { timeoutMs: 8_000 })
}

async function endOfDayTick($: E$): Promise<void> {
  const s = await loadSettings($)
  const now = Date.now()
  if (clock(now, off) !== s.endOfDay || targetFor(today(), s) === 0) return
  const done = await getStore<string>($, 'remindedDay', '')
  if (done === today()) return
  await setStore($, 'remindedDay', today())
  await refresh($, false)
  const m = await read($, model)
  const left = m.units.filter(u => u.day === today() && isOpen(u)).reduce((a, u) => a + u.minutes, 0)
  if (left >= 15) await $.ui.notify(`${fmtMin(left)} of today's work is not logged in Jira yet. Open /jira-wrapup to send the day.`, { title: 'Jira' }).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Snapshots (spec §8)
// ---------------------------------------------------------------------------

async function snapshotDays($: E$, units: Unit[], jiraLogged: Record<string, number>, s: Settings): Promise<void> {
  const days = [today(), addDays(today(), -1)]
  for (const day of days) {
    const list = units.filter(u => u.day === day)
    const sum = (f: (u: Unit) => boolean) => list.filter(f).reduce((a, u) => a + u.minutes, 0)
    const group = (k: (u: Unit) => string) => {
      const out: Record<string, number> = {}
      for (const u of list) out[k(u) || '-'] = (out[k(u) || '-'] ?? 0) + u.minutes

      return out
    }
    const snap: Snapshot = {
      day,
      sessions: new Set(list.map(u => u.sid)).size,
      linkedMin: sum(u => u.ticket !== ''),
      unlinkedMin: sum(u => u.ticket === ''),
      loggedMin: jiraLogged[day] ?? 0,
      targetMin: targetFor(day, s),
      looseEnds: list.filter(u => !u.ticket && isOpen(u)).length + list.filter(u => u.ticket && isOpen(u)).length,
      byProject: group(u => u.project || projectOfKey(u.ticket)),
      byRepo: group(u => u.repo),
      byTicket: group(u => u.ticket || 'no ticket'),
    }
    await $.fs.write(`${dataDir()}/snapshots/${day}.json`, JSON.stringify(snap)).catch(() => undefined)
  }
}

async function readSnapshot($: E$, day: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(String(await $.fs.read(`${dataDir()}/snapshots/${day}.json`))) as Snapshot
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pane open / close / navigation
// ---------------------------------------------------------------------------

async function openPane($: E$, tab?: Tab, view?: View): Promise<boolean> {
  if (tab || view) await update($, ui, u => ({ ...u, tab: tab ?? u.tab, view: view ?? 'main' }))
  const opened = await $.ui.open({ id: PANE, title: 'Jira', focus: true, closeOnEscape: true })
  if (!opened.isPlaced) {
    $.ui.toast(`The Jira pane could not open: ${opened.reason}`)

    return false
  }
  paneOpen = true
  await startTimer($)
  const m = await read($, model)
  if (Date.now() - m.loadedAt > 60_000) $.clock.after(0, () => void refresh($))

  return true
}

async function startTimer($: E$): Promise<void> {
  timer?.cancel()
  const s = await loadSettings($)
  timer = $.clock.every(Math.max(1, s.refreshMin) * MIN, () => void refresh($, paneOpen))
}

async function go($: E$, view: View, patch: Partial<Ui> = {}): Promise<void> {
  await update($, ui, u => ({ ...u, ...patch, view }))
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

async function back($: E$): Promise<void> {
  await update($, ui, u => ({ ...u, view: (u.view === 'preview' ? u.backTo : 'main') as View, backTo: 'main' as View }))
}

// ---------------------------------------------------------------------------
// Flows: link, split, create, log (spec §5)
// ---------------------------------------------------------------------------

async function unitById($: E$, id: string): Promise<Unit | undefined> {
  return (await read($, model)).units.find(u => u.id === id)
}

/** The current session's newest unit, for the slash commands. */
async function currentUnit($: E$): Promise<Unit | undefined> {
  const m = await read($, model)
  const sid = m.currentSid || (await $.session.id().catch(() => ''))
  const mine = m.units.filter(u => u.sid === sid)

  return mine[mine.length - 1]
}

async function linkUnit($: E$, unitId: string, key: string, ids: string[] = [unitId]): Promise<void> {
  const k = key.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(k)) {
    await say($, `"${key}" is not a ticket key.`)

    return
  }
  const u = await unitById($, unitId)
  const links = await getStore<Record<string, string>>($, 'links', {})
  for (const id of ids) links[id] = k
  await setStore($, 'links', links)
  const m = await read($, model)
  const bl = await getStore<Record<string, string>>($, 'branchLinks', {})
  for (const v of m.units.filter(x => ids.includes(x.id) && x.branch)) bl[`${v.repo}:${v.branch}`] = k
  await setStore($, 'branchLinks', bl)
  await addWrite($, { kind: 'link', key: k, unitIds: ids, worklogId: '', startedMs: u?.startMs ?? 0, minutes: 0, text: 'local link' })
  await say($, ids.length > 1 ? `Linked ${ids.length} sessions to ${k}.` : `Linked to ${k}.`)
  await go($, 'main', { groupIds: [] })
  await refresh($, false)
}

async function searchTickets($: E$, text: string): Promise<void> {
  const q = text.trim()
  await update($, ui, u => ({ ...u, search: q }))
  if (q === '') {
    await update($, ui, u => ({ ...u, searchHits: [] }))

    return
  }
  const s = await loadSettings($)
  if (!s.cloudId) return
  const isKey = /^[A-Za-z][A-Za-z0-9]+-\d+$/.test(q)
  const jql = isKey ? `key = ${q.toUpperCase()}` : `text ~ "${q.replace(/"/g, '')}" ORDER BY updated DESC`
  try {
    const hits = await jiraSearch($, s.cloudId, jql, 20)
    await update($, ui, u => ({ ...u, searchHits: hits }))
  } catch (err) {
    await say($, `Search failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function storiesFor($: E$, project: string): Promise<Story[]> {
  const hit = storyCache.get(project)
  if (hit && Date.now() - hit.at < 10 * MIN) return hit.list
  const s = await loadSettings($)
  if (!s.cloudId || !project) return []
  try {
    const list = await jiraSearch($, s.cloudId, `project = ${project} AND issuetype in (Epic, Story) AND statusCategory != Done ORDER BY updated DESC`, 100)
    const stories = list.map(t => ({ key: t.key, summary: t.summary, type: t.type, project: t.project, score: 0 }))
    storyCache.set(project, { at: Date.now(), list: stories })

    return stories
  } catch {
    return []
  }
}

/** Does the unit look like several pieces of work? (cheap check before a flow) */
function looksMixed(u: Unit): string {
  const keys = new Set(u.commits.flatMap(c => keysIn(`${c.subject} ${c.branch}`)))
  const branches = new Set(u.commits.map(c => c.branch).filter(Boolean))
  if (u.parts > 1) return ''
  if (keys.size > 1) return `commits name ${[...keys].join(', ')}`
  if (branches.size > 1) return `commits on ${[...branches].join(', ')}`

  return ''
}

async function startSplit($: E$, unitId: string): Promise<void> {
  const u = await unitById($, unitId)
  if (!u) return
  const baseId = `${u.sid}|${u.day}`
  const existing = (await getStore<Record<string, Chunk[]>>($, 'splits', {}))[baseId]
  await go($, 'split', { unitId: baseId, chunks: existing ?? [] })
  if (existing) return
  await update($, busy, () => 'Looking for separate pieces of work…')
  const chunks = await proposeChunks($, u).finally(() => update($, busy, () => ''))
  await update($, ui, x => ({ ...x, chunks }))
}

async function proposeChunks($: E$, u: Unit): Promise<Chunk[]> {
  const fallback: Chunk[] = [{ label: u.label, share: 1, ticket: u.ticket, branch: u.branch }]
  const facts = [
    `branch: ${u.branch}`,
    `commits: ${u.commits.map(c => `${c.subject} [${c.branch}] +${c.added}/-${c.removed}`).join('; ') || 'none'}`,
    `files: ${u.files.map(f => f.split('/').slice(-2).join('/')).slice(0, 40).join(', ') || 'none'}`,
    `requests: ${u.prompts.join(' | ').slice(0, 1200)}`,
  ].join('\n')
  const r = await $.model
    .complete({
      model: MODEL,
      maxTokens: 700,
      timeoutMs: 45_000,
      system:
        'You split one work session into separate pieces of work when it clearly covers more than one. Answer JSON only: {"chunks":[{"label":"3-8 plain words","share":0.5,"ticket":"KEY-1 or empty","branch":"branch or empty"}]}. Shares add up to 1. One chunk when it is one piece of work. Never mention AI or assistants.',
      prompt: facts,
    })
    .catch(() => null)
  if (!r || !r.isAnswered) return fallback
  try {
    const parsed = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)) as { chunks?: Chunk[] }
    const list = (parsed.chunks ?? []).filter(c => typeof c.label === 'string' && typeof c.share === 'number')
    if (list.length === 0) return fallback
    const total = list.reduce((a, c) => a + c.share, 0) || 1

    return list.map(c => ({ label: cleanLabel(scrubAi(c.label), 60), share: c.share / total, ticket: (c.ticket ?? '').toUpperCase(), branch: c.branch ?? '' }))
  } catch {
    return fallback
  }
}

async function saveSplit($: E$): Promise<void> {
  const x = await read($, ui)
  const splits = await getStore<Record<string, Chunk[]>>($, 'splits', {})
  const total = x.chunks.reduce((a, c) => a + c.share, 0) || 1
  if (x.chunks.length <= 1) delete splits[x.unitId]
  else splits[x.unitId] = x.chunks.map(c => ({ ...c, share: c.share / total }))
  await setStore($, 'splits', splits)
  // Chunk tickets become links the person already chose here.
  const links = await getStore<Record<string, string>>($, 'links', {})
  x.chunks.forEach((c, i) => {
    if (x.chunks.length > 1 && c.ticket) links[`${x.unitId}#${i}`] = c.ticket
  })
  await setStore($, 'links', links)
  await say($, x.chunks.length > 1 ? `Split into ${x.chunks.length} parts.` : 'Kept as one piece of work.')
  await go($, 'main')
  await refresh($, false)
}

/** One unit standing for several: their requests, commits, files and time together. */
function mergeUnits(units: Unit[]): Unit | undefined {
  const first = units[0]
  if (!first || units.length === 1) return first

  return {
    ...first,
    minutes: units.reduce((a, u) => a + u.minutes, 0),
    prompts: units.flatMap(u => u.prompts),
    commits: units.flatMap(u => u.commits),
    files: [...new Set(units.flatMap(u => u.files))],
    keys: [...new Set(units.flatMap(u => u.keys))],
    label: [...new Set(units.map(u => u.label))].join('; '),
  }
}

/** The units the current Link / Create ticket flow covers. */
async function flowUnits($: E$, unitId: string): Promise<Unit[]> {
  const x = await read($, ui)
  const m = await read($, model)
  const ids = x.groupIds.includes(unitId) ? x.groupIds : [unitId]

  return m.units.filter(u => ids.includes(u.id))
}

async function startNew($: E$, unitId: string, groupIds: string[] = []): Promise<void> {
  await update($, ui, x => ({ ...x, groupIds }))
  const u = mergeUnits(await flowUnits($, unitId))
  const s = await loadSettings($)
  const project = u?.project || s.projects[0]?.key || ''
  const cfg = s.projects.find(p => p.key === project) ?? blankProject(project)
  await update($, ui, x => ({
    ...x,
    tab: 'new' as Tab,
    view: 'main' as View,
    unitId,
    form: { ...EMPTY_FORM, unitId, project, issueType: cfg.issueType || 'Task', summary: cfg.prefix, description: cfg.template },
  }))
  await loadFormLists($, project, u)
}

async function loadFormLists($: E$, project: string, u?: Unit): Promise<void> {
  const s = await loadSettings($)
  if (!project || !s.cloudId) return
  let types = typeCache.get(project)
  if (!types) {
    types = await jiraIssueTypes($, s.cloudId, project).catch(() => [])
    typeCache.set(project, types)
  }
  const stories = await storiesFor($, project)
  const ranked = u ? rankStories(u, stories) : stories
  const best = ranked[0] && ranked[0].score > 0 ? ranked[0].key : ''
  await update($, ui, x => ({ ...x, form: { ...x.form, types: types ?? [], stories: ranked.slice(0, 15), parent: x.form.parent || best } }))
}

async function suggestSummary($: E$): Promise<void> {
  const x = await read($, ui)
  const u = mergeUnits(await flowUnits($, x.form.unitId))
  const s = await loadSettings($)
  const cfg = s.projects.find(p => p.key === x.form.project) ?? blankProject(x.form.project)
  await update($, busy, () => 'Writing a summary…')
  const facts = u
    ? `repo ${u.repo}, branch ${u.branch}; commits: ${u.commits.map(c => c.subject).join('; ') || 'none'}; requests: ${u.prompts.join(' | ').slice(0, 900)}`
    : x.form.description
  const r = await $.model
    .complete({
      model: MODEL,
      maxTokens: 120,
      timeoutMs: 30_000,
      system:
        'Write one Jira ticket title for this work: brief, plain, lower-case start, not too specific, at most 12 words, no trailing period, no ticket keys. Example: "review deeplink handling against UIKit on 2.32.0". Never mention AI, assistants, tools or that anything was generated. Answer the title only.',
      prompt: facts,
    })
    .catch(() => null)
    .finally(() => update($, busy, () => ''))
  if (!r || !r.isAnswered) {
    await say($, 'No summary could be suggested just now.')

    return
  }
  const title = scrubAi(r.text.split('\n')[0]!.replace(/^["']|["']$/g, '').trim())
  await update($, ui, y => ({ ...y, form: { ...y.form, summary: withPrefix(cfg.prefix, title) } }))
}

async function previewNew($: E$): Promise<void> {
  const x = await read($, ui)
  const f = x.form
  const s = await loadSettings($)
  const cfg = s.projects.find(p => p.key === f.project) ?? blankProject(f.project)
  if (!f.project || !f.issueType || f.summary.trim() === '' || f.summary.trim() === cfg.prefix) {
    await say($, 'Project, issue type and a summary are needed.')

    return
  }
  const covered = await flowUnits($, f.unitId)
  const u = covered[0]
  const ids = covered.map(v => v.id)
  const actions: Action[] = [
    {
      id: 'create',
      kind: 'create',
      isOn: true,
      key: 'NEW#1',
      unitIds: ids,
      project: f.project,
      issueType: f.issueType,
      summary: withPrefix(cfg.prefix, f.summary),
      description: f.description.trim(),
      labels: f.labels.split(/[\s,]+/).filter(Boolean),
      parent: f.parent,
      assignee: f.assignee === 'me' ? s.accountId : '',
    },
  ]
  if (u) actions.push({ id: 'link', kind: 'link', isOn: true, key: 'NEW#1', unitIds: ids })
  const oneBranch = new Set(covered.map(v => v.branch)).size === 1
  if (u && u.branch && oneBranch && f.rename && !['main', 'master', 'develop', 'dev', 'HEAD'].includes(u.branch)) {
    const to = branchFor(cfg.branchPattern, 'NEW#1', slugify(f.summary.replace(cfg.prefix, '')))
    if (!branchFollows(u.branch, cfg.branchPattern, 'NEW#1')) {
      const pushed = await gitIsPushed($, u.root, u.branch)
      actions.push({ id: 'rename', kind: 'rename', isOn: true, key: 'NEW#1', unitIds: ids, root: u.root, from: u.branch, to, isPushed: pushed })
    }
  }
  await go($, 'preview', { actions, backTo: 'main' })
}

/** Worklog + status (+ story link) actions for units, grouped per ticket per day. */
async function logActions($: E$, units: Unit[]): Promise<Action[]> {
  const s = await loadSettings($)
  const groups = new Map<string, Unit[]>()
  for (const u of units.filter(u => u.ticket && isOpen(u))) groups.set(`${u.ticket}|${u.day}`, [...(groups.get(`${u.ticket}|${u.day}`) ?? []), u])
  const actions: Action[] = []
  const seenTickets = new Set<string>()
  for (const [k, list] of groups) {
    const key = k.split('|')[0]!
    const options = timeOptions(list, off)
    const t = ticketIndex.get(key)
    actions.push({
      id: `wl:${k}`,
      kind: 'worklog',
      isOn: true,
      key,
      unitIds: list.map(u => u.id),
      options,
      pick: 'C',
      customStart: clock(options[0]!.startMs, off),
      customDur: fmtMin(options.find(o => o.code === 'C')!.minutes),
      comment: '',
      remainingSec: t?.remainingSec ?? 0,
    })
    if (seenTickets.has(key)) continue
    seenTickets.add(key)
    const project = projectOfKey(key)
    const cfg = s.projects.find(p => p.key === project)
    let transitions: Action['transitions'] = []
    try {
      if (s.cloudId) transitions = await jiraTransitions($, s.cloudId, key)
    } catch {
      transitions = []
    }
    actions.push({ id: `tr:${key}`, kind: 'transition', isOn: true, key, unitIds: list.map(u => u.id), transitions, transitionId: '', usedBefore: cfg?.lastStatus ?? '' })
    if (t && !t.parentKey && !/epic|story/i.test(t.type)) {
      const ranked = rankStories(list[0]!, await storiesFor($, project)).slice(0, 4)
      if (ranked.length > 0) {
        actions.push({ id: `pa:${key}`, kind: 'parent', isOn: ranked[0]!.score > 0.5, key, unitIds: [], parentKey: ranked[0]!.score > 0 ? ranked[0]!.key : '', transitions: ranked.map(r => ({ id: r.key, name: r.summary, to: r.type })) })
      }
    }
  }

  return actions
}

async function startLog($: E$, units: Unit[], backTo: View = 'main'): Promise<void> {
  if (units.length === 0) {
    await say($, 'Nothing linked to log here.')

    return
  }
  await update($, busy, () => 'Preparing the preview…')
  const actions = await logActions($, units).finally(() => update($, busy, () => ''))
  await go($, 'preview', { actions, backTo })
}

/** Close work with no ticket: kept out of every list and count until restored. Local only. */
async function setIgnored($: E$, ids: string[], isIgnored: boolean): Promise<void> {
  const cur = new Set(await getStore<string[]>($, 'ignored', []))
  for (const id of ids) {
    if (isIgnored) cur.add(id)
    else {
      cur.delete(id)
      cur.delete(id.split('#')[0]!)
    }
  }
  await setStore($, 'ignored', [...cur].slice(-5000))
  const n = ids.length
  await say($, isIgnored ? `Ignored ${n} session${n === 1 ? '' : 's'}. Restore from "Ignored" under the week.` : `Restored ${n} session${n === 1 ? '' : 's'}.`)
  await update($, model, m => {
    const set = new Set(ids)
    const units = m.units.map(u => (set.has(u.id) ? { ...u, isIgnored } : u))

    return { ...m, units, weeks: m.weeks.map(w => ({ ...w, unlinked: isIgnored ? w.unlinked.filter(u => !set.has(u.id)) : w.unlinked })) }
  })
  await refresh($, false)
}

async function setCollapsed($: E$, ids: string[], isFolded: boolean): Promise<void> {
  await update($, ui, x => ({ ...x, collapsed: isFolded ? [...new Set([...x.collapsed, ...ids])] : x.collapsed.filter(c => !ids.includes(c)) }))
  await setStore($, 'collapsed', (await read($, ui)).collapsed.slice(-500))
}

async function toggleCollapsed($: E$, id: string): Promise<void> {
  await update($, ui, x => ({ ...x, collapsed: x.collapsed.includes(id) ? x.collapsed.filter(c => c !== id) : [...x.collapsed, id] }))
  await setStore($, 'collapsed', (await read($, ui)).collapsed.slice(-500))
}

async function closeWeek($: E$, start: string): Promise<void> {
  const m = await read($, model)
  const units = m.units.filter(u => weekOf(u.day) === start && u.ticket && isOpen(u))
  const actions = units.length > 0 ? await logActions($, units) : []
  actions.push({ id: `close:${start}`, kind: 'link', isOn: true, key: '', unitIds: [], to: start })
  await go($, 'preview', { actions, backTo: 'main' })
}

// ---------------------------------------------------------------------------
// The preview: one screen, then the writes (spec §5.8)
// ---------------------------------------------------------------------------

function pickedTime(a: Action, day: string): { startMs: number; minutes: number } | null {
  if (a.pick === 'D') {
    const startMs = parseClock(day, a.customStart ?? '', off)
    const minutes = parseDuration(a.customDur ?? '')
    if (!Number.isFinite(startMs) || !Number.isFinite(minutes) || minutes <= 0) return null

    return { startMs, minutes }
  }
  const o = (a.options ?? []).find(x => x.code === a.pick) ?? (a.options ?? [])[0]

  return o ? { startMs: o.startMs, minutes: o.minutes } : null
}

function outgoingText(a: Action): string {
  return [a.summary, a.description, a.comment, ...(a.labels ?? [])].filter(Boolean).join(' \n ')
}

async function sendPreview($: E$): Promise<void> {
  const x = await read($, ui)
  const actions = x.actions.filter(a => a.isOn)
  if (actions.length === 0) {
    await say($, 'Nothing is selected.')

    return
  }
  // Final check before anything leaves: no AI mentions anywhere (spec §2).
  const bad = actions.flatMap(a => aiWords(outgoingText(a)).map(w => `${a.kind} ${a.key}: "${w}"`))
  if (bad.length > 0) {
    await say($, `Not sent. Remove these words first: ${bad.join(', ')}`)

    return
  }
  for (const a of actions.filter(a => a.kind === 'worklog' || a.kind === 'edit-worklog')) {
    const u = await unitById($, a.unitIds[0] ?? '')
    const day = u?.day ?? dayOf(a.options?.[0]?.startMs ?? Date.now(), off)
    if (!a.isRemove && !pickedTime(a, day)) {
      await say($, `Not sent: the custom time for ${a.key} is not readable (start like 09:30, duration like 1h 30m).`)

      return
    }
  }
  await update($, busy, () => `Sending ${actions.length} change${actions.length === 1 ? '' : 's'} to Jira…`)
  const failed = await runActions($, actions).finally(() => update($, busy, () => ''))
  const sent = actions.length - failed.length
  await say($, failed.length === 0 ? `Done: ${sent} change${sent === 1 ? '' : 's'} sent.` : `${sent} sent, ${failed.length} queued to retry: ${failed[0]!.error ?? ''}`)
  await update($, ui, u => ({ ...u, actions: [], view: 'main' as View, tab: (u.tab === 'new' ? 'log' : u.tab) as Tab }))
  await refresh($)
}

/** Runs confirmed actions in order; answers the ones that failed (queued). */
async function runActions($: E$, actions: Action[]): Promise<Action[]> {
  const s = await loadSettings($)
  const order: Action['kind'][] = ['create', 'link', 'parent', 'rename', 'worklog', 'edit-worklog', 'transition']
  const sorted = [...actions].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
  const made = new Map<string, string>()
  const failed: Action[] = []
  const realKey = (k: string) => made.get(k) ?? k
  for (const a0 of sorted) {
    const a = { ...a0, key: realKey(a0.key), to: a0.to?.replace(/NEW#1/g, realKey('NEW#1')) }
    if (a.key.startsWith('NEW#')) {
      failed.push({ ...a0, error: 'its ticket was not created' })
      continue
    }
    try {
      await runOne($, s, a, made)
    } catch (err) {
      failed.push({ ...a0, key: a.key, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (failed.length > 0) {
    const q = await getStore<Action[]>($, 'queue', [])
    await setStore($, 'queue', [...q, ...failed].slice(-200))
    await update($, queueSize, () => q.length + failed.length)
  }
  // A create that ran opens the time and status questions for the new ticket.
  const newKey = made.get('NEW#1')
  if (newKey) {
    $.clock.after(1500, () => void followNew($, newKey, actions.find(a => a.kind === 'link')?.unitIds ?? []))
  }

  return failed
}

async function runOne($: E$, s: Settings, a: Action, made: Map<string, string>): Promise<void> {
  switch (a.kind) {
    case 'create': {
      const key = await jiraCreateIssue($, s.cloudId, {
        project: a.project ?? '',
        issueType: a.issueType ?? 'Task',
        summary: a.summary ?? '',
        description: a.description ?? '',
        labels: a.labels ?? [],
        parent: a.parent ?? '',
        assignee: a.assignee ?? '',
      })
      made.set('NEW#1', key)
      await addWrite($, { kind: 'create', key, unitIds: a.unitIds, worklogId: '', startedMs: 0, minutes: 0, text: a.summary ?? '' })

      return
    }
    case 'link': {
      if (a.id.startsWith('close:')) {
        const closed = await getStore<string[]>($, 'closedWeeks', [])
        await setStore($, 'closedWeeks', [...new Set([...closed, a.to ?? ''])])

        return
      }
      const links = await getStore<Record<string, string>>($, 'links', {})
      for (const id of a.unitIds) links[id] = a.key
      await setStore($, 'links', links)
      const u = await unitById($, a.unitIds[0] ?? '')
      if (u?.branch) {
        const bl = await getStore<Record<string, string>>($, 'branchLinks', {})
        bl[`${u.repo}:${u.branch}`] = a.key
        await setStore($, 'branchLinks', bl)
      }

      return
    }
    case 'parent': {
      if (!a.parentKey) return
      await jiraSetParent($, s.cloudId, a.key, a.parentKey)
      await addWrite($, { kind: 'parent', key: a.key, unitIds: [], worklogId: '', startedMs: 0, minutes: 0, text: a.parentKey })

      return
    }
    case 'rename': {
      await gitRenameBranch($, a.root ?? '', a.from ?? '', a.to ?? '', a.isPushed === true)
      const u = await unitById($, a.unitIds[0] ?? '')
      if (u) {
        const bl = await getStore<Record<string, string>>($, 'branchLinks', {})
        bl[`${u.repo}:${a.to}`] = a.key
        await setStore($, 'branchLinks', bl)
      }
      await addWrite($, { kind: 'rename', key: a.key, unitIds: a.unitIds, worklogId: '', startedMs: 0, minutes: 0, text: `${a.from} → ${a.to}` })

      return
    }
    case 'worklog':
    case 'edit-worklog': {
      // Never log the same unit twice (spec §2): check the local record first.
      if (a.kind === 'worklog') {
        const done = new Set((await writes($)).filter(w => w.kind === 'worklog').flatMap(w => w.unitIds))
        if (a.unitIds.some(id => done.has(id))) throw new Error('already logged; skipped')
      }
      const u = await unitById($, a.unitIds[0] ?? '')
      const day = u?.day ?? dayOf(a.options?.[0]?.startMs ?? Date.now(), off)
      const t = a.isRemove ? { startMs: a.options?.[0]?.startMs ?? Date.now(), minutes: 0 } : pickedTime(a, day)
      if (!t) throw new Error('unreadable time')
      const id = await jiraPutWorklog($, s.cloudId, {
        key: a.key,
        started: jiraStarted(t.startMs, off),
        minutes: Math.round(t.minutes),
        comment: (a.comment ?? '').trim(),
        worklogId: a.worklogId,
      })
      await addWrite($, { kind: a.kind, key: a.key, unitIds: a.unitIds, worklogId: id, startedMs: t.startMs, minutes: Math.round(t.minutes), text: a.comment ?? '' })

      return
    }
    case 'transition': {
      if (!a.transitionId) return
      await jiraTransition($, s.cloudId, a.key, a.transitionId)
      const name = (a.transitions ?? []).find(t => t.id === a.transitionId)?.to ?? ''
      const settings = await loadSettings($)
      const project = projectOfKey(a.key)
      const has = settings.projects.some(p => p.key === project)
      const projects = has
        ? settings.projects.map(p => (p.key === project ? { ...p, lastStatus: name } : p))
        : [...settings.projects, { ...blankProject(project), lastStatus: name }]
      await setStore($, 'settings', { ...settings, projects })
      await addWrite($, { kind: 'transition', key: a.key, unitIds: a.unitIds, worklogId: '', startedMs: 0, minutes: 0, text: name })

      return
    }
  }
}

async function followNew($: E$, key: string, unitIds: string[]): Promise<void> {
  await refresh($)
  const m = await read($, model)
  const units = m.units.filter(u => unitIds.includes(u.id) || (u.ticket === key && isOpen(u)))
  if (units.length === 0) return
  await say($, `${key} created. Now the time and status for it:`)
  await startLog($, units)
}

async function retryQueue($: E$): Promise<void> {
  const q = await getStore<Action[]>($, 'queue', [])
  await update($, queueSize, () => q.length)
  if (q.length === 0) return
  await setStore($, 'queue', [])
  const failed = await runActions(
    $,
    q.map(a => ({ ...a, error: undefined })),
  )
  await update($, queueSize, () => failed.length)
  if (failed.length < q.length) await say($, `Retried the queue: ${q.length - failed.length} sent, ${failed.length} still waiting.`)
}

// ---------------------------------------------------------------------------
// Manual check (spec §6)
// ---------------------------------------------------------------------------

async function runCheck($: E$, days = 1): Promise<void> {
  await go($, 'check', { check: [] })
  await update($, busy, () => 'Checking repos and tickets…')
  try {
    await refresh($)
    const m = await read($, model)
    const from = addDays(today(), -(days - 1))
    const units = m.units.filter(u => u.day >= from)
    const out: LooseEnd[] = []
    const roots = new Map(units.map(u => [u.root, u.repo]))
    for (const [root, repo] of roots) {
      const dirty = await gitUncommitted($, root)
      if (dirty > 0) out.push({ kind: 'uncommitted', text: `${dirty} uncommitted change${dirty === 1 ? '' : 's'}`, repo, root, unitId: '', key: '', command: `git -C "${root}" status` })
      const branches = new Set(units.filter(u => u.root === root).map(u => u.branch).filter(Boolean))
      for (const b of await gitUnpushed($, root)) {
        if (!branches.has(b.branch)) continue
        if (!b.upstream) out.push({ kind: 'unpushed', text: `${b.branch} was never pushed`, repo, root, unitId: '', key: '', command: `git -C "${root}" push -u origin ${b.branch}` })
        else if (b.ahead > 0) out.push({ kind: 'unpushed', text: `${b.branch}: ${b.ahead} commit${b.ahead === 1 ? '' : 's'} not pushed`, repo, root, unitId: '', key: '', command: `git -C "${root}" push` })
        else if (!['main', 'master', 'develop', 'dev'].includes(b.branch)) {
          const mr = await gitHasMergeRequest($, root, b.branch)
          if (mr === false) out.push({ kind: 'no-mr', text: `${b.branch} is pushed with no open merge request`, repo, root, unitId: '', key: '', command: `git -C "${root}" push -o merge_request.create origin ${b.branch}` })
        }
      }
    }
    for (const u of units.filter(u => !u.ticket && isOpen(u))) {
      out.push({ kind: 'no-ticket', text: `${dayLabel(u.day)} ${fmtMin(u.minutes)} · ${u.label}`, repo: u.repo, root: u.root, unitId: u.id, key: '', command: '' })
    }
    for (const u of units.filter(u => u.ticket && isOpen(u))) {
      out.push({ kind: 'not-logged', text: `${u.ticket} ${fmtMin(u.minutes)} on ${dayLabel(u.day)} not logged`, repo: u.repo, root: u.root, unitId: u.id, key: u.ticket, command: '' })
    }
    for (const key of new Set(units.filter(u => u.ticket).map(u => u.ticket))) {
      const t = ticketIndex.get(key)
      const hasCommits = units.some(u => u.ticket === key && u.commits.length > 0)
      if (t && t.statusCat === 'new' && hasCommits) {
        out.push({ kind: 'status-behind', text: `${key} is still "${t.status}" but has commits`, repo: '', root: '', unitId: units.find(u => u.ticket === key)!.id, key, command: '' })
      }
    }
    await update($, ui, x => ({ ...x, check: out }))
  } finally {
    await update($, busy, () => '')
  }
}

// ---------------------------------------------------------------------------
// Edit or undo, manual time (spec §5.9, §3.1)
// ---------------------------------------------------------------------------

async function editWorklog($: E$, w: WriteRec, isRemove: boolean): Promise<void> {
  const day = dayOf(w.startedMs, off)
  const a: Action = {
    id: `ed:${w.worklogId}`,
    kind: 'edit-worklog',
    isOn: true,
    key: w.key,
    unitIds: [],
    worklogId: w.worklogId,
    isRemove,
    options: [{ code: 'A', startMs: w.startedMs, minutes: w.minutes, why: 'as logged' }],
    pick: 'D',
    customStart: clock(w.startedMs, off),
    customDur: fmtMin(w.minutes),
    comment: w.text,
  }
  void day
  await go($, 'preview', { actions: [a], backTo: 'history' })
}

async function previewAddTime($: E$): Promise<void> {
  const x = await read($, ui)
  const t = x.addTime
  const key = t.key.trim().toUpperCase()
  const day = t.date.trim() || today()
  const startMs = parseClock(day, t.start, off)
  const minutes = parseDuration(t.dur)
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key) || !/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(startMs) || !Number.isFinite(minutes)) {
    await say($, 'Give a ticket key, a date (YYYY-MM-DD), a start (09:30) and a duration (1h 30m).')

    return
  }
  const s = await loadSettings($)
  const transitions = s.cloudId ? await jiraTransitions($, s.cloudId, key).catch(() => []) : []
  const cfg = s.projects.find(p => p.key === projectOfKey(key))
  await go($, 'preview', {
    backTo: 'add-time',
    actions: [
      {
        id: 'manual',
        kind: 'worklog',
        isOn: true,
        key,
        unitIds: [`manual|${day}|${startMs}`],
        options: [{ code: 'D', startMs, minutes, why: 'entered by hand' }],
        pick: 'D',
        customStart: t.start,
        customDur: t.dur,
        comment: t.comment,
      },
      { id: `tr:${key}`, kind: 'transition', isOn: true, key, unitIds: [], transitions, transitionId: '', usedBefore: cfg?.lastStatus ?? '' },
    ],
  })
}

// ---------------------------------------------------------------------------
// Setup (spec §11)
// ---------------------------------------------------------------------------

type SetupDraft = Settings & { projectKeys: string }

async function openSetup($: E$): Promise<void> {
  const s = await loadSettings($)
  const draft: SetupDraft = { ...s, projectKeys: s.projects.map(p => p.key).join(', ') }
  await go($, 'setup', { setupDraft: JSON.stringify(draft) })
  if (!s.cloudId) {
    try {
      const site = await jiraSite($)
      await update($, ui, x => ({ ...x, setupDraft: JSON.stringify({ ...draft, cloudId: site.cloudId, site: site.url }) }))
    } catch (err) {
      await say($, `The Atlassian connection did not answer: ${err instanceof Error ? err.message : String(err)}. Check /mcp.`)
    }
  }
}

async function patchDraft($: E$, fn: (d: SetupDraft) => SetupDraft): Promise<void> {
  await update($, ui, x => ({ ...x, setupDraft: JSON.stringify(fn(JSON.parse(x.setupDraft || '{}') as SetupDraft)) }))
}

async function saveSetup($: E$): Promise<void> {
  const d = JSON.parse((await read($, ui)).setupDraft || '{}') as SetupDraft
  const keys = d.projectKeys
    .split(/[\s,]+/)
    .map(k => k.trim().toUpperCase())
    .filter(Boolean)
  const projects = keys.map(k => d.projects.find(p => p.key === k) ?? blankProject(k))
  const { projectKeys: _drop, ...rest } = d
  void _drop
  const s: Settings = { ...rest, projects, setupDone: true }
  await setStore($, 'settings', s)
  await startTimer($)
  await say($, 'Settings saved.')
  await go($, 'main')
  await refresh($)
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

type El = ReturnType<E$['ui']['resolve']>

function chip(B: El['Button'], key: string, label: string, isOn: boolean, onPress: () => unknown, hotkey?: string) {
  return hotkey ? (
    <B key={key} label={label} hotkey={hotkey} variant={isOn ? 'primary' : 'secondary'} onPress={() => void onPress()} />
  ) : (
    <B key={key} label={label} variant={isOn ? 'primary' : 'secondary'} onPress={() => void onPress()} />
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await initEnv($)
    const cmds: [string, string][] = [
      ['jira', 'Open the Jira session tracker pane'],
      ['jira-log', 'Log work for the current session'],
      ['jira-link', 'Link the current session to a ticket: /jira-link [KEY]'],
      ['jira-new', 'Create a Jira ticket from the current session'],
      ['jira-check', 'Check for loose ends: uncommitted, unpushed, unlinked, unlogged'],
      ['jira-wrapup', 'End-of-day wrap-up of all sessions'],
      ['jira-standup', 'Standup notes from your sessions and tickets'],
      ['jira-setup', 'Set up the Jira tracker (projects, hours, days off)'],
    ]
    for (const [name, description] of cmds) await $.command.register({ name, description })
    const sid = await $.session.id().catch(() => '')
    const log = await getStore<{ sid: string; cwd: string; startedAt: number; endedAt: number }[]>($, 'sessionLog', [])
    if (sid && !log.some(x => x.sid === sid)) await setStore($, 'sessionLog', [...log, { sid, cwd: e.cwd, startedAt: Date.now(), endedAt: 0 }].slice(-1000))
    const queuedNow = (await getStore<Action[]>($, 'queue', [])).length
    await update($, queueSize, () => queuedNow)
    const keptCollapsed = await getStore<string[]>($, 'collapsed', [])
    await update($, ui, x => ({ ...x, collapsed: keptCollapsed }))
    minuteTick?.cancel()
    minuteTick = $.clock.every(60_000, () => void endOfDayTick($))
    await startTimer($)
    $.clock.after(3_000, () => void refresh($, false))

    return r
  })

  on('session.end', async ($, e, next) => {
    const log = await getStore<{ sid: string; cwd: string; startedAt: number; endedAt: number }[]>($, 'sessionLog', [])
    await setStore(
      $,
      'sessionLog',
      log.map(x => (x.sid === e.sessionId ? { ...x, endedAt: Date.now() } : x)),
    )
    const m = await read($, model)
    const mine = m.units.filter(u => u.sid === e.sessionId)
    if (mine.length > 0 && mine.every(u => !u.ticket)) $.ui.toast(`This session (${fmtMin(mine.reduce((a, u) => a + u.minutes, 0))}) ended with no Jira ticket. Link it from /jira.`)

    return next(e)
  })

  on('command.run', { command: 'jira' }, async $ => {
    await openPane($, 'log', 'main')

    return { text: 'Opened the Jira pane.' }
  })

  on('command.run', { command: 'jira-setup' }, async $ => {
    if (await openPane($)) await openSetup($)

    return { text: 'Opened Jira setup.' }
  })

  on('command.run', { command: 'jira-check' }, async $ => {
    if (await openPane($)) $.clock.after(0, () => void runCheck($))

    return { text: 'Running the Jira check.' }
  })

  on('command.run', { command: 'jira-wrapup' }, async $ => {
    if (await openPane($, 'log', 'wrapup')) $.clock.after(0, () => void refresh($))

    return { text: 'Opened the end-of-day wrap-up.' }
  })

  on('command.run', { command: 'jira-standup' }, async $ => {
    await openPane($, 'log', 'standup')

    return { text: 'Opened standup notes.' }
  })

  on('command.run', { command: 'jira-log' }, async $ => {
    if (!(await openPane($))) return { text: 'The Jira pane could not open.' }
    await refresh($, true)
    const u = await currentUnit($)
    if (!u) return { text: 'This session has no recorded work yet.' }
    if (!u.ticket) {
      await go($, 'link', { unitId: u.id, groupIds: [] })

      return { text: 'This session has no ticket yet: pick one to link first.' }
    }
    await startLog($, [u])

    return { text: `Preparing a worklog for ${u.ticket}.` }
  })

  on('command.run', { command: 'jira-link' }, async ($, e) => {
    if (!(await openPane($))) return { text: 'The Jira pane could not open.' }
    await refresh($, true)
    const u = await currentUnit($)
    if (!u) return { text: 'This session has no recorded work yet.' }
    const key = e.args.trim()
    if (key) {
      await linkUnit($, u.id, key)

      return { text: `Linked this session to ${key.toUpperCase()}.` }
    }
    await go($, 'link', { unitId: u.id, groupIds: [] })

    return { text: 'Pick a ticket for this session.' }
  })

  on('command.run', { command: 'jira-new' }, async $ => {
    if (!(await openPane($))) return { text: 'The Jira pane could not open.' }
    await refresh($, true)
    const u = await currentUnit($)
    await startNew($, u?.id ?? '')

    return { text: 'Opened the new ticket form.' }
  })

  // The status-bar button: opens the pane, or closes it when open. Opened
  // inside the press so it counts as asked for.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const m = await read($, model)
    const pending = listedUnits(m).length
    const fill = paneOpen ? '#B3D4FF' : C.accent

    return statusGrid(
      { Box, Text },
      below,
      e.props.modes,
      <Button
        key="open-jira"
        plain
        onPress={async () => {
          if (paneOpen) {
            await $.ui.close({ id: PANE })

            return
          }
          await openPane($, 'log', 'main')
        }}
      >
        <Text color={fill}>▐</Text>
        <Text backgroundColor={fill} color="#091E42" bold>
          {pending > 0 ? `◷ Jira ${pending}` : '◷ Jira'}
        </Text>
        <Text color={fill}>▌</Text>
      </Button>,
    ) as never
  })

  // Esc goes back from a sub-screen, and closes from the main one.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const x = await read($, ui)
    if (e.origin.kind === 'person' && x.view !== 'main') {
      await back($)

      return { value: undefined }
    }
    paneOpen = false
    timer?.cancel()
    await startTimer($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const Input = 'Input' in el ? el.Input : undefined
    const Select = 'Select' in el ? el.Select : undefined
    const width = Math.max(50, e.props.bodyColumns ?? 100)
    const m = await read($, model)
    const x = await read($, ui)
    const working = await read($, busy)
    const last = await read($, note)
    const queued = await read($, queueSize)
    const s = await loadSettings($)

    const unlinkedAll = m.weeks.flatMap(w => w.unlinked)
    const toLog = listedUnits(m)
    const toLogMin = toLog.reduce((a, u) => a + u.minutes, 0)
    const openTickets = m.tickets.filter(t => t.statusCat !== 'done')
    const setupLater = await getStore<boolean>($, 'setupLater', false)

    const tab = (key: string, hotkey: string, label: string, isOn: boolean, onPress: () => unknown) => (
      <Button key={key} plain hotkey={hotkey} onPress={() => void onPress()}>
        <Text bold={isOn} underline={isOn} color={isOn ? C.accent : undefined} dimColor={!isOn}>
          {label}
        </Text>
      </Button>
    )
    const tool = (key: string, label: string, onPress: () => unknown) => (
      <Button
        key={key}
        plain
        onPress={() =>
          void (async () => {
            await update($, ui, u => ({ ...u, toolsOpen: false }))
            await onPress()
          })()
        }
      >
        <Text color={C.accent}>{label}</Text>
      </Button>
    )
    const dot = (k: string) => <Text dimColor>·</Text>
    const status = working || last
    const updated = m.loadedAt ? `Updated ${clock(m.loadedAt, off)}` : 'Loading…'

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" gap={2}>
            {tab('tab-log', '1', `Log work ${toLog.length} · ${fmtMin(toLogMin)}`, x.tab === 'log' && x.view === 'main', () => go($, 'main', { tab: 'log' }))}
            {tab('tab-tickets', '2', `Tickets ${openTickets.length}`, x.tab === 'tickets' && x.view === 'main', () => go($, 'main', { tab: 'tickets' }))}
            {tab('tab-new', '3', 'New', x.tab === 'new' && x.view === 'main', () => startNew($, x.unitId))}
            {tab('tab-dash', '4', 'Dashboard', x.tab === 'dash' && x.view === 'main', () => go($, 'main', { tab: 'dash', dashDay: x.dashDay || today() }))}
          </Box>
          <Box flexDirection="row" gap={2}>
            <Button key="tools" plain hotkey="t" onPress={() => void update($, ui, u => ({ ...u, toolsOpen: !u.toolsOpen }))}>
              <Text bold={x.toolsOpen} color={x.toolsOpen ? C.accent : undefined}>
                ⚙
              </Text>
            </Button>
            <Button key="refresh" plain hotkey="r" onPress={() => void $.clock.after(0, () => void refresh($))}>
              <Text color={working ? C.amber : undefined}>⟳</Text>
            </Button>
          </Box>
        </Box>
        {x.toolsOpen && (
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            {tool('t-add', '+ Add time', () => go($, 'add-time', { addTime: { key: '', date: today(), start: '09:00', dur: '1h', comment: '' } }))}
            {dot('d1')}
            {tool('t-wrap', 'Wrap-up', () => go($, 'wrapup'))}
            {dot('d2')}
            {tool('t-standup', 'Standup', () => go($, 'standup'))}
            {dot('d3')}
            {tool('t-sheet', 'Timesheet', () => go($, 'timesheet', { dashDay: today() }))}
            {dot('d4')}
            {tool('t-history', 'Edit logged', () => go($, 'history'))}
            {dot('d5')}
            {tool('t-check', 'Check', () => $.clock.after(0, () => void runCheck($)))}
            {dot('d6')}
            {tool('t-settings', 'Settings', () => openSetup($))}
          </Box>
        )}
        <Text dimColor>{'─'.repeat(Math.max(10, width - 1))}</Text>
        <Box flexDirection="row" justifyContent="space-between">
          <Text dimColor wrap="truncate-end">
            {status || ' '}
          </Text>
          <Text dimColor>{updated}</Text>
        </Box>
        {queued > 0 && (
          <Box flexDirection="row" gap={1}>
            <Text color={C.amber}>⚠ {queued} Jira change{queued === 1 ? '' : 's'} waiting to retry</Text>
            <Button key="retry" plain onPress={() => void $.clock.after(0, () => void retryQueue($))}>
              <Text color={C.accent}>Retry now</Text>
            </Button>
          </Box>
        )}
        {m.error !== '' && <Text color={C.red}>⚠ {m.error}</Text>}
        {!s.setupDone && !setupLater && (
          <Box flexDirection="row" gap={1}>
            <Text color={C.amber}>⚠ Set your projects and hours first.</Text>
            <Button key="setup-now" plain onPress={() => void openSetup($)}>
              <Text color={C.accent}>Set up</Text>
            </Button>
            <Text dimColor>·</Text>
            <Button key="setup-later" plain onPress={() => void setStore($, 'setupLater', true).then(() => update($, ui, u => ({ ...u })))}>
              <Text dimColor>Later</Text>
            </Button>
          </Box>
        )}
      </Box>
    )

    const body = await drawBody($, el, { m, x, s, width, unlinkedAll, Input, Select })

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {body}
      </Box>
    )
  })
}

// ---------------------------------------------------------------------------
// Body views
// ---------------------------------------------------------------------------

type Ctx = {
  m: Model
  x: Ui
  s: Settings
  width: number
  unlinkedAll: Unit[]
  Input: El['Input'] | undefined
  Select: El['Select'] | undefined
}

function fit(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length <= width ? one : `${one.slice(0, Math.max(1, width - 1))}…`
}

async function drawBody($: E$, el: El, c: Ctx) {
  switch (c.x.view) {
    case 'link':
      return drawLink($, el, c)
    case 'split':
      return drawSplit($, el, c)
    case 'preview':
      return drawPreview($, el, c)
    case 'check':
      return drawCheck($, el, c)
    case 'wrapup':
      return drawWrapup($, el, c)
    case 'standup':
      return drawStandup($, el, c)
    case 'timesheet':
      return drawTimesheet($, el, c)
    case 'history':
      return drawHistory($, el, c)
    case 'setup':
      return drawSetup($, el, c)
    case 'add-time':
      return drawAddTime($, el, c)
    default:
      break
  }
  if (c.x.tab === 'tickets') return drawTickets($, el, c, 'open')
  if (c.x.tab === 'new') return drawNew($, el, c)
  if (c.x.tab === 'dash') return drawDash($, el, c)

  return drawLog($, el, c)
}

/** Hours for the day strip: 2, 1.5, 0. */
function hrs(min: number): string {
  const hours = Math.round((min / 60) * 10) / 10

  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
}

function lastPart(path: string): { name: string; parent: string } {
  const parts = path.split('/')
  const name = parts.pop() || path

  return { name, parent: parts.join('/') }
}

function drawLog($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const { m } = c
  const now = today()
  if (m.loadedAt === 0) return <Text dimColor>Reading your sessions…</Text>
  const W = c.width
  // A row of plain text actions: `Link · Create · Split · Ignore`.
  const actions = (items: [string, string, () => unknown, string?][]) => (
    <Box flexDirection="row" gap={1} flexWrap="wrap">
      {items.flatMap(([key, label, onPress, color], i) => [
        ...(i > 0 ? [<Text dimColor>·</Text>] : []),
        <Button key={key} plain onPress={() => void onPress()}>
          <Text color={color ?? C.accent}>{label}</Text>
        </Button>,
      ])}
    </Box>
  )
  type Kid = ReturnType<typeof Text>
  const spread = (left: Kid, right: Kid) => (
    <Box flexDirection="row" justifyContent="space-between">
      {left}
      {right}
    </Box>
  )

  return (
    <Box flexDirection="column">
      {m.weeks.length === 0 && <Text dimColor>Nothing to log. Everything is linked, logged, ignored or closed.</Text>}
      {m.weeks.map(w => {
        const isThis = w.start === weekOf(now)
        const isOpenWeek = isThis !== c.x.weekToggled.includes(w.start)
        const target = w.days.reduce((a, d) => a + d.targetMin, 0)
        const unlinkedMin = w.unlinked.reduce((a, u) => a + u.minutes, 0)
        const ready = w.days.filter(d => d.linked.length > 0)
        const readyCount = ready.reduce((a, d) => a + d.linked.length, 0)
        const readyMin = ready.reduce((a, d) => a + d.linked.reduce((b, u) => b + u.minutes, 0), 0)
        const groups = groupUnits(w.unlinked, w.start)
        const ignored = m.units.filter(u => u.isIgnored && !u.isLogged && weekOf(u.day) === w.start)
        const isIgnShown = c.x.showIgnored.includes(w.start)
        const days = [...w.days].sort((a, b) => a.day.localeCompare(b.day))

        return (
          <Box key={`w-${w.start}`} flexDirection="column" marginBottom={1}>
            {spread(
              <Button
                key={`week-${w.start}`}
                plain
                onPress={() =>
                  void update($, ui, x => ({
                    ...x,
                    weekToggled: x.weekToggled.includes(w.start) ? x.weekToggled.filter(z => z !== w.start) : [...x.weekToggled, w.start],
                  }))
                }
              >
                <Text color={C.accent}>{isOpenWeek ? '▾' : '▸'}</Text>{' '}
                <Text bold color={C.accent}>
                  {isThis ? `This week · ${dayLabel(w.start).slice(4)}` : `Week of ${dayLabel(w.start).slice(4)}`}
                </Text>
              </Button>,
              <Text dimColor>
                {fmtMin(w.loggedMin)} / {fmtMin(target)} · {fmtMin(w.toLogMin)} to log
              </Text>,
            )}
            {isOpenWeek && (
              <Box flexDirection="column" paddingLeft={2}>
                <Text dimColor wrap="wrap">
                  {days.map(d => `${dayLabel(d.day).slice(0, 3)} ${d.targetMin === 0 && d.loggedMin === 0 ? '–' : `${hrs(d.loggedMin)}/${hrs(d.targetMin)}`}`).join(' · ')}
                </Text>
                {actions([[`close-${w.start}`, readyCount > 0 ? `Send & close week (${readyCount})` : 'Close week', () => $.clock.after(0, () => void closeWeek($, w.start))]])}

                {readyCount > 0 && (
                  <Box flexDirection="column" marginTop={1}>
                    <Text bold color={C.green}>
                      Ready to log · {readyCount} · {fmtMin(readyMin)}
                    </Text>
                    {ready
                      .sort((a, b) => b.day.localeCompare(a.day))
                      .map(d => (
                        <Box key={`d-${d.day}`} flexDirection="column">
                          {spread(
                            <Text bold>{dayLabel(d.day)}</Text>,
                            actions([[`send-${d.day}`, `Send the day (${d.linked.length})`, () => $.clock.after(0, () => void startLog($, d.linked))]]),
                          )}
                          {d.linked.map(u => (
                            <Box key={`l-${u.id}`} flexDirection="column" paddingLeft={2}>
                              <Text>
                                <Text color={C.accent}>{u.ticket}</Text> {fmtMin(u.minutes)} <Text dimColor>{fit(u.label, Math.max(12, W - 30))}</Text>
                              </Text>
                              <Box paddingLeft={2}>
                                {actions([
                                  [`log-${u.id}`, 'Log', () => $.clock.after(0, () => void startLog($, [u]))],
                                  [`relink-${u.id}`, 'Change ticket', () => go($, 'link', { unitId: u.id, groupIds: [] })],
                                ])}
                              </Box>
                            </Box>
                          ))}
                        </Box>
                      ))}
                  </Box>
                )}

                {w.unlinked.length > 0 && (
                  <Box flexDirection="column" marginTop={1}>
                    {spread(
                      <Text bold color={C.amber}>
                        No ticket · {w.unlinked.length} · {fmtMin(unlinkedMin)}
                      </Text>,
                      actions([
                        [`fold-all-${w.start}`, 'Fold all', () => setCollapsed($, groups.map(g => g.id), true)],
                        [`unfold-all-${w.start}`, 'Open all', () => setCollapsed($, groups.map(g => g.id), false)],
                      ]),
                    )}
                    {groups.map(g => {
                      const isFolded = c.x.collapsed.includes(g.id)
                      const where = lastPart(shortPath(g.root, home))
                      const right = `${g.units.length} · ${fmtMin(g.minutes)}`

                      return (
                        <Box key={`g-${g.id}`} flexDirection="column">
                          {spread(
                            <Button key={`fold-${g.id}`} plain onPress={() => void toggleCollapsed($, g.id)}>
                              <Text color={C.accent}>{isFolded ? '▸' : '▾'}</Text> <Text bold>{fit(where.name, 30)}</Text>{'  '}
                              <Text dimColor>{fitMiddle(where.parent, Math.max(6, W - 22 - Math.min(30, where.name.length) - right.length))}</Text>
                            </Button>,
                            <Text dimColor>{right}</Text>,
                          )}
                          {!isFolded && (
                            <Box flexDirection="column" paddingLeft={4}>
                              {g.units.length > 1 &&
                                actions([
                                  [`link-g-${g.id}`, `Link all ${g.units.length}`, () => go($, 'link', { unitId: g.units[0]!.id, groupIds: g.units.map(u => u.id) })],
                                  [`new-g-${g.id}`, 'One ticket', () => startNew($, g.units[0]!.id, g.units.map(u => u.id))],
                                  [`ign-g-${g.id}`, 'Ignore all', () => setIgnored($, g.units.map(u => u.id), true), C.muted],
                                ])}
                              {g.units.map(u => (
                                <Box key={`u-${u.id}`} flexDirection="column">
                                  <Text>
                                    {dayLabel(u.day).slice(4)} {fmtMin(u.minutes)} <Text color={C.violet}>{fit(u.branch || '-', 24)}</Text>{' '}
                                    <Text dimColor>{fit(u.label, Math.max(12, W - 52))}</Text>
                                  </Text>
                                  <Box paddingLeft={2}>
                                    {actions([
                                      ...(u.suggested ? ([[`use-${u.id}`, `Use ${u.suggested}`, () => linkUnit($, u.id, u.suggested), C.green]] as [string, string, () => unknown, string][]) : []),
                                      [`link-${u.id}`, 'Link', () => go($, 'link', { unitId: u.id, groupIds: [] })],
                                      [`new-${u.id}`, 'Create', () => startNew($, u.id)],
                                      [`split-${u.id}`, 'Split', () => $.clock.after(0, () => void startSplit($, u.id))],
                                      [`ign-${u.id}`, 'Ignore', () => setIgnored($, [u.id], true), C.muted],
                                    ])}
                                  </Box>
                                </Box>
                              ))}
                            </Box>
                          )}
                        </Box>
                      )
                    })}
                  </Box>
                )}

                {ignored.length > 0 && (
                  <Box flexDirection="column" marginTop={1}>
                    {spread(
                      <Button
                        key={`show-ign-${w.start}`}
                        plain
                        onPress={() =>
                          void update($, ui, x => ({
                            ...x,
                            showIgnored: x.showIgnored.includes(w.start) ? x.showIgnored.filter(z => z !== w.start) : [...x.showIgnored, w.start],
                          }))
                        }
                      >
                        <Text dimColor>
                          {isIgnShown ? '▾' : '▸'} Ignored ({ignored.length} · {fmtMin(ignored.reduce((a, u) => a + u.minutes, 0))})
                        </Text>
                      </Button>,
                      isIgnShown && ignored.length > 1 ? actions([[`rest-all-${w.start}`, 'Restore all', () => setIgnored($, ignored.map(u => u.id), false)]]) : <Text> </Text>,
                    )}
                    {isIgnShown &&
                      ignored.map(u => (
                        <Box key={`iu-${u.id}`} flexDirection="row" gap={1} paddingLeft={4}>
                          {actions([[`rest-${u.id}`, 'Restore', () => setIgnored($, [u.id], false)]])}
                          <Text dimColor>{fit(`${dayLabel(u.day).slice(4)} ${fmtMin(u.minutes)} · ${lastPart(u.root || u.cwd).name} · ${u.label}`, Math.max(12, W - 16))}</Text>
                        </Box>
                      ))}
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

function groupTickets(list: Ticket[]): { key: string; title: string; items: Ticket[] }[] {
  const groups = new Map<string, { key: string; title: string; items: Ticket[] }>()
  for (const t of list) {
    const k = t.parentKey || '~none'
    const g = groups.get(k) ?? { key: k, title: t.parentKey ? `${t.parentKey} ${t.parentSummary}` : 'No parent', items: [] }
    g.items.push(t)
    groups.set(k, g)
  }

  return [...groups.values()].sort((a, b) => (a.key === '~none' ? 1 : b.key === '~none' ? -1 : b.items.length - a.items.length))
}

function drawTickets($: E$, el: El, c: Ctx, mode: 'open' | 'pick', unitId = '', ids: string[] = [unitId]) {
  const { Box, Text, Button } = el
  const { x, m } = c
  const open = m.tickets.filter(t => t.statusCat !== 'done')
  const mine = open.filter(t => (x.projectFilter ? t.project === x.projectFilter : true))
  const projects = [...new Set(open.map(t => t.project))].sort()
  const pick = (t: Ticket) => (mode === 'pick' && unitId ? linkUnit($, unitId, t.key, ids) : openTicket($, c.s, t.key))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {chip(Button, 'pf-all', `All ${open.length}`, x.projectFilter === '', () => update($, ui, u => ({ ...u, projectFilter: '' })))}
        {projects.map(p =>
          chip(Button, `pf-${p}`, `${p} ${open.filter(t => t.project === p).length}`, x.projectFilter === p, () =>
            update($, ui, u => ({ ...u, projectFilter: u.projectFilter === p ? '' : p })),
          ),
        )}
      </Box>
      {c.Input && (
        <c.Input
          key="search"
          placeholder="Search by key or text…"
          value={x.search}
          submitLabel="search"
          onSubmit={(v: string) => void searchTickets($, v)}
        />
      )}
      {x.searchHits.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Search results</Text>
          {x.searchHits.map(t => (
            <Button key={`hit-${t.key}`} plain onPress={() => void pick(t)}>
              <Text color={C.accent}>{t.key}</Text> <Text dimColor>{t.status}</Text> {fit(t.summary, c.width - 30)}
            </Button>
          ))}
        </Box>
      )}
      {groupTickets(mine).map(g => (
        <Box key={`g-${g.key}`} flexDirection="column" marginTop={1}>
          <Text bold>
            {fit(g.title, c.width - 8)} <Text dimColor>({g.items.length})</Text>
          </Text>
          {g.items.map(t => (
            <Box key={`t-${t.key}`} flexDirection="row" gap={1}>
              <Button key={`tk-${t.key}`} plain onPress={() => void pick(t)}>
                {'  '}
                <Text color={C.accent}>{t.key}</Text> <Text color={t.statusCat === 'indeterminate' ? C.green : C.muted}>{t.status}</Text> {fit(t.summary, c.width - 34)}
              </Button>
              {mode === 'open' && x.unitId !== '' && (
                <Button key={`tl-${t.key}`} label="Link" onPress={() => void linkUnit($, x.unitId, t.key)} />
              )}
            </Box>
          ))}
        </Box>
      ))}
      {mine.length === 0 && <Text dimColor>No open tickets assigned to you{x.projectFilter ? ` in ${x.projectFilter}` : ''}.</Text>}
    </Box>
  )
}

async function openTicket($: E$, s: Settings, key: string): Promise<void> {
  const url = `${s.site || 'https://atlassian.net'}/browse/${key}`
  await $.process.run(['open', url], { timeoutMs: 5_000 }).catch(() => undefined)
}

function contextLine(u: Unit | undefined, count = 1): string {
  if (!u) return 'No session selected.'
  if (count > 1) return `For ${count} sessions in ${shortPath(u.root || u.cwd, home)} (${fmtMin(u.minutes)} in all): ${fit(u.label, 160)}`

  return `For the ${dayLabel(u.day)} work on ${u.repo} · ${u.branch || '-'} (${fmtMin(u.minutes)}): ${u.label}`
}

async function drawLink($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const ids = c.x.groupIds.includes(c.x.unitId) ? c.x.groupIds : [c.x.unitId]
  const u = mergeUnits(c.m.units.filter(v => ids.includes(v.id)))
  if (!u) return <Text dimColor>That session is no longer listed.</Text>
  const stories = u.project ? await storiesFor($, u.project) : []
  const cands = rankCandidates(u, c.m.tickets, c.m.inProgress, c.m.recent, stories).slice(0, 10)
  const mixed = ids.length > 1 ? '' : looksMixed(u)

  return (
    <Box flexDirection="column">
      <Text bold color={C.accent}>
        {ids.length > 1 ? `Link ${ids.length} sessions to one ticket` : 'Link to a ticket'}
      </Text>
      <Text dimColor wrap="wrap">
        {contextLine(u, ids.length)}
      </Text>
      {mixed !== '' && (
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Text color={C.amber}>This looks like several pieces of work ({mixed}).</Text>
          <Button key="go-split" label="Split it first" onPress={() => void $.clock.after(0, () => void startSplit($, u.id))} />
        </Box>
      )}
      <Text bold>Suggested</Text>
      {cands.length === 0 && <Text dimColor>No candidates found. Search below, or create a ticket.</Text>}
      {cands.map(cd => (
        <Button key={`cand-${cd.ticket.key}`} plain onPress={() => void linkUnit($, u.id, cd.ticket.key, ids)}>
          {'  '}
          <Text color={C.accent}>{cd.ticket.key}</Text> {fit(cd.ticket.summary || '(not in your open tickets)', c.width - 50)} <Text dimColor>· {cd.why}</Text>
        </Button>
      ))}
      <Box flexDirection="row" gap={1}>
        <Button key="link-new" label="Create a ticket instead" onPress={() => void startNew($, u.id, ids.length > 1 ? ids : [])} />
        <Button key="link-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
      {drawTickets($, el, c, 'pick', u.id, ids)}
    </Box>
  )
}

function drawSplit($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const base = c.m.units.find(v => `${v.sid}|${v.day}` === c.x.unitId)
  const chunks = c.x.chunks
  const set = (i: number, patch: Partial<Chunk>) => update($, ui, x => ({ ...x, chunks: x.chunks.map((k, j) => (j === i ? { ...k, ...patch } : k)) }))
  const total = base ? c.m.units.filter(v => `${v.sid}|${v.day}` === c.x.unitId).reduce((a, v) => a + v.minutes, 0) : 0

  return (
    <Box flexDirection="column">
      <Text bold color={C.accent}>
        Split this session
      </Text>
      <Text dimColor wrap="wrap">
        {contextLine(base)}
      </Text>
      {chunks.length === 0 && <Text dimColor>Working out the pieces…</Text>}
      {chunks.map((k, i) => (
        <Box key={`ch-${i}`} flexDirection="column" marginTop={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text bold>Part {i + 1}</Text>
            <Text>
              {Math.round(k.share * 100)}% · {fmtMin(total * k.share)}
            </Text>
            <Button key={`m-${i}`} label="−" onPress={() => void set(i, { share: Math.max(0.05, k.share - 0.05) })} />
            <Button key={`p-${i}`} label="+" onPress={() => void set(i, { share: Math.min(1, k.share + 0.05) })} />
            {i > 0 && (
              <Button
                key={`merge-${i}`}
                label="Merge with previous"
                onPress={() =>
                  void update($, ui, x => ({
                    ...x,
                    chunks: x.chunks.flatMap((q, j) => (j === i ? [] : j === i - 1 ? [{ ...q, share: q.share + k.share }] : [q])),
                  }))
                }
              />
            )}
          </Box>
          {c.Input ? (
            <Box flexDirection="column">
              <c.Input key={`lab-${i}`} label="What" value={k.label} onInput={(v: string) => void set(i, { label: v })} onSubmit={(v: string) => void set(i, { label: v })} />
              <c.Input key={`tik-${i}`} label="Ticket" placeholder="KEY-123, or leave empty to decide later" value={k.ticket} onInput={(v: string) => void set(i, { ticket: v.toUpperCase() })} onSubmit={(v: string) => void set(i, { ticket: v.toUpperCase() })} />
              <c.Input key={`br-${i}`} label="Branch" placeholder="keep the current one" value={k.branch} onInput={(v: string) => void set(i, { branch: v })} onSubmit={(v: string) => void set(i, { branch: v })} />
            </Box>
          ) : (
            <Text>{k.label}</Text>
          )}
        </Box>
      ))}
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        <Button key="split-save" label={chunks.length > 1 ? `Save ${chunks.length} parts` : 'Keep as one'} variant="primary" onPress={() => void saveSplit($)} />
        <Button key="split-add" label="Add part" onPress={() => void update($, ui, x => ({ ...x, chunks: [...x.chunks, { label: 'Other work', share: 0.1, ticket: '', branch: '' }] }))} />
        <Button key="split-un" label="Un-split" onPress={() => void update($, ui, x => ({ ...x, chunks: x.chunks.length ? [{ ...x.chunks[0]!, share: 1 }] : [] }))} />
        <Button
          key="split-again"
          label="Analyse again"
          onPress={() =>
            void $.clock.after(0, () =>
              void (async () => {
                const u = c.m.units.find(v => `${v.sid}|${v.day}` === c.x.unitId)
                if (!u) return
                await update($, ui, x => ({ ...x, chunks: [] }))
                const chunks = await proposeChunks($, u)
                await update($, ui, x => ({ ...x, chunks }))
              })(),
            )
          }
        />
        <Button key="split-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
    </Box>
  )
}

function drawNew($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const f = c.x.form
  const groupIds = c.x.groupIds.includes(f.unitId) ? c.x.groupIds : [f.unitId]
  const u = mergeUnits(c.m.units.filter(v => groupIds.includes(v.id)))
  const projects = [...new Set([...c.s.projects.map(p => p.key), ...c.m.tickets.map(t => t.project)])].filter(Boolean).sort()
  const set = (patch: Partial<NewForm>) => update($, ui, x => ({ ...x, form: { ...x.form, ...patch } }))
  const cfg = c.s.projects.find(p => p.key === f.project)
  const mixed = u && groupIds.length === 1 ? looksMixed(u) : ''
  const branchTo = u && cfg ? branchFor(cfg.branchPattern, 'KEY', slugify(f.summary.replace(cfg.prefix, ''))) : ''
  const Select = c.Select
  const Input = c.Input

  return (
    <Box flexDirection="column">
      <Text bold color={C.accent}>
        New ticket
      </Text>
      <Text dimColor wrap="wrap">
        {u ? contextLine(u, groupIds.length) : 'Not tied to a session (pick one with Create ticket on the Log work tab).'}
      </Text>
      {mixed !== '' && u && (
        <Box flexDirection="row" gap={1}>
          <Text color={C.amber}>Several pieces of work? ({mixed})</Text>
          <Button key="new-split" label="Split first" onPress={() => void $.clock.after(0, () => void startSplit($, u.id))} />
        </Box>
      )}
      {Select ? (
        <Box flexDirection="column">
          <Select
            key="f-project"
            label="Project"
            value={f.project}
            options={[{ value: '', label: 'Choose…' }, ...projects.map(p => ({ value: p, label: p }))]}
            onSelect={(v: string) =>
              void (async () => {
                const pc = c.s.projects.find(p => p.key === v)
                await set({ project: v, issueType: pc?.issueType || 'Task', summary: withPrefix(pc?.prefix ?? '', f.summary.replace(cfg?.prefix ?? '', '')), parent: '' })
                await loadFormLists($, v, u)
              })()
            }
          />
          <Select
            key="f-type"
            label="Issue type"
            value={f.issueType}
            options={(f.types.length ? f.types : ['Task', 'Story', 'Bug', 'Sub-task']).map(t => ({ value: t, label: t }))}
            onSelect={(v: string) => void set({ issueType: v })}
          />
          <Select
            key="f-parent"
            label="Parent story / epic"
            value={f.stories.some(s => s.key === f.parent) ? f.parent : ''}
            options={[
              { value: '', label: 'None' },
              ...f.stories.map((s, i) => ({ value: s.key, label: `${i === 0 && s.score > 0 ? '★ ' : ''}${s.key} ${fit(s.summary, 60)}` })),
            ]}
            onSelect={(v: string) => void set({ parent: v })}
          />
          <Select key="f-assignee" label="Assignee" value={f.assignee} options={[{ value: 'me', label: 'Me' }, { value: 'none', label: 'Unassigned' }]} onSelect={(v: string) => void set({ assignee: v })} />
        </Box>
      ) : (
        <Text dimColor>Pickers are not available on this surface.</Text>
      )}
      {Input && (
        <Box flexDirection="column">
          <Input key="f-parent-key" label="or parent key" placeholder="PROJ-100" value={f.stories.some(s => s.key === f.parent) ? '' : f.parent} onSubmit={(v: string) => void set({ parent: v.trim().toUpperCase() })} />
          <Input key="f-summary" label="Summary" value={f.summary} onInput={(v: string) => void set({ summary: v })} onSubmit={(v: string) => void set({ summary: v })} />
          <Input key="f-desc" label="Description" rows={3} value={f.description} placeholder="Brief, optional" onInput={(v: string) => void set({ description: v })} onSubmit={(v: string) => void set({ description: v })} />
          <Input key="f-labels" label="Labels" placeholder="comma separated" value={f.labels} onInput={(v: string) => void set({ labels: v })} onSubmit={(v: string) => void set({ labels: v })} />
        </Box>
      )}
      {aiWords(`${f.summary} ${f.description} ${f.labels}`).length > 0 && (
        <Text color={C.red}>Remove before sending: {aiWords(`${f.summary} ${f.description} ${f.labels}`).join(', ')}</Text>
      )}
      {u && u.branch && cfg && new Set(c.m.units.filter(v => groupIds.includes(v.id)).map(v => v.branch)).size === 1 && (
        <Box flexDirection="row" gap={1}>
          {chip(Button, 'f-rename', f.rename ? `✓ Rename branch → ${branchTo}` : `Rename branch → ${branchTo}`, f.rename, () => set({ rename: !f.rename }))}
        </Box>
      )}
      <Box flexDirection="row" gap={1}>
        <Button key="f-preview" label="Preview" variant="primary" onPress={() => void $.clock.after(0, () => void previewNew($))} />
        <Button key="f-suggest" label="Suggest summary" onPress={() => void $.clock.after(0, () => void suggestSummary($))} />
        <Button key="f-back" label="Back" onPress={() => void go($, 'main', { tab: 'log' })} />
      </Box>
    </Box>
  )
}

function optLabel(o: TimeOpt, isBest: boolean): string {
  return `${o.code}${isBest ? '★' : ''} ${clock(o.startMs, off)} ${fmtMin(o.minutes)}`
}

function drawPreview($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const acts = c.x.actions
  const set = (id: string, patch: Partial<Action>) => update($, ui, x => ({ ...x, actions: x.actions.map(a => (a.id === id ? { ...a, ...patch } : a)) }))
  const on = acts.filter(a => a.isOn).length
  const toggle = (a: Action) => (
    <Button key={`on-${a.id}`} plain label={a.isOn ? '[x]' : '[ ]'} onPress={() => void set(a.id, { isOn: !a.isOn })} />
  )

  return (
    <Box flexDirection="column">
      <Text bold color={C.accent}>
        Review before sending
      </Text>
      <Text dimColor>Nothing below reaches Jira or git until you press Confirm.</Text>
      {acts.map(a => {
        const u = c.m.units.find(v => v.id === a.unitIds[0])
        switch (a.kind) {
          case 'create':
            return (
              <Box key={`pv-${a.id}`} flexDirection="column" marginTop={1}>
                <Box flexDirection="row" gap={1}>
                  {toggle(a)}
                  <Text bold>Create {a.issueType} in {a.project}</Text>
                </Box>
                <Text>    {a.summary}</Text>
                {a.parent ? <Text dimColor>    parent {a.parent}</Text> : null}
                {a.description ? <Text dimColor wrap="wrap">    {fit(a.description, 300)}</Text> : null}
                <Text dimColor>    assignee {a.assignee ? 'me' : 'unassigned'}{(a.labels ?? []).length ? ` · labels ${(a.labels ?? []).join(', ')}` : ''}</Text>
              </Box>
            )
          case 'link':
            if (a.id.startsWith('close:')) {
              return (
                <Box key={`pv-${a.id}`} flexDirection="row" gap={1} marginTop={1}>
                  {toggle(a)}
                  <Text>Mark the week of {dayLabel(a.to ?? '')} as closed</Text>
                </Box>
              )
            }

            return (
              <Box key={`pv-${a.id}`} flexDirection="row" gap={1} marginTop={1}>
                {toggle(a)}
                <Text>
                  Link {u ? `${dayLabel(u.day)} ${u.repo} · ${u.branch}` : 'the session'} to {a.key === 'NEW#1' ? 'the new ticket' : a.key}
                </Text>
              </Box>
            )
          case 'rename':
            return (
              <Box key={`pv-${a.id}`} flexDirection="column" marginTop={1}>
                <Box flexDirection="row" gap={1}>
                  {toggle(a)}
                  <Text>
                    Rename branch {a.from} → {(a.to ?? '').replace('NEW#1', '<new key>')}
                  </Text>
                </Box>
                <Text dimColor>    {a.isPushed ? 'locally and on origin (push the new name, delete the old one)' : 'locally (it was never pushed)'}</Text>
              </Box>
            )
          case 'parent':
            return (
              <Box key={`pv-${a.id}`} flexDirection="column" marginTop={1}>
                <Box flexDirection="row" gap={1}>
                  {toggle(a)}
                  <Text>{a.key} has no parent story. Link it to:</Text>
                </Box>
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  <Text>   </Text>
                  {(a.transitions ?? []).map((st, i) =>
                    chip(Button, `par-${a.id}-${st.id}`, `${i === 0 ? '★ ' : ''}${st.id} ${fit(st.name, 40)}`, a.parentKey === st.id, () => set(a.id, { parentKey: st.id, isOn: true })),
                  )}
                  {chip(Button, `par-${a.id}-none`, 'None', a.parentKey === '' || !a.isOn, () => set(a.id, { parentKey: '', isOn: false }))}
                </Box>
              </Box>
            )
          case 'transition': {
            const cur = c.m.tickets.find(t => t.key === a.key)

            return (
              <Box key={`pv-${a.id}`} flexDirection="column" marginTop={1}>
                <Text>
                  Move {a.key} from <Text bold>{cur?.status || 'its status'}</Text> to:
                </Text>
                <Box flexDirection="row" gap={1} flexWrap="wrap">
                  <Text>   </Text>
                  {chip(Button, `tr-${a.id}-keep`, 'Keep current status', !a.transitionId, () => set(a.id, { transitionId: '' }))}
                  {(a.transitions ?? []).map(t =>
                    chip(
                      Button,
                      `tr-${a.id}-${t.id}`,
                      `${t.to}${a.usedBefore && a.usedBefore === t.to ? ` · used before in ${projectOfKey(a.key)}` : ''}`,
                      a.transitionId === t.id,
                      () => set(a.id, { transitionId: t.id }),
                    ),
                  )}
                  {(a.transitions ?? []).length === 0 && <Text dimColor>(no moves are allowed from here)</Text>}
                </Box>
              </Box>
            )
          }
          case 'worklog':
          case 'edit-worklog': {
            const day = u?.day ?? dayOf(a.options?.[0]?.startMs ?? Date.now(), off)
            const t = a.isRemove ? null : pickedTime(a, day)
            const remaining = a.remainingSec && t ? `remaining estimate ${fmtMin(a.remainingSec / 60)} → ${fmtMin(Math.max(0, a.remainingSec / 60 - t.minutes))}` : ''

            return (
              <Box key={`pv-${a.id}`} flexDirection="column" marginTop={1}>
                <Box flexDirection="row" gap={1}>
                  {toggle(a)}
                  <Text bold>
                    {a.kind === 'edit-worklog' ? (a.isRemove ? 'Remove' : 'Edit') : 'Log'} time on {a.key}
                  </Text>
                  <Text dimColor>
                    {dayLabel(day)}
                    {u ? ` · ${u.repo} · ${u.label}` : ''}
                  </Text>
                </Box>
                {a.isRemove ? (
                  <Text color={C.amber} wrap="wrap">
                    {'    '}The Jira connection cannot delete a worklog: this sets it to 0m. Delete it fully from Jira if you prefer.
                  </Text>
                ) : (
                  <Box flexDirection="column">
                    <Box flexDirection="row" gap={1} flexWrap="wrap">
                      <Text>   </Text>
                      {(a.options ?? []).map(o =>
                        chip(Button, `opt-${a.id}-${o.code}`, optLabel(o, o.code === 'C'), a.pick === o.code, () => set(a.id, { pick: o.code })),
                      )}
                      {chip(Button, `opt-${a.id}-D`, 'D Custom', a.pick === 'D', () => set(a.id, { pick: 'D' }))}
                    </Box>
                    <Text dimColor>
                      {'    '}
                      {(a.options ?? []).find(o => o.code === a.pick)?.why ?? 'your own start and duration'}
                      {remaining && c.s.projects.find(p => p.key === projectOfKey(a.key))?.usesEstimates ? ` · ${remaining}` : ''}
                    </Text>
                    {a.pick === 'D' && c.Input && (
                      <Box flexDirection="row" gap={1}>
                        <c.Input key={`cs-${a.id}`} label="Start" value={a.customStart ?? ''} onInput={(v: string) => void set(a.id, { customStart: v })} onSubmit={(v: string) => void set(a.id, { customStart: v })} />
                        <c.Input key={`cd-${a.id}`} label="Duration" value={a.customDur ?? ''} onInput={(v: string) => void set(a.id, { customDur: v })} onSubmit={(v: string) => void set(a.id, { customDur: v })} />
                      </Box>
                    )}
                    {c.Input && (
                      <c.Input
                        key={`cm-${a.id}`}
                        label="Comment"
                        placeholder="optional, brief"
                        value={a.comment ?? ''}
                        onInput={(v: string) => void set(a.id, { comment: v })}
                        onSubmit={(v: string) => void set(a.id, { comment: v })}
                      />
                    )}
                    {aiWords(a.comment ?? '').length > 0 && <Text color={C.red}>    Remove: {aiWords(a.comment ?? '').join(', ')}</Text>}
                  </Box>
                )}
              </Box>
            )
          }
          default:
            return null
        }
      })}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="pv-send" label={`Confirm and send (${on})`} variant="primary" onPress={() => void $.clock.after(0, () => void sendPreview($))} />
        <Button key="pv-all" label="Select all" onPress={() => void update($, ui, x => ({ ...x, actions: x.actions.map(a => ({ ...a, isOn: true })) }))} />
        <Button key="pv-none" label="Select none" onPress={() => void update($, ui, x => ({ ...x, actions: x.actions.map(a => ({ ...a, isOn: false })) }))} />
        <Button key="pv-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
    </Box>
  )
}

function drawCheck($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const names: Record<LooseEnd['kind'], string> = {
    uncommitted: 'Uncommitted changes',
    unpushed: 'Commits not pushed',
    'no-mr': 'Pushed with no merge request',
    'no-ticket': 'Work with no ticket',
    'not-logged': 'Linked work not logged',
    'status-behind': 'Status looks behind the work',
  }
  const kinds = Object.keys(names) as LooseEnd['kind'][]

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold color={C.accent}>
          Check
        </Text>
        <Button key="ck-day" label="Today" onPress={() => void $.clock.after(0, () => void runCheck($, 1))} />
        <Button key="ck-week" label="Last 7 days" onPress={() => void $.clock.after(0, () => void runCheck($, 7))} />
        <Button key="ck-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
      {c.x.check.length === 0 && <Text dimColor>{'Nothing found yet (or still checking).'}</Text>}
      {kinds.map(k => {
        const items = c.x.check.filter(i => i.kind === k)
        if (items.length === 0) return null

        return (
          <Box key={`ck-${k}`} flexDirection="column" marginTop={1}>
            <Text bold>
              {names[k]} ({items.length})
            </Text>
            {items.map((i, n) => (
              <Box key={`cki-${k}-${n}`} flexDirection="row" gap={1} flexWrap="wrap">
                <Text>
                  {'  '}
                  {i.repo ? <Text dimColor>{i.repo} </Text> : null}
                  {fit(i.text, c.width - 40)}
                </Text>
                {i.command !== '' && (
                  <Button key={`cmd-${k}-${n}`} label="Copy command" onPress={ev => void $.ui.copy({ text: i.command, surface: ev.surface }).then(() => say($, 'Copied.'))} />
                )}
                {k === 'no-ticket' && <Button key={`ckl-${n}`} label="Link" onPress={() => void go($, 'link', { unitId: i.unitId, groupIds: [] })} />}
                {k === 'no-ticket' && <Button key={`ckn-${n}`} label="Create" onPress={() => void startNew($, i.unitId)} />}
                {(k === 'not-logged' || k === 'status-behind') && (
                  <Button key={`ckg-${k}-${n}`} label="Log / move" onPress={() => void (async () => {
                    const u = (await read($, model)).units.find(v => v.id === i.unitId)
                    if (u) await startLog($, [u], 'check')
                  })()} />
                )}
              </Box>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

function drawWrapup($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const day = today()
  const units = c.m.units.filter(u => u.day === day)
  const target = targetFor(day, c.s)
  const recorded = units.reduce((a, u) => a + u.minutes, 0)
  const loggedJira = c.m.weeks.flatMap(w => w.days).find(d => d.day === day)?.loggedMin ?? 0
  const unlogged = units.filter(u => isOpen(u)).reduce((a, u) => a + u.minutes, 0)
  const gap = target - loggedJira - unlogged
  const sessions = new Set(units.map(u => u.sid)).size
  const span = units.length ? (Math.max(...units.map(u => u.endMs)) - Math.min(...units.map(u => u.startMs))) / MIN : 0
  const isDouble = loggedJira + unlogged > Math.max(span, target) + 30

  return (
    <Box flexDirection="column">
      <Text bold color={C.accent}>
        Wrap-up · {dayLabel(day)}
      </Text>
      <Text>
        {sessions} session{sessions === 1 ? '' : 's'} · recorded {fmtMin(recorded)} · in Jira {fmtMin(loggedJira)} · not logged {fmtMin(unlogged)} · working day {fmtMin(target)}
      </Text>
      {gap > 15 && <Text color={C.amber}>Gap: {fmtMin(gap)} of the working day has no recorded work (meetings, reviews?). Use + Add time for it.</Text>}
      {isDouble && <Text color={C.red}>Possible double counting: Jira plus unlogged work comes to more than the day's span ({fmtMin(span)}).</Text>}
      {units.map(u => (
        <Text key={`wu-${u.id}`}>
          {'  '}
          {clock(u.startMs, off)} {fmtMin(u.minutes)} {u.ticket ? <Text color={C.accent}>{u.ticket}</Text> : <Text color={C.amber}>no ticket</Text>} {u.isLogged ? '✓ logged ' : u.isIgnored ? '✗ ignored ' : ''}
          <Text dimColor>{fit(`${u.repo} · ${u.label}`, c.width - 36)}</Text>
        </Text>
      ))}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button
          key="wu-send"
          label={`Send the day (${units.filter(u => u.ticket && isOpen(u)).length})`}
          variant="primary"
          onPress={() => void $.clock.after(0, () => void startLog($, units.filter(u => u.ticket && isOpen(u)), 'wrapup'))}
        />
        <Button key="wu-check" label="Check loose ends" onPress={() => void $.clock.after(0, () => void runCheck($))} />
        <Button key="wu-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
    </Box>
  )
}

function lastWorkday(s: Settings): string {
  let d = addDays(today(), -1)
  for (let i = 0; i < 7 && targetFor(d, s) === 0; i++) d = addDays(d, -1)

  return d
}

function drawStandup($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const y = lastWorkday(c.s)
  const blockers = c.m.tickets.filter(t => /block|hold|wait/i.test(t.status)).map(t => `${t.key} ${t.summary} (${t.status})`)
  const text = standupText(
    c.m.units.filter(u => u.day === y),
    c.m.units.filter(u => u.day === today()),
    blockers,
  )

  return (
    <Box flexDirection="column">
      <Text bold color={C.accent}>
        Standup notes
      </Text>
      <Text dimColor>Yesterday = {dayLabel(y)}</Text>
      <Text wrap="wrap">{text}</Text>
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="su-copy" label="Copy" variant="primary" onPress={ev => void $.ui.copy({ text, surface: ev.surface }).then(() => say($, 'Standup notes copied.'))} />
        <Button key="su-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
    </Box>
  )
}

function drawTimesheet($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const start = weekOf(c.x.dashDay || today())
  const end = addDays(start, 6)
  const rows = timesheetRows(c.m.units, start, end)
  const md = timesheetMd(rows)
  const csv = timesheetCsv(rows)
  const save = async (ext: 'csv' | 'md') => {
    const path = `${dataDir()}/exports/timesheet-${start}.${ext}`
    await $.fs.write(path, ext === 'csv' ? csv : md)
    await say($, `Saved ${path}`)
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Button key="ts-prev" label="◀" onPress={() => void update($, ui, x => ({ ...x, dashDay: addDays(start, -7) }))} />
        <Text bold color={C.accent}>
          Timesheet · week of {dayLabel(start)}
        </Text>
        <Button key="ts-next" label="▶" onPress={() => void update($, ui, x => ({ ...x, dashDay: addDays(start, 7) }))} />
      </Box>
      {rows.length === 0 && <Text dimColor>No recorded work that week.</Text>}
      {rows.map((r, i) => (
        <Text key={`ts-${i}`}>
          {'  '}
          {dayLabel(r.day)} <Text color={C.accent}>{r.key}</Text> {fmtMin(r.minutes)}
        </Text>
      ))}
      <Text bold>  Total {fmtMin(rows.reduce((a, r) => a + r.minutes, 0))}</Text>
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        <Button key="ts-csv" label="Copy CSV" onPress={ev => void $.ui.copy({ text: csv, surface: ev.surface }).then(() => say($, 'CSV copied.'))} />
        <Button key="ts-md" label="Copy Markdown" onPress={ev => void $.ui.copy({ text: md, surface: ev.surface }).then(() => say($, 'Markdown copied.'))} />
        <Button key="ts-save-csv" label="Save CSV" onPress={() => void save('csv')} />
        <Button key="ts-save-md" label="Save Markdown" onPress={() => void save('md')} />
        <Button key="ts-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
    </Box>
  )
}

async function drawHistory($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const list = (await writes($)).filter(w => w.kind === 'worklog' || w.kind === 'edit-worklog').slice(-25).reverse()

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <Text bold color={C.accent}>
          Worklogs written from here
        </Text>
        <Button key="hi-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
      {list.length === 0 && <Text dimColor>None yet.</Text>}
      {list.map(w => (
        <Box key={`hi-${w.id}`} flexDirection="row" gap={1} flexWrap="wrap">
          <Text>
            <Text color={C.accent}>{w.key}</Text> {dayLabel(dayOf(w.startedMs, off))} {clock(w.startedMs, off)} {fmtMin(w.minutes)}
            {w.kind === 'edit-worklog' ? <Text dimColor> (edit)</Text> : null}
          </Text>
          {w.worklogId !== '' && <Button key={`hie-${w.id}`} label="Edit" onPress={() => void editWorklog($, w, false)} />}
          {w.worklogId !== '' && <Button key={`hir-${w.id}`} label="Remove" onPress={() => void editWorklog($, w, true)} />}
          <Button key={`hio-${w.id}`} label="Open" onPress={() => void openTicket($, c.s, w.key)} />
        </Box>
      ))}
    </Box>
  )
}

function drawAddTime($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const t = c.x.addTime
  const set = (patch: Partial<Ui['addTime']>) => update($, ui, x => ({ ...x, addTime: { ...x.addTime, ...patch } }))
  const Input = c.Input

  return (
    <Box flexDirection="column">
      <Text bold color={C.accent}>
        Add time by hand
      </Text>
      {Input ? (
        <Box flexDirection="column">
          <Input key="at-key" label="Ticket" placeholder="PROJ-1064" value={t.key} onInput={(v: string) => void set({ key: v })} onSubmit={(v: string) => void set({ key: v })} />
          <Input key="at-date" label="Date" placeholder="YYYY-MM-DD" value={t.date} onInput={(v: string) => void set({ date: v })} onSubmit={(v: string) => void set({ date: v })} />
          <Input key="at-start" label="Start" placeholder="09:30" value={t.start} onInput={(v: string) => void set({ start: v })} onSubmit={(v: string) => void set({ start: v })} />
          <Input key="at-dur" label="Duration" placeholder="1h 30m" value={t.dur} onInput={(v: string) => void set({ dur: v })} onSubmit={(v: string) => void set({ dur: v })} />
          <Input key="at-comment" label="Comment" placeholder="optional, brief" value={t.comment} onInput={(v: string) => void set({ comment: v })} onSubmit={(v: string) => void set({ comment: v })} />
        </Box>
      ) : (
        <Text dimColor>Typing is not available on this surface.</Text>
      )}
      <Box flexDirection="row" gap={1}>
        <Button key="at-preview" label="Preview" variant="primary" onPress={() => void $.clock.after(0, () => void previewAddTime($))} />
        <Button key="at-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
    </Box>
  )
}

function drawSetup($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const Input = c.Input
  let d: SetupDraft
  try {
    d = JSON.parse(c.x.setupDraft || '{}') as SetupDraft
  } catch {
    return <Text color={C.red}>Settings could not be read.</Text>
  }
  if (!d.workDays) return <Text dimColor>Loading settings…</Text>
  const num = (v: string, f: number) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : f)
  const keys = d.projectKeys
    .split(/[\s,]+/)
    .map(k => k.trim().toUpperCase())
    .filter(Boolean)
  const proj = (k: string) => d.projects.find(p => p.key === k) ?? blankProject(k)
  const setProj = (k: string, patch: Partial<ProjectCfg>) =>
    patchDraft($, x => ({ ...x, projects: [...x.projects.filter(p => p.key !== k), { ...proj(k), ...patch }] }))
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  return (
    <Box flexDirection="column">
      <Text bold color={C.accent}>
        Setup
      </Text>
      <Text dimColor>Jira site: {d.site || '(found through your Atlassian connection on save)'}</Text>
      {Input && (
        <Box flexDirection="column">
          <Input key="su-projects" label="Projects to track" placeholder="PROJ, MOBILE" value={d.projectKeys} onInput={(v: string) => void patchDraft($, x => ({ ...x, projectKeys: v }))} onSubmit={(v: string) => void patchDraft($, x => ({ ...x, projectKeys: v }))} />
          <Input key="su-hours" label="Hours per day" value={String(d.hoursPerDay)} onSubmit={(v: string) => void patchDraft($, x => ({ ...x, hoursPerDay: num(v, x.hoursPerDay) }))} />
          <Input key="su-eod" label="End of day" placeholder="18:00" value={d.endOfDay} onSubmit={(v: string) => void patchDraft($, x => ({ ...x, endOfDay: v.trim() }))} />
          <Input key="su-idle" label="Idle after (min)" value={String(d.idleMin)} onSubmit={(v: string) => void patchDraft($, x => ({ ...x, idleMin: num(v, x.idleMin) }))} />
          <Input key="su-refresh" label="Refresh every (min)" value={String(d.refreshMin)} onSubmit={(v: string) => void patchDraft($, x => ({ ...x, refreshMin: num(v, x.refreshMin) }))} />
          <Input key="su-alert" label="Warn when unlinked passes (min)" value={String(d.unlinkedAlertMin)} onSubmit={(v: string) => void patchDraft($, x => ({ ...x, unlinkedAlertMin: num(v, x.unlinkedAlertMin) }))} />
          <Input key="su-off" label="Days off" placeholder="2026-12-24, 2026-12-25" value={d.daysOff.join(', ')} onSubmit={(v: string) => void patchDraft($, x => ({ ...x, daysOff: v.split(/[\s,]+/).filter(z => /^\d{4}-\d\d-\d\d$/.test(z)) }))} />
        </Box>
      )}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text>Working days</Text>
        {days.map((n, i) =>
          chip(Button, `su-wd-${i}`, n, d.workDays.includes(i), () =>
            patchDraft($, x => ({ ...x, workDays: x.workDays.includes(i) ? x.workDays.filter(z => z !== i) : [...x.workDays, i].sort() })),
          ),
        )}
      </Box>
      <Box flexDirection="row" gap={1}>
        {chip(Button, 'su-headless', d.includeHeadless ? '✓ Count headless runs' : 'Count headless runs', d.includeHeadless, () => patchDraft($, x => ({ ...x, includeHeadless: !x.includeHeadless })))}
        {chip(Button, 'su-today-off', d.daysOff.includes(today()) ? '✓ Today is a day off' : 'Today is a day off', d.daysOff.includes(today()), () =>
          patchDraft($, x => ({ ...x, daysOff: x.daysOff.includes(today()) ? x.daysOff.filter(z => z !== today()) : [...x.daysOff, today()] })),
        )}
      </Box>
      {keys.map(k => {
        const p = proj(k)

        return (
          <Box key={`sp-${k}`} flexDirection="column" marginTop={1}>
            <Text bold>{k}</Text>
            {Input && (
              <Box flexDirection="column">
                <Input key={`sp-f-${k}`} label="Repos / folders" placeholder="my-ios-app, selfcare-*" value={p.folders.join(', ')} onSubmit={(v: string) => void setProj(k, { folders: v.split(/\s*,\s*/).filter(Boolean) })} />
                <Input key={`sp-p-${k}`} label="Summary prefix" placeholder="[iOS]-" value={p.prefix} onSubmit={(v: string) => void setProj(k, { prefix: v })} />
                <Input key={`sp-b-${k}`} label="Branch pattern" value={p.branchPattern} onSubmit={(v: string) => void setProj(k, { branchPattern: v.trim() })} />
                <Input key={`sp-t-${k}`} label="Default issue type" value={p.issueType} onSubmit={(v: string) => void setProj(k, { issueType: v.trim() })} />
                <Input key={`sp-d-${k}`} label="Ticket template" rows={2} value={p.template} onSubmit={(v: string) => void setProj(k, { template: v })} />
              </Box>
            )}
            {chip(Button, `sp-e-${k}`, p.usesEstimates ? '✓ Uses estimates' : 'Uses estimates', p.usesEstimates, () => setProj(k, { usesEstimates: !p.usesEstimates }))}
          </Box>
        )
      })}
      <Text dimColor>Press Enter in a field to keep its value.</Text>
      <Box flexDirection="row" gap={1}>
        <Button key="su-save" label="Save" variant="primary" onPress={() => void saveSetup($)} />
        <Button key="su-back" label="Back" hotkey="b" onPress={() => void back($)} />
      </Box>
    </Box>
  )
}

function bar(min: number, max: number, width: number): string {
  const n = max > 0 ? Math.round((min / max) * width) : 0

  return '█'.repeat(Math.min(width, n)) + '░'.repeat(Math.max(0, width - n))
}

async function drawDash($: E$, el: El, c: Ctx) {
  const { Box, Text, Button } = el
  const end = c.x.dashDay || today()
  const range = c.x.dashRange
  const days = Array.from({ length: range }, (_, i) => addDays(end, -(range - 1 - i)))
  const snaps = (await Promise.all(days.map(d => readSnapshot($, d)))).filter((x): x is Snapshot => x !== null)
  const filt = (rec: Record<string, number>, k: string) => (k ? (rec[k] ?? 0) : Object.values(rec).reduce((a, v) => a + v, 0))
  const projects = [...new Set(snaps.flatMap(s => Object.keys(s.byProject)))].filter(k => k !== '-').sort()
  const repos = [...new Set(snaps.flatMap(s => Object.keys(s.byRepo)))].sort()
  const sum = (f: (s: Snapshot) => number) => snaps.reduce((a, s) => a + f(s), 0)
  const linked = sum(s => s.linkedMin)
  const unlinked = sum(s => s.unlinkedMin)
  const logged = sum(s => s.loggedMin)
  const target = sum(s => s.targetMin)
  const byTicket = new Map<string, number>()
  for (const s of snaps) for (const [k, v] of Object.entries(s.byTicket)) byTicket.set(k, (byTicket.get(k) ?? 0) + v)
  const barW = Math.max(10, Math.min(40, c.width - 40))
  const maxDay = Math.max(1, ...snaps.map(s => Math.max(s.targetMin, filt(s.byRepo, c.x.dashRepo), filt(s.byProject, c.x.dashProject))))

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="db-prev" label="◀" onPress={() => void update($, ui, x => ({ ...x, dashDay: addDays(end, -1) }))} />
        <Text bold color={C.accent}>
          {range === 1 ? dayLabel(end) : `${dayLabel(days[0]!)} – ${dayLabel(end)}`}
        </Text>
        <Button key="db-next" label="▶" onPress={() => void update($, ui, x => ({ ...x, dashDay: end >= today() ? end : addDays(end, 1) }))} />
        <Button key="db-today" label="Today" onPress={() => void update($, ui, x => ({ ...x, dashDay: today() }))} />
        {chip(Button, 'db-r1', 'Day', range === 1, () => update($, ui, x => ({ ...x, dashRange: 1 })))}
        {chip(Button, 'db-r7', '7 days', range === 7, () => update($, ui, x => ({ ...x, dashRange: 7 })))}
        {chip(Button, 'db-r30', '30 days', range === 30, () => update($, ui, x => ({ ...x, dashRange: 30 })))}
      </Box>
      {c.Input && (
        <c.Input
          key="db-date"
          label="Go to date"
          placeholder="YYYY-MM-DD"
          value=""
          onSubmit={(v: string) => void (/^\d{4}-\d\d-\d\d$/.test(v.trim()) ? update($, ui, x => ({ ...x, dashDay: v.trim() })) : say($, 'Use YYYY-MM-DD.'))}
        />
      )}
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text dimColor>Project</Text>
        {chip(Button, 'db-p-all', 'All', c.x.dashProject === '', () => update($, ui, x => ({ ...x, dashProject: '' })))}
        {projects.map(p => chip(Button, `db-p-${p}`, p, c.x.dashProject === p, () => update($, ui, x => ({ ...x, dashProject: x.dashProject === p ? '' : p }))))}
      </Box>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text dimColor>Repo</Text>
        {chip(Button, 'db-r-all', 'All', c.x.dashRepo === '', () => update($, ui, x => ({ ...x, dashRepo: '' })))}
        {repos.map(p => chip(Button, `db-rr-${p}`, p, c.x.dashRepo === p, () => update($, ui, x => ({ ...x, dashRepo: x.dashRepo === p ? '' : p }))))}
      </Box>
      {snaps.length === 0 && <Text dimColor>No snapshot for these days yet. Snapshots are taken on each refresh from today on.</Text>}
      {snaps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Sessions {sum(s => s.sessions)} · linked {fmtMin(linked)} · unlinked <Text color={unlinked > 0 ? C.amber : C.green}>{fmtMin(unlinked)}</Text> · logged {fmtMin(logged)} of {fmtMin(target)} · loose ends {sum(s => s.looseEnds)}
          </Text>
          <Text bold>Per day (recorded vs working day)</Text>
          {snaps.map(s => {
            const rec = c.x.dashRepo ? filt(s.byRepo, c.x.dashRepo) : filt(s.byProject, c.x.dashProject)

            return (
              <Text key={`db-${s.day}`}>
                {'  '}
                {dayLabel(s.day)} <Text color={C.accent}>{bar(rec, maxDay, barW)}</Text> {fmtMin(rec)} / {fmtMin(s.targetMin)} · logged {fmtMin(s.loggedMin)} · {s.sessions} session{s.sessions === 1 ? '' : 's'}
              </Text>
            )
          })}
          <Text bold>Per ticket</Text>
          {[...byTicket]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([k, v]) => (
              <Text key={`dbt-${k}`}>
                {'  '}
                <Text color={k === 'no ticket' ? C.amber : C.accent}>{k}</Text> {fmtMin(v)}
              </Text>
            ))}
        </Box>
      )}
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Button key="db-ts" label="Weekly timesheet" onPress={() => void go($, 'timesheet', { dashDay: end })} />
        <Button key="db-check" label="Loose ends" onPress={() => void $.clock.after(0, () => void runCheck($, range))} />
      </Box>
    </Box>
  )
}

