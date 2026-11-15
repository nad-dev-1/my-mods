import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AddForm, FillStep, InjectView, SavedPrompt, Stash } from '../types'
import { statusGrid } from './status-grid'
import { offCommand, offPane, switchedHidden, switchedOff, watchSwitch } from './switch'

// Inject Prompt: a status-bar button opens a dialog of saved prompts, grouped
// by category, filtered by category, tag or search. Tick one or more, press
// Inject, fill any {{placeholders}}, and the text lands where the cursor was
// in the prompt box. The prompts live in ~/.claude/inject-prompts.json.

type E$ = EngineInterface

const PANE = 'inject-prompt'
const FILE_NAME = '.claude/inject-prompts.json'
const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g

const prompts = atom({ plugin: 'inject-prompt', key: 'prompts' } as const, [] as SavedPrompt[], {
  shape: 'prompts-1',
})
const isOpen = atom({ plugin: 'inject-prompt', key: 'isOpen' } as const, false)
const view = atom({ plugin: 'inject-prompt', key: 'view' } as const, 'list' as InjectView)
const query = atom({ plugin: 'inject-prompt', key: 'query' } as const, '')
const category = atom({ plugin: 'inject-prompt', key: 'category' } as const, '')
const tag = atom({ plugin: 'inject-prompt', key: 'tag' } as const, '')
const expanded = atom({ plugin: 'inject-prompt', key: 'expanded' } as const, [] as string[])
const selected = atom({ plugin: 'inject-prompt', key: 'selected' } as const, [] as string[])
const cursor = atom({ plugin: 'inject-prompt', key: 'cursor' } as const, '')
const top = atom({ plugin: 'inject-prompt', key: 'top' } as const, 0)
const stash = atom({ plugin: 'inject-prompt', key: 'stash' } as const, null as Stash | null, {
  shape: 'stash-1',
})
const fill = atom({ plugin: 'inject-prompt', key: 'fill' } as const, null as FillStep | null, {
  shape: 'fill-2',
})
const EMPTY_FORM: AddForm = { title: '', category: '', tags: '', text: '' }
const form = atom({ plugin: 'inject-prompt', key: 'form' } as const, EMPTY_FORM, { shape: 'form-1' })
const note = atom({ plugin: 'inject-prompt', key: 'note' } as const, '')

const C = {
  blue: '#58A6FF',
  blueBright: '#A5D6FF',
  ink: '#0D1117',
  sheet: '#161B22',
  muted: '#7D8590',
  text: '#E6EDF3',
  green: '#3FB950',
  amber: '#E3B341',
  chip: '#30363D',
}

/** What a fresh file holds: a few to start from, one per common need. */
const STARTERS: SavedPrompt[] = [
  {
    id: 'plan-first',
    title: 'Plan before coding',
    category: 'Workflow',
    tags: ['planning'],
    text: "Before writing any code, give me a short plan: the files you'll touch, the risks, and how you'll verify it. Wait for my OK.",
  },
  {
    id: 'review-branch',
    title: 'Review this branch',
    category: 'Review',
    tags: ['review', 'git'],
    text: 'Review the changes on this branch for bugs, missing tests and unclear names. List findings by severity, each with file:line.',
  },
  {
    id: 'explain-file',
    title: 'Explain a file',
    category: 'Understand',
    tags: ['explain'],
    text: 'Explain what {{file}} does, who calls it, and anything surprising in it.',
  },
  {
    id: 'bug-root-cause',
    title: 'Find a bug’s root cause',
    category: 'Debug',
    tags: ['bug'],
    text: 'There is a bug: {{symptom}}.\nSteps to reproduce: {{steps}}.\nFind the root cause before changing any code, then propose the smallest fix.',
  },
  {
    id: 'write-tests',
    title: 'Write tests',
    category: 'Testing',
    tags: ['tests'],
    text: 'Write tests for {{target}} covering the happy path, edge cases and failures. Run them and fix any that fail.',
  },
  {
    id: 'commit',
    title: 'Commit the changes',
    category: 'Workflow',
    tags: ['git'],
    text: 'Commit the current changes with a clear message, then summarise what changed in two lines.',
  },
  {
    id: 'short-answer',
    title: 'Keep it short',
    category: 'Style',
    tags: ['style'],
    text: 'Keep the answer short: bullet points, no preamble.',
  },
]

// ---------------------------------------------------------------------------
// The prompts file
// ---------------------------------------------------------------------------

async function filePath($: E$): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''

  return home ? `${home}/${FILE_NAME}` : FILE_NAME
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'prompt'
  )
}

/** Turns whatever the file holds into prompts, skipping entries with no text. */
function parsePrompts(raw: unknown): SavedPrompt[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { prompts?: unknown })?.prompts) ? (raw as { prompts: unknown[] }).prompts : []
  const seen = new Set<string>()
  const out: SavedPrompt[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const text = typeof o.text === 'string' ? o.text : ''
    if (!text.trim()) continue
    const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : text.split('\n')[0]!.slice(0, 50)
    let id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : slug(title)
    while (seen.has(id)) id = `${id}-2`
    seen.add(id)
    out.push({
      id,
      title,
      category: typeof o.category === 'string' && o.category.trim() ? o.category.trim() : 'General',
      tags: Array.isArray(o.tags) ? o.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map(t => t.trim()) : [],
      text,
    })
  }

  return out
}

function serialize(list: SavedPrompt[]): string {
  return `${JSON.stringify({ prompts: list }, null, 2)}\n`
}

/**
 * Reads the file into state. A missing file is created with the starters; a
 * file that does not parse is left untouched and the reason shown.
 */
async function loadPrompts($: E$): Promise<boolean> {
  const path = await filePath($)
  try {
    if (!(await $.fs.exists(path))) {
      await $.fs.write(path, serialize(STARTERS))
      await update($, prompts, () => STARTERS)
      await update($, note, () => `Created ${path} with a few prompts to start from.`)

      return true
    }
    const text = String(await $.fs.read(path))
    const list = parsePrompts(JSON.parse(text))
    await update($, prompts, () => list)

    return true
  } catch (err) {
    await update($, note, () => `Could not read ${path}: ${errorText(err)}. Fix the file, then reopen.`)

    return false
  }
}

async function addPrompt($: E$, f: AddForm): Promise<string> {
  const text = f.text.trim()
  if (!text) return 'Write the prompt text first.'
  const title = f.title.trim() || text.split('\n')[0]!.slice(0, 50)
  // Re-read so hand edits made while the dialog was open are kept.
  if (!(await loadPrompts($))) return await read($, note)
  const list = await read($, prompts)
  let id = slug(title)
  while (list.some(p => p.id === id)) id = `${id}-2`
  const entry: SavedPrompt = {
    id,
    title,
    category: f.category.trim() || 'General',
    tags: f.tags
      .split(/[,\s]+/)
      .map(t => t.replace(/^#/, '').trim())
      .filter(Boolean),
    text,
  }
  const next = [...list, entry]
  await $.fs.write(await filePath($), serialize(next))
  await update($, prompts, () => next)

  return `Saved “${title}” in ${entry.category}.`
}

// ---------------------------------------------------------------------------
// Opening, closing, injecting
// ---------------------------------------------------------------------------

/**
 * Opens the dialog. The draft in the prompt box is never touched: it stays
 * where it is, and an injected prompt goes in at its cursor on close. With a
 * draft in the box the dialog opens without the keyboard (a pane only takes
 * it over an empty box), so a click in the dialog hands it over.
 */
async function openDialog($: E$): Promise<void> {
  if (await read($, isOpen)) return
  // A put-back still landing from the last close goes first.
  if (restoring) await restoring
  // A draft an earlier version of this mod set aside comes back now.
  if (await read($, stash)) await putBack($, '')
  const box = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
  await update($, note, () => (box.text.trim() ? 'Your draft stays in the prompt box. Click in here to use the keys.' : ''))
  await loadPrompts($)
  await update($, view, () => 'list')
  await update($, fill, () => null)
  await update($, top, () => 0)
  await update($, isOpen, () => true)
  const opened = await $.ui.open({
    id: PANE,
    title: 'Inject prompt',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: 30,
    columns: 72,
    backgroundColor: C.sheet,
  })
  if (opened.isPlaced) await pinWindow($)
  if (!opened.isPlaced) {
    await update($, isOpen, () => false)
    await $.ui.close({ id: PANE }).catch(() => undefined)
    await restoreDraft($, '')
    $.ui.toast(`Inject could not open: ${opened.reason}`)
  }
}

/** Brings the list view back, its window one row down past the spare row. */
async function showList($: E$): Promise<void> {
  await update($, view, () => 'list')
  await pinWindow($)
}

/** Asks for a scroll; the ui.scroll hook sets the list's window at row 1. */
async function pinWindow($: E$): Promise<void> {
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

/**
 * Waits between tries when the box refuses the draft: right after the dialog
 * closes the keys may not be back with the prompt yet. About 3 s in all.
 */
const RETRY_MS = [100, 250, 500, 1000, 1500]

/** A put-back still trying; the next open waits for it. */
let restoring: Promise<void> | null = null

/** Puts the set-aside draft back, with `insert` at its cursor; see putBack. */
function restoreDraft($: E$, insert: string): Promise<void> {
  const run = putBack($, insert).finally(() => {
    if (restoring === run) restoring = null
  })
  restoring = run

  return run
}

/**
 * Puts `insert` in the prompt box at its cursor, keeping the draft around it.
 * A draft an earlier version of this mod set aside (`stash`) comes back too,
 * before anything typed since. A refused fill is tried again; when the box
 * never takes it, the text goes on the clipboard so it is not lost.
 */
async function putBack($: E$, insert: string): Promise<void> {
  const kept = await read($, stash)
  if (!kept && !insert) return
  let body = insert
  for (let attempt = 0; ; attempt++) {
    const now = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
    let text: string
    let cursor: number
    if (kept) {
      const before = kept.text.slice(0, kept.cursor)
      body = before + insert + kept.text.slice(kept.cursor)
      const typed = now.text.trim() ? now.text : ''
      text = typed ? `${body}${body.endsWith('\n') ? '' : '\n'}${typed}` : body
      cursor = before.length + insert.length
    } else {
      const at = Math.min(Math.max(0, now.cursor), now.text.length)
      text = now.text.slice(0, at) + insert + now.text.slice(at)
      cursor = at + insert.length
    }
    const done = await $.prompt.fill({ text, mode: 'replace', cursor }).catch(() => undefined)
    if (done?.isFilled) {
      await update($, stash, () => null)

      return
    }
    if (done?.refusal === 'no_composer' || attempt >= RETRY_MS.length) break
    await $.clock.sleep(RETRY_MS[attempt]!)
  }
  await update($, stash, () => null)
  const copied = await $.ui.copy({ text: body }).catch(() => undefined)
  $.ui.toast(
    copied?.isCopied
      ? 'Inject could not put your text back in the prompt box, so it is on the clipboard: paste it.'
      : 'Inject could not put your text back in the prompt box.',
  )
}

async function closeDialog($: E$, insert: string): Promise<void> {
  await update($, isOpen, () => false)
  await update($, view, () => 'list')
  await update($, fill, () => null)
  await $.ui.close({ id: PANE }).catch(() => undefined)
  await restoreDraft($, insert)
}

/** `{{name|default}}` → its name and default ('' when none). */
function splitPlaceholder(inner: string): { name: string; fallback: string } {
  const bar = inner.indexOf('|')

  return bar < 0 ? { name: inner.trim(), fallback: '' } : { name: inner.slice(0, bar).trim(), fallback: inner.slice(bar + 1).trim() }
}

/** Each `{{name}}` the texts use, in order of first use, with the first default given for it. */
function placeholdersIn(texts: string[]): { names: string[]; defaults: Record<string, string> } {
  const names: string[] = []
  const defaults: Record<string, string> = {}
  for (const t of texts) {
    for (const m of t.matchAll(PLACEHOLDER)) {
      const { name, fallback } = splitPlaceholder(m[1]!)
      if (!names.includes(name)) names.push(name)
      if (fallback && !defaults[name]) defaults[name] = fallback
    }
  }

  return { names, defaults }
}

function fillIn(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, inner: string) => values[splitPlaceholder(inner).name] ?? whole)
}

/** The ticked prompts (or the highlighted one when none is ticked). */
async function picked($: E$): Promise<SavedPrompt[]> {
  const list = await read($, prompts)
  let ids = await read($, selected)
  if (ids.length === 0) {
    const at = await read($, cursor)
    if (at) ids = [at]
  }

  return ids.map(id => list.find(p => p.id === id)).filter((p): p is SavedPrompt => Boolean(p))
}

/** Inject: straight in, or first ask for each placeholder. */
async function startInject($: E$): Promise<void> {
  const chosen = await picked($)
  if (chosen.length === 0) {
    await update($, note, () => 'Tick a prompt first (x, or its box).')

    return
  }
  const { names, defaults } = placeholdersIn(chosen.map(p => p.text))
  if (names.length === 0) {
    await finishInject($, chosen, {})

    return
  }
  await update($, fill, () => ({ ids: chosen.map(p => p.id), names, defaults, values: {}, index: 0 }))
  await update($, view, () => 'fill')
}

async function finishInject($: E$, chosen: SavedPrompt[], values: Record<string, string>): Promise<void> {
  const text = chosen.map(p => fillIn(p.text, values)).join('\n\n')
  await update($, selected, () => [])
  await closeDialog($, text)
}

async function answerPlaceholder($: E$, value: string): Promise<void> {
  const step = await read($, fill)
  if (!step) return
  const name = step.names[step.index]!
  const values = { ...step.values, [name]: value }
  if (step.index + 1 < step.names.length) {
    await update($, fill, () => ({ ...step, values, index: step.index + 1 }))

    return
  }
  const list = await read($, prompts)
  const chosen = step.ids.map(id => list.find(p => p.id === id)).filter((p): p is SavedPrompt => Boolean(p))
  await finishInject($, chosen, values)
}

async function saveForm($: E$): Promise<void> {
  try {
    const f = await read($, form)
    const said = await addPrompt($, f)
    await update($, note, () => said)
    if (said.startsWith('Saved')) {
      await update($, form, () => EMPTY_FORM)
      await showList($)
    }
  } catch (err) {
    await update($, note, () => `Could not save: ${errorText(err)}`)
  }
}

async function startAdd($: E$): Promise<void> {
  // Start from the draft in the prompt box, when there is one.
  const box = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
  const current = await read($, form)
  await update($, form, () => ({ ...current, text: current.text || box.text || '' }))
  await update($, view, () => 'add')
}

// ---------------------------------------------------------------------------
// The list window: the list scrolls by itself, so the buttons below stay put
// ---------------------------------------------------------------------------

/** One drawn line of the list. */
type Line =
  | { kind: 'group'; category: string; count: number }
  | { kind: 'gap'; key: string }
  | { kind: 'row'; p: SavedPrompt }
  | { kind: 'text'; p: SavedPrompt; text: string; i: number; isPreview: boolean }

/** Prompt text sits this far in from the row's left edge. */
const INDENT = 8

/** The size of the list window at the last draw, for handlers that scroll it. */
let geom = { width: 72, listRows: 12 }

/** Breaks a line into pieces no wider than `width`, at spaces when it can. */
function wrapLine(line: string, width: number): string[] {
  const w = Math.max(8, width)
  if (line.length <= w) return [line]
  const out: string[] = []
  let rest = line
  while (rest.length > w) {
    let cut = rest.lastIndexOf(' ', w)
    if (cut <= 0) cut = w
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^ /, '')
  }
  if (rest) out.push(rest)

  return out
}

function layout(groups: Group[], open: string[], width: number): Line[] {
  const lines: Line[] = []
  const textWidth = width - INDENT
  groups.forEach((g, gi) => {
    if (gi > 0) lines.push({ kind: 'gap', key: `gap-${g.category}` })
    lines.push({ kind: 'group', category: g.category, count: g.members.length })
    for (const p of g.members) {
      lines.push({ kind: 'row', p })
      if (open.includes(p.id)) {
        const pieces = p.text.split('\n').flatMap(l => wrapLine(l || ' ', textWidth))
        pieces.forEach((text, i) => lines.push({ kind: 'text', p, text, i, isPreview: false }))
        lines.push({ kind: 'gap', key: `after-${p.id}` })
      } else {
        lines.push({ kind: 'text', p, text: fit(p.text, textWidth), i: 0, isPreview: true })
      }
    }
  })

  return lines
}

/** The list as it stands now, laid out at the last drawn width. */
async function linesNow($: E$): Promise<Line[]> {
  const list = await read($, prompts)
  const typed = await read($, query)
  const cat = await read($, category)
  const t = await read($, tag)
  const open = await read($, expanded)

  return layout(groupsOf(list.filter(p => matches(p, typed, cat, t))), open, geom.width)
}

/** Scrolls the list so the prompt `id` (and its first line of text) shows. */
async function keepInView($: E$, id: string): Promise<void> {
  const lines = await linesNow($)
  const at = lines.findIndex(l => l.kind === 'row' && l.p.id === id)
  if (at < 0) return
  const rows = geom.listRows
  await update($, top, cur => {
    const now = cur ?? 0
    // The group heading above the first row of a group shows with it.
    if (at <= now) return Math.max(0, lines[at - 1]?.kind === 'group' ? at - 1 : at)
    if (at + 2 > now + rows) return at + 2 - rows

    return now
  })
}

async function scrollList($: E$, by: number): Promise<void> {
  const lines = await linesNow($)
  const max = Math.max(0, lines.length - geom.listRows)
  await update($, top, cur => Math.min(max, Math.max(0, (cur ?? 0) + by)))
}

/** How long a ring move waits for a press before it counts as an arrow key. */
const ARROW_MS = 150

/** The key holding the dialog's focus ring, as the last ui.focus left it. */
let ring = ''

/** A fold waiting to see whether the ring move was a click. */
let armed: { cancel: () => void } | null = null

/** The prompts in the order the list draws them. */
async function orderNow($: E$): Promise<SavedPrompt[]> {
  const list = await read($, prompts)
  const typed = await read($, query)
  const cat = await read($, category)
  const t = await read($, tag)

  return groupsOf(list.filter(p => matches(p, typed, cat, t))).flatMap(g => g.members)
}

/** Moves the highlight `by` prompts (a page or the ends for the bigger keys). */
async function moveBy($: E$, by: number, contentRows: number): Promise<void> {
  const order = await orderNow($)
  if (order.length === 0) return
  const cursorNow = (await read($, cursor)) || ring.replace(/^(row|sel|exp)#/, '')
  const at = Math.max(0, order.findIndex(p => p.id === readCursorFallback(order, `row#${cursorNow}`)))
  const page = Math.max(1, Math.floor(geom.listRows / 3))
  const steps = Math.abs(by) >= contentRows ? Math.sign(by) * order.length : Math.abs(by) > 1 ? Math.sign(by) * page : by
  const target = order[Math.min(order.length - 1, Math.max(0, at + steps))]!
  await update($, cursor, () => target.id)
  await keepInView($, target.id)
  await $.ui.focus({ requestId: PANE, key: `row#${target.id}` }).catch(() => {})
}

/** The prompt the ring is on, else the first: where a move starts from. */
function readCursorFallback(order: SavedPrompt[], key: string): string {
  const id = key.replace(/^(row|sel|exp)#/, '')

  return order.some(p => p.id === id) ? id : order[0]!.id
}

/**
 * Which way the ring went from prompt `id`'s row: -1 toward the start (the
 * row's own mark and box, anything above), 1 toward the end, 0 for none.
 */
async function sideOf($: E$, id: string, element: string): Promise<number> {
  const order = (await orderNow($)).map(p => p.id)
  const at = order.indexOf(id)
  const m = /^(sel|exp|row)#(.*)$/.exec(element)
  if (m) {
    const other = order.indexOf(m[2]!)
    if (other < 0 || at < 0) return 0
    if (other === at) return m[1] === 'row' ? 0 : -1

    return other < at ? -1 : 1
  }
  if (element === 'search' || element.startsWith('cat#') || element.startsWith('tag#')) return -1

  return 1
}

/** An arrow off a row: right unfolds it, left folds it; the ring goes back. */
async function foldFromArrow($: E$, id: string, isOpen: boolean): Promise<void> {
  await update($, cursor, () => id)
  await update($, expanded, ids => {
    const has = (ids ?? []).includes(id)
    if (isOpen && !has) return [...(ids ?? []), id]
    if (!isOpen && has) return (ids ?? []).filter(x => x !== id)

    return ids ?? []
  })
  await $.ui.focus({ requestId: PANE, key: `row#${id}` }).catch(() => {})
}

/** Enter on a prompt: inject what is ticked, or else fold or unfold it. */
async function enterOn($: E$, id: string): Promise<void> {
  if ((await read($, selected)).length > 0) {
    await startInject($)

    return
  }
  await toggleId($, 'expanded', id)
}

/** Rows a wrapped row of chips takes: each `label` is drawn about 4 wider. */
function chipRows(labels: string[], width: number): number {
  let rows = 1
  let used = 0
  for (const label of labels) {
    const w = label.length + 5
    if (used > 0 && used + w > width) {
      rows++
      used = 0
    }
    used += w
  }

  return rows
}

/** Ticks or unticks (or expands or collapses) one prompt, and moves the cursor to it. */
async function toggleId($: E$, which: 'selected' | 'expanded', id: string): Promise<void> {
  await update($, cursor, () => id)
  const flip = (ids: string[] | undefined) => ((ids ?? []).includes(id) ? (ids ?? []).filter(x => x !== id) : [...(ids ?? []), id])
  if (which === 'selected') await update($, selected, flip)
  else await update($, expanded, flip)
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function matches(p: SavedPrompt, typed: string, cat: string, t: string): boolean {
  if (cat && p.category !== cat) return false
  if (t && !p.tags.includes(t)) return false
  const q = typed.trim().toLowerCase()
  if (!q) return true
  const hay = `${p.title}\n${p.category}\n${p.tags.join(' ')}\n${p.text}`.toLowerCase()

  return q.split(/\s+/).every(word => hay.includes(word.replace(/^#/, '')))
}

type Group = { category: string; members: SavedPrompt[] }

function groupsOf(list: SavedPrompt[]): Group[] {
  const groups: Group[] = []
  for (const p of list) {
    const g = groups.find(x => x.category === p.category)
    if (g) g.members.push(p)
    else groups.push({ category: p.category, members: [p] })
  }

  return groups.sort((a, b) => a.category.localeCompare(b.category))
}

function fit(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length <= width ? one : `${one.slice(0, Math.max(0, width - 1))}…`
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await watchSwitch($, 'inject-prompt', 'Inject Prompt')
    const r = await next(e)
    await $.command.register({ name: 'inject', description: 'Pick saved prompts and insert them at the cursor' })
    // A reload while open: the pane is gone, so is the flag; the draft it
    // set aside goes back in the box.
    await update($, isOpen, () => false)
    if (await read($, stash)) void restoreDraft($, '')

    return r
  })

  on('command.run', { command: 'inject' }, async $ => {

    if (switchedOff()) return offCommand() /* switch-guarded */
    await openDialog($)

    return { text: 'Opening your saved prompts.' }
  })

  // The wheel or arrow keys over the dialog scroll the list, not the whole
  // dialog: the buttons below it stay where they are.
  on('ui.scroll', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE) return next(e)
    if (e.origin.kind === 'person' && e.by !== 0 && (await read($, view)) === 'list') {
      if (e.pointer) await scrollList($, e.by)
      else await moveBy($, e.by, e.contentRows)
    }

    return next({ ...e, offset: (await read($, view)) === 'list' ? 1 : e.offset })
  })

  // Left and right walk the ring off the highlighted row: read them as fold
  // and unfold. A click also moves the ring, but a press follows it at once,
  // and the press cancels the fold (see ui.press below).
  on('ui.focus', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE) return next(e)
    const from = ring
    const done = await next(e)
    if (done.deny) return done
    ring = e.element ?? ''
    if (e.origin.kind === 'person' && from.startsWith('row#') && e.element && e.element !== from) {
      const id = from.slice('row#'.length)
      const dir = await sideOf($, id, e.element)
      if (dir !== 0) {
        armed?.cancel()
        armed = $.clock.after(ARROW_MS, () => {
          armed = null
          void foldFromArrow($, id, dir > 0)
        })
      }
    }

    return done
  })

  on('ui.press', async ($, e, next) => {
    if (e.requestId === PANE) {
      armed?.cancel()
      armed = null
    }

    return next(e)
  })

  // Esc or the pane's own close: put the draft back as it was.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    if (await read($, isOpen)) {
      await update($, isOpen, () => false)
      await update($, view, () => 'list')
      await update($, fill, () => null)
      await restoreDraft($, '')
    }

    return done
  })

  // The status-bar button.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (switchedOff() || switchedHidden()) return next(e) /* switch-guarded */
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const open = await read($, isOpen)
    const fillColor = open ? C.blueBright : C.blue
    const modes = e.props.modes

    // Every mod's status-bar button goes in one shared grid (status-grid.tsx).
    return statusGrid(
      { Box, Text },
      below,
      modes,
      <Button
          key="open-inject"
          plain
          onPress={async () => {
            // Opened within the press, so it counts as asked for.
            if (await read($, isOpen)) await closeDialog($, '')
            else await openDialog($)
          }}
        >
          <Text color={fillColor}>▐</Text>
          <Text backgroundColor={fillColor} color={C.ink} bold>
            {'» Inject'}
          </Text>
          <Text color={fillColor}>▌</Text>
        </Button>,
    ) as never
  })

  // The dialog.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (switchedOff()) return offPane($, e) /* switch-guarded */
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const width = Math.max(30, e.props.bodyColumns ?? 72)
    const last = await read($, note)
    const mode = await read($, view)

    const header = (subtitle: string) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={C.blue}>
          {'» Inject prompt'}
        </Text>
        <Text dimColor>{subtitle}</Text>
      </Box>
    )

    // --- Placeholder step -------------------------------------------------
    if (mode === 'fill') {
      const step = await read($, fill)
      if (!step) return <Text dimColor>Nothing to fill.</Text>
      const name = step.names[step.index]!
      const fallback = step.defaults?.[name] ?? ''

      return (
        <Box flexDirection="column">
          {header(`value ${step.index + 1} of ${step.names.length}`)}
          <Box flexDirection="column" marginY={1}>
            {step.names.map((n, i) => (
              <Text key={`ph-${n}`} color={i === step.index ? C.amber : undefined} dimColor={i > step.index}>
                {i < step.index ? '✓ ' : i === step.index ? '▶ ' : '  '}
                {`{{${n}}}`}
                {i < step.index ? `  = ${fit(step.values[n] ?? '', Math.max(10, width - n.length - 12))}` : ''}
              </Text>
            ))}
          </Box>
          {Input ? (
            <Input
              key={`value-${step.index}`}
              label={name}
              value={fallback || undefined}
              placeholder={fallback ? `Enter keeps: ${fallback}` : `Value for ${name}`}
              submitLabel={step.index + 1 < step.names.length ? 'next' : 'inject'}
              autoFocus
              onSubmit={(value: string) => void answerPlaceholder($, value)}
            />
          ) : (
            <Text dimColor>Typing is not available here.</Text>
          )}
          <Box flexDirection="row" gap={1} marginTop={1}>
            {fallback !== '' && <Button key="fill-default" label={`Use default (${fit(fallback, 30)})`} variant="primary" onPress={() => void answerPlaceholder($, fallback)} />}
            <Button key="fill-skip" label="Leave as is" onPress={() => void answerPlaceholder($, `{{${name}}}`)} />
            <Button
              key="fill-back"
              label="Back"
              onPress={async () => {
                await update($, fill, () => null)
                await showList($)
              }}
            />
          </Box>
        </Box>
      )
    }

    // --- Add form ---------------------------------------------------------
    if (mode === 'add') {
      const f = await read($, form)
      const setField = (field: keyof AddForm) => (value: string) =>
        void update($, form, cur => ({ ...(cur ?? EMPTY_FORM), [field]: value }))

      return (
        <Box flexDirection="column">
          {header('new prompt')}
          {Input ? (
            <Box flexDirection="column" marginY={1} gap={1}>
              <Input key="add-title" label="Title" value={f.title} placeholder="Short name" autoFocus submitLabel="next" onInput={setField('title')} onSubmit={setField('title')} />
              <Input key="add-category" label="Category" value={f.category} placeholder="e.g. Review (General when empty)" submitLabel="next" onInput={setField('category')} onSubmit={setField('category')} />
              <Input key="add-tags" label="Tags" value={f.tags} placeholder="comma or space separated" submitLabel="next" onInput={setField('tags')} onSubmit={setField('tags')} />
              <Input key="add-text" label="Prompt" value={f.text} rows={6} placeholder="The prompt; {{name}} marks a value to ask for" submitLabel="save" onInput={setField('text')} onSubmit={(value: string) => {
                void (async () => {
                  await update($, form, cur => ({ ...(cur ?? EMPTY_FORM), text: value }))
                  await saveForm($)
                })()
              }} />
            </Box>
          ) : (
            <Text dimColor>Typing is not available here. Edit ~/{FILE_NAME} instead.</Text>
          )}
          <Box flexDirection="row" gap={1}>
            <Button key="add-save" label="Save" variant="primary" onPress={() => void saveForm($)} />
            <Button
              key="add-cancel"
              label="Cancel"
              onPress={async () => {
                await update($, form, () => EMPTY_FORM)
                await showList($)
              }}
            />
          </Box>
          {last !== '' && <Text dimColor>{last}</Text>}
        </Box>
      )
    }

    // --- The list ---------------------------------------------------------
    const list = await read($, prompts)
    const typed = await read($, query)
    const cat = await read($, category)
    const t = await read($, tag)
    const open = await read($, expanded)
    const ticked = await read($, selected)
    const shown = list.filter(p => matches(p, typed, cat, t))
    const groups = groupsOf(shown)
    const order = groups.flatMap(g => g.members)
    const at = await read($, cursor)
    const current = order.find(p => p.id === at) ?? order[0]
    const categories = [...new Set(list.map(p => p.category))].sort((a, b) => a.localeCompare(b))
    const tags = [...new Set(list.flatMap(p => p.tags))].sort((a, b) => a.localeCompare(b))

    const toggleIn = (which: 'selected' | 'expanded', id: string) => () => void toggleId($, which, id)

    const move = (step: number) => async () => {
      const i = Math.max(0, order.findIndex(p => p.id === current?.id))
      const target = order[Math.min(order.length - 1, Math.max(0, i + step))]
      if (!target) return
      await update($, cursor, () => target.id)
      await keepInView($, target.id)
      await $.ui.focus({ requestId: PANE, key: `row#${target.id}` }).catch(() => {})
    }

    const page = (dir: number) => () => void scrollList($, dir * Math.max(1, geom.listRows - 2))

    const filterTo = async (apply: () => Promise<unknown>) => {
      await apply()
      await update($, top, () => 0)
    }

    const chip = (key: string, label: string, isOn: boolean, onPress: () => unknown) => (
      <Button key={key} label={label} variant={isOn ? 'primary' : 'secondary'} onPress={onPress} />
    )

    // --- Sizes: everything but the list is fixed; the list gets the rest. ---
    const bodyRows = Math.max(12, e.props.scroll?.bodyRows ?? 30)
    const catLabels = ['Category', 'All', ...categories]
    const tagLabels = tags.length ? ['Tag', 'All', ...tags.map(x => `#${x}`)] : []
    const topRows =
      1 + // title
      (Input ? 4 : 0) + // search box, with the gap above it
      1 + chipRows(catLabels, width) + // category chips, with the gap above
      (tagLabels.length ? chipRows(tagLabels, width) : 0)
    const footRows = 1 + 1 + chipRows(['↑', '↓', 'Tick', 'Expand', 'PgUp', 'PgDn', 'Search', '· ↑↓ move · ←→ fold · Enter injects ticked · Esc closes'], width) + 1
    // Two rows for the "more above / below" marks, one kept spare.
    const listRows = Math.max(3, bodyRows - topRows - footRows - 3)
    geom = { width, listRows }

    const lines = layout(groups, open, width)
    const maxTop = Math.max(0, lines.length - listRows)
    const first = Math.min(maxTop, Math.max(0, await read($, top)))
    const visible = lines.slice(first, first + listRows)
    const above = first
    const below = Math.max(0, lines.length - first - listRows)

    const drawLine = (l: Line) => {
      if (l.kind === 'gap') return <Text key={l.key}> </Text>
      if (l.kind === 'group') {
        return (
          <Text key={`g-${l.category}`} color={C.blue} bold>
            {`${l.category.toUpperCase()}  `}
            <Text dimColor>{l.count}</Text>
          </Text>
        )
      }
      if (l.kind === 'text') {
        return (
          <Box key={`l-${l.p.id}-${l.i}`} marginLeft={INDENT}>
            <Text color={l.isPreview ? undefined : C.text} dimColor={l.isPreview} wrap="truncate-end">
              {l.text}
            </Text>
          </Box>
        )
      }
      const p = l.p
      const isCursor = current?.id === p.id
      const isTicked = ticked.includes(p.id)
      const isOpenRow = open.includes(p.id)
      const tickNo = ticked.indexOf(p.id) + 1
      const tagText = p.tags.length ? `  #${p.tags.join(' #')}` : ''
      const titleWidth = Math.max(10, width - 10)

      return (
        <Box key={`p-${p.id}`} flexDirection="row">
          <Button key={`sel#${p.id}`} plain label={`${isTicked ? 'Untick' : 'Tick'} ${p.title}`} onPress={toggleIn('selected', p.id)}>
            <Text color={C.blue} bold>
              {isCursor ? '▶ ' : '  '}
            </Text>
            <Text color={isTicked ? C.green : C.muted} bold>
              {isTicked ? `[${tickNo}]` : '[ ]'}
            </Text>
          </Button>
          <Button key={`exp#${p.id}`} plain label={`${isOpenRow ? 'Collapse' : 'Expand'} ${p.title}`} onPress={toggleIn('expanded', p.id)}>
            <Text color={C.blueBright}>{isOpenRow ? ' ▾ ' : ' ▸ '}</Text>
          </Button>
          <Button
            key={`row#${p.id}`}
            plain
            autoFocus={isCursor ? true : undefined}
            label={ticked.length > 0 ? `Inject the ${ticked.length} ticked` : `${isOpenRow ? 'Collapse' : 'Expand'} ${p.title}`}
            onPress={() => void enterOn($, p.id)}
          >
            <Text bold={isCursor || isTicked}>{fit(p.title, Math.min(p.title.length, titleWidth))}</Text>
            <Text dimColor>{fit(tagText, Math.max(0, titleWidth - p.title.length))}</Text>
          </Button>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
      {/* One spare row above and below the dialog, never shown: with them the
          engine has rows to scroll, so the up and down keys arrive as scrolls,
          which move the highlight instead (see the ui.scroll hook). */}
      <Text key="pad-top"> </Text>
      <Box flexDirection="column" height={bodyRows}>
        {/* Fixed at the top: title, search, filters. */}
        <Box flexDirection="column" flexShrink={0}>
          {header(`${shown.length} of ${list.length} · ${ticked.length} ticked`)}

          {Input && (
            <Box marginTop={1}>
              <Input
                key="search"
                placeholder="Search title, text or #tag…"
                value={typed}
                submitLabel="find"
                onInput={(value: string) => filterTo(() => update($, query, () => value))}
                onSubmit={(value: string) => filterTo(() => update($, query, () => value))}
              />
            </Box>
          )}

          <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
            <Text dimColor>Category</Text>
            {chip('cat#', 'All', cat === '', () => filterTo(() => update($, category, () => '')))}
            {categories.map(c => chip(`cat#${c}`, c, cat === c, () => filterTo(() => update($, category, cur => (cur === c ? '' : c)))))}
          </Box>
          {tags.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Text dimColor>Tag     </Text>
              {chip('tag#', 'All', t === '', () => filterTo(() => update($, tag, () => '')))}
              {tags.map(x => chip(`tag#${x}`, `#${x}`, t === x, () => filterTo(() => update($, tag, cur => (cur === x ? '' : x)))))}
            </Box>
          )}
        </Box>

        {/* The list: the only part that scrolls. */}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={3} overflow="hidden" marginTop={1}>
          <Text key="more-above" dimColor>
            {above > 0 ? `  ↑ ${above} more line${above === 1 ? '' : 's'}` : ' '}
          </Text>
          {list.length === 0 && <Text dimColor>No saved prompts yet. Press a to add one.</Text>}
          {list.length > 0 && shown.length === 0 && <Text dimColor>No prompts match.</Text>}
          {visible.map(drawLine)}
          <Text key="more-below" dimColor>
            {below > 0 ? `  ↓ ${below} more line${below === 1 ? '' : 's'}` : ' '}
          </Text>
        </Box>

        {/* Fixed at the bottom: the actions, always in view. */}
        <Box flexDirection="column" flexShrink={0}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="inject" label={ticked.length > 1 ? `Inject ${ticked.length}` : 'Inject'} hotkey="i" variant="primary" onPress={() => void startInject($)} />
            <Button key="add" label="Add" hotkey="a" onPress={() => void startAdd($)} />
            <Button key="clear" label="Clear" hotkey="c" onPress={async () => {
              await update($, selected, () => [])
              await update($, query, () => '')
              await update($, category, () => '')
              await update($, tag, () => '')
              await update($, top, () => 0)
            }} />
            <Button key="close" label="Close" onPress={() => void closeDialog($, '')} />
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="up" label="↑" hotkey="k" plain onPress={move(-1)} />
            <Button key="down" label="↓" hotkey="j" plain onPress={move(1)} />
            <Button key="tick" label="Tick" hotkey="x" plain onPress={current ? toggleIn('selected', current.id) : () => {}} />
            <Button key="expand" label="Expand" hotkey="e" plain onPress={current ? toggleIn('expanded', current.id) : () => {}} />
            <Button key="page-up" label="PgUp" hotkey="u" plain onPress={page(-1)} />
            <Button key="page-down" label="PgDn" hotkey="d" plain onPress={page(1)} />
            <Button key="find" label="Search" hotkey="s" plain onPress={() => void $.ui.focus({ requestId: PANE, key: 'search' }).catch(() => {})} />
            <Text dimColor>· ↑↓ move · ←→ fold · Enter injects ticked · Esc closes</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {last !== '' ? last : ' '}
          </Text>
        </Box>
      </Box>
      <Text key="pad-bottom"> </Text>
      </Box>
    )
  })
}
