import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { DayRecord } from '../types'
import { addDays, dayKey, dayOfYear, emptyDay, kindOfTask, streak, sumDays } from '../hooks/lib'

const PLUGIN = 'work-report'
const TODAY = new Date(2026, 10, 2, 12) // Monday, November 2 2026, local noon

const paneAt = (bodyColumns: number) =>
  ({
    plugin: PLUGIN,
    component: 'Pane',
    requestId: 'work-report',
    props: {
      title: 'Work Report',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  }) as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

function day(kinds: Partial<DayRecord['kinds']>, models: Record<string, number> = {}): DayRecord {
  const d = emptyDay()
  Object.assign(d.kinds, kinds)
  d.models = models
  return d
}

function world(on: On, stored: Record<string, unknown> = {}) {
  mock.store(on, stored)
  mock.clock(on, { now: TODAY.getTime() })
  const sent: string[] = []
  on('command.register', () => ({ value: { command: 'report' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  return { sent }
}

const start = ($: { session: { start: (e: never) => Promise<unknown> } }) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)

const typed = (text: string, extra: Record<string, unknown> = {}) =>
  ({ text, wait: false, origin: { kind: 'composer' }, ...extra }) as never

const command = (args: string) =>
  ({ command: 'report', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as never

/** One whole turn: a prompt (or none), its tools, and how it ended. */
async function turn(
  $: any,
  id: string,
  opts: { prompt?: unknown; tools?: Record<string, unknown>[]; reason?: 'answer' | 'aborted' | 'error'; model?: string; agentId?: string },
) {
  if (opts.prompt) await $.prompt.submit(opts.prompt)
  const agent = opts.agentId ? { agentId: opts.agentId } : {}
  await $.turn.start({ text: 'x', turnId: id, ...agent })
  for (const t of opts.tools ?? []) await $.tool.call(t)
  const reason = opts.reason ?? 'answer'
  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: reason === 'aborted',
    turnId: id,
    reason,
    usage: { ...USAGE, model: opts.model ?? 'claude-opus-5-5' },
    ...agent,
  })
}

async function texts(ui: { findAll: (q: { type?: string }) => Promise<{ text?: string }[]> }) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
}

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

describe('sorting a task by its tools', () => {
  test('each kind', () => {
    expect(kindOfTask([{ tool: 'mcp__claude_ai_Gmail__send_message' }])).toBe('emails')
    expect(kindOfTask([{ tool: 'mcp__media__generate_image' }])).toBe('images')
    expect(kindOfTask([{ tool: 'Write', path: '/tmp/hero.png' }])).toBe('images')
    expect(kindOfTask([{ tool: 'Write', path: '/tmp/plan.docx' }])).toBe('documents')
    expect(kindOfTask([{ tool: 'Skill', skill: 'pptx' }])).toBe('documents')
    expect(kindOfTask([{ tool: 'WebSearch' }])).toBe('research')
    expect(kindOfTask([{ tool: 'mcp__yt__get_transcript' }])).toBe('research')
    expect(kindOfTask([{ tool: 'Bash' }, { tool: 'Edit', path: '/src/app.ts' }])).toBe('other')
    expect(kindOfTask([])).toBe('other')
  })

  test('code search tools are not research, and email wins over research', () => {
    expect(kindOfTask([{ tool: 'ToolSearch' }, { tool: 'Grep' }, { tool: 'Glob' }])).toBe('other')
    expect(kindOfTask([{ tool: 'WebFetch' }, { tool: 'mcp__outlook__send_mail' }])).toBe('emails')
    expect(kindOfTask([{ tool: 'WebSearch' }, { tool: 'Write', path: '/r/report.pdf' }])).toBe('documents')
  })
})

describe('dates', () => {
  test('the day of the year', () => {
    expect(dayOfYear(new Date(2026, 0, 1, 12))).toBe(1)
    expect(dayOfYear(new Date(2024, 2, 1, 12))).toBe(61) // leap year
    expect(dayOfYear(new Date(2026, 2, 1, 12))).toBe(60)
    expect(dayOfYear(new Date(2026, 11, 31, 12))).toBe(365)
    expect(dayOfYear(new Date(2026, 2, 9, 0, 30))).toBe(68) // just after a spring clock change in many zones
  })

  test('stepping at noon never skips or repeats a day across the year', () => {
    let d = new Date(2026, 0, 1, 12)
    const seen = new Set<string>()
    for (let i = 0; i < 365; i++) {
      seen.add(dayKey(d))
      d = addDays(d, 1)
    }
    expect(seen.size).toBe(365)
    expect(dayKey(d)).toBe('2027-01-01')
  })

  test('adding days together', () => {
    const days: Record<string, DayRecord> = {
      [dayKey(TODAY)]: day({ emails: 2, research: 1 }, { 'claude-opus-5-5': 3 }),
      [dayKey(addDays(TODAY, -1))]: day({ documents: 4 }, { 'claude-opus-5-5': 1, 'claude-sonnet-5-5': 3 }),
      [dayKey(addDays(TODAY, -10))]: day({ other: 5 }, { 'claude-haiku-5-5': 5 }),
    }
    const week = sumDays(days, [0, 1, 2, 3, 4, 5, 6].map(i => addDays(TODAY, -i)))
    expect(week.tasks).toBe(7)
    expect(week.kinds.documents).toBe(4)
    expect(week.models['claude-opus-5-5']).toBe(4)
    expect(week.models['claude-sonnet-5-5']).toBe(3)
    expect(week.activeDays).toBe(2)
  })

  test('the streak', () => {
    const on = (n: number) => dayKey(addDays(TODAY, -n))
    const days: Record<string, DayRecord> = {
      [on(0)]: day({ other: 1 }),
      [on(1)]: day({ other: 2 }),
      [on(2)]: day({ emails: 1 }),
      [on(4)]: day({ other: 1 }),
    }
    expect(streak(days, TODAY)).toBe(3)
    // Nothing yet today: yesterday's run still stands.
    const { [on(0)]: _today, ...rest } = days
    expect(streak(rest, TODAY)).toBe(2)
    expect(streak({}, TODAY)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Through the engine
// ---------------------------------------------------------------------------

test('only typed prompts that end with an answer count', async ($, on) => {
  world(on)
  await start($)

  await turn($, 't1', { prompt: typed('Search for flights to Lisbon'), tools: [{ tool: 'WebSearch', query: 'flights' }] })
  await turn($, 't2', { prompt: typed('Write the plan as a doc'), tools: [{ tool: 'Write', file_path: '/p/plan.docx', content: 'x' }], model: 'claude-sonnet-5-5' })
  // Not counted: a slash command, a cancelled turn, an error, a helper agent's turn, a turn nobody typed.
  await turn($, 't3', { prompt: typed('/review', { command: { name: 'review', args: '' } }) })
  await turn($, 't4', { prompt: typed('Do the thing'), reason: 'aborted' })
  await turn($, 't5', { prompt: typed('Do another thing'), reason: 'error' })
  await turn($, 't6', { agentId: 'a1' })
  await turn($, 't7', {})
  // A prompt typed while Claude is working folds into that turn.
  await turn($, 't8', { prompt: typed('also this', { turnId: 't7' }) })

  const ui = await $.ui.mount({ ...paneAt(90), surface: 'terminal' })
  const all = (await texts(ui)).join('\n')
  expect(all).toContain('TASKS DONE')
  // Two tasks: one research, one document; 25 + 30 minutes is 0.9 hours, $46 at $50.
  expect(all).toMatch(/Research\s/)
  expect(all).toContain('1  0.4h')
  expect(all).toContain('1  0.5h')
  expect(all).toContain('Opus 5.5')
  expect(all).toContain('Sonnet 5.5')
  await ui.unmount()
})

test('the empty state', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  const all = (await texts(ui)).join('\n')
  expect(all).toContain('Nothing finished yet today. Your first finished task shows up here.')
  expect(all).not.toContain('TASKS DONE')
  await ui.unmount()
})

function stored(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  out['day:' + dayKey(TODAY)] = day({ emails: 3, research: 2 }, { 'claude-opus-5-5': 5 })
  out['day:' + dayKey(addDays(TODAY, -1))] = day({ documents: 6 }, { 'claude-sonnet-5-5': 6 })
  out['day:' + dayKey(addDays(TODAY, -2))] = day({ other: 1 }, { 'claude-opus-5-5': 1 })
  out['day:' + dayKey(addDays(TODAY, -20))] = day({ images: 9 }, { 'claude-opus-5-5': 9 })
  out['day:' + dayKey(new Date(2026, 2, 10, 12))] = day({ other: 40 }, { 'claude-opus-5-5': 40 })
  return out
}

test('each tab draws its own title and chart', async ($, on) => {
  world(on, stored())
  await start($)
  const ui = await $.ui.mount({ ...paneAt(90), surface: 'terminal' })

  let all = (await texts(ui)).join('\n')
  expect(all).toContain('TODAY')
  expect(all).toContain('Mon Nov 2, 2026')
  expect(all).toContain('Streak: 3 days in a row.')
  expect(all).toContain('Mon') // the seven weekday labels

  await ui.press({ key: 'tab-week' })
  all = (await texts(ui)).join('\n')
  expect(all).toContain('LAST 7 DAYS')
  expect(all).toContain('Oct 27 – Nov 2, 2026')
  expect(all).toContain('Tue')

  await ui.press({ key: 'tab-month' })
  all = (await texts(ui)).join('\n')
  expect(all).toContain('LAST 30 DAYS')
  expect(all).toContain('Oct 4 – Nov 2, 2026')
  expect(all).toContain('Best day: Tue Oct 13, 9 tasks. 4 active days.')
  expect(all).toContain('Today')

  await ui.press({ key: 'tab-year' })
  all = (await texts(ui)).join('\n')
  expect(all).toContain('THIS YEAR')
  expect(all).toContain('Jan 1 – Nov 2, 2026')
  expect(all).toContain('Best month: March, 40 tasks.')
  expect(all).toContain('Jan')
  expect(all).toContain('Dec')
  await ui.unmount()
})

test('rows fit the pane, narrow and wide, with fewer tiles across when narrow', async ($, on) => {
  world(on, stored())
  await start($)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const width of [26, 40, 120]) {
      for (const tab of ['today', 'week', 'month', 'year']) {
        const ui = await $.ui.mount({ ...paneAt(width), surface })
        await ui.press({ key: `tab-${tab}` })
        for (const t of await texts(ui)) expect(t.length).toBeLessThanOrEqual(width)
        // All three tiles stay, stacked as the width shrinks.
        expect(await ui.find({ key: 'tile-hours' })).toBeDefined()
        expect(await ui.find({ key: 'tile-value' })).toBeDefined()
        await ui.unmount()
      }
    }
  }
})

test('settings list and change', async ($, on) => {
  world(on)
  await start($)
  const listed = await $.command.run(command('settings'))
  expect(listed.text).toContain('Emails 10, Documents 30, Images and video 20, Research 25, Other 10')
  expect(listed.text).toContain('$50')
  expect((await $.command.run(command('settings rate 75'))).text).toContain('$75')
  expect((await $.command.run(command('settings emails 15'))).text).toContain('15 minutes')
  expect((await $.command.run(command('settings'))).text).toContain('Emails 15')
  expect((await $.command.run(command('settings colour 3'))).text).toContain('no setting')
})

test('/report answers at once and the footer button draws', async ($, on) => {
  world(on)
  // Stands for the engine's own mode labels beneath the mod.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.modes.join(' & ')}</Text>
  })
  await start($)
  expect((await $.command.run(command(''))).text).toContain('Opened')
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
  expect(await ui.find({ key: 'open-work-report' })).toBeDefined()
  expect((await texts(ui)).join(' ')).toContain('focus')
  await ui.unmount()
})
