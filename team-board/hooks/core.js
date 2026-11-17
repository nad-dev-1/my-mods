// Team Board: the shared rules. One file, used by the mod (imported) and by the
// dashboard page (inlined at build time), so both apply the same date rules,
// flags and report numbers. Pure functions only: no I/O, no clock of its own.

export const PRIORITIES = ['critical', 'high', 'medium', 'low']
export const TASK_STAGES = ['backlog', 'assigned', 'in_progress', 'in_review', 'done', 'cancelled']
export const IDEA_STAGES = ['new', 'discussing', 'approved', 'converted', 'parked', 'rejected']
export const NOTE_TAGS = ['update', 'decision', 'blocker', 'review']
export const STAGE_LABEL = {
  backlog: 'Backlog',
  assigned: 'Assigned',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
  new: 'New',
  discussing: 'Discussing',
  approved: 'Approved',
  converted: 'Converted',
  parked: 'Parked',
  rejected: 'Rejected',
}
export const PRIORITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }
export const DEFAULT_SETTINGS = {
  timezone: 'Asia/Beirut',
  staleDays: 5,
  wipLimit: 3,
  recentlyDoneDays: 14,
  jira: { cloudId: null, baseUrl: null },
  reports: { defaultScope: 'team', defaultPeriod: 'this_week' },
}
export const PERIODS = { this_week: 'This week', last_week: 'Last week', this_month: 'This month', last_month: 'Last month', custom: 'Custom range' }

const OPEN_TASK = new Set(['backlog', 'assigned', 'in_progress', 'in_review'])
const ONGOING = new Set(['in_progress', 'in_review'])
const CLOSED = new Set(['done', 'cancelled'])

// ── dates (date-only strings, YYYY-MM-DD) ──────────────────────────────

/** Today's date in a time zone. */
export function todayIn(tz, ms) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

function dayNum(d) {
  return Math.round(Date.parse(d + 'T00:00:00Z') / 86400000)
}

export function addDays(d, n) {
  return new Date((dayNum(d) + n) * 86400000).toISOString().slice(0, 10)
}

/** Whole days from a to b (b later = positive). */
export function daysBetween(a, b) {
  return dayNum(b) - dayNum(a)
}

export function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
}

/** Monday of the week holding d. */
export function weekStart(d) {
  const wd = new Date(d + 'T00:00:00Z').getUTCDay()
  return addDays(d, -((wd + 6) % 7))
}

/** A report period as an inclusive date range. */
export function periodRange(period, today, custom) {
  if (period === 'custom' && custom && isDate(custom.from) && isDate(custom.to)) {
    const [from, to] = custom.from <= custom.to ? [custom.from, custom.to] : [custom.to, custom.from]

    return { from, to, label: `${from} to ${to}` }
  }
  if (period === 'last_week') {
    const from = addDays(weekStart(today), -7)

    return { from, to: addDays(from, 6), label: `Week of ${from}` }
  }
  if (period === 'this_month' || period === 'last_month') {
    let y = Number(today.slice(0, 4))
    let m = Number(today.slice(5, 7))
    if (period === 'last_month') {
      m -= 1
      if (m === 0) {
        m = 12
        y -= 1
      }
    }
    const from = `${y}-${String(m).padStart(2, '0')}-01`
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

    return { from, to: addDays(next, -1), label: `${names[m - 1]} ${y}` }
  }
  const from = weekStart(today)

  return { from, to: addDays(from, 6), label: `Week of ${from}` }
}

const inRange = (d, r) => isDate(d) && d >= r.from && d <= r.to
const dateOf = iso => (typeof iso === 'string' ? iso.slice(0, 10) : '')

// ── ids, ranks, keys ───────────────────────────────────────────────────

export function formatId(kind, n) {
  return `${kind === 'idea' ? 'I' : 'T'}-${String(n).padStart(4, '0')}`
}

/** The next id for a kind from the counters doc; answers the id and the new counters. */
export function nextId(kind, counters) {
  const c = { idea: 0, task: 0, ...(counters || {}) }
  c[kind] = (Number(c[kind]) || 0) + 1

  return { id: formatId(kind, c[kind]), counters: { idea: c.idea, task: c.task } }
}

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * A rank string strictly between a and b (either may be empty or null for an
 * open end). Fractional indexing: a drag writes one document. Never ends in 0.
 */
export function rankBetween(a, b) {
  const lo = a || ''
  let hi = b || null
  if (hi !== null && lo >= hi) hi = null
  let out = ''
  for (let i = 0; i < 64; i++) {
    const da = i < lo.length ? DIGITS.indexOf(lo[i]) : 0
    const db = hi !== null && i < hi.length ? DIGITS.indexOf(hi[i]) : DIGITS.length
    if (da === db) {
      out += DIGITS[da]
      continue
    }
    const m = Math.floor((da + db) / 2)
    if (m > da) return out + DIGITS[m]
    out += DIGITS[da]
    hi = null
  }

  return out + 'i'
}

/** Ranks for n new items placed after `last`. */
export function ranksAfter(last, n) {
  const out = []
  let prev = last || ''
  for (let i = 0; i < n; i++) {
    prev = rankBetween(prev, null)
    out.push(prev)
  }

  return out
}

/** A Jira key from a key or an issue URL; null when there is none. */
export function normalizeJiraKey(input) {
  const s = String(input || '').trim()
  const m = /(?:browse\/|selectedIssue=|issues\/)?([A-Za-z][A-Za-z0-9_]{0,19}-\d{1,7})(?![\w-])/.exec(s)

  return m ? m[1].toUpperCase() : null
}

export function jiraKeysFrom(text) {
  const out = []
  for (const part of String(text || '').split(/[\s,]+/)) {
    const k = normalizeJiraKey(part)
    if (k && !out.includes(k)) out.push(k)
  }

  return out
}

// ── sorting ────────────────────────────────────────────────────────────

const prioIdx = p => {
  const i = PRIORITIES.indexOf(p)

  return i < 0 ? 2 : i
}

/** Level, then rank, then id: the default order everywhere. */
export function byPriority(a, b) {
  return prioIdx(a.priority) - prioIdx(b.priority) || String(a.rank || '').localeCompare(String(b.rank || '')) || String(a.id).localeCompare(String(b.id))
}

export function byQueue(a, b) {
  const qa = a.queueRank || ''
  const qb = b.queueRank || ''
  if (qa && qb && qa !== qb) return qa < qb ? -1 : 1
  if (qa && !qb) return -1
  if (!qa && qb) return 1

  return byPriority(a, b)
}

/** The last rank in a priority band (for placing a new or moved item at its end). */
export function lastRankIn(items, priority, type) {
  let last = ''
  for (const it of items) if (it.priority === priority && (!type || it.type === type) && (it.rank || '') > last) last = it.rank
  return last
}

export function lastQueueRank(items, memberId) {
  let last = ''
  for (const it of items) if (it.type === 'task' && it.assigneeId === memberId && (it.queueRank || '') > last) last = it.queueRank
  return last
}

// ── items and the automatic rules ──────────────────────────────────────

let seq = 0

/** An event id that sorts by time. */
export function eventId(nowIso) {
  seq = (seq + 1) % 1296

  return `E-${Date.parse(nowIso).toString(36)}-${seq.toString(36).padStart(2, '0')}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`
}

export function systemEvent(itemId, systemType, body, data, ctx) {
  return { id: eventId(ctx.nowIso), itemId, kind: 'system', tag: null, body, createdAt: ctx.nowIso, editedAt: null, resolved: false, systemType, data: data || {} }
}

export function noteEvent(itemId, tag, body, ctx) {
  const t = NOTE_TAGS.includes(tag) ? tag : null

  return { id: eventId(ctx.nowIso), itemId, kind: 'note', tag: t, body: String(body || ''), createdAt: ctx.nowIso, editedAt: null, resolved: false, systemType: null, data: {} }
}

/**
 * A new idea or task. `fields` holds what the person gave; ctx carries
 * { today, nowIso, items } (items: to place the rank at the end of its band).
 * Answers the item and its creation events.
 */
export function newItem(kind, id, fields, ctx) {
  const f = fields || {}
  const priority = PRIORITIES.includes(f.priority) ? f.priority : 'medium'
  const items = ctx.items || []
  const base = {
    id,
    type: kind,
    title: String(f.title || '').trim().slice(0, 120),
    description: String(f.description || ''),
    projectId: f.projectId || null,
    priority,
    rank: rankBetween(lastRankIn(items, priority, kind), null),
    archived: false,
    createdAt: ctx.nowIso,
    updatedAt: ctx.nowIso,
    lastActivityAt: ctx.nowIso,
  }
  const events = [systemEvent(id, 'created', `${kind === 'idea' ? 'Idea' : 'Task'} created`, {}, ctx)]
  if (kind === 'idea') {
    const item = {
      ...base,
      status: IDEA_STAGES.includes(f.status) ? f.status : 'new',
      ownerId: f.ownerId || null,
      rationale: String(f.rationale || ''),
      decision: String(f.decision || ''),
      jiraRefs: Array.isArray(f.jiraRefs) ? f.jiraRefs.map(normalizeJiraKey).filter(Boolean) : [],
      convertedTaskIds: [],
    }

    return { item, events }
  }
  const item = {
    ...base,
    status: 'backlog',
    assigneeId: null,
    collaboratorIds: Array.isArray(f.collaboratorIds) ? f.collaboratorIds.filter(Boolean) : [],
    assignmentHistory: [],
    queueRank: '',
    sourceIdeaId: f.sourceIdeaId || null,
    jiraKeys: [],
    etaOriginal: null,
    etaCurrent: null,
    etaHistory: [],
    startDate: null,
    reviewRequestedAt: null,
    reviewedBy: null,
    reviewedOn: null,
    reviewNote: '',
    endDate: null,
    manualDateFlags: [],
  }
  // The rest goes through the same rules as an edit, so a task captured as
  // "Ada, ETA Fri, in progress" gets its history and dates like any other.
  let cur = item
  const change = {}
  if (f.assigneeId) change.assigneeId = f.assigneeId
  if (f.eta) change.eta = f.eta
  if (Array.isArray(f.jiraKeys) && f.jiraKeys.length) change.jiraAdd = f.jiraKeys
  if (f.status && f.status !== 'backlog') change.status = f.status
  else if (f.assigneeId) change.status = 'assigned'
  if (Object.keys(change).length) {
    const r = applyChange(cur, change, { ...ctx, quiet: true })
    cur = { ...cur, ...r.patch }
    events.push(...r.events)
  }

  return { item: cur, events }
}

/**
 * Applies one change to an item by the rules of §6.3 and answers
 * { patch, events, warnings }. Never touches anything Jira owns.
 *
 * change (any of): status, assigneeId (null to unassign), collaboratorIds, eta
 * (null clears), reviewedBy (null clears), reviewNote, reviewedOn, priority,
 * rank, queueRank, title, description, projectId, ownerId, rationale, decision,
 * jiraAdd [keys], jiraRemove [keys], archived, dates { startDate | reviewRequestedAt | endDate | reviewedOn: date|null } (manual).
 * ctx: { today, nowIso, members, items, quiet }
 */
export function applyChange(item, change, ctx) {
  const c = change || {}
  const patch = {}
  const events = []
  const warnings = []
  const ev = (type, body, data) => events.push(systemEvent(item.id, type, body, data, ctx))
  const isTask = item.type === 'task'
  const members = ctx.members || []
  const nameOf = id => (members.find(m => m.id === id) || {}).name || id || 'nobody'
  const cur = k => (k in patch ? patch[k] : item[k])

  for (const k of ['title', 'description', 'projectId', 'rationale', 'decision', 'reviewNote']) {
    if (k in c && c[k] !== item[k]) {
      patch[k] = k === 'title' ? String(c[k]).trim().slice(0, 120) : c[k]
      if (k === 'projectId') ev('project_changed', `Project: ${item.projectId || 'none'} → ${c[k] || 'none'}`, { from: item.projectId, to: c[k] })
    }
  }
  if ('priority' in c && PRIORITIES.includes(c.priority) && c.priority !== item.priority) {
    patch.priority = c.priority
    if (!('rank' in c)) patch.rank = rankBetween(lastRankIn((ctx.items || []).filter(x => x.id !== item.id), c.priority, item.type), null)
    ev('priority_changed', `Priority: ${PRIORITY_LABEL[item.priority] || item.priority} → ${PRIORITY_LABEL[c.priority]}`, { from: item.priority, to: c.priority })
  }
  if ('rank' in c && c.rank && c.rank !== item.rank) patch.rank = c.rank
  if ('queueRank' in c && c.queueRank !== item.queueRank) patch.queueRank = c.queueRank
  if ('ownerId' in c && c.ownerId !== item.ownerId) {
    patch.ownerId = c.ownerId || null
    ev('owner_changed', `Owner: ${nameOf(c.ownerId)}`, { from: item.ownerId, to: c.ownerId })
  }

  if (isTask && 'assigneeId' in c && (c.assigneeId || null) !== (item.assigneeId || null)) {
    const to = c.assigneeId || null
    const hist = (item.assignmentHistory || []).map(h => (h.to === null ? { ...h, to: ctx.today } : h))
    if (to) hist.push({ memberId: to, from: ctx.today, to: null })
    patch.assignmentHistory = hist
    patch.assigneeId = to
    patch.queueRank = to ? rankBetween(lastQueueRank((ctx.items || []).filter(x => x.id !== item.id), to), null) : ''
    patch.collaboratorIds = (cur('collaboratorIds') || []).filter(x => x !== to)
    ev('assigned', to ? `Assigned to ${nameOf(to)}` : 'Unassigned', { from: item.assigneeId || null, to })
    const rev = cur('reviewedBy')
    if (rev && rev === to) warnings.push('The reviewer is now the assignee; pick another reviewer.')
  }
  if (isTask && 'collaboratorIds' in c) {
    const list = [...new Set((c.collaboratorIds || []).filter(x => x && x !== cur('assigneeId')))]
    if (JSON.stringify(list) !== JSON.stringify(item.collaboratorIds || [])) patch.collaboratorIds = list
  }

  if ('status' in c && c.status && c.status !== item.status) {
    const to = c.status
    const from = item.status
    const valid = isTask ? TASK_STAGES : IDEA_STAGES
    if (!valid.includes(to)) {
      warnings.push(`"${to}" is not a ${isTask ? 'task' : 'idea'} stage.`)
    } else {
      patch.status = to
      ev('status_changed', `${STAGE_LABEL[from] || from} → ${STAGE_LABEL[to]}`, { from, to })
      if (isTask) {
        if (to === 'in_progress' && !cur('startDate')) patch.startDate = ctx.today
        if (to === 'in_review') patch.reviewRequestedAt = ctx.today
        if (CLOSED.has(to)) patch.endDate = ctx.today
        if (CLOSED.has(from) && !CLOSED.has(to) && item.endDate) {
          patch.endDate = null
          ev('reopened', `Reopened; end date ${item.endDate} cleared`, { endDate: item.endDate })
        }
        if (to === 'backlog' && cur('assigneeId') && !('assigneeId' in c)) warnings.push('Still assigned: unassign it too if it goes back to the pool.')
      }
    }
  }

  if (isTask && 'eta' in c) {
    const to = c.eta || null
    if (to && !isDate(to)) warnings.push(`ETA "${to}" is not a date (YYYY-MM-DD).`)
    else if (to !== (item.etaCurrent || null)) {
      if (to && !item.etaOriginal) patch.etaOriginal = to
      patch.etaCurrent = to
      patch.etaHistory = [...(item.etaHistory || []), { date: to, changedOn: ctx.today }]
      ev('eta_changed', to ? (item.etaCurrent ? `ETA ${item.etaCurrent} → ${to}` : `ETA set to ${to}`) : 'ETA cleared', { from: item.etaCurrent || null, to })
    }
  }

  if (isTask && 'reviewedBy' in c) {
    const to = c.reviewedBy || null
    const m = members.find(x => x.id === to)
    if (to && to === cur('assigneeId')) warnings.push('The reviewer cannot be the assignee.')
    else if (to && m && !m.isSenior) warnings.push(`${m.name} is not marked as senior.`)
    else if (to !== (item.reviewedBy || null)) {
      patch.reviewedBy = to
      if (to && !item.reviewedOn && !('reviewedOn' in c)) patch.reviewedOn = ctx.today
      if (!to) patch.reviewedOn = null
      ev('review_set', to ? `Reviewed by ${nameOf(to)}` : 'Reviewer cleared', { from: item.reviewedBy || null, to })
    }
  }
  if (isTask && 'reviewedOn' in c && (c.reviewedOn || null) !== (item.reviewedOn || null)) patch.reviewedOn = c.reviewedOn || null

  if (isTask && c.dates && typeof c.dates === 'object') {
    const flags = new Set(cur('manualDateFlags') || [])
    for (const k of ['startDate', 'reviewRequestedAt', 'endDate', 'reviewedOn']) {
      if (!(k in c.dates)) continue
      const v = c.dates[k] || null
      if (v && !isDate(v)) {
        warnings.push(`${k} "${v}" is not a date.`)
        continue
      }
      if (v === (item[k] || null)) continue
      patch[k] = v
      flags.add(k)
      ev('date_edited', `${k} set by hand to ${v || 'empty'}`, { field: k, from: item[k] || null, to: v })
    }
    patch.manualDateFlags = [...flags]
  }

  const keysField = isTask ? 'jiraKeys' : 'jiraRefs'
  if (Array.isArray(c.jiraAdd) && c.jiraAdd.length) {
    const list = [...(cur(keysField) || [])]
    for (const raw of c.jiraAdd) {
      const k = normalizeJiraKey(raw)
      if (!k) {
        warnings.push(`"${raw}" is not a Jira key or link.`)
        continue
      }
      if (list.includes(k)) continue
      list.push(k)
      ev('jira_key_added', `Linked ${k}`, { key: k })
    }
    patch[keysField] = list
  }
  if (Array.isArray(c.jiraRemove) && c.jiraRemove.length) {
    const drop = new Set(c.jiraRemove.map(normalizeJiraKey).filter(Boolean))
    const before = cur(keysField) || []
    const list = before.filter(k => !drop.has(k))
    for (const k of before) if (drop.has(k)) ev('jira_key_removed', `Unlinked ${k}`, { key: k })
    patch[keysField] = list
  }

  if ('archived' in c && !!c.archived !== !!item.archived) {
    patch.archived = !!c.archived
    ev(c.archived ? 'archived' : 'restored', c.archived ? 'Archived' : 'Restored', {})
  }

  if (Object.keys(patch).length > 0) {
    patch.updatedAt = ctx.nowIso
    patch.lastActivityAt = ctx.nowIso
  }

  return { patch, events: ctx.quiet ? events.filter(e => e.systemType !== 'created') : events, warnings }
}

/**
 * Converts an idea into tasks. titles: [{ title, assigneeId?, eta? }].
 * Answers { ideaPatch, tasks: [{item, events}], ideaEvents, counters }.
 */
export function convertIdea(idea, specs, counters, ctx) {
  let c = counters
  const tasks = []
  let items = [...(ctx.items || [])]
  for (const s of specs) {
    const n = nextId('task', c)
    c = n.counters
    const made = newItem(
      'task',
      n.id,
      { title: s.title, description: s.description ?? idea.description, projectId: s.projectId || idea.projectId, priority: s.priority || idea.priority, assigneeId: s.assigneeId, eta: s.eta, sourceIdeaId: idea.id },
      { ...ctx, items },
    )
    items = [...items, made.item]
    tasks.push(made)
  }
  const ids = tasks.map(t => t.item.id)
  const r = applyChange(idea, { status: 'converted' }, ctx)
  const ideaPatch = { ...r.patch, convertedTaskIds: [...(idea.convertedTaskIds || []), ...ids] }
  const ideaEvents = [...r.events, systemEvent(idea.id, 'converted', `Converted to ${ids.join(', ')}`, { taskIds: ids }, ctx)]

  return { ideaPatch, tasks, ideaEvents, counters: c }
}

// ── derived flags ──────────────────────────────────────────────────────

/** Unresolved blocker notes per item id. */
export function openBlockers(events) {
  const out = new Map()
  for (const e of events || []) {
    if (e.kind !== 'note' || e.tag !== 'blocker' || e.resolved) continue
    const list = out.get(e.itemId) || []
    list.push(e)
    out.set(e.itemId, list)
  }

  return out
}

/**
 * Flags for one item. ctx: { today, settings, blockers (Map), jira ({key: snap}), members }.
 * Answers { overdue, slipped, slipDays, stale, blocked, needsClosing, mismatch, wip? }.
 */
export function flagsFor(item, ctx) {
  const s = { ...DEFAULT_SETTINGS, ...(ctx.settings || {}) }
  const f = { overdue: false, slipped: false, slipDays: 0, stale: false, blocked: false, needsClosing: false, mismatch: false }
  if (item.type === 'task') {
    const open = OPEN_TASK.has(item.status)
    if (open && item.etaCurrent && item.etaCurrent < ctx.today) f.overdue = true
    if (item.etaCurrent && item.etaOriginal && item.etaCurrent > item.etaOriginal) {
      f.slipped = true
      f.slipDays = daysBetween(item.etaOriginal, item.etaCurrent)
    }
    if (item.status === 'in_progress' && item.lastActivityAt) {
      const idle = daysBetween(dateOf(item.lastActivityAt), ctx.today)
      if (idle > Number(s.staleDays || 5)) f.stale = true
    }
    const keys = item.jiraKeys || []
    const snaps = keys.map(k => (ctx.jira || {})[k]).filter(Boolean)
    if (keys.length && open && snaps.length === keys.length && snaps.every(j => !j.error && j.statusCategory === 'done')) f.needsClosing = true
    const me = (ctx.members || []).find(m => m.id === item.assigneeId)
    if (me && me.jiraAccountId && snaps.some(j => j.assigneeAccountId && j.assigneeAccountId !== me.jiraAccountId)) f.mismatch = true
  }
  if (ctx.blockers && (ctx.blockers.get(item.id) || []).length) f.blocked = true

  return f
}

export function isOngoing(item) {
  return item.type === 'task' && ONGOING.has(item.status)
}

export function isOpenTask(item) {
  return item.type === 'task' && OPEN_TASK.has(item.status)
}

/** Members over the WIP limit: { memberId: count }. */
export function wipOver(items, limit) {
  const n = {}
  for (const it of items) if (!it.archived && isOngoing(it) && it.assigneeId) n[it.assigneeId] = (n[it.assigneeId] || 0) + 1
  const out = {}
  for (const [k, v] of Object.entries(n)) if (v > Number(limit || 3)) out[k] = v

  return out
}

// ── Jira snapshots ─────────────────────────────────────────────────────

export const JIRA_FIELDS = ['summary', 'status', 'assignee', 'priority', 'created', 'updated', 'resolutiondate']

/** A jira/{key} doc from one issue as the connector returns it. */
export function jiraSnapshot(issue, nowIso) {
  const f = (issue && issue.fields) || {}
  const st = f.status || {}
  const as = f.assignee || {}

  return {
    key: String(issue.key || ''),
    summary: String(f.summary || ''),
    status: String(st.name || ''),
    statusCategory: String((st.statusCategory || {}).key || ''),
    assigneeAccountId: as.accountId || null,
    assigneeName: as.displayName || null,
    priority: (f.priority || {}).name || null,
    created: f.created || null,
    updated: f.updated || null,
    resolutionDate: f.resolutiondate || null,
    fetchedAt: nowIso,
    error: null,
  }
}

/** Issues from a search answer in any of the shapes the connector uses. */
export function issuesFrom(answer) {
  const a = answer && typeof answer === 'object' ? answer : {}
  const d = a.data && typeof a.data === 'object' ? a.data : a
  if (Array.isArray(d.issues)) return d.issues
  if (d.issues && Array.isArray(d.issues.nodes)) return d.issues.nodes
  if (d.key && d.fields) return [d]

  return []
}

/** The keys to refresh, in chunks (JQL `key in (…)`). */
export function jiraChunks(items, size) {
  const keys = new Set()
  for (const it of items) if (!it.archived) for (const k of [...(it.jiraKeys || []), ...(it.jiraRefs || [])]) keys.add(k)
  const list = [...keys].sort()
  const out = []
  for (let i = 0; i < list.length; i += size || 10) out.push(list.slice(i, i + (size || 10)))

  return out
}

// ── filters ────────────────────────────────────────────────────────────

/**
 * The items a filter set keeps. f: { project, team, member, type, priority,
 * status, flags: [..], archived, q }. ctx as flagsFor, plus members.
 */
export function filterItems(items, f, ctx) {
  const members = ctx.members || []
  const teamOf = id => (members.find(m => m.id === id) || {}).teams || []
  const q = String(f.q || '').trim().toLowerCase()

  return items.filter(it => {
    if (!f.archived && it.archived) return false
    if (f.project && it.projectId !== f.project) return false
    if (f.type && it.type !== f.type) return false
    if (f.priority && it.priority !== f.priority) return false
    if (f.status && it.status !== f.status) return false
    const people = it.type === 'task' ? [it.assigneeId, ...(it.collaboratorIds || [])] : [it.ownerId]
    if (f.member && !people.includes(f.member)) return false
    if (f.team && !people.some(p => teamOf(p).includes(f.team))) return false
    if (q && !`${it.id} ${it.title} ${it.description || ''} ${(it.jiraKeys || it.jiraRefs || []).join(' ')}`.toLowerCase().includes(q)) return false
    if (f.flags && f.flags.length) {
      const fl = flagsFor(it, ctx)
      if (!f.flags.every(k => fl[k])) return false
    }

    return true
  })
}

// ── reports ────────────────────────────────────────────────────────────

/** Scope label and member set. scope: { kind: team|group|project|member, value }. */
export function scopeOf(scope, members, projects) {
  const s = scope || { kind: 'team' }
  if (s.kind === 'group') return { label: `${s.value} team`, members: members.filter(m => (m.teams || []).includes(s.value)) }
  if (s.kind === 'member') {
    const m = members.find(x => x.id === s.value)

    return { label: m ? m.name : s.value, members: m ? [m] : [] }
  }
  if (s.kind === 'project') {
    const p = projects.find(x => x.id === s.value)

    return { label: p ? p.name : s.value, members, project: s.value }
  }

  return { label: 'Whole team', members }
}

/**
 * The report numbers, deterministic. input: { items, events, members, projects,
 * jira, settings, scope, period, custom, today }. Reports attribute a task to
 * its current assignee only.
 */
export function computeReport(input) {
  const { items = [], events = [], members = [], projects = [], jira = {}, settings = {}, today } = input
  const range = periodRange(input.period || 'this_week', today, input.custom)
  const sc = scopeOf(input.scope, members, projects)
  const ids = new Set(sc.members.map(m => m.id))
  const live = items.filter(it => !it.archived)
  const inScope = it => {
    if (sc.project) return it.projectId === sc.project
    if (!input.scope || input.scope.kind === 'team') return true
    if (it.type === 'task') return ids.has(it.assigneeId)

    return ids.has(it.ownerId)
  }
  const tasks = live.filter(it => it.type === 'task' && inScope(it))
  const ideas = live.filter(it => it.type === 'idea' && inScope(it))
  const blockers = openBlockers(events)
  const fctx = { today, settings, blockers, jira, members }
  const nameOf = id => (members.find(m => m.id === id) || {}).name || (id ? id : 'Unassigned')
  const row = it => ({ id: it.id, title: it.title, priority: it.priority, status: it.status, assignee: nameOf(it.assigneeId || it.ownerId), project: (projects.find(p => p.id === it.projectId) || {}).name || it.projectId || '', jiraKeys: it.jiraKeys || it.jiraRefs || [], eta: it.etaCurrent || null, endDate: it.endDate || null })

  const delivered = tasks.filter(t => t.status === 'done' && inRange(t.endDate, range))
  const inProgress = tasks.filter(t => ONGOING.has(t.status))
  const flagged = tasks.map(t => ({ t, f: flagsFor(t, fctx) }))
  const overdue = flagged.filter(x => x.f.overdue).map(x => x.t)
  const withEta = delivered.filter(t => t.etaOriginal)
  const onTime = withEta.filter(t => t.endDate <= t.etaOriginal)
  const cycles = delivered.filter(t => t.startDate && t.endDate).map(t => Math.max(0, daysBetween(t.startDate, t.endDate)))
  const slipSet = tasks.filter(t => OPEN_TASK.has(t.status) || delivered.includes(t))
  const totalSlip = slipSet.reduce((a, t) => a + (t.etaCurrent && t.etaOriginal && t.etaCurrent > t.etaOriginal ? daysBetween(t.etaOriginal, t.etaCurrent) : 0), 0)

  const deliveredByPriority = PRIORITIES.map(p => ({ priority: p, items: delivered.filter(t => t.priority === p).sort(byPriority).map(row) })).filter(g => g.items.length)

  const risk = (pred, label) => flagged.filter(x => OPEN_TASK.has(x.t.status) && pred(x.f)).map(x => ({ ...row(x.t), reason: label(x) }))
  const risks = {
    overdue: risk(f => f.overdue, x => `due ${x.t.etaCurrent}`),
    slipped: risk(f => f.slipped, x => `slipped ${x.f.slipDays}d (${x.t.etaOriginal} → ${x.t.etaCurrent})`),
    stale: risk(f => f.stale, x => `no activity since ${dateOf(x.t.lastActivityAt)}`),
    blocked: risk(f => f.blocked, x => (blockers.get(x.t.id) || []).map(e => e.body).join(' · ')),
  }

  const itemIds = new Set([...tasks, ...ideas].map(i => i.id))
  const decisions = events
    .filter(e => e.kind === 'note' && e.tag === 'decision' && itemIds.has(e.itemId) && inRange(dateOf(e.createdAt), range))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map(e => {
      const it = items.find(i => i.id === e.itemId) || {}

      return { itemId: e.itemId, title: it.title || '', date: dateOf(e.createdAt), body: e.body }
    })

  const people = input.scope && input.scope.kind === 'project' ? members.filter(m => tasks.some(t => t.assigneeId === m.id)) : sc.members
  const workload = people
    .filter(m => m.active !== false || tasks.some(t => t.assigneeId === m.id))
    .map(m => ({
      memberId: m.id,
      name: m.name,
      ongoing: tasks.filter(t => t.assigneeId === m.id && ONGOING.has(t.status)).length,
      done: delivered.filter(t => t.assigneeId === m.id).length,
      overdue: overdue.filter(t => t.assigneeId === m.id).length,
      reviewed: live.filter(t => t.type === 'task' && t.reviewedBy === m.id && inRange(t.reviewedOn, range)).length,
    }))
  const memberItems = input.scope && input.scope.kind === 'member' ? tasks.filter(t => !CLOSED.has(t.status) || inRange(t.endDate, range)).sort(byPriority).map(row) : []

  const stageMoves = to => new Set(events.filter(e => e.systemType === 'status_changed' && e.data && e.data.to === to && inRange(dateOf(e.createdAt), range)).map(e => e.itemId))
  const ideaIds = new Set(ideas.map(i => i.id))
  const countIn = set => [...set].filter(id => ideaIds.has(id)).length
  const pipeline = {
    created: ideas.filter(i => inRange(dateOf(i.createdAt), range)).length,
    approved: countIn(stageMoves('approved')),
    converted: countIn(stageMoves('converted')),
    rejected: countIn(stageMoves('rejected')),
  }

  const horizon = addDays(today, 14)
  const comingUp = tasks
    .filter(t => OPEN_TASK.has(t.status) && t.etaCurrent && t.etaCurrent >= today && t.etaCurrent <= horizon)
    .sort((a, b) => a.etaCurrent.localeCompare(b.etaCurrent) || byPriority(a, b))
    .map(row)

  return {
    scope: input.scope || { kind: 'team' },
    scopeLabel: sc.label,
    period: input.period || 'this_week',
    range,
    today,
    headline: {
      delivered: delivered.length,
      inProgress: inProgress.length,
      overdue: overdue.length,
      onTimeRate: withEta.length ? Math.round((onTime.length / withEta.length) * 100) : null,
      onTimeBase: withEta.length,
      avgCycleDays: cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 10) / 10 : null,
      totalSlipDays: totalSlip,
    },
    delivered: deliveredByPriority,
    risks,
    decisions,
    workload,
    memberItems,
    pipeline,
    comingUp,
  }
}

const mdEsc = s => String(s || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ')

/** The report as Markdown; empty sections are left out. */
export function reportMarkdown(r, summary) {
  const h = r.headline
  const out = [`# Team Board report: ${r.scopeLabel}`, '', `${r.range.label} (${r.range.from} to ${r.range.to}) · generated ${r.today}`, '']
  if (summary && summary.trim()) out.push('## Executive summary', '', summary.trim(), '')
  out.push(
    '## Headline numbers',
    '',
    '| Delivered | In progress | Overdue | On-time rate | Avg cycle time | Total slip |',
    '| --- | --- | --- | --- | --- | --- |',
    `| ${h.delivered} | ${h.inProgress} | ${h.overdue} | ${h.onTimeRate === null ? 'n/a' : `${h.onTimeRate}% of ${h.onTimeBase}`} | ${h.avgCycleDays === null ? 'n/a' : `${h.avgCycleDays} day${h.avgCycleDays === 1 ? '' : 's'}`} | ${h.totalSlipDays} day${h.totalSlipDays === 1 ? '' : 's'} |`,
    '',
  )
  if (r.delivered.length) {
    out.push('## Delivered', '')
    for (const g of r.delivered) {
      out.push(`**${PRIORITY_LABEL[g.priority]}**`, '')
      for (const t of g.items) out.push(`- ${t.id} ${mdEsc(t.title)} · ${mdEsc(t.assignee)}${t.jiraKeys.length ? ` · ${t.jiraKeys.join(', ')}` : ''}`)
      out.push('')
    }
  }
  const risks = [
    ['Overdue', r.risks.overdue],
    ['Slipped', r.risks.slipped],
    ['Stale', r.risks.stale],
    ['Blocked', r.risks.blocked],
  ].filter(([, l]) => l.length)
  if (risks.length) {
    out.push('## Risks', '')
    for (const [label, list] of risks) {
      out.push(`**${label}**`, '')
      for (const t of list) out.push(`- ${t.id} ${mdEsc(t.title)} · ${mdEsc(t.assignee)} · ${mdEsc(t.reason)}`)
      out.push('')
    }
  }
  if (r.decisions.length) {
    out.push('## Decisions', '')
    for (const d of r.decisions) out.push(`- ${d.date} · ${d.itemId} ${mdEsc(d.title)}: ${mdEsc(d.body)}`)
    out.push('')
  }
  if (r.workload.length) {
    out.push('## Workload', '', '| Member | Ongoing | Done | Overdue | Reviewed |', '| --- | --- | --- | --- | --- |')
    for (const w of r.workload) out.push(`| ${mdEsc(w.name)} | ${w.ongoing} | ${w.done} | ${w.overdue} | ${w.reviewed} |`)
    out.push('')
  }
  if (r.memberItems.length) {
    out.push('## Items', '')
    for (const t of r.memberItems) out.push(`- ${t.id} ${mdEsc(t.title)} · ${STAGE_LABEL[t.status] || t.status}${t.eta ? ` · ETA ${t.eta}` : ''}`)
    out.push('')
  }
  const p = r.pipeline
  if (p.created + p.approved + p.converted + p.rejected > 0) {
    out.push('## Ideas pipeline', '', `Created ${p.created} · approved ${p.approved} · converted ${p.converted} · rejected ${p.rejected}`, '')
  }
  if (r.comingUp.length) {
    out.push('## Coming up (next 14 days)', '')
    for (const t of r.comingUp) out.push(`- ${t.eta} · ${t.id} ${mdEsc(t.title)} · ${mdEsc(t.assignee)}`)
    out.push('')
  }

  return out.join('\n').trim() + '\n'
}

const csvCell = v => {
  const s = Array.isArray(v) ? v.join(' ') : v === null || v === undefined ? '' : String(v)

  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Raw rows behind a report, one per task or idea in scope. */
export function reportCsv(input) {
  const { items = [], members = [], projects = [] } = input
  const r = computeReport(input)
  const sc = scopeOf(input.scope, members, projects)
  const ids = new Set(sc.members.map(m => m.id))
  const nameOf = id => (members.find(m => m.id === id) || {}).name || ''
  const rows = items
    .filter(it => !it.archived)
    .filter(it => (sc.project ? it.projectId === sc.project : !input.scope || input.scope.kind === 'team' ? true : ids.has(it.type === 'task' ? it.assigneeId : it.ownerId)))
    .sort(byPriority)
  const head = ['id', 'type', 'title', 'project', 'priority', 'status', 'assignee_or_owner', 'eta_original', 'eta_current', 'start', 'review_requested', 'reviewed_by', 'reviewed_on', 'end', 'jira']
  const lines = [head.join(',')]
  for (const it of rows) {
    lines.push(
      [
        it.id,
        it.type,
        it.title,
        (projects.find(p => p.id === it.projectId) || {}).name || it.projectId,
        it.priority,
        it.status,
        nameOf(it.type === 'task' ? it.assigneeId : it.ownerId),
        it.etaOriginal,
        it.etaCurrent,
        it.startDate,
        it.reviewRequestedAt,
        nameOf(it.reviewedBy),
        it.reviewedOn,
        it.endDate,
        it.jiraKeys || it.jiraRefs,
      ]
        .map(csvCell)
        .join(','),
    )
  }

  return { csv: lines.join('\n') + '\n', report: r }
}

/** Facts for a drafted summary: plain numbers only, nothing invented. */
export function summaryFacts(r) {
  const h = r.headline

  return [
    `Scope: ${r.scopeLabel}. Period: ${r.range.label} (${r.range.from} to ${r.range.to}).`,
    `Delivered ${h.delivered}; in progress ${h.inProgress}; overdue ${h.overdue}; on-time rate ${h.onTimeRate === null ? 'n/a' : h.onTimeRate + '% of ' + h.onTimeBase}; average cycle ${h.avgCycleDays === null ? 'n/a' : h.avgCycleDays + ' days'}; total slip ${h.totalSlipDays} days.`,
    r.delivered.length ? `Delivered: ${r.delivered.flatMap(g => g.items.map(t => `${t.title} (${g.priority})`)).join('; ')}.` : '',
    r.risks.blocked.length ? `Blocked: ${r.risks.blocked.map(t => `${t.title}: ${t.reason}`).join('; ')}.` : '',
    r.risks.overdue.length ? `Overdue: ${r.risks.overdue.map(t => t.title).join('; ')}.` : '',
    r.risks.slipped.length ? `Slipped: ${r.risks.slipped.map(t => `${t.title} ${t.reason}`).join('; ')}.` : '',
    r.decisions.length ? `Decisions: ${r.decisions.map(d => d.body).join('; ')}.` : '',
    `Ideas: created ${r.pipeline.created}, approved ${r.pipeline.approved}, converted ${r.pipeline.converted}, rejected ${r.pipeline.rejected}.`,
    r.comingUp.length ? `Due in the next 14 days: ${r.comingUp.map(t => `${t.title} (${t.eta})`).join('; ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** The one-line status: "2 overdue · 1 blocked"; empty when nothing to show. */
export function statusLine(items, events, ctx) {
  const blockers = openBlockers(events)
  let overdue = 0
  let blocked = 0
  for (const it of items) {
    if (it.archived || it.type !== 'task') continue
    const f = flagsFor(it, { ...ctx, blockers })
    if (f.overdue) overdue += 1
    if (f.blocked && isOpenTask(it)) blocked += 1
  }
  const parts = []
  if (overdue) parts.push(`${overdue} overdue`)
  if (blocked) parts.push(`${blocked} blocked`)

  return parts.join(' · ')
}
