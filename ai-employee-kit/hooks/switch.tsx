// The Mods panel's switch, shared by every mod in my-mods. Keep every copy
// identical. The panel writes `~/.claude/mods/switches.json`:
//   "<mod>": false          the mod is off in every chat
//   "<mod>:hidden": true    the mod keeps working but draws nothing
// A missing key means on and shown. Each mod reads the file every 3 seconds,
// so a change reaches every open chat within that time, with no reload.
//
// A hook may only be a function literal, so each hook guards itself on its
// first line: `if (switchedOff()) return next(e)` for what the mod does,
// `if (switchedOff() || switchedHidden()) return next(e)` for what it draws.

import type { EngineInterface } from 'claude-code'

export const SWITCHES = '.claude/mods/switches.json'
const POLL_MS = 3000

let name = ''
let title = ''
let off = false
let hidden = false
let raw = ''
let timer: { cancel: () => void } | null = null

export const switchedOff = () => off
export const switchedHidden = () => hidden

/** The switches as the file holds them; an unreadable or broken file reads as all on. */
export function parseSwitches(text: string): Record<string, unknown> {
  try {
    const json: unknown = JSON.parse(text)

    return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function readSwitch($: EngineInterface, path: string) {
  const text = await $.fs.read(path).catch(() => '')
  if (text === raw) return
  raw = text
  const json = parseSwitches(text)
  const nowOff = json[name] === false
  const nowHidden = json[`${name}:hidden`] === true
  if (nowOff === off && nowHidden === hidden) return
  off = nowOff
  hidden = nowHidden
  $.ui.invalidate('ui.render')
}

/** Starts reading this mod's switch: once now, then every 3 seconds. Call it from `session.start`. */
export async function watchSwitch($: EngineInterface, modName: string, modTitle: string) {
  name = modName
  title = modTitle
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
  if (!home) return
  const path = `${home}/${SWITCHES}`
  await readSwitch($, path).catch(() => undefined)
  timer?.cancel()
  timer = $.clock.every(POLL_MS, () => {
    void readSwitch($, path).catch(() => undefined)
  })
}

/** What one of the mod's own commands answers while it is off. */
export function offCommand() {
  return { text: `${title || name} is off. Turn it on in /mods.` }
}

/** What the mod's pane shows while it is off. */
export function offPane($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0]) {
  const { Text } = $.ui.resolve(e)

  return <Text dimColor>{`${title || name} is off in every chat. Turn it on in /mods.`}</Text>
}
