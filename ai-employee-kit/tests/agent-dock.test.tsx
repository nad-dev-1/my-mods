import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { badge, clock, duration, initials, jobName, parseSize, restoreSize, splitInstruction, taskName } from '../hooks/dock-logic'

const PLUGIN = 'ai-employee-kit'
const PROGRESS = 'mcp__ai-employee-kit__report_progress'
const JOB_PROMPT = 'Research bakery pricing for the five biggest chains, then write a summary'

const paneAt = (bodyColumns: number) =>
  ({
    plugin: PLUGIN,
    component: 'Pane',
    requestId: 'agent-dock',
    props: { title: 'Agent Dock', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  }) as const

const pause = (ms: number) =>
  new Promise<void>(resolve => {
    const t = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
    if (t) t(resolve, ms)
    else void Promise.resolve().then(resolve)
  })

async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await pause(10)
  }
  throw new Error(`never happened: ${what}`)
}

type World = {
  submitted: { text: string; context?: readonly string[]; origin: unknown }[]
  open: Set<string>
  status: unknown[]
  toasts: unknown[]
  gates: Map<string, () => void>
  holdAgents: boolean
  /** Held calls asleep in /bin/sleep; `wake` lets each look for a free slot once. */
  sleepers: (() => void)[]
  wake: () => void
}

/** Stands in for the engine beneath the mod. */
function world(on: On, stored: Record<string, unknown> = {}, env: Record<string, string> = {}): World {
  const w: World = {
    submitted: [], open: new Set(), status: [], toasts: [], gates: new Map(), holdAgents: false, sleepers: [],
    wake: () => {
      const all = w.sleepers.splice(0)
      for (const fn of all) fn()
    },
  }
  // Clean View's plan-first rule is tested in its own file; these helpers run without it.
  mock.store(on, { cleanViewEnabled: false, ...stored })
  mock.clock(on, { now: Date.UTC(2026, 10, 2, 12, 0) })
  mock.env(on, { HOME: '/home/tester', ...env })
  on('command.register', () => ({ value: { command: 'dock' } }))
  on('tool.register', () => ({ value: { tool: PROGRESS } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 's1' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => new Promise(resolve => w.sleepers.push(() => resolve({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))))
  on('ui.open', (_, e) => {
    w.open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    w.open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...w.open].map(id => ({ id, title: 'Agent Dock', isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.status', (_, e) => {
    w.status.push(e)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e)
    return { value: undefined }
  })
  on('prompt.submit', (_, e) => {
    w.submitted.push({ text: e.text, context: e.context, origin: e.origin })
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    if (!w.holdAgents) return { result: { status: 'completed' } }
    const key = String((e as unknown as { description: string }).description)
    return new Promise(resolve => w.gates.set(key, () => resolve({ result: { status: 'completed' } })))
  })
  return w
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never
const command = (args: string) =>
  ({ command: 'dock', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as never
const agent = (description: string) => ({ tool: 'Agent', description, prompt: `Do: ${description}` }) as never
const finishTurn = (turnId: string) =>
  ({ answer: 'done', durationMs: 1000, isAborted: false, turnId, reason: 'answer' }) as never

async function textOf(ui: { findAll: (q: { type?: string }) => Promise<{ text?: string }[]> }): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')
}

async function setSize($: any, n: number, w: World) {
  await $.command.run(command(String(n)))
  if (n > 20) {
    const ui = await $.ui.mount({ ...paneAt(90), surface: 'terminal' })
    await until(async () => (await ui.find({ key: 'big-continue' })) !== undefined, 'the big team box')
    await ui.press({ key: 'big-continue' })
    await ui.unmount()
  }
  await pause(20)
  void w
}

// ---------------------------------------------------------------------------
// 1. parseSize (and the other pure helpers)
// ---------------------------------------------------------------------------

describe('dock logic', () => {
  test('parseSize', () => {
    expect(parseSize('10')).toBe(10)
    expect(parseSize(' 25 ')).toBe(25)
    expect(parseSize('0')).toBeNull()
    expect(parseSize('101')).toBeNull()
    expect(parseSize('abc')).toBeNull()
    expect(parseSize('2.5')).toBeNull()
  })

  test('names, badge and clock', () => {
    expect(jobName(JOB_PROMPT)).toBe('Research bakery pricing for the five')
    expect(taskName('Price check: Panera Bread cafe locations today', 0)).toBe('Price check: Panera Bread cafe')
    expect(initials('Price check: Panera')).toBe('PA')
    expect(initials('Crumbl Bakery')).toBe('CB')
    expect(badge({ working: 12, queued: 8, done: 30, stuck: 0 })).toBe('12 working · 8 queued · 30 done')
    expect(clock(72_000)).toBe('1:12')
    expect(duration(134_000)).toBe('2m 14s')
    expect(splitInstruction(5, PROGRESS)).toContain('exactly 5')
  })
})

// ---------------------------------------------------------------------------
// 2. Sizes above 20 do not carry over
// ---------------------------------------------------------------------------

test('a saved size of 50 comes back as 1; 10 stays 10', async ($, on) => {
  expect(restoreSize(50)).toBe(1)
  expect(restoreSize(10)).toBe(10)
  world(on, { size: 50 })
  await start($)
  const ui = await $.ui.mount({ ...paneAt(90), surface: 'terminal' })
  expect(await textOf(ui)).toContain('Claude decides how many helpers')
  await ui.unmount()
})

test('a saved size of 10 stays 10', async ($, on) => {
  world(on, { size: 10 })
  await start($)
  const ui = await $.ui.mount({ ...paneAt(90), surface: 'terminal' })
  expect(await textOf(ui)).toContain('Splits each request across 10 helpers')
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// 3. The instruction
// ---------------------------------------------------------------------------

test('at size 5 a request carries the exactly-5 instruction; at size 1 nothing', async ($, on) => {
  const w = world(on, { size: 5 })
  await start($)
  await $.prompt.submit(typed(JOB_PROMPT))
  expect(w.submitted[0]!.context?.join('\n')).toContain('exactly 5 independent pieces')

  await $.command.run(command('1'))
  await until(() => true, 'size set')
  await pause(20)
  await $.prompt.submit(typed('Another request about something else entirely'))
  expect(w.submitted[1]!.context).toBeUndefined()
})

// ---------------------------------------------------------------------------
// 4. The cap
// ---------------------------------------------------------------------------

test('the 6th Agent call at size 5 is denied with the Team Size message', async ($, on) => {
  world(on, { size: 5 })
  await start($)
  await $.prompt.submit(typed(JOB_PROMPT))
  for (let i = 1; i <= 5; i++) {
    const r = await $.tool.call(agent(`Price check: Store ${i}`))
    expect(r.deny).toBeUndefined()
  }
  const sixth = await $.tool.call(agent('Price check: Store 6'))
  expect(String(sixth.deny ?? sixth.text)).toContain('Team Size is 5: this request already has 5 helpers. Finish with the helpers you have.')
})

// ---------------------------------------------------------------------------
// 5. The nudge
// ---------------------------------------------------------------------------

test('a request that used 3 of 10 gets exactly one nudge', async ($, on) => {
  const w = world(on, { size: 10 })
  await start($)
  await $.prompt.submit(typed(JOB_PROMPT))
  await $.turn.start({ text: JOB_PROMPT, turnId: 't1' })
  for (const s of ['Panera', 'Crumbl', 'Paris Baguette']) await $.tool.call(agent(`Price check: ${s}`))
  await $.turn.complete(finishTurn('t1'))
  await until(() => w.submitted.some(s => s.text.startsWith('You used 3 of 10')), 'the nudge')

  await $.turn.start({ text: '', turnId: 't2' })
  await $.turn.complete(finishTurn('t2'))
  await pause(30)
  const nudges = w.submitted.filter(s => s.text.startsWith('You used'))
  expect(nudges).toHaveLength(1)
  expect(nudges[0]!.text).toBe('You used 3 of 10 helpers. Split the remaining work across the other 7, one helper per piece, all in parallel.')
  // The nudge itself carries no second split instruction.
  expect(w.submitted[w.submitted.length - 1]!.context).toBeUndefined()
})

// ---------------------------------------------------------------------------
// 6 and 7. Cards from queued to working to done, progress, and the summary
// ---------------------------------------------------------------------------

test('three helpers: queued, working with progress, done, then the summary', async ($, on) => {
  const w = world(on, { size: 3 })
  w.holdAgents = true
  await start($)
  await $.prompt.submit(typed(JOB_PROMPT))
  await $.turn.start({ text: JOB_PROMPT, turnId: 't1' })
  const names = ['Price check: Panera', 'Price check: Crumbl', 'Price check: Insomnia']

  // Claude writes the three Agent calls: queued cards appear before any call runs.
  await $.session.append({
    message: {
      type: 'assistant',
      role: 'assistant',
      content: names.map((n, i) => ({ type: 'tool_use', id: `toolu_${i}`, name: 'Agent', input: { description: n, prompt: `Do: ${n}` } })),
    },
    door: 'response',
    origin: { kind: 'model', model: 'claude-opus-5-5' },
    uuid: 'row-1',
  } as never)

  const ui = await $.ui.mount({ ...paneAt(100), surface: 'terminal' })
  let all = await textOf(ui)
  expect(all).toContain('○ 3 queued')
  for (const n of names) expect(all).toContain(n)

  // The calls start: working.
  const calls = names.map(n => $.tool.call(agent(n)))
  await until(async () => (await textOf(ui)).includes('● 3 working'), 'three working')
  expect((await ui.findAll({ type: 'Box' })).filter(b => (b.key ?? '').startsWith('card-'))).toHaveLength(3)

  // A helper reports 60%.
  const noted = await $.tool.call({ tool: PROGRESS, task: 'Price check: Panera', percent: 60, agentId: 'agent-1' } as never)
  expect(String(noted.text ?? JSON.stringify(noted.result))).toContain('Progress noted: 60%.')
  await until(async () => (await textOf(ui)).includes(' 60%'), 'the 60% meter')

  // They return: done, and the summary once the turn ends.
  for (const n of names) w.gates.get(n)?.()
  await Promise.all(calls)
  await $.turn.complete(finishTurn('t1'))
  await until(async () => (await textOf(ui)).includes('3 agents finished'), 'the summary')
  all = await textOf(ui)
  expect(all).toContain('✓ 3 done')
  expect(all).toMatch(/3 agents finished Research bakery pricing for the five in \d/)
  expect(all).toContain('C O M P L E T E')
  await ui.unmount()
})

// ---------------------------------------------------------------------------
// 8. Fold and back
// ---------------------------------------------------------------------------

test('/dock folds the pane to the badge and back', async ($, on) => {
  const w = world(on, { size: 3 })
  await start($)
  const answer = await $.command.run(command(''))
  expect(answer.text).toBeTruthy()
  await until(() => w.open.has('agent-dock'), 'the pane opens')

  await $.command.run(command(''))
  await until(() => !w.open.has('agent-dock'), 'the pane folds')
  expect(JSON.stringify(w.status[w.status.length - 1])).toContain('Agent Dock · team of 3')

  await $.command.run(command(''))
  await until(() => w.open.has('agent-dock'), 'the pane reopens')
  const last = w.status[w.status.length - 1] as { text?: unknown } | undefined
  expect(last === undefined || last.text === undefined).toBe(true)
})

// ---------------------------------------------------------------------------
// Sizes, widths and the big team
// ---------------------------------------------------------------------------

test('a bad size answers plainly, and above 20 asks to confirm', async ($, on) => {
  const w = world(on)
  await start($)
  expect((await $.command.run(command('abc'))).text).toBe('Team Size is a whole number from 1 to 100, e.g. /dock 10.')
  expect((await $.command.run(command('50'))).text).toBe('Confirm the team of 50 in the Agent Dock.')
  await setSize($, 50, w)
  const ui = await $.ui.mount({ ...paneAt(90), surface: 'terminal' })
  expect(await textOf(ui)).toContain('Splits each request across 50 helpers')
  await ui.unmount()
})

test('50 helpers draw as tiles, and every row fits narrow and wide', async ($, on) => {
  const w = world(on, { size: 20 })
  w.holdAgents = true
  await start($)
  await $.prompt.submit(typed(JOB_PROMPT))
  const blocks = Array.from({ length: 20 }, (_, i) => ({ type: 'tool_use', id: `toolu_${i}`, name: 'Agent', input: { description: `Price check: Store ${i + 1}` } }))
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: blocks }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'row-2' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const width of [30, 60, 120]) {
      const ui = await $.ui.mount({ ...paneAt(width), surface })
      const tiles = (await ui.findAll({ type: 'Box' })).filter(b => (b.key ?? '').startsWith('tile-'))
      expect(tiles).toHaveLength(20)
      for (const t of (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '')) expect(t.length).toBeLessThanOrEqual(width)
      await ui.unmount()
    }
  }
  // Idle at both widths too.
  void w
})

test('a team of 50 runs 20 at a time and the rest wait their turn', async ($, on) => {
  const w = world(on, {}, { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '20', CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: '20' })
  w.holdAgents = true
  await start($)
  await setSize($, 50, w)
  await $.prompt.submit(typed(JOB_PROMPT))
  await $.turn.start({ text: JOB_PROMPT, turnId: 't1' })
  const names = Array.from({ length: 50 }, (_, i) => `Price check: Store ${i + 1}`)
  const calls = names.map(n => $.tool.call(agent(n)))
  const ui = await $.ui.mount({ ...paneAt(90), surface: 'terminal' })
  await until(async () => (await textOf(ui)).includes('● 20 working'), '20 working')
  expect(await textOf(ui)).toContain('○ 30 queued')
  expect((await ui.findAll({ type: 'Box' })).filter(b => (b.key ?? '').startsWith('tile-'))).toHaveLength(50)

  // One returns: the next in line starts.
  w.gates.get(names[0]!)?.()
  await until(async () => {
    w.wake()
    return (await textOf(ui)).includes('○ 29 queued')
  }, 'the next helper starts')
  expect(await textOf(ui)).toContain('● 20 working')

  for (let i = 0; i < 300; i++) {
    for (const n of names) w.gates.get(n)?.()
    w.wake()
    if ((await textOf(ui)).includes('✓ 50 done')) break
    await pause(10)
  }
  await Promise.all(calls)
  await $.turn.complete(finishTurn('t1'))
  await until(async () => (await textOf(ui)).includes('50 agents finished'), 'the summary')
  await ui.unmount()
})

test('cards fit narrow and wide', async ($, on) => {
  const w = world(on, { size: 5 })
  w.holdAgents = true
  await start($)
  await $.prompt.submit(typed(JOB_PROMPT))
  await $.turn.start({ text: JOB_PROMPT, turnId: 't1' })
  const names = ['Price check: Panera', 'Price check: Crumbl', 'Price check: Insomnia Cookies', 'Price check: Tim Hortons', 'Price check: Dunkin']
  const calls = names.map(n => $.tool.call(agent(n)))
  for (const width of [30, 64, 120]) {
    const ui = await $.ui.mount({ ...paneAt(width), surface: 'terminal' })
    await until(async () => (await textOf(ui)).includes('5 working') || (await textOf(ui)).includes('●5'), 'five working')
    expect((await ui.findAll({ type: 'Box' })).filter(b => (b.key ?? '').startsWith('card-'))).toHaveLength(5)
    for (const t of (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '')) expect(t.length).toBeLessThanOrEqual(width)
    await ui.unmount()
  }
  for (const n of names) w.gates.get(n)?.()
  await Promise.all(calls)
})

test('the ◆ Dock button sits beside what the footer already shows', async ($, on) => {
  const w = world(on)
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>{e.props.modes.join(' & ')}</Text>
  })
  await start($)
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'SessionMode', props: { modes: ['focus'] } })
  expect((await textOf(ui))).toContain('focus')
  expect((await textOf(ui))).toContain('◆ Dock')
  await ui.press({ key: 'open-agent-dock' })
  expect(w.open.has('agent-dock')).toBe(true)
  await ui.unmount()
})
