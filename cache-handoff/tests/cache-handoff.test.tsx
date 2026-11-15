import { expect, mock, test } from 'claude-code/testing'

import { stampOf } from '../hooks/handoff-logic'
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

const STATUS_BAR = { plugin: 'cache-handoff', component: 'SessionMode', props: { modes: [] } } as const
const CTX = { name: 'handoff', description: '', source: 'plugin', plugin: 'ctx-handoff', isFullscreen: false }

const DOC = [
  'HANDOFF: Acme onboarding pack',
  'Continue work in /work. Finish the onboarding pack.',
  '1. Goal and scope',
  'Ship it.',
  '2. User constraints and preferences',
  '"keep it short"',
  '3. Where it stopped',
  'Mid-review.',
  '4. Verified',
  'None',
  '5. Done but unverified / discussed only',
  'None',
  '6. Tried and failed',
  'None',
  '7. Facts found',
  'None',
  '8. Tools and environment',
  'None',
  '9. Still running or unfinished',
  'None',
  '10. Decisions',
  'None',
  '11. Next step',
  'Run the tests.',
  '12. Questions for the user',
  'None',
].join('\n')

const MESSAGES = [
  { role: 'user', text: 'Read https://example.com/spec. please', toolUses: [] },
  {
    role: 'assistant',
    text: 'On it.',
    toolUses: [
      { tool_use_id: 'a', tool: 'Read', input: { file_path: '/work/a.ts' } },
      { tool_use_id: 'b', tool: 'Edit', input: { file_path: '/work/b.ts' } },
      { tool_use_id: 'c', tool: 'Read', input: { file_path: '/work/a.ts' } },
      { tool_use_id: 'd', tool: 'Skill', input: { skill: 'graphify' } },
      { tool_use_id: 'e', tool: 'Bash', input: { command: 'ls' } },
    ],
  },
  { role: 'user', text: 'Thanks', toolUses: [] },
]

const WRITE_USAGE = { input_tokens: 40, output_tokens: 1500, cache_read_input_tokens: 214_000, cache_creation_input_tokens: 0 }

type Desk = {
  files: Record<string, string>
  agents: { id: string; status: string }[]
  copies: string[]
  opened: string[]
  listing: { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }[]
}

/** The rest of the world a handoff touches: the transcript, files, git, the clipboard, subagents. */
function desk(on: any, w: World): Desk {
  const d: Desk = { files: { '/work/.git/info/exclude': '# git ls-files --others --exclude-from=.git/info/exclude\n' }, agents: [], copies: [], opened: [], listing: [] }
  w.forkAnswers = [{ isAnswered: true, text: DOC, usage: WRITE_USAGE }]
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.root', () => ({ value: '/work' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('agent.list', () => ({ value: d.agents }))
  on('command.register', () => ({ value: undefined }))
  on('fs.write', (_: unknown, e: any) => {
    d.files[e.path] = e.text

    return { value: undefined }
  })
  on('fs.read', (_: unknown, e: any) => {
    if (!(e.path in d.files)) throw new Error(`ENOENT ${e.path}`)

    return { value: d.files[e.path] }
  })
  on('fs.list', () => ({ value: d.listing }))
  on('process.run', (_: unknown, e: any) => {
    const argv = e.argv as string[]
    if (argv[0] === 'git') return { value: { exitCode: 0, stdout: '.git/info/exclude\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    d.opened.push(argv.join(' '))

    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.copy', (_: unknown, e: any) => {
    d.copies.push(e.text)

    return { value: { isCopied: true } }
  })

  return d
}

const STAMP = stampOf(1_000_000)
const HANDOFF_FILE = `/work/.claude/handoffs/${STAMP}-acme-onboarding-pack.md`

/** Runs a handoff to its end with the card mounted, and gives the card back. */
async function buildOne($: any, w: World) {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'create-handoff' })
  await w.clock.advance(1)

  return ui
}

test('Create Handoff runs the five steps and shows a ready card with the figures', async ($, on) => {
  const w = world(on)
  const d = desk(on, w)
  await start($)
  await reply($)
  const ui = await buildOne($, w)

  const all = await texts(ui)
  expect(all).toMatch(/Handoff ready: \d+ words/)
  expect(all).toMatch(/1\. Reading the conversation/)
  expect(all).toMatch(/3 messages/)
  expect(all).toMatch(/2 files/)
  expect(all).toMatch(/1 skill, 1 link/)
  expect(all).toMatch(/5\. Saving and checking/)
  expect(all).toMatch(/acme-onboarding-pack\.md/)
  expect(all).toMatch(/Saved to \.claude\/handoffs\/.*acme-onboarding-pack\.md/)
  expect(all).toMatch(/Writing it cost ~\$0\.07/)
  expect(all).toMatch(/Each message in the new chat starts from about/)
  for (const key of ['handoff-new-chat', 'handoff-copy', 'handoff-open', 'handoff-recent', 'handoff-close']) {
    expect(await ui.find({ type: 'Button', key })).toBeTruthy()
  }
  // The request names the files and links, and asks for the twelve sections in English.
  const ask = w.forks[0]!
  expect(ask).toMatch(/twelve numbered sections/)
  expect(ask).toMatch(/write it all in English/)
  expect(ask).toContain('- /work/a.ts')
  expect(ask).toContain('https://example.com/spec')
  // Saved whole, and the folder kept out of git on this machine.
  expect(d.files[HANDOFF_FILE]).toBe(`${DOC}\n`)
  expect(d.files['/work/.git/info/exclude']).toMatch(/\n\.claude\/handoffs\/\n$/)
  await ui.unmount()
})

test('the exclude entry is added once, however many handoffs', async ($, on) => {
  const w = world(on)
  const d = desk(on, w)
  await start($)
  await reply($)
  let ui = await buildOne($, w)
  await ui.press({ key: 'handoff-close' })
  await ui.unmount()
  ui = await buildOne($, w)
  expect(d.files['/work/.git/info/exclude']!.match(/\.claude\/handoffs\//g)).toHaveLength(1)
  await ui.unmount()
})

test('the handoff waits for the reply and the subagents under way, and says so', async ($, on) => {
  const w = world(on)
  const d = desk(on, w)
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: USAGE }
  })
  await start($)
  await reply($)
  // A reply under way.
  await (async () => {
    const it = ($ as any).turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5' })
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  })()
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await ui.press({ key: 'create-handoff' })
  await w.clock.advance(1)
  expect(await texts(ui)).toMatch(/Refreshing: waiting for Claude's reply/)
  expect(w.forks).toEqual([])

  d.agents = [{ id: 'x', status: 'running' }]
  await reply($)
  await w.clock.advance(1)
  expect(await texts(ui)).toMatch(/Refreshing: waiting for 1 subagent to finish/)
  expect(w.forks).toEqual([])

  d.agents = [{ id: 'x', status: 'completed' }]
  await w.clock.advance(2000)
  expect(await texts(ui)).toMatch(/Handoff ready/)
  expect(w.forks).toHaveLength(1)
  await ui.unmount()
})

test('Start new chat clears, then fills the prompt with the handoff and what was typed meanwhile, without sending', async ($, on) => {
  const w = world(on)
  desk(on, w)
  await start($)
  await reply($)
  const ui = await buildOne($, w)
  w.box = 'also check the logs'
  await ui.press({ key: 'handoff-new-chat' })
  await w.clock.advance(1)
  expect(w.runs).toEqual([{ command: 'clear', args: '' }])
  expect(w.box).toBe(`${DOC}\n\nalso check the logs`)
  expect(w.sent).toEqual([])
  expect(await ui.find({ type: 'Button', key: 'handoff-new-chat' })).toBeFalsy()
  await ui.unmount()
})

test('Copy puts the handoff on the clipboard; Open file opens the saved file', async ($, on) => {
  const w = world(on)
  const d = desk(on, w)
  await start($)
  await reply($)
  const ui = await buildOne($, w)
  await ui.press({ key: 'handoff-copy' })
  expect(d.copies).toEqual([DOC])
  expect(await texts(ui)).toMatch(/Copied the handoff prompt/)
  await ui.press({ key: 'handoff-open' })
  expect(d.opened).toEqual([`open ${HANDOFF_FILE}`])
  await ui.unmount()
})

test('Earlier handoffs lists this project\'s others, newest first', async ($, on) => {
  const w = world(on)
  const d = desk(on, w)
  await start($)
  await reply($)
  const ui = await buildOne($, w)
  d.listing = [
    { name: '2026-10-01-0900-old.md', kind: 'file', size: 1, mtimeMs: 1, isLink: false },
    { name: `${STAMP}-acme-onboarding-pack.md`, kind: 'file', size: 1, mtimeMs: 9, isLink: false },
    { name: '2026-10-02-0900-newer.md', kind: 'file', size: 1, mtimeMs: 2, isLink: false },
    { name: 'notes.txt', kind: 'file', size: 1, mtimeMs: 3, isLink: false },
  ]
  await ui.press({ key: 'handoff-recent' })
  const all = await texts(ui)
  expect(all).toMatch(/Earlier handoffs in this project/)
  expect(all.indexOf('newer.md')).toBeLessThan(all.indexOf('old.md'))
  expect(all).not.toMatch(/notes\.txt/)
  await ui.press({ key: 'recent-2026-10-01-0900-old.md' })
  expect(d.opened).toEqual(['open /work/.claude/handoffs/2026-10-01-0900-old.md'])
  await ui.unmount()
})

test('a handoff the model could not write fails with the reason and a Try again', async ($, on) => {
  const w = world(on)
  desk(on, w)
  await start($)
  await reply($)
  w.forkAnswers = [{ isAnswered: true, text: 'Sorry, I cannot.', usage: WRITE_USAGE }]
  const ui = await buildOne($, w)
  expect(await texts(ui)).toMatch(/Handoff failed/)
  expect(await texts(ui)).toMatch(/does not start with a HANDOFF: line/)
  w.forkAnswers = [{ isAnswered: true, text: DOC, usage: WRITE_USAGE }]
  await ui.press({ key: 'handoff-retry' })
  await w.clock.advance(1)
  expect(await texts(ui)).toMatch(/Handoff ready/)
  await ui.unmount()
})

test('/handoff-new starts the same flow, and Cancel drops it', async ($, on) => {
  const w = world(on)
  desk(on, w)
  on('turn.step', async function* (_: unknown, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], usage: USAGE }
  })
  await start($)
  await reply($)
  await (async () => {
    const it = ($ as any).turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5' })
    if (it && typeof it[Symbol.asyncIterator] === 'function') for await (const _ of it) void _
    else await it
  })()
  const r = await ($ as any).command.run({ command: 'handoff-new', args: '' })
  expect(r.text).toMatch(/Building a handoff/)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  await w.clock.advance(1)
  expect(await texts(ui)).toMatch(/Refreshing: waiting/)
  await ui.press({ key: 'handoff-cancel' })
  await reply($)
  await w.clock.advance(3000)
  expect(w.forks).toEqual([])
  expect(await texts(ui)).not.toMatch(/Refreshing/)
  await ui.unmount()
})

test('past 250k a Refresh banner shows; Hide keeps it away until 50k more', async ($, on) => {
  const w = world(on)
  desk(on, w)
  w.ctxTokens = 240_000
  await start($)
  await reply($)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Button', key: 'banner-refresh' })).toBeFalsy()
  w.ctxTokens = 262_000
  await w.clock.advance(1000)
  expect(await texts(ui)).toMatch(/Context at 262k\. Refresh moves this work to a new chat with a full handoff\./)
  await ui.press({ key: 'banner-hide' })
  expect(await ui.find({ type: 'Button', key: 'banner-refresh' })).toBeFalsy()
  w.ctxTokens = 300_000
  await w.clock.advance(1000)
  expect(await ui.find({ type: 'Button', key: 'banner-refresh' })).toBeFalsy()
  w.ctxTokens = 313_000
  await w.clock.advance(1000)
  expect(await ui.find({ type: 'Button', key: 'banner-refresh' })).toBeTruthy()
  await ui.press({ key: 'banner-refresh' })
  await w.clock.advance(1)
  expect(await texts(ui)).toMatch(/Handoff ready/)
  await ui.unmount()
})

test('a cold cache on a chat of 50k or more shows the banner with the re-send price', async ($, on) => {
  const w = world(on)
  desk(on, w)
  await start($)
  await reply($)
  await w.clock.advance(61 * MIN)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await texts(ui)).toMatch(/Cache cold on a 214k chat: your next message writes it all again \(~\$1\.71\)\. Refresh moves/)
  await ui.press({ key: 'banner-hide' })
  expect(await ui.find({ type: 'Button', key: 'banner-refresh' })).toBeFalsy()
  await ui.unmount()
})

test('the status-bar Handoff button starts the handoff directly', async ($, on) => {
  const w = world(on)
  desk(on, w)
  await start($)
  await reply($)
  const bar = await $.ui.mount({ ...STATUS_BAR, surface: 'terminal' } as any)
  expect(await bar.find({ type: 'Text', text: /^⇄ Handoff$/ })).toBeTruthy()
  await bar.press({ key: 'open-handoff' })
  await bar.unmount()
  await w.clock.advance(1)
  expect(w.forks).toHaveLength(1)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await texts(ui)).toMatch(/Handoff ready/)
  await ui.unmount()
})

test('ctx-handoff\'s own keep-warm refresh is switched off once', async ($, on) => {
  const w = world(on, [CTX])
  desk(on, w)
  await start($)
  await w.clock.advance(1)
  expect(w.runs).toEqual([{ command: 'handoff', args: 'refresh off' }])
  await start($)
  await w.clock.advance(1)
  expect(w.runs).toHaveLength(1)
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
