import type { EngineInterface, PaneOpenArgs, PromptSubmitInput, Register } from 'claude-code'

import type { DayRecord, Kind, Settings, Tab } from '../types'
import {
  DAY_MS,
  KIND_LABEL,
  KIND_SHORT,
  KINDS,
  MONTHS,
  MONTHS_LONG,
  WEEKDAYS,
  asDay,
  asSettings,
  bestDay,
  dayFromKey,
  dayKey,
  daysOf,
  emptyDay,
  fmtDollars,
  fmtHours,
  hoursFor,
  kindOfTask,
  lastDays,
  modelName,
  monthTotals,
  noonOf,
  rangeLabel,
  shortDate,
  streak,
  sumDays,
  tasksOn,
  toolUseOf,
} from './lib'
import type { ToolUse } from './lib'
import { statusGrid } from './status-grid'

type E$ = EngineInterface

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PANE = 'work-report'
const DAY_PREFIX = 'day:'
const STORE_SETTINGS = 'settings'
const KEEP_DAYS = 730

const DAYS = { plugin: 'work-report', key: 'days' } as const
const SETTINGS = { plugin: 'work-report', key: 'settings' } as const
const TAB = { plugin: 'work-report', key: 'tab' } as const

const PANE_OPEN: PaneOpenArgs = {
  id: PANE,
  title: 'Work Report',
  focus: true,
  closeOnEscape: true,
  rows: 34,
  columns: 72,
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

const KIND_COLOR: Record<Kind, string> = {
  emails: '#79C0FF',
  images: '#D2A8FF',
  documents: '#FFA657',
  research: '#56D4DD',
  other: '#7D8590',
}

const TABS: { tab: Tab; label: string; title: string }[] = [
  { tab: 'today', label: 'Today', title: 'TODAY' },
  { tab: 'week', label: 'Week', title: 'LAST 7 DAYS' },
  { tab: 'month', label: 'Month', title: 'LAST 30 DAYS' },
  { tab: 'year', label: 'Year', title: 'THIS YEAR' },
]

const FAIL_LINE = 'Work Report could not do that just now. Nothing was changed.'

// ---------------------------------------------------------------------------
// Recording (module variables: one typed prompt in flight at a time)
// ---------------------------------------------------------------------------

/** A typed prompt was accepted and its turn has not started yet. */
let armed = false
/** The main-loop turn a typed prompt started, and the tools used while it ran. */
let live: { turnId: string; uses: ToolUse[] } | null = null

/** One typed request: the person's own words, sent while Claude was idle, not a slash command. */
export function isTypedPrompt(e: PromptSubmitInput): boolean {
  if (e.command !== undefined || e.isMeta === true || e.turnId !== undefined) return false
  const o = e.origin as { kind: string; asUser?: boolean }
  if (o.kind === 'composer' || o.kind === 'bridge') return true
  // A prompt another mod sends as the person's own words (Prompt Upgrade's Run) is still their request.
  return o.kind === 'plugin' && o.asUser === true
}

async function recordTask($: E$, kind: Kind, model: string): Promise<void> {
  const key = dayKey(noonOf(await $.clock.now()))
  for (let i = 0; i < 5; i++) {
    const got = await $.state.get(DAYS)
    const days = { ...(got.value ?? {}) } as Record<string, DayRecord>
    const day = asDay(days[key]) ?? emptyDay()
    day.kinds[kind] += 1
    day.models[model] = (day.models[model] ?? 0) + 1
    days[key] = day
    const r = await $.state.set(DAYS, days, { ifVersion: got.version })
    if (r.isSet) {
      await $.store.set(DAY_PREFIX + key, day)
      return
    }
  }
}

async function loadFromStore($: E$): Promise<void> {
  const now = noonOf(await $.clock.now())
  const oldest = now.getTime() - KEEP_DAYS * DAY_MS
  const days: Record<string, DayRecord> = {}
  for (const key of await $.store.keys()) {
    if (!key.startsWith(DAY_PREFIX)) continue
    const dk = key.slice(DAY_PREFIX.length)
    const date = dayFromKey(dk)
    if (!date || date.getTime() < oldest) {
      await $.store.delete(key)
      continue
    }
    const day = asDay(await $.store.get(key))
    if (day) days[dk] = day
  }
  const held = await $.state.get(DAYS)
  // Keep anything recorded this session that the store has not caught up with.
  await $.state.set(DAYS, { ...days, ...((held.value ?? {}) as Record<string, DayRecord>) })
  await $.state.set(SETTINGS, asSettings(await $.store.get(STORE_SETTINGS)))
}

async function readSettings($: E$): Promise<Settings> {
  return asSettings((await $.state.get(SETTINGS)).value)
}

async function writeSettings($: E$, s: Settings): Promise<void> {
  await $.state.set(SETTINGS, s)
  await $.store.set(STORE_SETTINGS, s)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const KIND_ALIASES: Record<string, Kind> = {
  email: 'emails', emails: 'emails', mail: 'emails',
  document: 'documents', documents: 'documents', docs: 'documents', doc: 'documents',
  image: 'images', images: 'images', video: 'images', videos: 'images', media: 'images',
  research: 'research',
  other: 'other',
}

function settingsText(s: Settings): string {
  const m = s.minutes
  return [
    'Work Report estimate settings:',
    `Minutes saved per task: Emails ${m.emails}, Documents ${m.documents}, Images and video ${m.images}, Research ${m.research}, Other ${m.other}.`,
    `Hourly rate: $${s.rate}.`,
    'Change one with /report settings rate 75 or /report settings emails 15.',
  ].join('\n')
}

async function runSettings($: E$, words: string[]): Promise<string> {
  const s = await readSettings($)
  if (words.length === 0) return settingsText(s)
  const [what = '', raw = ''] = words
  const value = Number(raw)
  if (words.length !== 2 || raw === '' || !Number.isFinite(value) || value < 0) {
    return 'Use /report settings rate 75, or a kind and minutes such as /report settings emails 15.'
  }
  if (what === 'rate') {
    if (value > 100_000) return 'That rate is too high to use. Pick a number up to 100000.'
    const next = { ...s, rate: Math.round(value * 100) / 100 }
    await writeSettings($, next)
    return `Hourly rate is now $${next.rate}. Dollar figures are an estimate.`
  }
  const kind = KIND_ALIASES[what]
  if (!kind) return `There is no setting called "${what}". Use rate, emails, documents, images, research or other.`
  if (value > 1440) return 'That is more than a day per task. Pick a number of minutes up to 1440.'
  const next = { ...s, minutes: { ...s.minutes, [kind]: Math.round(value) } }
  await writeSettings($, next)
  return `${KIND_LABEL[kind]} now count as ${next.minutes[kind]} minutes saved per task (an estimate).`
}

function openInBackground($: E$): void {
  void $.ui.open(PANE_OPEN).catch(() => $.ui.log(FAIL_LINE))
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

type Els = { Box: any; Text: any; Button: any }

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
  '$': ['┏╋╸', '┗╋┓', '╺╋┛'],
  '.': [' ', ' ', '•'],
}

export function bigText(value: string): [string, string, string] | null {
  const glyphs: [string, string, string][] = []
  for (const ch of value) {
    const g = DIGITS[ch]
    if (!g) return null
    glyphs.push(g)
  }
  return [0, 1, 2].map(r => glyphs.map(g => g[r]).join(' ')) as [string, string, string]
}

function clip(text: string, max: number): string {
  if (max <= 0) return ''
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '…'
}

function center(text: string, width: number): string {
  const t = clip(text, width)
  const pad = Math.max(0, width - t.length)
  const left = Math.floor(pad / 2)
  return ' '.repeat(left) + t + ' '.repeat(pad - left)
}

function padLeft(text: string, width: number): string {
  const t = clip(text, width)
  return ' '.repeat(Math.max(0, width - t.length)) + t
}

function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  let line = ''
  for (const word0 of text.split(/\s+/).filter(Boolean)) {
    let word = word0
    while (word.length > w) {
      if (line) out.push(line)
      out.push(word.slice(0, w))
      word = word.slice(w)
      line = ''
    }
    if (!word) continue
    if (!line) line = word
    else if (line.length + 1 + word.length <= w) line += ' ' + word
    else {
      out.push(line)
      line = word
    }
  }
  if (line) out.push(line)
  return out.length ? out : ['']
}

function Lines(els: Els, text: string, w: number, color: string): any[] {
  return wrap(text, w).map(l => (
    <els.Text color={color} wrap="truncate">{l}</els.Text>
  ))
}

function Heading(els: Els, label: string, w: number): any {
  const { Box, Text } = els
  const l = clip(label, w)
  const rest = Math.max(0, w - l.length - 1)
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={C.muted} wrap="truncate">{l}</Text>
      {rest > 0 && <Text color={C.hair} wrap="truncate">{' ' + '─'.repeat(rest)}</Text>}
    </Box>
  )
}

function Tabs($: E$, els: Els, current: Tab, w: number): any {
  const { Box, Button, Text } = els
  const rows: (typeof TABS)[] = []
  let row: typeof TABS = []
  let used = 0
  for (const t of TABS) {
    const cw = t.label.length + 2
    const need = row.length ? used + 1 + cw : cw
    if (row.length && need > w) {
      rows.push(row)
      row = [t]
      used = cw
    } else {
      row.push(t)
      used = need
    }
  }
  if (row.length) rows.push(row)
  return (
    <Box flexDirection="column">
      {rows.map(r => (
        <Box flexDirection="row">
          {r.flatMap((t, i) => {
            const isOn = t.tab === current
            const chip = (
              <Button
                key={`tab-${t.tab}`}
                plain
                onPress={async () => {
                  try {
                    await $.state.set(TAB, t.tab)
                  } catch {
                    // the next press tries again
                  }
                }}
              >
                <Text backgroundColor={isOn ? C.gold : C.slate} color={isOn ? C.ink : C.text} bold={isOn}>
                  {` ${t.label} `}
                </Text>
              </Button>
            )
            return i === 0 ? [chip] : [<Text> </Text>, chip]
          })}
        </Box>
      ))}
    </Box>
  )
}

function TitleBar(els: Els, title: string, dates: string, shortDates: string, w: number): any {
  const { Box, Text } = els
  const t = clip(title, w)
  const right = t.length + 2 + dates.length <= w ? dates : t.length + 2 + shortDates.length <= w ? shortDates : ''
  const gap = Math.max(0, w - t.length - right.length)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={C.text} bold wrap="truncate">{t}</Text>
        <Text>{' '.repeat(gap)}</Text>
        {right ? <Text color={C.muted} wrap="truncate">{right}</Text> : null}
      </Box>
      <Box flexDirection="row">
        <Text color={C.gold} wrap="truncate">{'━'.repeat(t.length)}</Text>
        <Text color={C.hair} wrap="truncate">{'─'.repeat(Math.max(0, w - t.length))}</Text>
      </Box>
    </Box>
  )
}

type TileSpec = { key: string; value: string; caption: string; color: string }

function Tiles(els: Els, tiles: TileSpec[], w: number): any {
  const { Box, Text } = els
  const perRow = w >= 3 * 18 + 2 ? 3 : w >= 2 * 18 + 1 ? 2 : 1
  const tileW = Math.floor((w - (perRow - 1)) / perRow)
  const inner = Math.max(1, tileW - 4)
  const rows: TileSpec[][] = []
  for (let i = 0; i < tiles.length; i += perRow) rows.push(tiles.slice(i, i + perRow))
  const drawTile = (t: TileSpec) => {
    // Big numerals when they fit the tile; plain bold text otherwise.
    const big = bigText(t.value)
    const lines = big && big[0].length <= inner ? big : ['', clip(t.value, inner), '']
    return (
      <Box key={t.key} flexDirection="column" borderStyle="round" borderColor={C.hair} paddingX={1} width={tileW}>
        {lines.map(l => (
          <Text color={t.color} bold wrap="truncate">{center(l, inner)}</Text>
        ))}
        <Text color={C.muted} wrap="truncate">{center(t.caption, inner)}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map(r => (
        <Box flexDirection="row">
          {r.flatMap((t, i) => (i === 0 ? [drawTile(t)] : [<Text> </Text>, drawTile(t)]))}
        </Box>
      ))}
    </Box>
  )
}

function BarRow(els: Els, opts: { label: string; labelW: number; color: string; value: number; max: number; tail: string; tailW: number; w: number }): any {
  const { Box, Text } = els
  const barW = Math.max(0, opts.w - opts.labelW - 1 - opts.tailW - 1)
  const filled = opts.value > 0 && opts.max > 0 ? Math.max(1, Math.round((opts.value / opts.max) * barW)) : 0
  const isZero = opts.value === 0
  return (
    <Box flexDirection="row">
      <Text color={isZero ? C.muted : C.text} wrap="truncate">{clip(opts.label, opts.labelW).padEnd(opts.labelW)}</Text>
      <Text> </Text>
      {barW > 0 && <Text color={opts.color}>{'━'.repeat(filled)}</Text>}
      {barW > 0 && <Text color={C.hair}>{'─'.repeat(barW - filled)}</Text>}
      <Text> </Text>
      <Text color={isZero ? C.muted : C.text} wrap="truncate">{padLeft(opts.tail, opts.tailW)}</Text>
    </Box>
  )
}

const EIGHTHS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** A chart three rows tall: one bar per value; `null` is a period still to come (drawn empty). */
function Chart(els: Els, values: (number | null)[], labels: string[], highlight: number, w: number, spanLabels?: [string, string]): any {
  const { Box, Text } = els
  let vals = values
  let labs = labels
  let hi = highlight
  if (vals.length > w) {
    const cut = vals.length - w
    vals = vals.slice(cut)
    labs = labs.slice(cut)
    hi -= cut
  }
  const n = Math.max(1, vals.length)
  let gap: number
  let barW: number
  if (n <= 12) {
    const per = Math.floor((w + 1) / n)
    gap = per >= 3 ? 1 : 0
    barW = Math.max(1, Math.min(5, per - gap))
  } else {
    gap = 2 * n - 1 <= w ? 1 : 0
    barW = 1
  }
  const max = Math.max(1, ...vals.map(v => v ?? 0))
  const level = (v: number | null) => (v === null || v <= 0 ? 0 : Math.max(1, Math.round((v / max) * 24)))
  const cell = (lv: number, row: number) => {
    const part = lv - row * 8
    return part >= 8 ? '█' : part <= 0 ? ' ' : EIGHTHS[part]!
  }
  const rows: any[] = []
  for (const row of [2, 1, 0]) {
    const segs: { color: string; text: string }[] = []
    vals.forEach((v, i) => {
      const lv = level(v)
      let text: string
      let color: string
      if (row === 0 && v !== null && lv === 0) {
        text = '─'.repeat(barW)
        color = C.hair
      } else {
        text = cell(lv, row).repeat(barW)
        color = i === hi ? C.gold : C.text
      }
      const last = segs[segs.length - 1]
      const lead = i > 0 && gap ? ' ' : ''
      if (last && last.color === color) last.text += lead + text
      else if (last) {
        last.text += lead
        segs.push({ color, text })
      } else segs.push({ color, text })
    })
    rows.push(
      <Box flexDirection="row">
        {segs.map(s => (
          <Text color={s.color}>{s.text}</Text>
        ))}
      </Box>,
    )
  }
  const width = n * barW + (n - 1) * gap
  let labelRow: any
  if (spanLabels) {
    const [left, right] = spanLabels
    const fits = left.length + 1 + right.length <= width
    labelRow = (
      <Box flexDirection="row">
        <Text color={C.muted} wrap="truncate">{fits ? left : ''}</Text>
        <Text>{' '.repeat(Math.max(0, width - (fits ? left.length : 0) - clip(right, width).length))}</Text>
        <Text color={C.gold} wrap="truncate">{clip(right, width)}</Text>
      </Box>
    )
  } else {
    labelRow = (
      <Box flexDirection="row">
        {labs.flatMap((l, i) => {
          const text = (barW >= 3 ? l.slice(0, 3) : l.slice(0, 1)).padEnd(barW).slice(0, barW)
          const el = (
            <Text color={i === hi ? C.gold : vals[i] === null ? C.hair : C.muted}>{text}</Text>
          )
          return i > 0 && gap ? [<Text> </Text>, el] : [el]
        })}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows}
      {labelRow}
    </Box>
  )
}

function emptyLine(tab: Tab): string {
  if (tab === 'today') return 'Nothing finished yet today. Your first finished task shows up here.'
  if (tab === 'week') return 'Nothing finished in the last 7 days. Your next finished task shows up here.'
  if (tab === 'month') return 'Nothing finished in the last 30 days. Your next finished task shows up here.'
  return 'Nothing finished yet this year. Your next finished task shows up here.'
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

async function drawPane($: E$, els: Els, w: number): Promise<any> {
  const { Box, Text } = els
  const tab = ((await $.state.get(TAB)).value ?? 'today') as Tab
  const days = ((await $.state.get(DAYS)).value ?? {}) as Record<string, DayRecord>
  const settings = await readSettings($)
  const today = noonOf(await $.clock.now())
  const dates = daysOf(tab, today)
  const totals = sumDays(days, dates)
  const est = hoursFor(totals, settings)
  const meta = TABS.find(t => t.tab === tab) ?? TABS[0]!
  const dateLabel = rangeLabel(tab, today)
  const shortLabel = tab === 'today' ? shortDate(today) : `${shortDate(dates[0]!)} – ${shortDate(today)}`

  const head = (
    <Box flexDirection="column">
      {Tabs($, els, tab, w)}
      {TitleBar(els, meta.title, dateLabel, shortLabel, w)}
    </Box>
  )

  if (totals.tasks === 0) {
    return (
      <Box flexDirection="column" width={w}>
        {head}
        <Box flexDirection="column" marginTop={1}>
          {Lines(els, emptyLine(tab), w, C.text)}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {Lines(els, 'Each prompt you type that ends with an answer counts as one task.', w, C.muted)}
        </Box>
      </Box>
    )
  }

  const tiles: TileSpec[] = [
    { key: 'tile-hours', value: fmtHours(est.hours), caption: 'HOURS SAVED (EST.)', color: C.gold },
    { key: 'tile-tasks', value: String(totals.tasks), caption: 'TASKS DONE', color: C.text },
    { key: 'tile-value', value: fmtDollars(est.dollars), caption: 'VALUE (EST.)', color: C.green },
  ]

  // Where the time went
  const labelW = w >= 44 ? 16 : 8
  const tailW = 13
  const maxKind = Math.max(1, ...KINDS.map(k => totals.kinds[k]))
  const kindRows = KINDS.map(k =>
    BarRow(els, {
      label: labelW >= 16 ? KIND_LABEL[k] : KIND_SHORT[k],
      labelW,
      color: KIND_COLOR[k],
      value: totals.kinds[k],
      max: maxKind,
      tail: `${totals.kinds[k]}  ${fmtHours(est.byKind[k])}h`,
      tailW,
      w,
    }),
  )

  // Who did the work
  const models = Object.entries(totals.models).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const maxModel = Math.max(1, ...models.map(m => m[1]))
  const modelRows = models.map(([id, n]) =>
    BarRow(els, { label: modelName(id), labelW, color: C.gold, value: n, max: maxModel, tail: String(n), tailW: 5, w }),
  )

  // The chart and its summary line
  let chart: any
  let summary: string
  let summaryColor: string = C.text
  if (tab === 'today' || tab === 'week') {
    const week = lastDays(today, 7)
    chart = Chart(els, week.map(d => tasksOn(days[dayKey(d)])), week.map(d => WEEKDAYS[d.getDay()]!), 6, w)
    const run = streak(days, today)
    summary = run === 1 ? 'Streak: 1 day.' : `Streak: ${run} days in a row.`
    if (run >= 2) summaryColor = C.green
  } else if (tab === 'month') {
    const month = lastDays(today, 30)
    chart = Chart(els, month.map(d => tasksOn(days[dayKey(d)])), month.map(d => shortDate(d)), 29, w, [shortDate(month[0]!), 'Today'])
    const best = bestDay(days, month)
    summary = best
      ? `Best day: ${WEEKDAYS[best.date.getDay()]} ${shortDate(best.date)}, ${best.tasks} task${best.tasks === 1 ? '' : 's'}. ${totals.activeDays} active day${totals.activeDays === 1 ? '' : 's'}.`
      : `${totals.activeDays} active days.`
  } else {
    const perMonth = monthTotals(days, today.getFullYear())
    const current = today.getMonth()
    chart = Chart(els, perMonth.map((n, i) => (i > current ? null : n)), MONTHS, current, w)
    let bestMonth = -1
    perMonth.forEach((n, i) => {
      if (i <= current && n > 0 && (bestMonth < 0 || n > perMonth[bestMonth]!)) bestMonth = i
    })
    summary = bestMonth >= 0
      ? `Best month: ${MONTHS_LONG[bestMonth]}, ${perMonth[bestMonth]} tasks. ${totals.activeDays} active day${totals.activeDays === 1 ? '' : 's'}.`
      : `${totals.activeDays} active days.`
  }

  const m = settings.minutes
  const note = `Hours and dollars are estimates: ${m.emails} to ${m.documents} minutes a task depending on kind, at $${settings.rate} an hour. /report settings changes them.`

  return (
    <Box flexDirection="column" width={w}>
      {head}
      {Tiles(els, tiles, w)}
      {Heading(els, 'WHERE THE TIME WENT', w)}
      {kindRows}
      {Heading(els, 'WHO DID THE WORK', w)}
      {modelRows}
      {Heading(els, tab === 'year' ? 'BY MONTH' : tab === 'month' ? 'BY DAY' : 'LAST 7 DAYS', w)}
      {chart}
      <Box flexDirection="column">{Lines(els, summary, w, summaryColor)}</Box>
      <Box flexDirection="column" marginTop={1}>{Lines(els, note, w, C.muted)}</Box>
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'report',
      description: 'Show what Claude finished for you, with estimated hours saved',
      argumentHint: '[today | week | month | year | settings]',
      immediate: true,
    })
    await loadFromStore($).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'report' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const [first] = words
    if (first === 'settings') return { text: await runSettings($, words.slice(1)) }
    const tab = TABS.find(t => t.tab === first)?.tab
    if (first && !tab) return { text: 'Use /report, /report week, /report month, /report year or /report settings.' }
    if (tab) await $.state.set(TAB, tab)
    openInBackground($)
    return { text: 'Opened your work report.' }
  }).catch(() => ({ text: FAIL_LINE }))

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    if (result.drop === undefined && isTypedPrompt(e)) armed = true
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      live = armed ? { turnId: e.turnId, uses: [] } : null
      armed = false
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (live) live.uses.push(toolUseOf(e as unknown as { tool: string } & Record<string, unknown>))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && live && live.turnId === e.turnId) {
      const task = live
      live = null
      if (e.reason === 'answer' && !e.isAborted) {
        await recordTask($, kindOfTask(task.uses), e.usage?.model ?? 'unknown').catch(() => undefined)
      }
    }
    return result
  })

  // The status bar button: the footer's mode labels, then "Work report".
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Text, Button } = $.ui.resolve(e) as unknown as Els
    // Draw beside what is already there (the engine's labels, other mods' buttons), never over it.
    const below = await next(e)
    const modes = e.props.modes
    // Every mod's status-bar button goes in one shared grid (status-grid.tsx).
    return statusGrid(
      { Box, Text },
      below,
      modes,
      <Button
          key="open-work-report"
          plain
          onPress={async () => {
            try {
              await $.ui.open(PANE_OPEN)
            } catch {
              $.ui.log(FAIL_LINE)
            }
          }}
        >
          <Text color={C.gold}>Work report</Text>
        </Button>,
      undefined,
      e.viewport?.columns,
    ) as never
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Els
    const w = Math.max(20, e.props.bodyColumns)
    return drawPane($, els, w)
  }).catch(($, e) => {
    const { Box, Text } = $.ui.resolve(e) as unknown as Els
    return (
      <Box flexDirection="column">
        <Text color={C.amber}>Work Report could not draw this view.</Text>
        <Text color={C.text}>Your records are safe. Try another tab.</Text>
      </Box>
    )
  })
}
