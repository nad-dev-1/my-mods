import { expect, mock, test } from 'claude-code/testing'

import { ENGLISH_HANDOFF, ENGLISH_NOTES, isHandoffRequest, isNotesRequest } from '../hooks/register'

const BAND = {
  plugin: 'cache-handoff',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const

const MIN = 60 * 1000
const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
}

type World = {
  clock: ReturnType<typeof mock.clock>
  sent: string[]
  runs: { command: string; args?: string }[]
}

function world(
  on: any,
  commands: object[] = [],
  stored: Record<string, unknown> = {},
): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, stored)
  const sent: string[] = []
  const runs: { command: string; args?: string }[] = []
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: any) => {
    sent.push(e.text)

    return { text: e.text }
  })
  on('command.list', () => ({ value: commands }))
  on('command.run', (_: unknown, e: any) => {
    runs.push({ command: e.command, args: e.args })

    return { text: '' }
  })
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer, usage: e.usage }))

  return { clock, sent, runs }
}

async function start($: any) {
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
}

/** A finished main-loop turn that sent a request: the cache's hour starts now. */
async function reply($: any) {
  await $.turn.complete({
    answer: 'ok',
    durationMs: 1000,
    isAborted: false,
    turnId: 't',
    reason: 'answer',
    usage: USAGE,
  })
}

test('before any reply the bar says it is waiting, with both buttons', async ($, on) => {
  world(on)
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /waiting for the first reply/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'keep-cache' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'create-handoff' })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^OFF$/ })).toBeTruthy()
  await ui.unmount()
})

test('after a reply the bar counts down the hour, then says it expired', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^1h00m left$/ })).toBeTruthy()

  await w.clock.advance(18 * MIN)
  expect(await ui.find({ type: 'Text', text: /^42m left$/ })).toBeTruthy()

  await w.clock.advance(38 * MIN)
  expect(await ui.find({ type: 'Text', text: /^4:00 left$/ })).toBeTruthy()

  await w.clock.advance(7 * MIN)
  expect(await ui.find({ type: 'Text', text: /^expired 3m ago$/ })).toBeTruthy()
  await ui.unmount()
})

test('with Keep cache on, "Hi" goes out 5 minutes before the cache expires', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'keep-cache' })
  expect(await ui.find({ type: 'Text', text: /^ON$/ })).toBeTruthy()

  await w.clock.advance(54 * MIN)
  expect(w.sent).toEqual([])

  await w.clock.advance(1 * MIN)
  expect(w.sent).toEqual(['Hi'])
  await ui.unmount()
})

test('with Keep cache off, nothing is sent', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)

  await w.clock.advance(70 * MIN)
  expect(w.sent).toEqual([])
})

test('turning Keep cache off on the fly cancels the pending "Hi"', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'keep-cache' })
  await w.clock.advance(30 * MIN)
  await ui.press({ key: 'keep-cache' })
  expect(await ui.find({ type: 'Text', text: /^OFF$/ })).toBeTruthy()

  await w.clock.advance(40 * MIN)
  expect(w.sent).toEqual([])
  await ui.unmount()
})

test('a new reply restarts the hour, so the "Hi" moves later', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'keep-cache' })
  await w.clock.advance(30 * MIN)
  await reply($)

  await w.clock.advance(30 * MIN)
  expect(w.sent).toEqual([])
  await w.clock.advance(25 * MIN)
  expect(w.sent).toEqual(['Hi'])
  await ui.unmount()
})

test('a session starts with the Keep cache switch as it was left', async ($, on) => {
  const w = world(on, [], { 'keep-cache': true })
  await start($)
  await reply($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^ON$/ })).toBeTruthy()
  await w.clock.advance(55 * MIN)
  expect(w.sent).toEqual(['Hi'])
  await ui.unmount()
})

test('Create Handoff asks first, and "Just write it" runs ctx-handoff dry', async ($, on) => {
  const w = world(on, [
    { name: 'handoff', description: '', source: 'plugin', plugin: 'ctx-handoff', isFullscreen: false },
  ])
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'create-handoff' })
  expect(await ui.find({ type: 'Button', key: 'handoff-now' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'handoff-write' })).toBeTruthy()
  expect(w.runs).toEqual([])

  await ui.press({ key: 'handoff-write' })
  await w.clock.settle()
  expect(w.runs).toEqual([{ command: 'handoff', args: 'dry' }])
  expect(await ui.find({ type: 'Button', key: 'create-handoff' })).toBeTruthy()
  await ui.unmount()
})

test('"Hand off now" runs ctx-handoff now, under the name it registered', async ($, on) => {
  const w = world(on, [
    { name: 'ctx-handoff', description: '', source: 'plugin', plugin: 'ctx-handoff', isFullscreen: false },
  ])
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'create-handoff' })
  await ui.press({ key: 'handoff-now' })
  await w.clock.settle()
  expect(w.runs).toEqual([{ command: 'ctx-handoff', args: 'now' }])
  await ui.unmount()
})

test('Cancel closes the choice without running anything', async ($, on) => {
  const w = world(on)
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'create-handoff' })
  await ui.press({ key: 'handoff-cancel' })
  expect(w.runs).toEqual([])
  expect(await ui.find({ type: 'Button', key: 'create-handoff' })).toBeTruthy()
  await ui.unmount()
})

test('a slow handoff does not hold the button press', async ($, on) => {
  const w = world(on, [
    { name: 'handoff', description: '', source: 'plugin', plugin: 'ctx-handoff', isFullscreen: false },
  ])
  // ctx-handoff takes a minute or more to write a handoff.
  on('command.run', { command: 'handoff' }, async (_: unknown, e: any) => {
    w.runs.push({ command: e.command, args: e.args })
    await w.clock.sleep(90 * 1000)

    return { text: '' }
  })
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'create-handoff' })
  const pressed = await ui.press({ key: 'handoff-write' })
  expect(pressed).not.toHaveProperty('deny')
  await w.clock.settle()
  expect(w.runs).toEqual([{ command: 'handoff', args: 'dry' }])
  await ui.unmount()
})

test('without ctx-handoff the bar says it is needed', async ($, on) => {
  const w = world(on, [])
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'create-handoff' })
  await ui.press({ key: 'handoff-write' })
  expect(w.runs).toEqual([])
  expect(await ui.find({ type: 'Text', text: /needs the ctx-handoff mod/ })).toBeTruthy()
  await ui.unmount()
})

const STATUS_BAR = { plugin: 'cache-handoff', component: 'SessionMode', props: { modes: [] } } as const
const CHOICE = {
  plugin: 'cache-handoff',
  component: 'Pane',
  requestId: 'cache-handoff-choice',
  props: { title: 'Handoff', isFocused: true, bodyColumns: 46, placement: 'dock', scroll: { offset: 0, bodyRows: 7 }, view: {} },
} as const
const CTX = { name: 'handoff', description: '', source: 'plugin', plugin: 'ctx-handoff', isFullscreen: false }

function dialogs(on: any) {
  const d = { opens: [] as string[], closes: [] as string[] }
  on('ui.open', (_: unknown, e: any) => {
    d.opens.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: unknown, e: any) => {
    d.closes.push(e.id)

    return { value: undefined }
  })

  return d
}

test('the status-bar Handoff button opens a dialog; "Just write it" runs ctx-handoff dry', async ($, on) => {
  const w = world(on, [CTX])
  const d = dialogs(on)
  await start($)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  expect(await bar.find({ type: 'Text', text: /^⇄ Handoff$/ })).toBeTruthy()
  await bar.press({ key: 'open-handoff' })
  await w.clock.advance(1)
  expect(d.opens).toContain('cache-handoff-choice')

  const pane = await $.ui.mount({ ...CHOICE, surface: 'terminal' } as any)
  await pane.press({ key: 'dialog-write' })
  await w.clock.advance(1)
  expect(d.closes).toContain('cache-handoff-choice')
  expect(w.runs).toEqual([{ command: 'handoff', args: 'dry' }])
  await pane.unmount()
  await bar.unmount()
})

test('a handoff picked while Claude replies starts when the reply ends', async ($, on) => {
  const w = world(on, [CTX])
  dialogs(on)
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: USAGE }
  })
  await start($)
  // A reply under way.
  await (async () => {
    const it = ($ as any).turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5' })
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  })()

  const pane = await $.ui.mount({ ...CHOICE, surface: 'terminal' } as any)
  expect(await pane.find({ type: 'Text', text: /starts when the reply ends/ })).toBeTruthy()
  await pane.press({ key: 'dialog-now' })
  await w.clock.advance(1)
  expect(w.runs).toEqual([])

  await reply($)
  await w.clock.advance(1)
  expect(w.runs).toEqual([{ command: 'handoff', args: 'now' }])
  await pane.unmount()
})

const HANDOFF_ZH = '為接手這段工作的新對話寫一份 handoff。\n第一行寫「HANDOFF:」加一句話的目標。\n用使用者在對話裡使用的語言撰寫；程式碼、指令、路徑與錯誤訊息維持原文。'

test('ctx-handoff\'s handoff request is recognised; other requests are not', () => {
  expect(isHandoffRequest(HANDOFF_ZH, 'ctx-handoff')).toBe(true)
  expect(isHandoffRequest(HANDOFF_ZH, 'engine')).toBe(true)
  expect(isHandoffRequest('Summarise the last turn.', 'ctx-handoff')).toBe(false)
  expect(isHandoffRequest('Write HANDOFF: notes', 'someone-else')).toBe(false)
  expect(ENGLISH_HANDOFF).toContain('write the whole handoff in English')
})

test('ctx-handoff\'s notes request is recognised; other requests are not', () => {
  const NOTES_ZH = '你在背景整理使用者訊息裡附上的對話紀錄，目標是讓這個工作區之後的工作越做越好。'

  expect(isNotesRequest(NOTES_ZH, 'ctx-handoff')).toBe(true)
  expect(isNotesRequest('You classify text.', 'ctx-handoff')).toBe(false)
  expect(isNotesRequest(NOTES_ZH, 'some-other-mod')).toBe(false)
  expect(ENGLISH_NOTES).toContain('write every value you output in English')
  expect(ENGLISH_NOTES).toContain('never translated')
})
