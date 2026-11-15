import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'prompt-upgrade'

const paneAt = (bodyColumns: number) =>
  ({
    plugin: PLUGIN,
    component: 'Pane',
    requestId: 'prompt-upgrade',
    props: {
      title: 'Prompt Upgrade',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const QUESTIONS_REPLY =
  'Here you go:\n```json\n' +
  JSON.stringify({
    questions: [
      { question: 'Who is the page for?', options: ['New users', 'Admins'] },
      { question: 'What format should the result be?', options: ['A short list', 'A full page', 'Code only'] },
      { question: 'A question with one option is dropped', options: ['Only'] },
      { question: 'What counts as done?', options: ['Tests pass', 'Reviewed'] },
      { question: 'A fifth question is past the limit', options: ['A', 'B'] },
    ],
  }) +
  '\n```'

const UPGRADED = 'Write a help page for [product] aimed at new users, as a short list. It is done when the tests pass.'

const REWRITE_REPLY = JSON.stringify({ prompt: UPGRADED, added: ['Clear goal', 'Audience', 'Definition of done'] })

type World = {
  submitted: { text: string; origin: unknown }[]
  filled: string[]
  closed: string[]
  calls: string[]
  clock?: ReturnType<typeof mock.clock>
}

/** Stands in for the engine beneath the mod: the model, the pane, the prompt box. */
function world(
  on: On,
  replies: { questions?: string | null; rewrite?: string | null } = {},
): World {
  const w: World = { submitted: [], filled: [], closed: [], calls: [] }
  mock.store(on)
  w.clock = mock.clock(on, { now: Date.UTC(2026, 10, 2, 12, 0) })
  on('command.register', () => ({ value: { command: 'better' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', (_, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.fill', (_, e) => {
    w.filled.push(e.text)
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    w.submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('model.complete', (_, e) => {
    const isRewrite = String(e.system ?? '').includes('rewrite')
    w.calls.push(isRewrite ? 'rewrite' : 'questions')
    const text = isRewrite ? replies.rewrite : replies.questions
    if (text === null) {
      return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE } }
    }
    return { value: { isAnswered: true, text: text ?? (isRewrite ? REWRITE_REPLY : QUESTIONS_REPLY), usage: USAGE } }
  })
  return w
}

const typed = (text: string, extra: Record<string, unknown> = {}) =>
  ({ text, wait: false, origin: { kind: 'composer' }, ...extra }) as never

const command = (args: string) =>
  ({ command: 'better', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } }) as never

const pause = (ms: number) =>
  new Promise<void>(resolve => {
    const t = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
    if (t) t(resolve, ms)
    else void Promise.resolve().then(resolve)
  })

async function settle(_$: unknown, check: () => Promise<boolean>, ui?: { findAll: (q: { type?: string }) => Promise<{ text?: string }[]> }) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await pause(10)
  }
  throw new Error('the pane never reached the expected step' + (ui ? ':\n' + (await textOf(ui)) : ''))
}

async function textOf(ui: { findAll: (q: { type?: string }) => Promise<{ text?: string }[]> }) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')
}

test('automatic mode intercepts typed prompts and lets the rest through', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run(command('on'))

  // Intercepted: a real prompt typed at the box while idle.
  const taken = await $.prompt.submit(typed('Add a dark mode switch to the settings page'))
  expect(taken.drop).toBeDefined()

  // Through, untouched.
  const through = [
    typed('/help', { command: { name: 'help', args: '' } }),
    typed('Describe this screenshot please', { attachments: [{ type: 'image', mediaType: 'image/png' }] }),
    typed('Also update the tests while you are at it', { turnId: 't1' }),
    typed('yes'),
    typed('keep going'),
    typed('Upgraded text the mod sent itself', { origin: { kind: 'plugin', name: PLUGIN, asUser: true } }),
  ]
  for (const e of through) {
    const r = await $.prompt.submit(e)
    expect(r.drop).toBeUndefined()
  }

  // ">" goes through with the marker stripped.
  const quoted = await $.prompt.submit(typed('> just send this as it is'))
  expect(quoted.drop).toBeUndefined()
  expect(w.submitted.map(s => s.text)).toContain('just send this as it is')
  expect(w.submitted.map(s => s.text)).not.toContain('Add a dark mode switch to the settings page')
})

test('the on and off switch', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)

  // Off by default.
  expect((await $.prompt.submit(typed('Refactor the login screen'))).drop).toBeUndefined()

  const turnedOn = await $.command.run(command('on'))
  expect(turnedOn.text).toMatch(/on/)
  expect((await $.prompt.submit(typed('Refactor the login screen'))).drop).toBeDefined()

  const turnedOff = await $.command.run(command('off'))
  expect(turnedOff.text).toMatch(/off/)
  expect((await $.prompt.submit(typed('Refactor the login screen'))).drop).toBeUndefined()
  expect(w.submitted.filter(s => s.text === 'Refactor the login screen')).toHaveLength(2)
})

test('reads the questions: at most three, each with two to four options', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const out = await $.command.run(command('write a help page'))
  expect(out.text).toMatch(/Prompt Upgrade/)

  const ui = await $.ui.mount({ ...paneAt(90), surface: 'terminal' })
  await settle($, async () => (await textOf(ui)).includes('of 3 answered'))
  const all = await textOf(ui)
  expect(all).toContain('Who is the page for?')
  expect(all).toContain('What counts as done?')
  expect(all).not.toContain('dropped')
  expect(all).not.toContain('fifth')
  expect(await ui.find({ key: 'opt-q1-0' })).toBeDefined()
  expect(await ui.find({ key: 'other-q1' })).toBeDefined()
  expect(await ui.find({ key: 'skip-q1' })).toBeDefined()
  expect(await ui.find({ key: 'skip-rest' })).toBeDefined()
  expect(w.calls).toEqual(['questions'])
  await ui.unmount()
})

test('the full flow from /better to Run, and reading the rewrite', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run(command('write a help page'))

  const ui = await $.ui.mount({ ...paneAt(100), surface: 'terminal' })
  await settle($, async () => (await ui.find({ key: 'opt-q1-0' })) !== undefined)

  await ui.press({ key: 'opt-q1-0' })
  expect(await textOf(ui)).toContain('1 of 3 answered')
  await ui.press({ key: 'opt-q2-0' })
  await ui.press({ key: 'skip-q3' })

  await settle($, async () => (await ui.find({ key: 'run' })) !== undefined)
  const review = await textOf(ui)
  expect(review).toContain('WHAT I ADDED')
  expect(review).toContain('Definition of done')
  expect(review).toContain('[product]')
  expect(review).toContain('WORDS BEFORE')
  expect(w.calls).toEqual(['questions', 'rewrite'])

  await ui.press({ key: 'run' })
  expect(w.submitted.map(s => s.text)).toContain(UPGRADED)
  expect(w.closed).toContain('prompt-upgrade')
  await ui.unmount()

  // It landed in history, and reopening it shows its review.
  await $.command.run(command('history'))
  const hist = await $.ui.mount({ ...paneAt(100), surface: 'terminal' })
  const rows = (await hist.findAll({ type: 'Button' })).filter(b => (b.key ?? '').startsWith('hist-'))
  expect(rows).toHaveLength(1)
  await hist.press({ key: rows[0]!.key! })
  expect(await hist.find({ key: 'run' })).toBeDefined()
  await hist.unmount()
})

test('Cancel puts the original prompt back in the box', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run(command('on'))
  await $.prompt.submit(typed('Make the onboarding flow faster'))

  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await settle($, async () => (await ui.find({ key: 'cancel' })) !== undefined)
  await ui.press({ key: 'cancel' })
  expect(w.filled).toContain('Make the onboarding flow faster')
  expect(w.closed).toContain('prompt-upgrade')
  expect(w.submitted.map(s => s.text)).not.toContain('Make the onboarding flow faster')
  await ui.unmount()
})

test('a failed model call shows a calm card and can send the original', async ($, on) => {
  const w = world(on, { questions: null })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run(command('tidy up the network layer'))

  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await settle($, async () => (await ui.find({ key: 'retry' })) !== undefined)
  expect(await textOf(ui)).toContain('Your prompt is safe')
  expect(await ui.find({ key: 'send-original' })).toBeDefined()
  await ui.press({ key: 'send-original' })
  expect(w.submitted.map(s => s.text)).toContain('tidy up the network layer')
  await ui.unmount()
})

test('no question needed goes straight to the rewrite', async ($, on) => {
  const w = world(on, { questions: '{"questions":[]}' })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run(command('rename foo to bar in utils.ts'))
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await settle($, async () => (await ui.find({ key: 'run' })) !== undefined, ui)
  expect(w.calls).toEqual(['questions', 'rewrite'])
  await ui.unmount()
})

test('every row fits the pane, narrow and wide, on terminal and desktop', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  await $.command.run(command('write a help page for the new billing screen with screenshots and a faq'))

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const width of [32, 140]) {
      const ui = await $.ui.mount({ ...paneAt(width), surface })
      await settle($, async () => (await ui.find({ key: 'opt-q1-0' })) !== undefined)
      for (const t of await ui.findAll({ type: 'Text' })) {
        for (const line of (t.text ?? '').split('\n')) expect(line.length).toBeLessThanOrEqual(width)
      }
      await ui.unmount()
    }
  }

  // And the review at both widths.
  const first = await $.ui.mount({ ...paneAt(140), surface: 'terminal' })
  await settle($, async () => (await first.find({ key: 'skip-rest' })) !== undefined)
  await first.press({ key: 'skip-rest' })
  await settle($, async () => (await first.find({ key: 'run' })) !== undefined)
  await first.unmount()
  for (const width of [32, 140]) {
    const ui = await $.ui.mount({ ...paneAt(width), surface: 'terminal' })
    expect(await ui.find({ key: 'run' })).toBeDefined()
    for (const t of await ui.findAll({ type: 'Text' })) {
      for (const line of (t.text ?? '').split('\n')) expect(line.length).toBeLessThanOrEqual(width)
    }
    await ui.unmount()
  }
})

test('a reload mid-step picks the step back up', async ($, on) => {
  const w = world(on)
  // What the code before the reload left in state: a flow waiting on the rewrite.
  const stuck = {
    v: 1, id: 'f1', original: 'add caching to the api client', step: 'rewrite',
    questions: [], answers: {}, otherOpen: null, upgraded: '', added: [], editing: false,
    error: null, notice: null, pending: 'old-token', source: 'command',
  }
  // The stored value stands until the reloaded code writes over it.
  let isOverwritten = false
  on('state.get', async (_, e, next) => {
    if (!isOverwritten && e.key === 'flow') return { value: { value: stuck, version: 0 } }
    return next(e)
  })
  on('state.set', async (_, e, next) => {
    if (e.key === 'flow') isOverwritten = true
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await settle($, async () => (await ui.find({ key: 'run' })) !== undefined, ui)
  expect(w.calls).toEqual(['rewrite'])
  await ui.unmount()
})

const STATUS_BAR = { plugin: PLUGIN, component: 'SessionMode', props: { modes: [] } } as const

test('the status-bar Upgrade button upgrades what is typed in the box', async ($, on) => {
  const w = world(on)
  on('prompt.read', () => ({ value: { text: '  make the login page nicer  ', cursor: 0 } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as never)
  expect(await bar.find({ type: 'Text', text: /^✦ Upgrade$/ })).toBeTruthy()
  await bar.press({ key: 'open-prompt-upgrade' })
  await w.clock!.settle()
  await settle($, async () => w.calls.includes('questions'))

  // The draft left the box for the pane, and the button shows one is under way.
  expect(w.filled).toContain('')
  expect(await bar.find({ type: 'Text', text: /^✦ Upgrade …$/ })).toBeTruthy()
  const pane = await $.ui.mount({ ...paneAt(90), surface: 'terminal' } as never)
  expect(await textOf(pane)).toContain('make the login page nicer')
  await pane.unmount()
  await bar.unmount()
})

test('with an empty box, the Upgrade button opens the pane to type a prompt', async ($, on) => {
  const w = world(on)
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as never)

  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as never)
  await bar.press({ key: 'open-prompt-upgrade' })
  await w.clock!.settle()

  expect(w.calls).toEqual([])
  expect(w.filled).toEqual([])
  expect(await bar.find({ type: 'Text', text: /^✦ Upgrade …$/ })).toBeTruthy()
  await bar.unmount()
})
