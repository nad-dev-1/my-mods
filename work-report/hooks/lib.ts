import type { DayRecord, Kind, Settings, Tab } from '../types'

// ---------------------------------------------------------------------------
// Kinds and settings
// ---------------------------------------------------------------------------

export const KINDS: readonly Kind[] = ['emails', 'images', 'documents', 'research', 'other']

export const KIND_LABEL: Record<Kind, string> = {
  emails: 'Emails',
  images: 'Images and video',
  documents: 'Documents',
  research: 'Research',
  other: 'Other',
}

export const KIND_SHORT: Record<Kind, string> = {
  emails: 'Email',
  images: 'Media',
  documents: 'Docs',
  research: 'Research',
  other: 'Other',
}

export const DEFAULT_SETTINGS: Settings = {
  rate: 50,
  minutes: { emails: 10, documents: 30, images: 20, research: 25, other: 10 },
}

export function emptyDay(): DayRecord {
  return { kinds: { emails: 0, images: 0, documents: 0, research: 0, other: 0 }, models: {} }
}

export function asSettings(value: unknown): Settings {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<Settings>
  const m = (v.minutes && typeof v.minutes === 'object' ? v.minutes : {}) as Partial<Record<Kind, unknown>>
  const num = (x: unknown, fallback: number) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : fallback)
  const minutes = {} as Record<Kind, number>
  for (const k of KINDS) minutes[k] = num(m[k], DEFAULT_SETTINGS.minutes[k])
  return { rate: num(v.rate, DEFAULT_SETTINGS.rate), minutes }
}

export function asDay(value: unknown): DayRecord | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<DayRecord>
  const day = emptyDay()
  const kinds = (v.kinds && typeof v.kinds === 'object' ? v.kinds : {}) as Record<string, unknown>
  for (const k of KINDS) {
    const n = kinds[k]
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) day.kinds[k] = Math.round(n)
  }
  const models = (v.models && typeof v.models === 'object' ? v.models : {}) as Record<string, unknown>
  for (const [name, n] of Object.entries(models)) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) day.models[name] = Math.round(n)
  }
  return day
}

// ---------------------------------------------------------------------------
// Sorting a task by its tools
// ---------------------------------------------------------------------------

/** What one tool call tells about a task: its name and the file it wrote, if any. */
export type ToolUse = { tool: string; path?: string; skill?: string }

const MAIL = /mail|gmail|outlook|inbox|smtp|imap/i
const MEDIA_TOOL = /image|video|photo|picture|dall-?e|imagen|midjourney|stable.?diffusion|\bsora\b|\bveo\b|runway|ffmpeg|\bgif\b/i
const MEDIA_FILE = /\.(png|jpe?g|gif|webp|svg|heic|bmp|tiff?|avif|mp4|mov|webm|mkv|avi|m4v)$/i
const DOC_TOOL = /docx|pptx|xlsx|document|docs\b|_docs|slide|sheet|spreadsheet|excel|powerpoint|\bword\b|notion|confluence|\bpdf\b|_pdf/i
const DOC_FILE = /\.(docx?|pdf|pptx?|xlsx?|csv|odt|ods|odp|rtf|pages|key|numbers)$/i
const RESEARCH_TOOL = /^web(search|fetch)$|web_?search|web_?fetch|fetch_?url|browse|navigate|read_?page|page_?text|get_?page|transcript|scrape|crawl|deep.?research/i
const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const NOT_RESEARCH = new Set(['ToolSearch', 'Grep', 'Glob'])

/** The kind one tool call points at, or null when it says nothing. */
export function kindOfUse(use: ToolUse): Kind | null {
  const name = use.tool
  if (MAIL.test(name)) return 'emails'
  if (MEDIA_TOOL.test(name)) return 'images'
  if (use.path && WRITERS.has(name) && MEDIA_FILE.test(use.path)) return 'images'
  if (DOC_TOOL.test(name)) return 'documents'
  if (name === 'Skill' && use.skill && /docx|pptx|xlsx|pdf|slides?|sheets?/i.test(use.skill)) return 'documents'
  if (use.path && WRITERS.has(name) && DOC_FILE.test(use.path)) return 'documents'
  if (!NOT_RESEARCH.has(name) && RESEARCH_TOOL.test(name)) return 'research'
  return null
}

const PRIORITY: readonly Kind[] = ['emails', 'images', 'documents', 'research']

/** One kind per task: the first of Emails, Images and video, Documents, Research it touched, else Other. */
export function kindOfTask(uses: readonly ToolUse[]): Kind {
  const hits = new Set(uses.map(kindOfUse).filter((k): k is Kind => k !== null))
  return PRIORITY.find(k => hits.has(k)) ?? 'other'
}

/** Pulls what classification needs out of a tool call's input. */
export function toolUseOf(e: { tool: string } & Record<string, unknown>): ToolUse {
  const path = [e.file_path, e.notebook_path, e.path].find((p): p is string => typeof p === 'string')
  const skill = typeof e.skill === 'string' ? e.skill : undefined
  return { tool: String(e.tool), path, skill }
}

// ---------------------------------------------------------------------------
// Dates (always stepped at local noon, so a clock change never skips or repeats a day)
// ---------------------------------------------------------------------------

export const DAY_MS = 86_400_000

export function noonOf(ms: number): Date {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12)
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12)
}

export function dayKey(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export function dayFromKey(key: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)
}

/** 1 for January 1. */
export function dayOfYear(d: Date): number {
  const jan1 = new Date(d.getFullYear(), 0, 1, 12)
  const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12)
  return Math.round((noon.getTime() - jan1.getTime()) / DAY_MS) + 1
}

/** `count` days ending with `today`, oldest first. */
export function lastDays(today: Date, count: number): Date[] {
  const out: Date[] = []
  for (let i = count - 1; i >= 0; i--) out.push(addDays(today, -i))
  return out
}

export function daysOf(tab: Tab, today: Date): Date[] {
  if (tab === 'today') return [addDays(today, 0)]
  if (tab === 'week') return lastDays(today, 7)
  if (tab === 'month') return lastDays(today, 30)
  return lastDays(today, dayOfYear(today))
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function shortDate(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** The dates shown on the right of the title bar. */
export function rangeLabel(tab: Tab, today: Date): string {
  if (tab === 'today') return `${WEEKDAYS[today.getDay()]} ${shortDate(today)}, ${today.getFullYear()}`
  const days = daysOf(tab, today)
  const first = days[0]!
  return `${shortDate(first)} – ${shortDate(today)}, ${today.getFullYear()}`
}

// ---------------------------------------------------------------------------
// Adding days together, streaks, the estimate
// ---------------------------------------------------------------------------

export function tasksOn(day: DayRecord | undefined): number {
  if (!day) return 0
  return KINDS.reduce((n, k) => n + (day.kinds[k] ?? 0), 0)
}

export type Totals = { tasks: number; kinds: Record<Kind, number>; models: Record<string, number>; activeDays: number }

export function sumDays(days: Readonly<Record<string, DayRecord>>, dates: readonly Date[]): Totals {
  const total = emptyDay()
  let activeDays = 0
  for (const d of dates) {
    const day = days[dayKey(d)]
    if (!day) continue
    if (tasksOn(day) > 0) activeDays += 1
    for (const k of KINDS) total.kinds[k] += day.kinds[k] ?? 0
    for (const [m, n] of Object.entries(day.models)) total.models[m] = (total.models[m] ?? 0) + n
  }
  return { tasks: KINDS.reduce((n, k) => n + total.kinds[k], 0), kinds: total.kinds, models: total.models, activeDays }
}

/** Days in a row with a finished task, ending today (or yesterday, while today has none yet). */
export function streak(days: Readonly<Record<string, DayRecord>>, today: Date): number {
  let d = tasksOn(days[dayKey(today)]) > 0 ? addDays(today, 0) : addDays(today, -1)
  let n = 0
  while (tasksOn(days[dayKey(d)]) > 0 && n < 3660) {
    n += 1
    d = addDays(d, -1)
  }
  return n
}

export function hoursFor(totals: Totals, settings: Settings): { hours: number; byKind: Record<Kind, number>; dollars: number } {
  const byKind = {} as Record<Kind, number>
  let minutes = 0
  for (const k of KINDS) {
    byKind[k] = (totals.kinds[k] * settings.minutes[k]) / 60
    minutes += totals.kinds[k] * settings.minutes[k]
  }
  const hours = minutes / 60
  return { hours, byKind, dollars: hours * settings.rate }
}

export function bestDay(days: Readonly<Record<string, DayRecord>>, dates: readonly Date[]): { date: Date; tasks: number } | null {
  let best: { date: Date; tasks: number } | null = null
  for (const d of dates) {
    const n = tasksOn(days[dayKey(d)])
    if (n > 0 && (!best || n > best.tasks)) best = { date: d, tasks: n }
  }
  return best
}

/** Tasks per month of `year`, January first. */
export function monthTotals(days: Readonly<Record<string, DayRecord>>, year: number): number[] {
  const out = new Array<number>(12).fill(0)
  for (const [key, day] of Object.entries(days)) {
    const d = dayFromKey(key)
    if (d && d.getFullYear() === year) out[d.getMonth()]! += tasksOn(day)
  }
  return out
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtHours(hours: number): string {
  if (hours <= 0) return '0'
  if (hours < 10) return (Math.round(hours * 10) / 10).toFixed(1)
  return String(Math.round(hours))
}

export function fmtDollars(dollars: number): string {
  return `$${Math.round(Math.max(0, dollars))}`
}

/** A model id as people say it: claude-opus-5-5 is "Opus 5.5". */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i.exec(id)
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1)
    return m[3] !== undefined ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
  }
  return id
}
