// The Mods panel's pure parts: what a mod's hooks source says about it (does
// it read the shared switch, does it draw, does it have a pane, its command),
// its title and icon, and how the switch file changes.

import type { ModInfo } from '../types'

/** Titles for mods whose package name reads badly. */
const TITLES: Record<string, string> = {
  'ai-employee-kit': 'AI Employee Kit',
  'cache-handoff': 'Cache Clock & Handoff',
  'chat-inventory': 'Chat Inventory',
  'employee-control-panel': 'Control Tools',
  'filetree-button': 'Files button',
  'git-review': 'Git Review',
  'inject-prompt': 'Inject Prompt',
  'mod-manager': 'Mods',
  'prompt-upgrade': 'Prompt Upgrade',
  'replay-button': 'Replay button',
  'work-report': 'Work Report',
  'reflect-mod': 'Reflect',
  'ctx-handoff': 'Context Handoff',
  'savvy-progress': 'Savvy Progress',
  'terminal-browser': 'Terminal Browser',
  filetree: 'File Tree',
  'replay-theater': 'Replay Theater',
  'blast-radius': 'Blast Radius',
  'cache-tax': 'Cache Tax',
  'code-modernization': 'Code Modernization',
}

const ICONS: Record<string, string> = {
  'ai-employee-kit': '☷',
  'cache-handoff': '◷',
  'chat-inventory': '▤',
  'employee-control-panel': '⚙',
  'filetree-button': '▦',
  'git-review': '⑂',
  'inject-prompt': '✎',
  'mod-manager': '≡',
  'prompt-upgrade': '✦',
  'replay-button': '⟲',
  'work-report': '▥',
  'reflect-mod': '↻',
  'ctx-handoff': '⇄',
  'savvy-progress': '▰',
  'terminal-browser': '⊕',
  filetree: '▦',
  'replay-theater': '▶',
  'blast-radius': '⚠',
  'cache-tax': '$',
  'code-modernization': '⌁',
}

export function titleOf(name: string): string {
  return TITLES[name] ?? name.split(/[-_]+/).filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1)).join(' ')
}

export const iconOf = (name: string) => ICONS[name] ?? '◆'

/** The first sentence of a description, for a one-line row. */
export function firstSentence(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  const end = one.search(/[.!?;](\s|$)/)

  return end > 0 ? one.slice(0, end) : one
}

/** What a mod's hooks source says about it. */
export type SourceFacts = { isSwitchable: boolean; draws: boolean; hasPane: boolean; command: string }

const DRAW_SITES = /component:\s*'(AbovePrompt|SessionMode|PromptHint|ToolUse|ToolResult|ToolGroup|ToolProgress)'/
const PANE_SITE = /component:\s*'Pane'/
const COMMAND = /command\s*\.register\(\s*\{\s*name:\s*'([\w:-]+)'/

export function factsOf(source: string): SourceFacts {
  return {
    isSwitchable: /\bwatchSwitch\(/.test(source),
    draws: DRAW_SITES.test(source),
    hasPane: PANE_SITE.test(source),
    command: COMMAND.exec(source.replace(/\$\.command\s*\n\s*\./g, '$.command.'))?.[1] ?? '',
  }
}

/** The grey line under a row: how to reach the mod. */
export function hintOf(m: Pick<ModInfo, 'command' | 'hasPane'>): string {
  if (!m.command) return ''

  return m.hasPane ? `/${m.command} to open` : `/${m.command} to run`
}

export type Switches = Record<string, unknown>

export const isSwitchedOff = (s: Switches, name: string) => s[name] === false
export const isSwitchedHidden = (s: Switches, name: string) => s[`${name}:hidden`] === true

/** The switches with one mod turned on (its key removed) or off (`false`). */
export function withOff(s: Switches, name: string, off: boolean): Switches {
  const next = { ...s }
  if (off) next[name] = false
  else delete next[name]

  return next
}

/** The switches with one mod hidden (`"<name>:hidden": true`) or shown (removed). */
export function withHidden(s: Switches, name: string, hidden: boolean): Switches {
  const next = { ...s }
  if (hidden) next[`${name}:hidden`] = true
  else delete next[`${name}:hidden`]

  return next
}

/** Whether the mod runs in this chat: installed and enabled, and not switched off. */
export function isOn(m: ModInfo, s: Switches): boolean {
  return m.isEnabled && !(m.isSwitchable && isSwitchedOff(s, m.name))
}

/** Your mods first (A to Z by title), then the others, then this panel itself last of yours. */
export function sortMods(list: ModInfo[]): ModInfo[] {
  return [...list].sort((a, b) => Number(b.isOwn) - Number(a.isOwn) || a.title.localeCompare(b.title))
}
