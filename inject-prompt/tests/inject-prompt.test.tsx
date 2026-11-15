import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'inject-prompt'
const HOME = '/home/me'
const FILE = `${HOME}/.claude/inject-prompts.json`

const STATUS_BAR = { plugin: PLUGIN, component: 'SessionMode', props: { modes: [] } } as const
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: PLUGIN,
  props: {
    title: 'Inject prompt',
    isFocused: true,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const SAVED = {
  prompts: [
    { id: 'hello', title: 'Say hello', category: 'Basics', tags: ['greet'], text: 'Hello there.' },
    { id: 'bye', title: 'Say goodbye', category: 'Basics', tags: ['greet', 'end'], text: 'Goodbye now.' },
    { id: 'explain', title: 'Explain a file', category: 'Understand', tags: ['explain'], text: 'Explain {{file}} for {{who}}.' },
  ],
}

type World = {
  clock: ReturnType<typeof mock.clock>
  files: Record<string, string>
  fills: { text: string; cursor?: number }[]
  opens: any[]
  closes: string[]
  /** The prompt box as it stands: fills write it, reads return it. */
  box: { text: string; cursor: number }
  /** How many of the next fills the box refuses, as it does while a dialog holds the keys. */
  refuse: number
}

function world(on: any, box = { text: '', cursor: 0 }, files: Record<string, string> = { [FILE]: JSON.stringify(SAVED) }): World {
  const w: World = { clock: mock.clock(on, { now: 1_000_000 }), files, fills: [], opens: [], closes: [], box, refuse: 0 }
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'inject' } }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_: unknown, e: any) => ({ value: e.path in w.files }))
  on('fs.read', (_: unknown, e: any) => {
    if (!(e.path in w.files)) throw new Error('missing')

    return { value: w.files[e.path] }
  })
  on('fs.write', (_: unknown, e: any) => {
    w.files[e.path] = e.text

    return { value: undefined }
  })
  on('prompt.read', () => ({ value: w.box }))
  on('prompt.fill', (_: unknown, e: any) => {
    if (w.refuse > 0) {
      w.refuse--

      return { isFilled: false, refusal: 'dialog' }
    }
    w.fills.push({ text: e.text, cursor: e.cursor })
    w.box = { text: e.text, cursor: e.cursor ?? e.text.length }

    return { isFilled: true }
  })
  on('ui.open', (_: unknown, e: any) => {
    w.opens.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: unknown, e: any) => {
    w.closes.push(e.id)

    return { value: undefined }
  })

  return w
}

async function start($: any) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

/** Presses the status-bar button and lets the dialog open. */
async function openFromBar($: any, w: World) {
  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' })
  await bar.press({ key: 'open-inject' })
  await w.clock.settle()
  await bar.unmount()
}

test('the status bar has an Inject button that opens the dialog', async ($, on) => {
  const w = world(on)
  await start($)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  expect(await bar.find({ type: 'Text', text: /^» Inject$/ })).toBeTruthy()
  await bar.press({ key: 'open-inject' })
  await w.clock.settle()
  expect(w.opens.some(o => o.id === PLUGIN && o.focus === true && o.closeOnEscape === true)).toBe(true)
  await bar.unmount()
})

test('with no prompts file yet, one is created with starter prompts', async ($, on) => {
  const w = world(on, { text: '', cursor: 0 }, {})
  await start($)
  await openFromBar($, w)

  expect(FILE in w.files).toBe(true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  // Categories sort A to Z: Debug comes first.
  expect(await ui.find({ type: 'Button', key: 'row#bug-root-cause' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^DEBUG/ })).toBeTruthy()
  await ui.unmount()
})

test('prompts are grouped by category, and filter by category, tag and search', async ($, on) => {
  const w = world(on)
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  expect(await ui.find({ type: 'Text', text: /^BASICS/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^UNDERSTAND/ })).toBeTruthy()

  await ui.press({ key: 'cat#Understand' })
  expect(await ui.find({ type: 'Button', key: 'row#hello' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'row#explain' })).toBeTruthy()

  await ui.press({ key: 'cat#' })
  await ui.press({ key: 'tag#end' })
  expect(await ui.find({ type: 'Button', key: 'row#hello' })).toBeFalsy()
  expect(await ui.find({ type: 'Button', key: 'row#bye' })).toBeTruthy()

  await ui.press({ key: 'tag#' })
  await ui.input({ key: 'search', text: 'hello', kind: 'change' })
  expect(await ui.find({ type: 'Button', key: 'row#hello' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'row#bye' })).toBeFalsy()
  await ui.unmount()
})

test('a prompt expands to show its full text, and collapses again', async ($, on) => {
  const w = world(on)
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  expect(await ui.find({ type: 'Text', text: /^ ▸ $/ })).toBeTruthy()
  await ui.press({ key: 'exp#hello' })
  expect(await ui.find({ type: 'Text', text: /^ ▾ $/ })).toBeTruthy()
  await ui.press({ key: 'exp#hello' })
  expect(await ui.find({ type: 'Text', text: /^ ▾ $/ })).toBeFalsy()

  // Enter on a prompt with nothing ticked unfolds it too.
  await ui.press({ key: 'row#hello' })
  expect(await ui.find({ type: 'Text', text: /^ ▾ $/ })).toBeTruthy()
  await ui.unmount()
})

test('Inject puts the prompt where the cursor was, around the draft', async ($, on) => {
  const w = world(on, { text: 'Start. End.', cursor: 7 })
  await start($)
  await openFromBar($, w)

  // The draft was set aside so the dialog could take the keyboard.
  expect(w.fills[0]).toEqual({ text: '', cursor: undefined })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'sel#hello' })
  await ui.press({ key: 'inject' })

  const last = w.fills[w.fills.length - 1]!
  expect(last.text).toBe('Start. Hello there.End.')
  expect(last.cursor).toBe('Start. Hello there.'.length)
  expect(w.closes).toContain(PLUGIN)
  await ui.unmount()
})

test('several ticked prompts go in tick order, a blank line apart', async ($, on) => {
  const w = world(on)
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  await ui.press({ key: 'sel#bye' })
  await ui.press({ key: 'sel#hello' })
  expect(await ui.find({ type: 'Button', key: 'inject', label: 'Inject 2' } as any)).toBeTruthy()
  await ui.press({ key: 'inject' })

  expect(w.fills[w.fills.length - 1]!.text).toBe('Goodbye now.\n\nHello there.')
  await ui.unmount()
})

test('placeholders are asked for one by one, then filled in', async ($, on) => {
  const w = world(on)
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  await ui.press({ key: 'sel#explain' })
  await ui.press({ key: 'inject' })
  expect(await ui.find({ type: 'Text', text: /value 1 of 2/ })).toBeTruthy()
  await ui.input({ key: 'value-0', text: 'src/app.ts' })
  expect(await ui.find({ type: 'Text', text: /value 2 of 2/ })).toBeTruthy()
  await ui.input({ key: 'value-1', text: 'a new teammate' })

  expect(w.fills[w.fills.length - 1]!.text).toBe('Explain src/app.ts for a new teammate.')
  await ui.unmount()
})

test('closing without injecting puts the draft back untouched', async ($, on) => {
  const w = world(on, { text: 'my draft', cursor: 2 })
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  await ui.press({ key: 'close' })
  const last = w.fills[w.fills.length - 1]!
  expect(last).toEqual({ text: 'my draft', cursor: 2 })
  expect(w.closes).toContain(PLUGIN)
  await ui.unmount()
})

test('Add saves a new prompt to the file, starting from the draft', async ($, on) => {
  const w = world(on, { text: 'Check the {{service}} logs', cursor: 0 })
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  await ui.press({ key: 'add' })
  await ui.input({ key: 'add-title', text: 'Check logs', kind: 'change' })
  await ui.input({ key: 'add-category', text: 'Ops', kind: 'change' })
  await ui.input({ key: 'add-tags', text: 'logs, ops', kind: 'change' })
  await ui.press({ key: 'add-save' })

  const saved = JSON.parse(w.files[FILE]!)
  const entry = saved.prompts.find((p: any) => p.title === 'Check logs')
  expect(entry).toEqual({ id: 'check-logs', title: 'Check logs', category: 'Ops', tags: ['logs', 'ops'], text: 'Check the {{service}} logs' })
  expect(await ui.find({ type: 'Button', key: 'row#check-logs' })).toBeTruthy()
  await ui.unmount()
})

test('a prompts file that does not parse is left alone, and says why', async ($, on) => {
  const w = world(on, { text: '', cursor: 0 }, { [FILE]: '{ not json' })
  await start($)
  await openFromBar($, w)

  expect(w.files[FILE]).toBe('{ not json')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /Could not read/ })).toBeTruthy()
  await ui.unmount()
})

test('Enter on a prompt injects what is ticked', async ($, on) => {
  const w = world(on)
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  await ui.press({ key: 'sel#bye' })
  await ui.press({ key: 'row#hello' })

  expect(w.fills[w.fills.length - 1]!.text).toBe('Goodbye now.')
  expect(w.closes).toContain(PLUGIN)
  await ui.unmount()
})

test('the action buttons stay drawn when the list is longer than the dialog', async ($, on) => {
  const many = { prompts: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, title: `Prompt ${i}`, category: 'Lots', tags: [], text: `Text ${i}` })) }
  const w = world(on, { text: '', cursor: 0 }, { [FILE]: JSON.stringify(many) })
  await start($)
  await openFromBar($, w)
  const short = { ...PANE, props: { ...PANE.props, scroll: { offset: 1, bodyRows: 24 } } }
  const ui = await $.ui.mount({ ...short, surface: 'terminal' } as any)

  for (const key of ['inject', 'add', 'clear', 'close']) expect(await ui.find({ type: 'Button', key })).toBeTruthy()
  // Only a window of the list is drawn, with a mark for the rest.
  expect(await ui.find({ type: 'Button', key: 'row#p0' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'row#p39' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /↓ \d+ more lines/ })).toBeTruthy()

  // j moves down; the window follows the highlight.
  for (let i = 0; i < 20; i++) await ui.press({ key: 'down' })
  expect(await ui.find({ type: 'Button', key: 'row#p20' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'row#p0' })).toBeFalsy()
  expect(await ui.find({ type: 'Text', text: /↑ \d+ more lines/ })).toBeTruthy()
  await ui.unmount()
})

test('a placeholder with a default offers it, and every use of the name is filled', async ($, on) => {
  const withDefault = {
    prompts: [{ id: 'plan', title: 'Plan', category: 'Planning', tags: [], text: 'Save to {{dir|PLAN_v4}}/PLAN.md and link phases from {{dir}}/PLAN.md for {{goal}}.' }],
  }
  const w = world(on, { text: '', cursor: 0 }, { [FILE]: JSON.stringify(withDefault) })
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  await ui.press({ key: 'sel#plan' })
  await ui.press({ key: 'inject' })
  expect(await ui.find({ type: 'Button', key: 'fill-default' })).toBeTruthy()
  await ui.press({ key: 'fill-default' })
  await ui.input({ key: 'value-1', text: 'the login refactor' })

  expect(w.fills[w.fills.length - 1]!.text).toBe('Save to PLAN_v4/PLAN.md and link phases from PLAN_v4/PLAN.md for the login refactor.')
  await ui.unmount()
})

test('when the box refuses the draft at first, it is tried again until it is back', async ($, on) => {
  const w = world(on, { text: 'my draft', cursor: 2 })
  await start($)
  await openFromBar($, w)
  expect(w.box.text).toBe('')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  w.refuse = 2
  await ui.press({ key: 'close' })
  await w.clock.advance(5_000)
  expect(w.box).toEqual({ text: 'my draft', cursor: 2 })
  await ui.unmount()
})

test('an injected prompt still lands with the draft when the box refuses at first', async ($, on) => {
  const w = world(on, { text: 'Say: ', cursor: 5 })
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  await ui.press({ key: 'sel#hello' })
  w.refuse = 1
  await ui.press({ key: 'inject' })
  await w.clock.advance(5_000)
  expect(w.box.text).toBe('Say: Hello there.')
  await ui.unmount()
})

test('a reload while the dialog is open gives the draft back', async ($, on) => {
  const w = world(on, { text: 'my draft', cursor: 8 })
  await start($)
  await openFromBar($, w)
  expect(w.box.text).toBe('')

  await start($)
  await w.clock.advance(5_000)
  expect(w.box.text).toBe('my draft')
})

test('text typed in the box while the dialog was open is kept on close', async ($, on) => {
  const w = world(on, { text: 'my draft', cursor: 8 })
  await start($)
  await openFromBar($, w)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  w.box = { text: 'typed meanwhile', cursor: 15 }
  await ui.press({ key: 'close' })
  await w.clock.settle()
  expect(w.box.text).toContain('my draft')
  expect(w.box.text).toContain('typed meanwhile')
  await ui.unmount()
})

test('when the box would not be emptied, nothing is put back over it later', async ($, on) => {
  const w = world(on, { text: 'my draft', cursor: 8 })
  w.refuse = 1
  await start($)
  await openFromBar($, w)
  expect(w.box.text).toBe('my draft')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)

  w.box = { text: 'my draft, edited', cursor: 16 }
  await ui.press({ key: 'close' })
  await w.clock.settle()
  expect(w.box.text).toBe('my draft, edited')
  await ui.unmount()
})
