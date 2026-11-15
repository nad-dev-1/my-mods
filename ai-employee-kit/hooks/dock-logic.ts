// Agent Dock: everything that needs no `$`. Pure functions, so tests can call them.

import type { Helper, HelperModel, HelperState, Run } from '../types'

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

export const SIZES: readonly number[] = [1, 3, 5, 10, 20, 50, 100]
export const MAX_SIZE = 100
/** Above this, a size needs Continue and never carries over to a new session. */
export const BIG_TEAM = 20

/** A whole number from 1 to 100, spaces allowed around it; anything else is null. */
export function parseSize(text: string): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null
  const n = Number(text.trim())
  return Number.isInteger(n) && n >= 1 && n <= MAX_SIZE ? n : null
}

/** The size a new session starts with: a saved size up to 20 stays; anything else is 1. */
export function restoreSize(saved: unknown): number {
  const n = typeof saved === 'number' ? saved : typeof saved === 'string' ? parseSize(saved) : null
  if (n === null || !Number.isInteger(n) || n < 1 || n > BIG_TEAM) return 1
  return n
}

/** How many helpers run at once: the lower of the two engine limits (defaults 20 and 10). */
export function atOnce(maxSubagents: string | undefined, maxToolUse: string | undefined): number {
  const read = (v: string | undefined, fallback: number) => {
    const n = v === undefined ? NaN : Number(v)
    return Number.isInteger(n) && n > 0 ? n : fallback
  }
  return Math.min(read(maxSubagents, 20), read(maxToolUse, 10))
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function clipWords(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max + 1)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.5 ? cut.slice(0, space) : t.slice(0, max)).replace(/[\s,;:.-]+$/, '')
}

/** The job name: the first clause of the request, about 40 characters, first letter capital. */
export function jobName(request: string): string {
  const first = request.replace(/\s+/g, ' ').trim().split(/[.!?;\n]|,\s|\s[-–—]\s|\s(?:and then|then)\s/i)[0] ?? ''
  const clipped = clipWords(first, 40) || 'Request'
  return clipped.charAt(0).toUpperCase() + clipped.slice(1)
}

/** A helper's task name: 3 to 5 words from the Agent call's description. */
export function taskName(description: string | undefined, seat: number): string {
  const words = (description ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length === 0) return `Helper ${seat + 1}`
  return clipWords(words.slice(0, 5).join(' '), 32)
}

/** Two letters for the badge: the first letters of the first two words, else the first two letters. */
export function initials(name: string): string {
  const words = name
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const skip = new Set(['price', 'check', 'the', 'a', 'an', 'of', 'for', 'to', 'and'])
  const useful = words.filter(w => !skip.has(w.toLowerCase()))
  const pick = useful.length ? useful : words
  if (pick.length === 0) return '··'
  if (pick.length === 1) return pick[0]!.slice(0, 2).toUpperCase().padEnd(2, pick[0]!.charAt(0).toUpperCase())
  return (pick[0]!.charAt(0) + pick[1]!.charAt(0)).toUpperCase()
}

/** Loose match between the task a helper reports and a card's name. */
export function sameTask(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const x = norm(a)
  const y = norm(b)
  return x !== '' && (x === y || x.startsWith(y) || y.startsWith(x))
}

// ---------------------------------------------------------------------------
// What Claude is told
// ---------------------------------------------------------------------------

export function splitInstruction(n: number, progressTool: string): string {
  return [
    `Agent Dock: Team Size is ${n}.`,
    `Split this request into exactly ${n} independent pieces and launch one helper (the Agent tool) per piece, all ${n} in one message so they run in parallel.`,
    'Find a real split, one helper per item (per store, per task, per file, per section). Never argue that it cannot be split and never pad with useless work.',
    'Give each helper a short plain-English description of 3 to 5 words, for example "Price check: Panera".',
    `In each helper's prompt add: "As you work, call ${progressTool} with your task name and a percent at about 25, 50, 75 and 100. Do not call plan_steps."`,
    'When they finish, combine their results into one answer.',
  ].join('\n')
}

export function nudgeText(used: number, n: number): string {
  return `You used ${used} of ${n} helpers. Split the remaining work across the other ${n - used}, one helper per piece, all in parallel.`
}

export function capDeny(n: number): string {
  return `Team Size is ${n}: this request already has ${n} helpers. Finish with the helpers you have.`
}

export const STOPPED = 'Stopped before this helper started.'
export const BAD_SIZE_COMMAND = 'Team Size is a whole number from 1 to 100, e.g. /dock 10.'
export const BAD_SIZE_TOAST = 'Type a whole number from 1 to 100'
export const NARROW = 'The window is too narrow to show the Agent Dock. Widen it or watch the status bar.'

export function infoLine(size: number, together: number, model: HelperModel): string[] {
  const first = size <= 1 ? 'Claude decides how many helpers' : `Splits each request across ${size} helpers`
  return [first, `${Math.min(together, Math.max(1, size))} at a time`, model === 'fast' ? 'Fast & Cheap' : 'Same model as you']
}

// ---------------------------------------------------------------------------
// Counts, badge, clock, summary
// ---------------------------------------------------------------------------

export type Counts = Record<HelperState, number>

export function counts(helpers: readonly Helper[]): Counts {
  const c: Counts = { working: 0, queued: 0, done: 0, stuck: 0 }
  for (const x of helpers) c[x.state] += 1
  return c
}

/** The folded status-bar badge. */
export function badge(c: Counts): string {
  const parts = [`${c.working} working`, `${c.queued} queued`, `${c.done} done`]
  if (c.stuck > 0) parts.push(`${c.stuck} stuck`)
  return parts.join(' · ')
}

/** m:ss, for timers. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "2m 14s", "45s", "1h 3m", for the summary. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function summary(run: Run): string {
  const c = counts(run.helpers)
  const n = run.helpers.length
  const took = duration((run.endedAt ?? run.startedAt) - run.startedAt)
  const base = `${n} agent${n === 1 ? '' : 's'} finished ${run.job} in ${took}`
  return c.stuck > 0 ? `${base} (${c.stuck} got stuck)` : base
}

/** One helper's meter, 0 to 100. */
export function helperPercent(x: Helper): number {
  if (x.state === 'done') return 100
  if (x.state === 'queued') return 0
  if (x.state === 'stuck') return x.percent ?? 0
  return Math.max(0, Math.min(99, x.percent ?? 0))
}

/** The mission's percent: every helper weighed the same. */
export function missionPercent(run: Run): number {
  if (run.status === 'complete') return 100
  if (run.helpers.length === 0) return 0
  const total = run.helpers.reduce((n, x) => n + helperPercent(x), 0)
  return Math.min(99, Math.round(total / run.helpers.length))
}

/** Cells of the mission bar: done, working, and the rest, summing to `width`. */
export function missionCells(run: Run, width: number): { done: number; working: number; rest: number } {
  const n = Math.max(1, run.helpers.length)
  const c = counts(run.helpers)
  if (run.status === 'complete') return { done: width, working: 0, rest: 0 }
  const doneShare = run.helpers.reduce((s, x) => s + (x.state === 'done' || x.state === 'stuck' ? 1 : x.state === 'working' ? helperPercent(x) / 100 : 0), 0)
  const done = Math.min(width, Math.round((doneShare / n) * width))
  const working = c.working > 0 ? Math.max(1, Math.min(width - done, Math.round((c.working / n) * width * 0.25))) : 0
  return { done, working, rest: Math.max(0, width - done - working) }
}

/** Filled cells of a meter `width` wide. */
export function meterCells(percent: number, width: number): number {
  return Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
}

/** Cards per row by width; past 12 helpers the dock draws tiles instead. */
export function cardsPerRow(width: number): number {
  if (width >= 3 * 34 + 2) return 3
  if (width >= 2 * 28 + 1) return 2
  return 1
}

export const TILE_THRESHOLD = 12
export const TILE_WIDTH = 6

export function tilesPerRow(width: number): number {
  return Math.max(1, Math.floor((width + 1) / (TILE_WIDTH + 1)))
}

// ---------------------------------------------------------------------------
// Color
// ---------------------------------------------------------------------------

export const CORAL = '#FF7A59'
export const GOLD = '#F2C46D'

/** Hex color between `a` and `b`, `t` from 0 to 1. */
export function mix(a: string, b: string, t: number): string {
  const p = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const k = Math.max(0, Math.min(1, t))
  const ch = [0, 1, 2].map(i => Math.round(p(a, i) + (p(b, i) - p(a, i)) * k))
  return '#' + ch.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Muted seat colors: calm, never a rainbow. */
export const SEAT_COLORS = ['#FF7A59', '#F2C46D', '#79C0FF', '#56D4DD', '#D2A8FF', '#3DD68C', '#FFA657', '#A5D6FF']

export function seatColor(seat: number): string {
  return SEAT_COLORS[seat % SEAT_COLORS.length]!
}

/** Letter-spaced capitals for headings: "TEAM SIZE" is "T E A M  S I Z E". */
export function spaced(text: string): string {
  return text
    .toUpperCase()
    .split(' ')
    .map(word => word.split('').join(' '))
    .join('  ')
}
