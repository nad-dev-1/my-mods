// The handoff's pure parts, after "Mod #4" (Handoff) of Ben AI's "9 Insane
// Claude Mods" video: what the conversation used, the request that writes the
// document (ctx-handoff's twelve sections, in English), and the checks and
// names of the file it is saved to.

/** One message as `$.session.messages()` gives it. */
export type Msg = { role: string; text: string; toolUses: readonly { tool: string; input: Record<string, unknown> }[] }

/** What the conversation used: the figures of steps 1 to 3. */
export type Scan = { count: number; files: string[]; skills: string[]; tools: string[]; links: string[] }

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const URL = /\bhttps?:\/\/[^\s<>()"'`\]]+/g

export const SECTIONS = [
  'Goal and scope',
  'User constraints and preferences',
  'Where it stopped',
  'Verified',
  'Done but unverified / discussed only',
  'Tried and failed',
  'Facts found',
  'Tools and environment',
  'Still running or unfinished',
  'Decisions',
  'Next step',
  'Questions for the user',
]

/** The messages, the files the tools touched, and the skills, MCP tools and links seen. */
export function scanMessages(msgs: readonly Msg[]): Scan {
  const files = new Set<string>()
  const skills = new Set<string>()
  const tools = new Set<string>()
  const links = new Set<string>()
  for (const m of msgs) {
    for (const u of m.toolUses ?? []) {
      const path = u.input.file_path ?? u.input.notebook_path
      if (FILE_TOOLS.has(u.tool) && typeof path === 'string' && path) files.add(path)
      if (u.tool === 'Skill' && typeof u.input.skill === 'string') skills.add(u.input.skill)
      if (u.tool.startsWith('mcp__')) tools.add(u.tool)
    }
    for (const link of m.text.match(URL) ?? []) links.add(link.replace(/[.,;:!?]+$/, ''))
  }

  return { count: msgs.length, files: [...files], skills: [...skills], tools: [...tools], links: [...links] }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Step 3's figure: "2 skills, 3 links", leaving out the kinds there are none of. */
export function usedFigure(s: Scan): string {
  const parts = [
    s.skills.length ? plural(s.skills.length, 'skill') : '',
    s.tools.length ? plural(s.tools.length, 'tool') : '',
    s.links.length ? plural(s.links.length, 'link') : '',
  ].filter(Boolean)

  return parts.length ? parts.join(', ') : 'none used'
}

const list = (items: string[], max = 40) =>
  items.length ? items.slice(0, max).map(x => `- ${x}`).join('\n') + (items.length > max ? `\n- … and ${items.length - max} more` : '') : '- None'

/** The request that writes the handoff, over the conversation as the main thread sent it. */
export function handoffPrompt(root: string, s: Scan): string {
  return [
    'Write a handoff document so this work can continue in a fresh conversation that has not seen this one.',
    '',
    'Format, in Markdown, nothing before or after it:',
    '- The first line is "HANDOFF: " followed by the goal in a few words.',
    `- The second line is "Continue work in ${root}." followed by the goal in one sentence.`,
    `- Then twelve numbered sections with these headings, in this order: ${SECTIONS.map((h, i) => `${i + 1}. ${h}`).join('; ')}.`,
    '- Write "None" for an empty section.',
    '',
    'Rules: write it all in English, whatever language the conversation used. Keep what was verified apart from what was only changed or discussed. ' +
      'Quote the user\'s own words exactly as they wrote them for their constraints and preferences. ' +
      'Keep code, commands, paths, names and error messages verbatim. End "Next step" with exactly one concrete next action.',
    '',
    'Files used in this conversation:',
    list(s.files),
    '',
    'Skills, tools and links used:',
    list([...s.skills.map(x => `skill ${x}`), ...s.tools.map(x => `tool ${x}`), ...s.links]),
  ].join('\n')
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Why a written handoff is not usable; '' when it is. */
export function checkHandoff(text: string): string {
  const doc = text.trim()
  if (!doc) return 'the answer was empty'
  if (!/^#*\s*HANDOFF:/i.test(doc)) return 'it does not start with a HANDOFF: line'
  const found = SECTIONS.filter(h => doc.toLowerCase().includes(h.toLowerCase())).length
  if (found < 9) return `it has only ${found} of the 12 sections`

  return ''
}

/** "HANDOFF: Acme onboarding pack" → "acme-onboarding-pack" (six words at most). */
export function slugOf(text: string): string {
  const first = /HANDOFF:\s*(.+)/i.exec(text)?.[1] ?? 'handoff'
  const words = first
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 6)

  return words.join('-') || 'handoff'
}

/** 2026-10-16-1432, in local time. */
export function stampOf(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}
