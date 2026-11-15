// Clean View: everything that needs no `$`. Pure functions, so tests can call them.

import type { CleanTask, Checklist } from '../types'

export const MAX_NAME = 40
export const METER = 10
export const FALLBACK_NAME = 'Working on it'

const CODE_FILE =
  /\.(tsx?|jsx?|mjs|cjs|py|rb|go|rs|java|kts?|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|json|ya?ml|toml|lock|css|scss|less|html?|vue|svelte|sql|md|mdx|gradle|xml|ini|env|dart|lua|pl|r)[),.;:!?'"]*$/i

/** Every step and job name passes through here: no code, no paths, no file names, at most 40 characters. */
export function cleanName(raw: unknown, max = MAX_NAME): string {
  let s = typeof raw === 'string' ? raw : ''
  s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/`/g, ' ')
  s = s
    .split(/\s+/)
    .filter(word => word !== '' && !word.includes('/') && !word.includes('\\') && !CODE_FILE.test(word))
    .join(' ')
  s = s.replace(/\s+/g, ' ').trim().replace(/[\s,;:(\-–—]+$/, '').trim()
  if (!s) return FALLBACK_NAME
  s = s.charAt(0).toUpperCase() + s.slice(1)
  if (s.length <= max) return s
  const room = s.slice(0, max - 1)
  const space = room.lastIndexOf(' ')
  const cut = (space > 0 ? room.slice(0, space) : room).replace(/[\s,;:(\-–—]+$/, '')
  return cut + '…'
}

/** A job title: 2 to 6 plain words. */
export function cleanTitle(raw: unknown): string {
  const cleaned = cleanName(typeof raw === 'string' ? raw.replace(/["'.!?]+/g, ' ') : raw)
  if (cleaned === FALLBACK_NAME) return cleaned
  return cleanName(cleaned.replace(/…$/, '').split(' ').slice(0, 6).join(' '))
}

/** A first title from the request itself, until Haiku names the job. */
export function titleFromRequest(text: string): string {
  const first = text.replace(/\s+/g, ' ').trim().split(/[.!?\n]/)[0] ?? ''
  return cleanTitle(first.split(' ').slice(0, 6).join(' '))
}

export function namingPrompt(request: string): string {
  return `Name this request for a progress bar in 2 to 6 plain words that start with a verb, like "Build my landing page". No file names, paths, code or quotes. Reply with the name only.\n\nRequest:\n${request.slice(0, 2000)}`
}

// ---------------------------------------------------------------------------
// The checklist
// ---------------------------------------------------------------------------

export function newChecklist(jobId: string, title: string, now: number): Checklist {
  return {
    jobId,
    title,
    phase: 'working',
    tasks: [
      { id: 'p1', name: 'Understand your request', status: 'active', percent: null, hasReported: false },
      { id: 'p2', name: 'Plan the steps', status: 'upcoming', percent: null, hasReported: false },
    ],
    needsYouReason: null,
    stuckReason: null,
    startedAt: now,
    finishedAt: null,
    isCollapsed: false,
    hasPlan: false,
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** plan_steps: the plan replaces whatever stood; the first step starts. */
export function applyPlan(list: Checklist, steps: unknown): { list: Checklist; count: number } {
  const names = (Array.isArray(steps) ? steps : []).map(s => cleanName(s)).filter((s, i, all) => all.findIndex(x => same(x, s)) === i).slice(0, 8)
  if (names.length === 0) return { list, count: 0 }
  const tasks: CleanTask[] = names.map((name, i) => ({ id: `s${i + 1}`, name, status: i === 0 ? 'active' : 'upcoming', percent: null, hasReported: false }))
  return { list: { ...list, tasks, hasPlan: true, phase: 'working', stuckReason: null }, count: names.length }
}

/** Makes `index` the active step: everything before it done, the rest upcoming unless already done. */
function activate(tasks: CleanTask[], index: number): CleanTask[] {
  return tasks.map((t, i) => {
    if (i < index) return t.status === 'done' ? t : { ...t, status: 'done', percent: 100 }
    if (i === index) return t.status === 'done' ? { ...t, status: 'active', percent: null, hasReported: false } : { ...t, status: 'active' }
    return t.status === 'active' ? { ...t, status: 'upcoming' } : t
  })
}

/** report_progress: move the meter, check off what came before, start the next at 100. */
export function applyProgress(list: Checklist, task: unknown, percent: unknown): { list: Checklist; percent: number } {
  const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)))
  const name = cleanName(task)
  let tasks = [...list.tasks]
  const placeholders = !list.hasPlan
  if (placeholders) tasks = []
  let index = tasks.findIndex(t => same(t.name, name))
  if (index < 0 && name !== FALLBACK_NAME) {
    // A step that is not in the plan: it is what's happening now, right after the current one.
    const current = tasks.findIndex(t => t.status === 'active')
    const at = current >= 0 ? current + 1 : tasks.filter(t => t.status === 'done').length
    tasks.splice(at, 0, { id: `r${Date.now().toString(36)}${tasks.length}`, name, status: 'upcoming', percent: null, hasReported: false })
    index = at
  }
  if (index < 0) index = Math.max(0, tasks.findIndex(t => t.status === 'active'))
  if (tasks.length === 0) return { list, percent: pct }
  tasks = activate(tasks, index)
  const target = tasks[index]!
  tasks[index] = { ...target, percent: pct, hasReported: true }
  if (pct >= 100) {
    tasks[index] = { ...tasks[index]!, status: 'done', percent: 100 }
    const nextUp = tasks.findIndex((t, i) => i > index && t.status === 'upcoming')
    if (nextUp >= 0) tasks[nextUp] = { ...tasks[nextUp]!, status: 'active', percent: null, hasReported: false }
  }
  return { list: { ...list, tasks, hasPlan: true }, percent: pct }
}

/** TodoWrite: the whole list, as the to-do tool keeps it. */
export function applyTodos(list: Checklist, todos: unknown): Checklist {
  const items = (Array.isArray(todos) ? todos : []) as { content?: unknown; status?: unknown; activeForm?: unknown }[]
  if (items.length === 0) return list
  let seenActive = false
  const tasks: CleanTask[] = items.map((t, i) => {
    let status: CleanTask['status'] = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'upcoming'
    if (status === 'active') {
      if (seenActive) status = 'upcoming'
      seenActive = true
    }
    return { id: `t${i + 1}`, name: cleanName(t.content), status, percent: status === 'done' ? 100 : null, hasReported: false }
  })
  return { ...list, tasks, hasPlan: true }
}

/** TaskCreate: one more step, waiting its turn. */
export function applyTaskCreate(list: Checklist, id: string, subject: unknown): Checklist {
  const base = list.hasPlan ? list.tasks : []
  if (base.some(t => t.id === id)) return list
  const task: CleanTask = { id, name: cleanName(subject), status: 'upcoming', percent: null, hasReported: false }
  const tasks = [...base, task]
  if (!tasks.some(t => t.status === 'active')) {
    const first = tasks.findIndex(t => t.status === 'upcoming')
    if (first >= 0) tasks[first] = { ...tasks[first]!, status: 'active' }
  }
  return { ...list, tasks, hasPlan: true }
}

/** TaskUpdate: a status change, a rename, or a removal. */
export function applyTaskUpdate(list: Checklist, input: { taskId?: unknown; status?: unknown; subject?: unknown }): Checklist {
  const id = String(input.taskId ?? '')
  const index = list.tasks.findIndex(t => t.id === id)
  if (index < 0) return list
  if (input.status === 'deleted') return { ...list, tasks: list.tasks.filter(t => t.id !== id) }
  let tasks = [...list.tasks]
  if (typeof input.subject === 'string') tasks[index] = { ...tasks[index]!, name: cleanName(input.subject) }
  if (input.status === 'in_progress') {
    tasks = tasks.map((t, i) => (i === index ? { ...t, status: 'active' } : t.status === 'active' ? { ...t, status: 'upcoming' } : t))
  } else if (input.status === 'completed') {
    tasks[index] = { ...tasks[index]!, status: 'done', percent: 100 }
  } else if (input.status === 'pending') {
    tasks[index] = { ...tasks[index]!, status: 'upcoming' }
  }
  return { ...list, tasks }
}

export function hasUnfinished(list: Checklist): boolean {
  return list.hasPlan && list.tasks.some(t => t.status !== 'done')
}

/** All done: every step checked off. */
export function finishAll(list: Checklist, now: number): Checklist {
  return {
    ...list,
    phase: 'done',
    tasks: list.tasks.map(t => ({ ...t, status: 'done', percent: 100 })),
    needsYouReason: null,
    stuckReason: null,
    finishedAt: now,
  }
}

// ---------------------------------------------------------------------------
// Plain sentences
// ---------------------------------------------------------------------------

export const NEEDS_OK = 'Claude needs your OK to continue'
export const NEEDS_ANSWER = 'Claude has a question for you'
export const NEEDS_REPLY = 'Claude is waiting for your reply'
export const SAID_NO = 'you said no to a step, so Claude paused'
export const KEEPS_FAILING = 'a step keeps failing, Claude is trying another way'
export const REFUSED = "Claude couldn't help with that request"

/** An API error as one calm sentence. */
export function friendlyError(kind: string | undefined, details?: string): string {
  const d = details ?? ''
  if (kind === 'rate_limit' || kind === 'billing_error') return 'you hit your usage limit, try again a little later'
  if (kind === 'overloaded' || kind === 'server_error') return "Claude's servers are busy, try again in a minute"
  if (/prompt is too long|context|too many tokens|max_tokens/i.test(d) || kind === 'max_output_tokens') return 'type /compact and try again'
  if (/network|connection|ECONN|ETIMEDOUT|ENOTFOUND|socket|fetch failed|offline/i.test(d)) return 'the internet connection dropped'
  if (kind === 'authentication_failed' || kind === 'oauth_org_not_allowed' || kind === 'cloud_credential_error' || kind === 'verification_required') return 'type /login'
  if (kind === 'invalid_request') return 'type /compact and try again'
  return 'something went wrong, try again in a moment'
}

/** The user turned down a permission prompt (the text the model reads back). */
export function isRefusal(text: unknown): boolean {
  return typeof text === 'string' && /user doesn't want to proceed|user (declined|rejected|denied)|was rejected|permission (was )?denied by the user/i.test(text)
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** The 10-cell meter: filled to the percent, or a moving sweep while nothing is reported. */
export function meter(task: CleanTask, tick: number): { filled: string; empty: string; sweep?: { before: string; lit: string; after: string } } {
  if (task.status === 'done') return { filled: '█'.repeat(METER), empty: '' }
  if (task.status === 'upcoming') return { filled: '', empty: '░'.repeat(METER) }
  if (!task.hasReported || task.percent === null) {
    const span = 3
    const pos = tick % (METER + span) - span
    const cells = Array.from({ length: METER }, (_, i) => i >= pos && i < pos + span)
    const first = cells.indexOf(true)
    const count = cells.filter(Boolean).length
    if (first < 0) return { filled: '', empty: '░'.repeat(METER) }
    return { filled: '', empty: '', sweep: { before: '░'.repeat(first), lit: '█'.repeat(count), after: '░'.repeat(METER - first - count) } }
  }
  const n = Math.max(0, Math.min(METER, Math.round((task.percent / 100) * METER)))
  return { filled: '█'.repeat(n), empty: '░'.repeat(METER - n) }
}

export function label(task: CleanTask, isFirstUpcoming: boolean): string {
  if (task.status === 'done') return 'Done'
  if (task.status === 'upcoming') return isFirstUpcoming ? 'Next' : 'Up next'
  if (!task.hasReported || task.percent === null) return 'Working'
  return `${task.percent}%`
}

/** Columns a row's name may use, so rows never wrap: icon, name, meter, label. */
export function nameColumns(bodyColumns: number): number {
  return Math.max(4, bodyColumns - 2 - 1 - METER - 2 - 7)
}

export function fit(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length <= width ? text : text.slice(0, Math.max(1, width - 1)) + '…'
}

export const SYSTEM_SECTION = (planTool: string, progressTool: string) => `# Clean View is on
The person sees a simple checklist above the prompt instead of tool calls. Keep it accurate.
- For every request, even a quick question, call ${planTool} first with 2 to 8 short step names in order. If it is deferred, load it with ToolSearch first. If this session has TodoWrite or TaskCreate, your to-do list can be the plan instead.
- Then call ${progressTool} as real progress happens (task = the step's name, percent = 0 to 100), and with percent 100 the moment a step finishes.
- Write every step name in plain English a non-technical person understands, under 40 characters, starting with a verb, like "Build the pricing section".
- Never put file paths, file names, commands, code or tool names in a step name.`
