import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'employee-control-panel'
const PANE_ID = 'control-tools'

const STATUS_BAR = { plugin: PLUGIN, component: 'SessionMode', props: { modes: [] } } as const
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: PANE_ID,
  props: {
    title: 'Control Tools',
    isFocused: true,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const IDS: Record<string, string> = {
  fable: 'claude-fable-5-2',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

type World = {
  clock: ReturnType<typeof mock.clock>
  model: string
  root: string
  /** Aliases /model refuses, as an account without access would. */
  refused: string[]
  /** A reply is running: a command waits until the test ends it. */
  isReplying: boolean
  runs: { command: string; args: string }[]
  opens: any[]
  closes: string[]
  spawns: any[]
  calls: any[]
  stored: Record<string, unknown>
}

function world(on: any, opts: { model?: string; root?: string; stored?: Record<string, unknown> } = {}): World {
  const w: World = {
    clock: mock.clock(on, { now: 1_000_000 }),
    model: opts.model ?? IDS.opus!,
    root: opts.root ?? '/work/app',
    refused: [],
    isReplying: false,
    runs: [],
    opens: [],
    closes: [],
    spawns: [],
    calls: [],
    stored: opts.stored ?? {},
  }
  mock.store(on, w.stored)
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'controls' } }))
  on('session.model', () => ({ value: w.model }))
  on('session.root', () => ({ value: w.root }))
  on('turn.start', (_: unknown, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.run', async (_: unknown, e: any) => {
    w.runs.push({ command: e.command, args: e.args })
    // A command picked mid-reply runs once the reply ends.
    while (w.isReplying) await w.clock.sleep(100)
    if (e.command === 'model') {
      if (w.refused.includes(e.args)) return { text: `Model '${e.args}' is not available on this account.` }
      w.model = IDS[e.args] ?? w.model

      return { text: `Set model to ${e.args}` }
    }
    if (e.command === 'effort') return { text: `Set effort level to ${e.args}` }

    return { text: '' }
  })
  on('ui.open', (_: unknown, e: any) => {
    w.opens.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: unknown, e: any) => {
    w.closes.push(e.id)

    return { value: undefined }
  })
  on('agent.spawn', (_: unknown, e: any) => {
    w.spawns.push(e)

    return { model: e.model ?? 'inherit' }
  })
  on('tool.call', (_: unknown, e: any) => {
    w.calls.push(e)

    return { result: {} }
  })

  return w
}

async function start($: any) {
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
}

async function openPanel($: any, w: World) {
  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  await bar.press({ key: 'open-controls' })
  await w.clock.settle()
  await bar.unmount()

  return $.ui.mount({ ...PANE, surface: 'terminal' } as any)
}

/** Whether the footer row's text, every piece joined, matches `re`. */
async function barHas($: any, re: RegExp): Promise<boolean> {
  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  const texts = (await bar.findAll({ type: 'Text' })).map((t: any) => t.text ?? '').join(' ')
  await bar.unmount()

  return re.test(texts)
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`[${surface}] the status bar button opens a panel with model and effort for main and subagents`, async ($, on) => {
    const w = world(on)
    await start($)
    const bar = await $.ui.mount({ ...STATUS_BAR, surface } as any)
    expect(await bar.find({ type: 'Text', text: /Control Tools/ })).toBeTruthy()
    await bar.press({ key: 'open-controls' })
    await w.clock.settle()
    await bar.unmount()
    expect(w.opens.some(o => o.id === PANE_ID && o.focus === true && o.closeOnEscape === true)).toBe(true)

    const ui = await $.ui.mount({ ...PANE, surface } as any)
    for (const key of ['main-model#fable', 'main-model#opus', 'main-model#sonnet', 'main-model#haiku']) {
      expect(await ui.find({ type: 'Button', key })).toBeTruthy()
    }
    for (const key of ['main-effort#low', 'main-effort#medium', 'main-effort#high', 'main-effort#xhigh', 'main-effort#max']) {
      expect(await ui.find({ type: 'Button', key })).toBeTruthy()
    }
    expect(await ui.find({ type: 'Button', key: 'sub-model#' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'sub-effort#' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Main: Opus 5\.5/ })).toBeTruthy()
    await ui.unmount()
  })
}

test('picking a model runs /model, keeps the panel open and shows it applied', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPanel($, w)

  await ui.press({ key: 'main-model#sonnet' })
  await w.clock.settle()
  expect(w.runs).toContainEqual({ command: 'model', args: 'sonnet' })
  expect(w.model).toBe(IDS.sonnet)
  expect(await ui.find({ type: 'Text', text: /Main: Sonnet 5\.5/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /applied/ })).toBeTruthy()
  expect(w.closes).not.toContain(PANE_ID)
  expect(await barHas($, /Sonnet 5\.5/)).toBe(true)
  await ui.unmount()
})

test('picking an effort runs /effort and the status shows it', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPanel($, w)

  await ui.press({ key: 'main-effort#xhigh' })
  await w.clock.settle()
  expect(w.runs).toContainEqual({ command: 'effort', args: 'xhigh' })
  expect(await ui.find({ type: 'Text', text: /effort xhigh/ })).toBeTruthy()
  expect(await barHas($, /effort\s+xhigh/)).toBe(true)
  await ui.unmount()
})

test('a /model or /effort typed by hand shows up live', async ($, on) => {
  const w = world(on)
  await start($)
  expect(await barHas($, /effort\s+low/)).toBe(false)

  await $.command.run({ command: 'effort', args: 'low' } as never)
  await $.command.run({ command: 'model', args: 'haiku' } as never)
  await w.clock.settle()
  expect(await barHas($, /Haiku 5\.5/)).toBe(true)
  // The effort was set on Opus, and Haiku has none recorded yet.
  await $.command.run({ command: 'effort', args: 'medium' } as never)
  expect(await barHas($, /effort\s+medium/)).toBe(true)
})

test('a pick made while Claude is replying shows pending, then applies when the reply ends', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPanel($, w)

  await $.turn.start({ text: 'go', turnId: 't1' })
  w.isReplying = true
  await ui.press({ key: 'main-model#haiku' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Text', text: /applies when Claude finishes/ })).toBeTruthy()
  expect(w.model).toBe(IDS.opus)

  // A newer pick before the reply ends replaces the queued one.
  await ui.press({ key: 'main-model#sonnet' })
  w.isReplying = false
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await w.clock.advance(1_000)
  expect(w.model).toBe(IDS.sonnet)
  expect(await ui.find({ type: 'Text', text: /Main: Sonnet 5\.5/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /applies when Claude finishes/ })).toBeFalsy()
  await ui.unmount()
})

test('a model the account cannot use shows why in the status line', async ($, on) => {
  const w = world(on)
  w.refused = ['fable']
  await start($)
  const ui = await openPanel($, w)

  await ui.press({ key: 'main-model#fable' })
  await w.clock.settle()
  expect(w.model).toBe(IDS.opus)
  expect(await ui.find({ type: 'Text', text: /not available on this account/ })).toBeTruthy()
  await ui.unmount()
})

test('a subagent model pick overrides every subagent but a fork; Auto leaves them alone', async ($, on) => {
  const w = world(on)
  await start($)

  await $.agent.spawn({ prompt: 'a', subagentType: 'general-purpose' } as never)
  expect(w.spawns.at(-1)!.model).toBeUndefined()

  const ui = await openPanel($, w)
  await ui.press({ key: 'sub-model#haiku' })
  await $.agent.spawn({ prompt: 'b', subagentType: 'Explore', model: 'opus' } as never)
  expect(w.spawns.at(-1)!.model).toBe('haiku')
  await $.agent.spawn({ prompt: 'c', subagentType: 'fork' } as never)
  expect(w.spawns.at(-1)!.model).toBeUndefined()

  await ui.press({ key: 'sub-model#' })
  await $.agent.spawn({ prompt: 'd', subagentType: 'Explore', model: 'opus' } as never)
  expect(w.spawns.at(-1)!.model).toBe('opus')
  await ui.unmount()
})

test('a subagent effort pick is set on every Agent call but a fork', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPanel($, w)

  await ui.press({ key: 'sub-effort#low' })
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'general-purpose', effort: 'max' } as never)
  expect(w.calls.at(-1)!.effort).toBe('low')
  await $.tool.call({ tool: 'Agent', description: 'd', prompt: 'p', subagent_type: 'fork' } as never)
  expect(w.calls.at(-1)!.effort).toBeUndefined()
  expect(await barHas($, /sub\s+low/)).toBe(true)
  await ui.unmount()
})

test('subagent picks are remembered per project', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPanel($, w)
  await ui.press({ key: 'sub-model#sonnet' })
  await ui.press({ key: 'sub-effort#high' })
  await ui.unmount()

  // A new session in another project starts on Auto.
  w.root = '/work/other'
  await start($)
  await $.agent.spawn({ prompt: 'x', subagentType: 'Explore' } as never)
  expect(w.spawns.at(-1)!.model).toBeUndefined()

  // Back in the first project, its picks are back.
  w.root = '/work/app'
  await start($)
  await $.agent.spawn({ prompt: 'y', subagentType: 'Explore' } as never)
  expect(w.spawns.at(-1)!.model).toBe('sonnet')
  expect(await barHas($, /sub\s+Sonnet\/high/)).toBe(true)
})

test('Close shuts the panel, and the button opens it again', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPanel($, w)
  await ui.press({ key: 'close' })
  expect(w.closes).toContain(PANE_ID)
  await ui.unmount()

  await openPanel($, w)
  expect(w.opens.filter(o => o.id === PANE_ID).length).toBe(2)
})

test('/controls opens the panel', async ($, on) => {
  const w = world(on)
  await start($)
  await $.command.run({ command: 'controls', args: '' } as never)
  expect(w.opens.some(o => o.id === PANE_ID)).toBe(true)
})

test('the footer shows the live session bar: plan, context, 5h usage and agents', async ($, on) => {
  const w = world(on)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200_000, tokens: 36_000, percent: 18 }, rateLimits: [{ kind: 'five_hour', percentUsed: 6 }] },
  }))
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'x', type: 'Explore', status: 'running' }] }))
  await start($)
  await $.command.run({ command: 'effort', args: 'high' } as never)
  await w.clock.settle()

  expect(await barHas($, /◆ Subscription/)).toBe(true)
  expect(await barHas($, /Opus 5\.5/)).toBe(true)
  expect(await barHas($, /effort\s+high/)).toBe(true)
  expect(await barHas($, /ctx\s+▰▰▱▱▱▱▱▱▱▱\s+18%/)).toBe(true)
  expect(await barHas($, /5h\s+6%/)).toBe(true)
  expect(await barHas($, /◆ 1 agent\b/)).toBe(true)
  expect(await barHas($, /◆ Control Tools ∧/)).toBe(true)
})

test('the panel shows the video layout: spaced title, current pick, full model names', async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await openPanel($, w)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text ?? '').join(' ')
  expect(texts).toMatch(/◆ C O N T R O L {3}T O O L S/)
  expect(texts).toMatch(/Opus 5\.5 · Default/)
  for (const name of ['Haiku 5.5', 'Sonnet 5.5', 'Opus 5.5', 'Fable 5.2', 'XHigh']) expect(texts).toContain(name)
  await ui.unmount()
})

test('the bar carries everything ccstatusline showed', async ($, on) => {
  const w = world(on)
  const now = 1_000_000
  on('session.usage', () => ({
    value: {
      startedAt: now - (65 * 60_000),
      context: { window: 200_000, tokens: 36_400, percent: 18 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 6, resetsAt: new Date(now + 170 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 41 },
      ],
    },
  }))
  on('session.cwd', () => ({ value: '/Users/me/projects/my app' }))
  const ran = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
  on('process.run', (_: unknown, e: any) => {
    const args = e.argv.join(' ')
    if (args.includes('rev-parse')) return ran(0, 'feature/bar\n')
    if (args.includes('--shortstat')) return ran(0, ' 3 files changed, 12 insertions(+), 4 deletions(-)\n')

    return ran(1, '')
  })
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({
    answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer',
    usage: { input_tokens: 1200, output_tokens: 3400, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 20_000, model: IDS.opus },
  } as never)
  await w.clock.settle()

  // Line 1: model, effort, context % and bar, context length.
  expect(await barHas($, /Opus 5\.5/)).toBe(true)
  expect(await barHas($, /effort/)).toBe(true)
  expect(await barHas($, /ctx\s+▰▰▱▱▱▱▱▱▱▱\s+18%\s+·?\s*36\.4k/)).toBe(true)
  // Line 2: 5h usage, block timer (2h 10m into the window), weekly usage, session clock.
  expect(await barHas($, /5h\s+6%/)).toBe(true)
  expect(await barHas($, /block\s+2h 10m/)).toBe(true)
  expect(await barHas($, /week\s+41%/)).toBe(true)
  expect(await barHas($, /session\s+1h 05m/)).toBe(true)
  // Line 3: folder, branch and changes, tokens, output style.
  expect(await barHas($, /my app/)).toBe(true)
  expect(await barHas($, /feature\/bar\s+\+12\s+−4/)).toBe(true)
  expect(await barHas($, /in\s+1\.2k/)).toBe(true)
  expect(await barHas($, /out\s+3\.4k/)).toBe(true)
  expect(await barHas($, /cached\s+120k/)).toBe(true)
  expect(await barHas($, /total\s+125k/)).toBe(true)
  expect(await barHas($, /style\s+default/)).toBe(true)
})
