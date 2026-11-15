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
  /** Invisible pings: each fork's prompt. */
  forks: string[]
  /** What the next forks answer, first first; the last one repeats. */
  forkAnswers: any[]
  notes: string[]
  /** The chat's size as the session reports it. */
  ctxTokens: number
  box: string
}

const PING_READ = { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 214_000, cache_creation_input_tokens: 0 }

function world(
  on: any,
  commands: object[] = [],
  stored: Record<string, unknown> = {},
): World {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, stored)
  const sent: string[] = []
  const runs: { command: string; args?: string }[] = []
  const w0 = { forks: [] as string[], forkAnswers: [{ isAnswered: true, text: 'OK', usage: PING_READ }] as any[], notes: [] as string[], ctxTokens: 214_000, box: '' }
  on('model.fork', (_: unknown, e: any) => {
    w0.forks.push(e.prompt)
    const answer = w0.forkAnswers.length > 1 ? w0.forkAnswers.shift() : w0.forkAnswers[0]

    return { value: answer }
  })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: w0.ctxTokens, percent: 21 }, rateLimits: [] } }))
  on('ui.notify', (_: unknown, e: any) => {
    w0.notes.push(e.text)

    return { value: { isSent: true, channel: 'terminal' } }
  })
  on('prompt.read', () => ({ value: { text: w0.box, cursor: w0.box.length } }))
  on('prompt.fill', (_: unknown, e: any) => {
    w0.box = e.text

    return { isFilled: true }
  })
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

  return Object.assign(w0, { clock, sent, runs }) as World
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

/** Every text the card shows, button captions included. */
const texts = async (ui: any) =>
  [...(await ui.findAll({ type: 'Text' })), ...(await ui.findAll({ type: 'Button' }))]
    .map((t: any) => [t.text, t.label, t.props?.label].filter(Boolean).join(' '))
    .join('\n')

test('before any reply the card says it is waiting, with the switch, Create Handoff and Hide', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await texts(ui)).toMatch(/Cache waiting for the first reply/)
  for (const key of ['keep-cache', 'create-handoff', 'hide-card']) expect(await ui.find({ type: 'Button', key })).toBeTruthy()
  await ui.unmount()
})

test('after a reply the card counts the hour down in mm:ss with a bar, then says it went cold', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /^60:00$/ })).toBeTruthy()
  expect(await texts(ui)).toMatch(/Cache warm/)
  expect(await texts(ui)).toMatch(/1 hour cache, as Anthropic's last reply set it\. Reply now and 214k tokens cost 5 to 10% as much/)

  await w.clock.advance(18 * MIN + 11_000)
  expect(await ui.find({ type: 'Text', text: /^41:49$/ })).toBeTruthy()

  await w.clock.advance(38 * MIN)
  expect(await ui.find({ type: 'Text', text: /^3:49$/ })).toBeTruthy()

  await w.clock.advance(7 * MIN)
  expect(await texts(ui)).toMatch(/Cache cold · expired 3m ago/)
  await ui.unmount()
})

test('Auto-warm sends an invisible ping 5 minutes before expiry, never a message, and the hour starts again', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'keep-cache' })
  expect(await texts(ui)).toMatch(/Auto-warm: ON/)
  expect(await texts(ui)).toMatch(/Keeping warm · first ping in 55:00/)

  await w.clock.advance(54 * MIN)
  expect(w.forks.length).toBe(0)
  await w.clock.advance(1 * MIN)
  expect(w.forks.length).toBe(1)
  expect(w.sent).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^60:00$/ })).toBeTruthy()
  expect(await texts(ui)).toMatch(/Keeping warm · ping 1 · next in 55:00 · last ping read 214k cached tokens/)
  await ui.unmount()
})

test('Auto-warm stays on with no cap: a long break keeps pinging every hour', async ($, on) => {
  const w = world(on, [], { 'keep-cache': true })
  await start($)
  await reply($)
  await w.clock.advance(55 * MIN)
  await w.clock.advance(55 * MIN)
  await w.clock.advance(55 * MIN)
  await w.clock.advance(55 * MIN)
  expect(w.forks.length).toBe(4)
  // A reply in between keeps it on; the next ping counts from that reply.
  await reply($)
  await w.clock.advance(55 * MIN)
  expect(w.forks.length).toBe(5)
})

test('turning Auto-warm off on the fly cancels the pending ping', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'keep-cache' })
  await w.clock.advance(30 * MIN)
  await ui.press({ key: 'keep-cache' })
  expect(await texts(ui)).toMatch(/Auto-warm: OFF/)
  await w.clock.advance(40 * MIN)
  expect(w.forks.length).toBe(0)
  await ui.unmount()
})

test('with Auto-warm off, nothing is sent, and a notification comes once 5 minutes before it goes cold', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)
  await w.clock.advance(54 * MIN)
  expect(w.notes).toEqual([])
  await w.clock.advance(1 * MIN)
  expect(w.notes.length).toBe(1)
  expect(w.notes[0]).toMatch(/goes cold in 5 minutes/)
  await w.clock.advance(20 * MIN)
  expect(w.notes.length).toBe(1)
  expect(w.forks.length).toBe(0)
  expect(w.sent).toEqual([])
})

test('a ping that read no cache stops the pinging and says why; the next reply starts it again', async ($, on) => {
  const w = world(on)
  w.forkAnswers = [{ isAnswered: true, text: 'OK', usage: { ...PING_READ, cache_read_input_tokens: 0, cache_creation_input_tokens: 214_000 } }, { isAnswered: true, text: 'OK', usage: PING_READ }]
  await start($)
  await reply($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'keep-cache' })
  await ui.unmount()
  await w.clock.advance(55 * MIN)
  expect(w.forks.length).toBe(1)
  const paused = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await texts(paused)).toMatch(/Pinging paused: the last ping found no cache/)
  await paused.unmount()
  await w.clock.advance(60 * MIN)
  expect(w.forks.length).toBe(1)

  await reply($)
  const resumed = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await texts(resumed)).not.toMatch(/Pinging paused/)
  await resumed.unmount()
  await w.clock.advance(55 * MIN)
  expect(w.forks.length).toBe(2)
})

test('a ping refused by a busy API is tried again a minute later', async ($, on) => {
  const w = world(on)
  w.forkAnswers = [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: PING_READ }, { isAnswered: true, text: 'OK', usage: PING_READ }]
  await start($)
  await reply($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'keep-cache' })
  await w.clock.advance(55 * MIN)
  expect(w.forks.length).toBe(1)
  await w.clock.advance(1 * MIN)
  expect(w.forks.length).toBe(2)
  expect(await texts(ui)).toMatch(/ping 1 · next in/)
  await ui.unmount()
})

test('the card shows dollar estimates and what the pings have cost', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  // Opus 5.5: 214k tokens read warm at $0.20/MTok, written cold at $8/MTok.
  expect(await texts(ui)).toMatch(/~\$0\.04 warm vs ~\$1\.71 if it goes cold/)
  await ui.press({ key: 'keep-cache' })
  await w.clock.advance(55 * MIN)
  expect(await texts(ui)).toMatch(/pings so far ~\$0\.04/)
  await ui.unmount()
})

test('Hide folds the card to one line that keeps the timer and the switch; Show brings it back', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'hide-card' })
  const folded = await texts(ui)
  expect(folded).not.toMatch(/1 hour cache/)
  expect(await ui.find({ type: 'Text', text: /^60:00$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'keep-cache' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'hide-card' })).toBeTruthy()
  expect(folded).toMatch(/Show/)
  await ui.unmount()

  // Remembered: a new session starts folded.
  await start($)
  const again = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await texts(again)).not.toMatch(/1 hour cache/)
  await again.press({ key: 'hide-card' })
  expect(await texts(again)).toMatch(/1 hour cache/)
  await again.unmount()
  void w
})

test('a session starts with the Auto-warm switch as it was left', async ($, on) => {
  const w = world(on, [], { 'keep-cache': true })
  await start($)
  await reply($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await texts(ui)).toMatch(/Auto-warm: ON/)
  await w.clock.advance(55 * MIN)
  expect(w.forks.length).toBe(1)
  await ui.unmount()
})

const typed = (text: string) => ({ text, wait: false, origin: { kind: 'composer' } }) as never

test('the cold-send guard holds back the first message on a cold, large chat once, with the price', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)
  await w.clock.advance(75 * MIN)

  const first = await $.prompt.submit(typed('carry on'))
  expect(first.drop).toMatch(/cold 15m ago.*214k tokens.*~\$1\.71/)
  expect(w.sent).toEqual([])
  // The text is put back in the box, so sending again is one keypress.
  await w.clock.advance(1000)
  expect(w.box).toBe('carry on')

  const second = await $.prompt.submit(typed('carry on'))
  expect(second.drop).toBeUndefined()
  expect(w.sent).toEqual(['carry on'])
})

test('the guard leaves warm chats, small chats, slash commands and prompts nobody typed alone', async ($, on) => {
  const w = world(on)
  await start($)
  await reply($)
  expect((await $.prompt.submit(typed('warm'))).drop).toBeUndefined()

  await w.clock.advance(75 * MIN)
  expect((await $.prompt.submit({ text: '/clear', wait: false, origin: { kind: 'composer' }, command: { name: 'clear', args: '' } } as never)).drop).toBeUndefined()
  expect((await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } } as never)).drop).toBeUndefined()
  w.ctxTokens = 20_000
  expect((await $.prompt.submit(typed('small'))).drop).toBeUndefined()
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
