import type { EngineInterface, ModelCompleteResult, PaneOpenArgs, PromptSubmitInput, Register } from 'claude-code'

import type { Answer, Flow, FlowSource, HistoryEntry, Notice, Question } from '../types'
import { statusGrid } from './status-grid'

type E$ = EngineInterface

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANE = 'prompt-upgrade'
const MODEL = 'haiku'
const HISTORY_MAX = 20
const CALL_TIMEOUT_MS = 60_000

const FLOW = { plugin: 'prompt-upgrade', key: 'flow' } as const
const HISTORY = { plugin: 'prompt-upgrade', key: 'history' } as const
const VIEW = { plugin: 'prompt-upgrade', key: 'view' } as const

const STORE_AUTO = 'auto'
const STORE_HISTORY = 'history'

const PANE_OPEN: PaneOpenArgs = {
  id: PANE,
  title: 'Prompt Upgrade',
  focus: true,
  closeOnEscape: true,
  rows: 30,
  columns: 76,
  backgroundColor: '#0D1117',
}

const C = {
  gold: '#F2C46D',
  hair: '#262B33',
  slate: '#262B33',
  muted: '#7D8590',
  text: '#E6EDF3',
  green: '#3DD68C',
  amber: '#E3B341',
  ink: '#0D1117',
} as const

const TITLE = 'PROMPT UPGRADE'

const NARROW_LINE =
  'Prompt Upgrade needs a wider window, so your prompt is back in the box.'
const FAIL_LINE =
  'Prompt Upgrade could not do that just now. Nothing was sent, and your prompt is safe.'

const SHORT_REPLIES = new Set([
  'yes', 'y', 'yeah', 'yep', 'yup', 'no', 'n', 'nope', 'ok', 'okay', 'k', 'sure',
  'thanks', 'thank you', 'thx', 'ty', 'go', 'go on', 'go ahead', 'keep going',
  'continue', 'carry on', 'proceed', 'do it', 'done', 'stop', 'wait', 'next',
  'sounds good', 'looks good', 'lgtm', 'perfect', 'great', 'nice', 'cool',
  'right', 'correct', 'exactly', 'agreed', 'approved', 'ship it', 'retry',
  'try again', 'again', 'more', 'yes please', 'please do', 'go for it',
])

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function mint(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6)
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

export function isShortReply(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/[\s.!?,;:]+$/g, '').replace(/\s+/g, ' ')
  if (norm === '') return true
  if (SHORT_REPLIES.has(norm)) return true
  if (/^\d{1,2}$/.test(norm)) return true
  // A single word is a reply, not a prompt worth upgrading.
  return !norm.includes(' ') && norm.length <= 14
}

export type SubmitDecision =
  | { kind: 'pass' }
  | { kind: 'strip'; text: string }
  | { kind: 'intercept'; text: string }

/** Which prompts automatic mode takes to the pane. Only called while it is on. */
export function decide(e: PromptSubmitInput): SubmitDecision {
  if (e.origin.kind !== 'composer') return { kind: 'pass' } // includes this mod's own sends
  if (e.command !== undefined || e.isMeta === true) return { kind: 'pass' }
  if ((e.attachments?.length ?? 0) > 0) return { kind: 'pass' }
  if (e.turnId !== undefined) return { kind: 'pass' } // Claude is working
  const text = e.text.trim()
  if (text.startsWith('/')) return { kind: 'pass' }
  if (text.startsWith('>')) {
    const rest = text.slice(1).trimStart()
    return rest ? { kind: 'strip', text: rest } : { kind: 'pass' }
  }
  if (isShortReply(text)) return { kind: 'pass' }
  return { kind: 'intercept', text }
}

function extractJson(text: string): unknown {
  const body = text.replace(/```(?:json)?/gi, '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : t.slice(0, Math.max(1, max - 1)).trimEnd() + '…'
}

/** Up to three questions, each with two to four short options. Anything unreadable is dropped. */
export function parseQuestions(text: string): Question[] {
  const data = extractJson(text) as { questions?: unknown } | undefined
  const list = Array.isArray(data?.questions) ? data.questions : []
  const out: Question[] = []
  for (const item of list) {
    if (out.length >= 3) break
    if (!item || typeof item !== 'object') continue
    const raw = item as { question?: unknown; text?: unknown; options?: unknown }
    const q = typeof raw.question === 'string' ? raw.question : typeof raw.text === 'string' ? raw.text : ''
    const opts = Array.isArray(raw.options)
      ? raw.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map(o => clip(o, 40))
      : []
    const unique = [...new Set(opts)].slice(0, 4)
    if (!q.trim() || unique.length < 2) continue
    out.push({ id: `q${out.length + 1}`, text: clip(q, 160), options: unique })
  }
  return out
}

/** The upgraded prompt and what was added, or undefined when the reply cannot be read. */
export function parseRewrite(text: string): { prompt: string; added: string[] } | undefined {
  const data = extractJson(text) as { prompt?: unknown; added?: unknown } | undefined
  if (!data || typeof data.prompt !== 'string' || !data.prompt.trim()) return undefined
  const added = Array.isArray(data.added)
    ? data.added.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map(a => clip(a, 120)).slice(0, 8)
    : []
  return { prompt: data.prompt.trim(), added }
}

function explain(r: ModelCompleteResult | null): string {
  if (r === null) return 'The request could not be sent.'
  if (r.isAnswered) return 'The reply came back in a form I could not read.'
  if (r.reason === 'aborted') return 'The model took too long to answer.'
  if (r.reason === 'empty-reply') return 'The model sent back an empty answer.'
  if (r.error === 'rate_limit') return 'The model is rate limited right now.'
  if (r.error === 'overloaded') return 'The model is overloaded right now.'
  if (r.error === 'authentication_failed') return 'The model call was not signed in.'
  return `The model call failed (${r.error}${r.status ? `, ${r.status}` : ''}).`
}

/** Word wrap to `width`, keeping blank lines and breaking words that are too long. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  for (const para of text.replace(/\r/g, '').split('\n')) {
    if (para.trim() === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }
    const lead = /^\s*/.exec(para)?.[0].slice(0, Math.floor(w / 3)) ?? ''
    let line = lead
    for (const word0 of para.trim().split(/\s+/)) {
      let word = word0
      while (word.length > w - lead.length && w - lead.length > 0) {
        if (line.trim()) {
          out.push(line)
          line = lead
        }
        out.push(lead + word.slice(0, w - lead.length))
        word = word.slice(w - lead.length)
      }
      if (!word) continue
      const cand = line.trim() ? `${line} ${word}` : lead + word
      if (cand.length > w) {
        out.push(line)
        line = lead + word
      } else {
        line = cand
      }
    }
    if (line.trim()) out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.length ? out : ['']
}

const DIGITS: Record<string, [string, string, string]> = {
  '0': ['┏━┓', '┃ ┃', '┗━┛'],
  '1': ['╺┓ ', ' ┃ ', '╺┻╸'],
  '2': ['╺━┓', '┏━┛', '┗━╸'],
  '3': ['╺━┓', ' ━┫', '╺━┛'],
  '4': ['╻ ╻', '┗━┫', '  ╹'],
  '5': ['┏━╸', '┗━┓', '╺━┛'],
  '6': ['┏━╸', '┣━┓', '┗━┛'],
  '7': ['╺━┓', '  ┃', '  ╹'],
  '8': ['┏━┓', '┣━┫', '┗━┛'],
  '9': ['┏━┓', '┗━┫', '╺━┛'],
}

export function bigNumber(n: number): [string, string, string] {
  const glyphs = String(Math.max(0, Math.round(n))).split('').map(d => DIGITS[d] ?? DIGITS['0']!)
  return [0, 1, 2].map(row => glyphs.map(g => g[row]).join(' ')) as [string, string, string]
}

function center(text: string, width: number): string {
  const pad = Math.max(0, width - text.length)
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + text + ' '.repeat(pad - left)
}

function stamp(at: number): string {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

// ---------------------------------------------------------------------------
// Model prompts
// ---------------------------------------------------------------------------

const QUESTIONS_SYSTEM = `You help a person improve a prompt they are about to send to an AI coding assistant.
Pick up to three multiple-choice questions whose answers would most improve the result.
Rules:
- Ask only about things the prompt leaves open that would change the outcome: the goal, who it is for, the format, the scope, what "done" looks like, constraints.
- Never ask about something the prompt already says.
- Each question is short and plain. Each has 2 to 4 options of 1 to 5 words.
- If no question would clearly help, return an empty list.
Reply with JSON only, no prose:
{"questions":[{"question":"...","options":["...","..."]}]}`

const REWRITE_SYSTEM = `You rewrite a person's rough prompt for an AI coding assistant into a clear, complete request.
Rules:
- Keep exactly what the person meant. Do not change the task.
- Add a clear goal, who it is for, the format of the result, and what "done" looks like.
- Use the answers the person gave. Leave out anything they skipped or that was not asked.
- Never invent facts, names, numbers, prices, file paths or versions. Where something needed is unknown, write a [placeholder] in square brackets.
- Write it as one request the person could have typed themselves, in plain language, first person, no headings or markdown decoration. Short paragraphs or a short list are fine.
- "added" lists what you added, each item a few words (for example "Clear goal", "Definition of done").
Reply with JSON only, no prose:
{"prompt":"...","added":["...","..."]}`

function questionsRequest(original: string): string {
  return `Rough prompt:\n<prompt>\n${original}\n</prompt>`
}

function rewriteRequest(flow: Flow): string {
  const lines: string[] = []
  for (const q of flow.questions) {
    const a = flow.answers[q.id]
    if (!a || a.kind === 'skip') continue
    lines.push(`- ${q.text} -> ${a.value}`)
  }
  const answers = lines.length
    ? `Answers the person gave:\n${lines.join('\n')}`
    : 'The person gave no answers. Do not assume any.'
  return `Rough prompt:\n<prompt>\n${flow.original}\n</prompt>\n\n${answers}`
}

// ---------------------------------------------------------------------------
// State access (reads anywhere, writes only from events and presses)
// ---------------------------------------------------------------------------

function asFlow(value: unknown): Flow | null {
  if (!value || typeof value !== 'object') return null
  const f = value as Partial<Flow>
  if (f.v !== 1 || typeof f.id !== 'string' || typeof f.original !== 'string' || typeof f.step !== 'string') return null
  return {
    questions: [],
    answers: {},
    otherOpen: null,
    upgraded: '',
    added: [],
    editing: false,
    error: null,
    notice: null,
    pending: null,
    source: 'command',
    ...f,
  } as Flow
}

function asHistory(value: unknown): HistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((x): x is HistoryEntry =>
      !!x && typeof x === 'object' && typeof (x as HistoryEntry).id === 'string' &&
      typeof (x as HistoryEntry).original === 'string' && typeof (x as HistoryEntry).upgraded === 'string')
    .map(x => ({ ...x, added: Array.isArray(x.added) ? x.added : [], at: Number(x.at) || 0 }))
    .slice(0, HISTORY_MAX)
}

async function readFlow($: E$): Promise<{ flow: Flow | null; version: number }> {
  const got = await $.state.get(FLOW)
  return { flow: asFlow(got.value as unknown), version: got.version }
}

async function writeFlow($: E$, flow: Flow | null): Promise<void> {
  await $.state.set(FLOW, flow)
}

/** Read-modify-write of the current flow, only while it is still flow `id`. */
async function changeFlow($: E$, id: string, fn: (f: Flow) => Flow | null): Promise<Flow | null> {
  for (let i = 0; i < 5; i++) {
    const { flow, version } = await readFlow($)
    if (!flow || flow.id !== id) return null
    const nextFlow = fn(flow)
    const r = await $.state.set(FLOW, nextFlow, { ifVersion: version })
    if (r.isSet) return nextFlow
  }
  return null
}

async function readHistory($: E$): Promise<HistoryEntry[]> {
  const got = await $.state.get(HISTORY)
  return asHistory(got.value as unknown)
}

async function writeHistory($: E$, list: HistoryEntry[]): Promise<void> {
  const kept = list.slice(0, HISTORY_MAX)
  await $.state.set(HISTORY, kept)
  await $.store.set(STORE_HISTORY, kept)
}

async function loadHistoryIntoState($: E$): Promise<void> {
  const got = await $.state.get(HISTORY)
  if (got.version > 0) return
  const stored = asHistory(await $.store.get(STORE_HISTORY))
  await $.state.set(HISTORY, stored)
}

async function isAuto($: E$): Promise<boolean> {
  return (await $.store.get(STORE_AUTO)) === true
}

function newFlow(original: string, source: FlowSource, step: Flow['step']): Flow {
  return {
    v: 1,
    id: mint(),
    original,
    step,
    questions: [],
    answers: {},
    otherOpen: null,
    upgraded: '',
    added: [],
    editing: false,
    error: null,
    notice: null,
    pending: null,
    source,
  }
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

async function startQuestions($: E$, id: string): Promise<void> {
  const token = mint()
  try {
    const began = await changeFlow($, id, f => ({ ...f, step: 'reading', pending: token, error: null, notice: null }))
    if (!began) return
    let reply: ModelCompleteResult | null = null
    try {
      reply = await $.model.complete({
        model: MODEL,
        system: QUESTIONS_SYSTEM,
        prompt: questionsRequest(began.original),
        maxTokens: 800,
        timeoutMs: CALL_TIMEOUT_MS,
      })
    } catch {
      reply = null
    }
    const { flow } = await readFlow($)
    if (!flow || flow.id !== id || flow.pending !== token) return
    if (!reply || !reply.isAnswered) {
      await changeFlow($, id, f => ({ ...f, step: 'error', pending: null, error: { at: 'questions', message: explain(reply) } }))
      return
    }
    const questions = parseQuestions(reply.text)
    if (questions.length === 0) {
      await changeFlow($, id, f => ({ ...f, questions: [], answers: {}, pending: null }))
      await startRewrite($, id)
      return
    }
    await changeFlow($, id, f => ({ ...f, step: 'questions', pending: null, questions, answers: {}, otherOpen: null }))
  } catch {
    await changeFlow($, id, f => ({ ...f, step: 'error', pending: null, error: { at: 'questions', message: 'Something went wrong on my side.' } })).catch(() => null)
  }
}

async function startRewrite($: E$, id: string): Promise<void> {
  const token = mint()
  try {
    const began = await changeFlow($, id, f => ({ ...f, step: 'rewrite', pending: token, error: null, otherOpen: null, notice: null }))
    if (!began) return
    let reply: ModelCompleteResult | null = null
    try {
      reply = await $.model.complete({
        model: MODEL,
        system: REWRITE_SYSTEM,
        prompt: rewriteRequest(began),
        maxTokens: 3000,
        timeoutMs: CALL_TIMEOUT_MS,
      })
    } catch {
      reply = null
    }
    const { flow } = await readFlow($)
    if (!flow || flow.id !== id || flow.pending !== token) return
    const parsed = reply && reply.isAnswered ? parseRewrite(reply.text) : undefined
    if (!parsed) {
      await changeFlow($, id, f => ({ ...f, step: 'error', pending: null, error: { at: 'rewrite', message: explain(reply) } }))
      return
    }
    const done = await changeFlow($, id, f => ({
      ...f,
      step: 'review',
      pending: null,
      upgraded: parsed.prompt,
      added: parsed.added,
      editing: false,
    }))
    if (done && done.source !== 'history') {
      try {
        const at = await $.clock.now()
        const list = await readHistory($)
        const entry: HistoryEntry = { id: done.id, at, original: done.original, upgraded: done.upgraded, added: done.added }
        await writeHistory($, [entry, ...list.filter(x => x.id !== done.id)])
      } catch {
        // History is a convenience: the review stands even if it could not be saved.
      }
    }
  } catch {
    await changeFlow($, id, f => ({ ...f, step: 'error', pending: null, error: { at: 'rewrite', message: 'Something went wrong on my side.' } })).catch(() => null)
  }
}

/** Picks a step that was mid-call back up after a reload (module variables start over, state stays). */
async function resume($: E$): Promise<void> {
  const { flow } = await readFlow($)
  if (!flow) return
  if (flow.step === 'reading') void startQuestions($, flow.id)
  else if (flow.step === 'rewrite') void startRewrite($, flow.id)
}

async function closePane($: E$): Promise<void> {
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // a hook kept it open; nothing to do
  }
}

async function restorePrompt($: E$, text: string): Promise<void> {
  if (!text) return
  try {
    await $.prompt.fill({ text, mode: 'replace' })
  } catch {
    // no prompt box (headless); nothing to restore into
  }
}

async function sendText($: E$, text: string, historyId?: string): Promise<void> {
  await writeFlow($, null)
  await closePane($)
  await $.prompt.submit({ text, asUser: true })
  if (historyId) {
    const list = await readHistory($)
    if (list.some(x => x.id === historyId && x.upgraded !== text)) {
      await writeHistory($, list.map(x => (x.id === historyId ? { ...x, upgraded: text } : x)))
    }
  }
}

async function cancel($: E$): Promise<void> {
  const { flow } = await readFlow($)
  await writeFlow($, null)
  await $.state.set(VIEW, 'flow')
  await closePane($)
  if (flow) await restorePrompt($, flow.original)
}

async function answer($: E$, id: string, qid: string, a: Answer): Promise<void> {
  const f = await changeFlow($, id, fl => {
    if (fl.step !== 'questions') return fl
    return { ...fl, answers: { ...fl.answers, [qid]: a }, otherOpen: fl.otherOpen === qid ? null : fl.otherOpen }
  })
  if (f && f.step === 'questions' && f.questions.every(q => f.answers[q.id] !== undefined)) {
    await startRewrite($, id)
  }
}

async function skipRest($: E$, id: string): Promise<void> {
  const f = await changeFlow($, id, fl => {
    if (fl.step !== 'questions') return fl
    const answers: Record<string, Answer> = { ...fl.answers }
    for (const q of fl.questions) if (!answers[q.id]) answers[q.id] = { kind: 'skip' }
    return { ...fl, answers, otherOpen: null }
  })
  if (f && f.step === 'questions') await startRewrite($, id)
}

async function setNotice($: E$, id: string, notice: Notice | null): Promise<void> {
  await changeFlow($, id, f => ({ ...f, notice }))
}

/** Opens the pane from a command without holding the command's answer. */
function openInBackground($: E$, restore: string, onPlaced?: () => void): void {
  void $.ui
    .open(PANE_OPEN)
    .then(async opened => {
      if (opened.isPlaced) {
        onPlaced?.()
        return
      }
      await writeFlow($, null)
      await closePane($)
      await restorePrompt($, restore)
      $.ui.log(NARROW_LINE)
    })
    .catch(() => {
      $.ui.log(FAIL_LINE)
    })
}

/** Runs a press handler so a failure shows as a calm line instead of nothing. */
function act($: E$, id: string | null, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn()
    } catch {
      if (id) await setNotice($, id, { tone: 'warn', text: 'That did not work. Your prompt is safe.' }).catch(() => undefined)
    }
  }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

type Els = { Box: any; Text: any; Button: any; Input?: any }

type Tone = 'gold' | 'slate' | 'quiet' | 'picked'

type Chip = { key: string; label: string; tone: Tone; onPress: () => unknown; autoFocus?: boolean }

function chipWidth(c: Chip): number {
  return c.tone === 'quiet' ? c.label.length : c.label.length + 2
}

function ChipEl(els: Els, c: Chip, maxWidth: number): any {
  const { Button, Text } = els
  const room = c.tone === 'quiet' ? maxWidth : maxWidth - 2
  const label = c.label.length > room ? clip(c.label, Math.max(1, room)) : c.label
  const focus = c.autoFocus ? { autoFocus: true as const } : {}
  if (c.tone === 'quiet') {
    return (
      <Button key={c.key} plain onPress={c.onPress} {...focus}>
        <Text color={C.muted}>{label}</Text>
      </Button>
    )
  }
  const bg = c.tone === 'gold' || c.tone === 'picked' ? C.gold : C.slate
  const fg = c.tone === 'gold' || c.tone === 'picked' ? C.ink : C.text
  return (
    <Button key={c.key} plain onPress={c.onPress} {...focus}>
      <Text backgroundColor={bg} color={fg} bold={c.tone === 'gold' || c.tone === 'picked'}>
        {` ${label} `}
      </Text>
    </Button>
  )
}

/** Lays chips into rows that never pass `width`, one cell between chips. */
function ChipRows(els: Els, chips: Chip[], width: number, indent = 0): any {
  const { Box, Text } = els
  const room = Math.max(4, width - indent)
  const rows: Chip[][] = []
  let row: Chip[] = []
  let used = 0
  for (const c of chips) {
    const cw = Math.min(chipWidth(c), room)
    const need = row.length ? used + 1 + cw : cw
    if (row.length && need > room) {
      rows.push(row)
      row = [c]
      used = cw
    } else {
      row.push(c)
      used = need
    }
  }
  if (row.length) rows.push(row)
  return (
    <Box flexDirection="column">
      {rows.map(r => (
        <Box flexDirection="row">
          {indent > 0 && <Text>{' '.repeat(indent)}</Text>}
          {r.flatMap((c, i) => (i === 0 ? [ChipEl(els, c, room)] : [<Text> </Text>, ChipEl(els, c, room)]))}
        </Box>
      ))}
    </Box>
  )
}

function Title(els: Els, w: number): any {
  const { Box, Text } = els
  const t = TITLE.slice(0, w)
  return (
    <Box flexDirection="column">
      <Text color={C.text} bold wrap="truncate">{t}</Text>
      <Box flexDirection="row">
        <Text color={C.gold} wrap="truncate">{'━'.repeat(Math.min(t.length, w))}</Text>
        <Text color={C.hair} wrap="truncate">{'─'.repeat(Math.max(0, w - t.length))}</Text>
      </Box>
    </Box>
  )
}

function Heading(els: Els, label: string, w: number): any {
  const { Box, Text } = els
  const l = label.slice(0, w)
  const rest = Math.max(0, w - l.length - 1)
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={C.muted} wrap="truncate">{l}</Text>
      {rest > 0 && <Text color={C.hair} wrap="truncate">{' ' + '─'.repeat(rest)}</Text>}
    </Box>
  )
}

const STEP_SETS: string[][] = [
  ['YOUR PROMPT', 'QUESTIONS', 'REWRITE', 'REVIEW'],
  ['PROMPT', 'ASK', 'WRITE', 'REVIEW'],
  ['1', '2', '3', '4'],
]

function Tracker(els: Els, current: number, w: number): any {
  const { Box, Text } = els
  let labels = STEP_SETS[STEP_SETS.length - 1]!
  for (const set of STEP_SETS) {
    const items = set.reduce((n, l) => n + l.length + 2, 0)
    if (items + 3 * 3 <= w) {
      labels = set
      break
    }
  }
  const items = labels.reduce((n, l) => n + l.length + 2, 0)
  const gap = Math.max(1, Math.min(7, Math.floor((w - items) / 3)))
  const joiner = gap >= 3 ? ` ${'─'.repeat(gap - 2)} ` : ' '.repeat(gap)
  const parts: any[] = []
  labels.forEach((label, i) => {
    if (i > 0) parts.push(<Text color={C.hair}>{joiner}</Text>)
    if (i < current) {
      parts.push(<Text color={C.green}>{'✓ '}</Text>)
      parts.push(<Text color={C.text}>{label}</Text>)
    } else if (i === current) {
      parts.push(<Text color={C.gold} bold>{'● ' + label}</Text>)
    } else {
      parts.push(<Text color={C.muted}>{'○ ' + label}</Text>)
    }
  })
  return (
    <Box flexDirection="row" marginTop={1}>
      {parts}
    </Box>
  )
}

function Lines(els: Els, text: string, width: number, color: string = C.text): any[] {
  const { Text } = els
  return wrap(text, width).map(line => (
    <Text color={color} wrap="truncate">{line === '' ? ' ' : line}</Text>
  ))
}

function Card(els: Els, opts: { label: string; labelColor: string; border: string; body: string; width: number }): any {
  const { Box, Text } = els
  const inner = Math.max(1, opts.width - 4)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={opts.border} paddingX={1} width={opts.width}>
      <Text color={opts.labelColor} wrap="truncate">{opts.label.slice(0, inner)}</Text>
      {Lines(els, opts.body, inner)}
    </Box>
  )
}

function Tiles(els: Els, before: number, after: number, added: number, w: number): any {
  const { Box, Text } = els
  const tiles = [
    { n: before, cap: 'WORDS BEFORE', color: C.text },
    { n: after, cap: 'WORDS AFTER', color: C.gold },
    { n: added, cap: 'DETAILS ADDED', color: C.green },
  ].map(t => {
    const rows = bigNumber(t.n)
    const inner = Math.max(rows[0].length, t.cap.length)
    return { ...t, rows, inner, outer: inner + 4 }
  })
  const total = tiles.reduce((n, t) => n + t.outer, 0) + (tiles.length - 1)
  if (total > w) {
    const line = `${before} words before · ${after} after · ${added} added`
    return (
      <Box flexDirection="column" marginTop={1}>
        {Lines(els, line, w, C.text)}
      </Box>
    )
  }
  return (
    <Box flexDirection="row" marginTop={1}>
      {tiles.flatMap((t, i) => {
        const tile = (
          <Box flexDirection="column" borderStyle="round" borderColor={C.hair} paddingX={1} width={t.outer}>
            {t.rows.map(r => (
              <Text color={t.color} bold wrap="truncate">{center(r, t.inner)}</Text>
            ))}
            <Text color={C.muted} wrap="truncate">{center(t.cap, t.inner)}</Text>
          </Box>
        )
        return i === 0 ? [tile] : [<Text> </Text>, tile]
      })}
    </Box>
  )
}

function NoticeLine(els: Els, notice: Notice | null, w: number): any {
  if (!notice) return null
  return (
    <els.Box flexDirection="column" marginTop={1}>
      {Lines(els, notice.text, w, notice.tone === 'good' ? C.green : C.amber)}
    </els.Box>
  )
}

function drawCompose($: E$, els: Els, flow: Flow, w: number): any {
  const { Box, Text, Input } = els
  return (
    <Box flexDirection="column">
      {Tracker(els, 0, w)}
      {Heading(els, 'YOUR PROMPT', w)}
      {Input ? (
        <Input
          key="compose"
          rows={5}
          placeholder="Type the rough prompt you want to upgrade"
          submitLabel="upgrade"
          autoFocus
          onSubmit={(value: string) =>
            act($, flow.id, async () => {
              const text = value.trim()
              if (!text) return
              const f = await changeFlow($, flow.id, fl => ({ ...fl, original: text, source: 'compose' }))
              if (f) await startQuestions($, f.id)
            })()
          }
        />
      ) : (
        <Text color={C.muted} wrap="truncate">Typing is not available here. Use /better with your prompt.</Text>
      )}
      <Box marginTop={1}>{ChipRows(els, [{ key: 'cancel', label: 'Cancel', tone: 'quiet', onPress: act($, null, () => cancel($)) }], w)}</Box>
    </Box>
  )
}

function drawWorking($: E$, els: Els, flow: Flow, w: number, stepIndex: number, line: string): any {
  const { Box, Text } = els
  return (
    <Box flexDirection="column">
      {Tracker(els, stepIndex, w)}
      <Box marginTop={1}>
        {Card(els, { label: 'YOUR PROMPT', labelColor: C.muted, border: C.hair, body: flow.original, width: w })}
      </Box>
      {Lines(els, line, w, C.muted)}
      <Box marginTop={1}>{ChipRows(els, [{ key: 'cancel', label: 'Cancel', tone: 'quiet', onPress: act($, null, () => cancel($)) }], w)}</Box>
      <Text> </Text>
    </Box>
  )
}

function drawQuestions($: E$, els: Els, flow: Flow, w: number): any {
  const { Box, Text, Input } = els
  const total = flow.questions.length
  const answered = flow.questions.filter(q => {
    const a = flow.answers[q.id]
    return a && a.kind !== 'skip'
  }).length
  const firstOpen = flow.questions.find(q => !flow.answers[q.id])?.id
  const body: any[] = []
  flow.questions.forEach((q, i) => {
    const a = flow.answers[q.id]
    const isAnswered = !!a && a.kind !== 'skip'
    const isSkipped = a?.kind === 'skip'
    const badge = isAnswered ? (
      <Text backgroundColor={C.green} color={C.ink} bold>{' ✓ '}</Text>
    ) : isSkipped ? (
      <Text backgroundColor={C.slate} color={C.muted}>{' – '}</Text>
    ) : (
      <Text backgroundColor={C.gold} color={C.ink} bold>{` ${i + 1} `}</Text>
    )
    const qLines = wrap(q.text, Math.max(1, w - 4))
    body.push(
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          {badge}
          <Text> </Text>
          <Text color={isSkipped ? C.muted : C.text} bold={!isSkipped} wrap="truncate">{qLines[0]}</Text>
        </Box>
        {qLines.slice(1).map(l => (
          <Text color={isSkipped ? C.muted : C.text} bold={!isSkipped} wrap="truncate">{'    ' + l}</Text>
        ))}
      </Box>,
    )
    const chips: Chip[] = q.options.map((opt, j) => ({
      key: `opt-${q.id}-${j}`,
      label: opt,
      tone: a?.kind === 'option' && a.value === opt ? 'picked' : 'slate',
      autoFocus: q.id === firstOpen && j === 0,
      onPress: act($, flow.id, () => answer($, flow.id, q.id, { kind: 'option', value: opt })),
    }))
    if (Input) {
      chips.push({
        key: `other-${q.id}`,
        label: a?.kind === 'other' ? `Other: ${clip(a.value, 24)}` : 'Other (type it)',
        tone: a?.kind === 'other' ? 'picked' : 'slate',
        onPress: act($, flow.id, async () => {
          await changeFlow($, flow.id, f => ({ ...f, otherOpen: f.otherOpen === q.id ? null : q.id }))
        }),
      })
    }
    chips.push({
      key: `skip-${q.id}`,
      label: isSkipped ? 'Skipped' : 'Skip',
      tone: 'quiet',
      onPress: act($, flow.id, () => answer($, flow.id, q.id, { kind: 'skip' })),
    })
    body.push(ChipRows(els, chips, w, 4))
    if (Input && flow.otherOpen === q.id) {
      body.push(
        <Box flexDirection="row">
          <Text>{'    '}</Text>
          <Input
            key={`other-input-${q.id}`}
            placeholder="Type your answer, then Enter"
            submitLabel="save"
            autoFocus
            onSubmit={(value: string) =>
              act($, flow.id, async () => {
                const v = value.trim()
                if (v) await answer($, flow.id, q.id, { kind: 'other', value: clip(v, 200) })
                else await changeFlow($, flow.id, f => ({ ...f, otherOpen: null }))
              })()
            }
          />
        </Box>,
      )
    }
  })
  return (
    <Box flexDirection="column">
      {Tracker(els, 1, w)}
      <Box marginTop={1} flexDirection="column">
        {Lines(els, `Your prompt: “${clip(flow.original, Math.max(8, w * 2))}”`, w, C.muted)}
      </Box>
      {Heading(els, 'QUESTIONS', w)}
      <Text color={answered === total ? C.green : C.muted} wrap="truncate">
        {`${answered} of ${total} answered`.slice(0, w)}
      </Text>
      {body}
      <Box marginTop={1}>
        {ChipRows(
          els,
          [
            { key: 'skip-rest', label: 'Skip the rest, upgrade now', tone: 'gold', onPress: act($, flow.id, () => skipRest($, flow.id)) },
            { key: 'cancel', label: 'Cancel', tone: 'quiet', onPress: act($, null, () => cancel($)) },
          ],
          w,
        )}
      </Box>
      {NoticeLine(els, flow.notice, w)}
    </Box>
  )
}

function drawReview($: E$, els: Els, flow: Flow, w: number): any {
  const { Box, Text, Input } = els
  const before = wordCount(flow.original)
  const after = wordCount(flow.upgraded)
  const historyId = flow.source === 'history' ? undefined : flow.id
  const actions: Chip[] = flow.editing
    ? [
        { key: 'stop-edit', label: 'Stop editing', tone: 'slate', onPress: act($, flow.id, async () => {
          const draft = drafts.get(flow.id)
          drafts.delete(flow.id)
          await changeFlow($, flow.id, f => ({ ...f, editing: false, upgraded: draft ?? f.upgraded }))
        }) },
        { key: 'cancel', label: 'Cancel', tone: 'quiet', onPress: act($, null, () => cancel($)) },
      ]
    : [
        { key: 'run', label: 'Run it', tone: 'gold', autoFocus: true, onPress: act($, flow.id, () => sendText($, flow.upgraded, historyId)) },
        ...(Input
          ? [{ key: 'edit', label: 'Edit', tone: 'slate' as const, onPress: act($, flow.id, async () => {
              await changeFlow($, flow.id, f => ({ ...f, editing: true, notice: null }))
            }) }]
          : []),
        { key: 'copy', label: 'Copy', tone: 'slate', onPress: async (press?: { surface?: string }) => {
          try {
            const r = await $.ui.copy({ text: flow.upgraded, surface: press?.surface as never })
            await setNotice($, flow.id, r.isCopied
              ? { tone: 'good', text: 'Copied the upgraded prompt.' }
              : { tone: 'warn', text: 'Could not copy here. Select the text instead.' })
          } catch {
            await setNotice($, flow.id, { tone: 'warn', text: 'Could not copy here. Select the text instead.' }).catch(() => undefined)
          }
        } },
        { key: 'cancel', label: 'Cancel', tone: 'quiet', onPress: act($, null, () => cancel($)) },
      ]

  const addedList = flow.added.length
    ? flow.added.flatMap(item => {
        const lines = wrap(item, Math.max(1, w - 2))
        return lines.map((l, i) => (
          <Box flexDirection="row">
            <Text color={C.green}>{i === 0 ? '+ ' : '  '}</Text>
            <Text color={C.text} wrap="truncate">{l}</Text>
          </Box>
        ))
      })
    : [<Text color={C.muted} wrap="truncate">{'Nothing new was needed.'.slice(0, w)}</Text>]

  const sideBySide = w >= 64
  const colW = sideBySide ? Math.floor((w - 1) / 2) : w
  const left = Card(els, { label: 'YOUR PROMPT', labelColor: C.muted, border: C.hair, body: flow.original, width: colW })
  const right = Card(els, { label: 'UPGRADE', labelColor: C.gold, border: C.gold, body: flow.upgraded, width: colW })

  return (
    <Box flexDirection="column">
      {Tracker(els, 3, w)}
      {Tiles(els, before, after, flow.added.length, w)}
      <Box marginTop={1}>{ChipRows(els, actions, w)}</Box>
      {NoticeLine(els, flow.notice, w)}
      {flow.editing && Input ? (
        <Box flexDirection="column">
          {Heading(els, 'EDIT THE UPGRADE', w)}
          {Lines(els, 'Enter runs the edited prompt.', w, C.muted)}
          <Input
            key="edit-input"
            rows={Math.min(14, Math.max(3, wrap(flow.upgraded, Math.max(1, w - 2)).length + 1))}
            value={flow.upgraded}
            submitLabel="run"
            autoFocus
            onInput={(value: string) => {
              drafts.set(flow.id, value)
            }}
            onSubmit={(value: string) =>
              act($, flow.id, async () => {
                drafts.delete(flow.id)
                const text = value.trim()
                if (text) await sendText($, text, historyId)
              })()
            }
          />
        </Box>
      ) : null}
      {Heading(els, 'WHAT I ADDED', w)}
      {addedList}
      <Box marginTop={1} flexDirection={sideBySide ? 'row' : 'column'}>
        {left}
        {sideBySide ? <Text> </Text> : null}
        {right}
      </Box>
    </Box>
  )
}

function drawError($: E$, els: Els, flow: Flow, w: number): any {
  const { Box, Text } = els
  const at = flow.error?.at ?? 'questions'
  const inner = Math.max(1, w - 4)
  return (
    <Box flexDirection="column">
      {Tracker(els, at === 'rewrite' ? 2 : 1, w)}
      <Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={C.amber} paddingX={1} width={w}>
        <Text color={C.amber} bold wrap="truncate">{'That did not go through'.slice(0, inner)}</Text>
        {Lines(els, 'Your prompt is safe. Nothing has been sent.', inner, C.text)}
        {Lines(els, flow.error?.message ?? '', inner, C.muted)}
      </Box>
      <Box marginTop={1}>
        {ChipRows(
          els,
          [
            { key: 'retry', label: 'Try again', tone: 'gold', autoFocus: true, onPress: act($, flow.id, () =>
              at === 'rewrite' ? startRewrite($, flow.id) : startQuestions($, flow.id)) },
            { key: 'send-original', label: 'Send my original', tone: 'slate', onPress: act($, flow.id, () => sendText($, flow.original)) },
            { key: 'cancel', label: 'Cancel', tone: 'quiet', onPress: act($, null, () => cancel($)) },
          ],
          w,
        )}
      </Box>
    </Box>
  )
}

function drawHistory($: E$, els: Els, list: HistoryEntry[], hasFlow: boolean, w: number): any {
  const { Box, Text, Button } = els
  const rows = list.map(entry => {
    const head = `${stamp(entry.at)}  ${wordCount(entry.original)}>${wordCount(entry.upgraded)} words  `
    const room = Math.max(1, w - head.length)
    return (
      <Button
        key={`hist-${entry.id}`}
        plain
        onPress={act($, null, async () => {
          const flow: Flow = { ...newFlow(entry.original, 'history', 'review'), upgraded: entry.upgraded, added: entry.added }
          await writeFlow($, flow)
          await $.state.set(VIEW, 'flow')
        })}
      >
        <Text color={C.muted}>{head.slice(0, w)}</Text>
        <Text color={C.text}>{head.length < w ? clip(entry.original, room) : ''}</Text>
      </Button>
    )
  })
  return (
    <Box flexDirection="column">
      {Heading(els, `LAST ${HISTORY_MAX} UPGRADES`, w)}
      {rows.length ? rows : [<Text color={C.muted} wrap="truncate">{'No upgrades yet. Try /better with a prompt.'.slice(0, w)}</Text>]}
      <Box marginTop={1}>
        {ChipRows(
          els,
          [
            ...(hasFlow
              ? [{ key: 'back', label: 'Back', tone: 'slate' as const, onPress: act($, null, async () => { await $.state.set(VIEW, 'flow') }) }]
              : []),
            { key: 'close', label: 'Close', tone: 'quiet', onPress: act($, null, async () => {
              await $.state.set(VIEW, 'flow')
              if (!hasFlow) await closePane($)
            }) },
          ],
          w,
        )}
      </Box>
    </Box>
  )
}

/** Drafts typed into the Edit field, kept between key presses (lost on reload, by design). */
const drafts = new Map<string, string>()

// ---------------------------------------------------------------------------
// Status-bar button
// ---------------------------------------------------------------------------

/**
 * The status-bar Upgrade button. With text in the prompt box, that text is
 * upgraded (as `/better <text>` would); with an empty box, the pane opens to
 * type one. An upgrade already under way is brought back instead of replaced.
 */
async function upgradeFromButton($: E$): Promise<void> {
  try {
    const { flow } = await readFlow($)
    if (flow) {
      await $.state.set(VIEW, 'flow')
      openInBackground($, '')
      return
    }
    let text = ''
    try {
      text = (await $.prompt.read()).text.trim()
    } catch {
      // no prompt box: open the pane to type in
    }
    if (!text) {
      await writeFlow($, newFlow('', 'compose', 'compose'))
      await $.state.set(VIEW, 'flow')
      openInBackground($, '')
      return
    }
    // Take the draft out of the box; Cancel, Esc or a narrow window put it back.
    await $.prompt.fill({ text: '', mode: 'replace' }).catch(() => undefined)
    const next = newFlow(text, 'command', 'reading')
    await writeFlow($, next)
    await $.state.set(VIEW, 'flow')
    openInBackground($, text, () => void startQuestions($, next.id))
  } catch {
    $.ui.toast(FAIL_LINE)
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'better',
      description: 'Upgrade a rough prompt before sending it (on, off, history)',
      argumentHint: '[prompt | on | off | history]',
      immediate: true,
    })
    await loadHistoryIntoState($).catch(() => undefined)
    await resume($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'better' }, async ($, e) => {
    const arg = e.args.trim()
    const word = arg.toLowerCase()
    if (word === 'on' || word === 'off') {
      await $.store.set(STORE_AUTO, word === 'on')
      return {
        text:
          word === 'on'
            ? 'Prompt Upgrade is on. Prompts you type open in the pane first. Start one with > to send it as is.'
            : 'Prompt Upgrade is off. Prompts go straight to Claude.',
      }
    }
    if (word === 'history') {
      await loadHistoryIntoState($)
      const count = (await readHistory($)).length
      await $.state.set(VIEW, 'history')
      openInBackground($, '')
      return { text: count ? `Showing your last ${count} upgrades.` : 'No upgrades yet.' }
    }
    if (!arg) {
      await writeFlow($, newFlow('', 'compose', 'compose'))
      await $.state.set(VIEW, 'flow')
      openInBackground($, '')
      return { text: 'Type your prompt in the Prompt Upgrade pane.' }
    }
    const flow = newFlow(arg, 'command', 'reading')
    await writeFlow($, flow)
    await $.state.set(VIEW, 'flow')
    openInBackground($, arg, () => void startQuestions($, flow.id))
    return { text: 'Upgrading your prompt in the Prompt Upgrade pane. Nothing is sent until you press Run.' }
  }).catch(() => ({ text: FAIL_LINE }))

  on('prompt.submit', async ($, e, next) => {
    if (!(await isAuto($))) return next(e)
    const d = decide(e)
    if (d.kind === 'pass') return next(e)
    if (d.kind === 'strip') return next({ ...e, text: d.text })
    const flow = newFlow(d.text, 'auto', 'reading')
    await writeFlow($, flow)
    await $.state.set(VIEW, 'flow')
    const opened = await $.ui.open(PANE_OPEN)
    if (!opened.isPlaced) {
      await writeFlow($, null)
      await closePane($)
      void $.clock.after(50, () => void restorePrompt($, e.text))
      return { drop: NARROW_LINE }
    }
    void startQuestions($, flow.id)
    return { drop: 'Opened in Prompt Upgrade. Nothing is sent until you press Run.' }
  }).catch(($, e, next) => next(e))

  // The Upgrade button in the status bar, beside the other mods' buttons.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const { flow } = await readFlow($)
    const fill = flow ? C.amber : C.gold
    const modes = e.props.modes
    // Every mod's status-bar button goes in one shared grid (status-grid.tsx).
    return statusGrid(
      { Box, Text },
      below,
      modes,
      <Button
          key="open-prompt-upgrade"
          plain
          onPress={() => {
            // The upgrade calls a model; keep the press itself short.
            $.clock.after(0, () => void upgradeFromButton($))
          }}
        >
          <Text color={fill}>▐</Text>
          <Text backgroundColor={fill} color={C.ink} bold>
            {flow ? '✦ Upgrade …' : '✦ Upgrade'}
          </Text>
          <Text color={fill}>▌</Text>
        </Button>,
      undefined,
      e.viewport?.columns,
    ) as never
  }).catch(($, e, next) => next(e))

  // The person closed the pane (its mark, Esc): same as Cancel, so nothing is lost.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    if (e.origin.kind === 'person') {
      const { flow } = await readFlow($)
      await writeFlow($, null)
      await $.state.set(VIEW, 'flow')
      if (flow) await restorePrompt($, flow.original)
    }
    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Els
    const { Box } = els
    const w = Math.max(20, e.props.bodyColumns)
    const view = (await $.state.get(VIEW)).value ?? 'flow'
    const { flow } = await readFlow($)
    let body: any
    if (view === 'history') {
      body = drawHistory($, els, await readHistory($), flow !== null, w)
    } else if (!flow) {
      body = drawHistory($, els, await readHistory($), false, w)
    } else if (flow.step === 'compose') {
      body = drawCompose($, els, flow, w)
    } else if (flow.step === 'reading') {
      body = drawWorking($, els, flow, w, 0, 'Reading your prompt and picking the questions that would help most.')
    } else if (flow.step === 'questions') {
      body = drawQuestions($, els, flow, w)
    } else if (flow.step === 'rewrite') {
      const n = Object.values(flow.answers).filter(a => a.kind !== 'skip').length
      body = drawWorking($, els, flow, w, 2, `Writing the upgrade from your prompt${n ? ` and ${n} answer${n === 1 ? '' : 's'}` : ''}.`)
    } else if (flow.step === 'review') {
      body = drawReview($, els, flow, w)
    } else {
      body = drawError($, els, flow, w)
    }
    return (
      <Box flexDirection="column" width={w}>
        {Title(els, w)}
        {body}
      </Box>
    )
  }).catch(($, e) => {
    const { Box, Text } = $.ui.resolve(e) as unknown as Els
    return (
      <Box flexDirection="column">
        <Text color={C.amber}>Prompt Upgrade could not draw this step.</Text>
        <Text color={C.text}>Your prompt is safe. Close the pane to get it back.</Text>
      </Box>
    )
  })
}
