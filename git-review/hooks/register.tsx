import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AskPath, GrView, MergeRequest, MrRole, PipeFilter, ReviewStatus, Scope, SortBy } from '../types'
import { statusGrid } from './status-grid'
import { offCommand, offPane, switchedHidden, switchedOff, watchSwitch } from './switch'

// Git Review: a status-bar button opens a dialog of open GitLab merge requests
// (assigned to me, asking me to review, and the configured group's), grouped by
// project. Picking one opens a new terminal in the project's local clone with
// Claude running the git-review:review-mr skill on it.

type E$ = EngineInterface

const PANE = 'git-review'
const REFRESH_MS = 3 * 60 * 60 * 1000
const STATUS_POLL_MS = 60 * 1000
const SCAN_TTL_MS = 10 * 60 * 1000
const PIPELINE_CONCURRENCY = 6
const RUNNING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'scheduled'])

const mrs = atom({ plugin: 'git-review', key: 'mrs' } as const, [] as MergeRequest[], { shape: 'mrs-1' })
const isLoading = atom({ plugin: 'git-review', key: 'isLoading' } as const, false)
const loadedAt = atom({ plugin: 'git-review', key: 'loadedAt' } as const, 0)
const isOpen = atom({ plugin: 'git-review', key: 'isOpen' } as const, false)
const view = atom({ plugin: 'git-review', key: 'view' } as const, 'list' as GrView)
const query = atom({ plugin: 'git-review', key: 'query' } as const, '')
const scope = atom({ plugin: 'git-review', key: 'scope' } as const, 'all' as Scope)
const sortBy = atom({ plugin: 'git-review', key: 'sort' } as const, 'updated' as SortBy)
const pipe = atom({ plugin: 'git-review', key: 'pipe' } as const, 'any' as PipeFilter)
const project = atom({ plugin: 'git-review', key: 'project' } as const, '')
const hideDrafts = atom({ plugin: 'git-review', key: 'hideDrafts' } as const, false)
const collapsed = atom({ plugin: 'git-review', key: 'collapsed' } as const, [] as string[])
const cursor = atom({ plugin: 'git-review', key: 'cursor' } as const, '')
const top = atom({ plugin: 'git-review', key: 'top' } as const, 0)
const statuses = atom({ plugin: 'git-review', key: 'statuses' } as const, {} as Record<string, ReviewStatus>, {
  shape: 'statuses-1',
})
const ask = atom({ plugin: 'git-review', key: 'ask' } as const, null as AskPath | null, { shape: 'ask-1' })
const note = atom({ plugin: 'git-review', key: 'note' } as const, '')

const C = {
  green: '#56D364',
  greenBright: '#A6F0B0',
  ink: '#0D1117',
  sheet: '#161B22',
  muted: '#7D8590',
  text: '#E6EDF3',
  red: '#F85149',
  amber: '#D29922',
  blue: '#58A6FF',
  violet: '#A371F7',
}

/** Settings from /config, read at load. */
let cfg = { group: 'example-group/example-subgroup', roots: ['~/Documents/Projects', '~/Desktop', '~/code', '~/dev'], allowed: [] as string[] }
let refreshTimer: { cancel: () => void } | null = null
let scanCache: { at: number; map: Record<string, string[]> } | null = null
let seededStatuses = false

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fit(text: string, width: number): string {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length <= width ? one : `${one.slice(0, Math.max(0, width - 1))}…`
}

function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'now'
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`

  return `${Math.floor(h / 24)}d`
}

function lastSegment(path: string): string {
  return path.split('/').pop() ?? path
}

/** `group/sub/project` from a gitlab.com remote URL (ssh or https). */
export function remoteProject(url: string): string {
  const m = /gitlab\.com[:/](.+?)(?:\.git)?\/?$/i.exec(url.trim())

  return m ? m[1]!.toLowerCase() : ''
}

/** The project path from an MR web URL. */
function projectOfUrl(url: string): string {
  const m = /gitlab\.com\/(.+?)\/-\/merge_requests\//.exec(url)

  return m ? m[1]! : ''
}

async function home($: E$): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}

async function expand($: E$, path: string): Promise<string> {
  const p = path.trim()
  if (p === '~') return await home($)
  if (p.startsWith('~/')) return `${await home($)}/${p.slice(2)}`

  return p
}

/** Runs a tool, retrying under /opt/homebrew/bin when PATH does not reach it. */
async function runTool($: E$, argv: string[], timeoutMs = 60_000, cwd?: string) {
  try {
    return await $.process.run(argv, { timeoutMs, cwd })
  } catch (err) {
    if (argv[0]!.includes('/')) throw err

    return await $.process.run([`/opt/homebrew/bin/${argv[0]}`, ...argv.slice(1)], { timeoutMs, cwd })
  }
}

async function glab($: E$, path: string, timeoutMs = 60_000): Promise<unknown> {
  const r = await runTool($, ['glab', 'api', path], timeoutMs)
  if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || `glab exited ${r.exitCode}`)

  return JSON.parse(r.stdout)
}

// ---------------------------------------------------------------------------
// Fetching merge requests
// ---------------------------------------------------------------------------

type RawMr = {
  iid: number
  project_id: number
  title: string
  draft?: boolean
  work_in_progress?: boolean
  has_conflicts?: boolean
  source_branch: string
  target_branch: string
  web_url: string
  created_at: string
  updated_at: string
  author?: { username?: string }
}

function toMr(raw: RawMr, role: MrRole): MergeRequest {
  const projectPath = projectOfUrl(raw.web_url)

  return {
    key: `${projectPath}!${raw.iid}`,
    projectId: raw.project_id,
    projectPath,
    iid: raw.iid,
    title: raw.title,
    author: raw.author?.username ?? '',
    isDraft: Boolean(raw.draft ?? raw.work_in_progress),
    hasConflicts: Boolean(raw.has_conflicts),
    sourceBranch: raw.source_branch,
    targetBranch: raw.target_branch,
    webUrl: raw.web_url,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    roles: [role],
    pipeline: '',
  }
}

async function fetchMrs($: E$): Promise<MergeRequest[]> {
  const me = ((await glab($, 'user')) as { username: string }).username
  const byKey = new Map<string, MergeRequest>()
  const add = (list: unknown, role: MrRole) => {
    for (const raw of (Array.isArray(list) ? list : []) as RawMr[]) {
      const mr = toMr(raw, role)
      const had = byKey.get(mr.key)
      if (had) {
        if (!had.roles.includes(role)) had.roles.push(role)
      } else byKey.set(mr.key, mr)
    }
  }
  const [assigned, reviewing] = await Promise.all([
    glab($, 'merge_requests?state=opened&scope=assigned_to_me&per_page=100'),
    glab($, `merge_requests?state=opened&scope=all&reviewer_username=${encodeURIComponent(me)}&per_page=100`),
  ])
  add(assigned, 'assignee')
  add(reviewing, 'reviewer')
  const group = encodeURIComponent(cfg.group)
  for (let page = 1; page <= 5; page++) {
    const list = await glab($, `groups/${group}/merge_requests?state=opened&include_subgroups=true&per_page=100&page=${page}`)
    add(list, 'group')
    if (!Array.isArray(list) || list.length < 100) break
  }

  // The newest pipeline of each, a few at a time.
  const all = [...byKey.values()]
  let next = 0
  const worker = async () => {
    while (next < all.length) {
      const mr = all[next++]!
      try {
        const list = (await glab($, `projects/${mr.projectId}/merge_requests/${mr.iid}/pipelines?per_page=1`)) as { status?: string }[]
        mr.pipeline = list[0]?.status ?? ''
      } catch {
        mr.pipeline = ''
      }
    }
  }
  await Promise.all(Array.from({ length: PIPELINE_CONCURRENCY }, worker))

  return all
}

async function refresh($: E$): Promise<void> {
  if (await read($, isLoading)) return
  await update($, isLoading, () => true)
  await update($, note, () => 'Loading merge requests…')
  try {
    const list = await fetchMrs($)
    await update($, mrs, () => list)
    await update($, loadedAt, () => Date.now())
    await update($, note, () => `${list.length} open merge requests.`)
  } catch (err) {
    await update($, note, () => `Could not load merge requests: ${errorText(err)}. Is glab logged in? (glab auth login)`)
  } finally {
    await update($, isLoading, () => false)
  }
}

// ---------------------------------------------------------------------------
// Review status files written by the review-mr skill
// ---------------------------------------------------------------------------

async function readStatuses($: E$): Promise<void> {
  const dir = `${await home($)}/.claude/git-review/status`
  if (!(await $.fs.exists(dir).catch(() => false))) {
    seededStatuses = true

    return
  }
  const found: Record<string, ReviewStatus> = {}
  for (const entry of await $.fs.list(dir)) {
    if (!entry.name.endsWith('.json')) continue
    const parts = entry.name.slice(0, -'.json'.length).split('__')
    const iid = parts.pop()
    if (!iid || parts.length === 0) continue
    try {
      const s = JSON.parse(String(await $.fs.read(`${dir}/${entry.name}`))) as Partial<ReviewStatus>
      found[`${parts.join('/')}!${iid}`] = { stage: s.stage ?? '', verdict: s.verdict ?? '', report: s.report ?? '', at: s.at ?? '' }
    } catch {
      // half-written: next poll
    }
  }
  const before = await read($, statuses)
  if (seededStatuses) {
    for (const [key, s] of Object.entries(found)) {
      if (s.verdict && s.verdict !== before[key]?.verdict) $.ui.toast(`Git Review ${key}: ${s.verdict}`)
    }
  }
  seededStatuses = true
  await update($, statuses, () => found)
}

// ---------------------------------------------------------------------------
// Finding the local clone
// ---------------------------------------------------------------------------

const SCAN_SCRIPT = `for root in "$@"; do
  [ -d "$root" ] || continue
  find "$root" -maxdepth 6 \\( -name node_modules -o -name Pods -o -name build -o -name .build -o -name DerivedData -o -name .dart_tool -o -name .mr-worktrees \\) -prune -o -type d -name .git -print -prune 2>/dev/null |
  while IFS= read -r g; do d="\${g%/.git}"; u=$(git -C "$d" remote get-url origin 2>/dev/null) && printf '%s\\t%s\\n' "$u" "$d"; done
done`

async function scanRoots($: E$, isFresh: boolean): Promise<Record<string, string[]>> {
  if (!isFresh && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) return scanCache.map
  const roots = await Promise.all(cfg.roots.map(r => expand($, r)))
  const r = await $.process.run(['/bin/sh', '-c', SCAN_SCRIPT, 'scan', ...roots], { timeoutMs: 120_000 })
  const map: Record<string, string[]> = {}
  for (const line of r.stdout.split('\n')) {
    const [url, dir] = line.split('\t')
    const path = url ? remoteProject(url) : ''
    if (path && dir) (map[path] ??= []).push(dir)
  }
  // Several clones of one project: the shallowest first (the main checkout, not a copy inside another folder).
  for (const dirs of Object.values(map)) dirs.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length)
  scanCache = { at: Date.now(), map }

  return map
}

async function isCloneOf($: E$, dir: string, projectPath: string): Promise<boolean> {
  try {
    const r = await runTool($, ['git', '-C', dir, 'remote', 'get-url', 'origin'], 10_000)

    return r.exitCode === 0 && remoteProject(r.stdout) === projectPath.toLowerCase()
  } catch {
    return false
  }
}

async function rememberPath($: E$, projectPath: string, dir: string): Promise<void> {
  const paths = ((await $.store.get('paths').catch(() => undefined)) ?? {}) as Record<string, string>
  await $.store.set('paths', { ...paths, [projectPath.toLowerCase()]: dir })
}

async function findLocal($: E$, projectPath: string): Promise<string> {
  const key = projectPath.toLowerCase()
  const paths = ((await $.store.get('paths').catch(() => undefined)) ?? {}) as Record<string, string>
  const kept = paths[key]
  if (kept && (await isCloneOf($, kept, projectPath))) return kept
  for (const isFresh of [false, true]) {
    const found = (await scanRoots($, isFresh))[key]?.[0]
    if (found) {
      await rememberPath($, projectPath, found)

      return found
    }
  }

  return ''
}

// ---------------------------------------------------------------------------
// Starting a review in a new terminal
// ---------------------------------------------------------------------------

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Reviews being started right now, so a second click does not start another. */
const starting = new Set<string>()

async function hcPath($: E$): Promise<string> {
  const h = await home($)

  return (await $.fs.exists(`${h}/.local/bin/herdr-core`).catch(() => false)) ? `${h}/.local/bin/herdr-core` : 'hc'
}

async function hcJson($: E$, hc: string, args: string[]): Promise<Record<string, unknown> | null> {
  try {
    const r = await runTool($, [hc, ...args, '--json'], 15_000)

    return r.exitCode === 0 ? (JSON.parse(r.stdout) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * The labels that seat a terminal in the Herdr workspace and tab this session
 * is in: without them the app runs it but shows it nowhere.
 */
async function herdrPlace($: E$, hc: string): Promise<string[]> {
  const self = await $.env.get('HC_TERMINAL_ID')
  if (!self) return []
  const labels = ((await hcJson($, hc, ['get', self]))?.labels ?? {}) as Record<string, string>
  const space = labels['herdr.space']
  const tab = labels['herdr.tab']

  return space && tab ? ['--label', `herdr.space=${space}`, '--label', `herdr.tab=${tab}`] : []
}

/** A live Herdr terminal already reviewing `mr`, if there is one. */
async function runningReview($: E$, hc: string, mr: MergeRequest): Promise<{ address: string; where: string } | null> {
  const list = ((await hcJson($, hc, ['ls']))?.terminals ?? []) as { address: string; state?: string; where?: string }[]
  for (const t of list) {
    if (t.state !== 'live') continue
    const one = await hcJson($, hc, ['get', t.address])
    const labels = (one?.labels ?? {}) as Record<string, string>
    if (labels['git-review'] === mr.key) return { address: t.address, where: t.where ?? labels.where ?? '' }
  }

  return null
}

/**
 * Reads back where Herdr put the new terminal; when it is shown nowhere, seats
 * it in this tab again (labels set at start are sometimes not picked up).
 */
async function ensureShown($: E$, hc: string, name: string, place: string[]): Promise<string> {
  const pairs = place.filter((_, i) => i % 2 === 1)
  for (let i = 0; i < 12; i++) {
    const labels = ((await hcJson($, hc, ['get', name]))?.labels ?? {}) as Record<string, string>
    if (labels.where) return labels.where
    if (pairs.length && (i === 4 || i === 8)) await runTool($, [hc, 'label', name, ...pairs], 15_000).catch(() => undefined)
    await $.clock.sleep(250)
  }

  return ''
}

/** Whether Claude Code already trusts `dir` (otherwise its first screen asks). */
async function isTrusted($: E$, dir: string): Promise<boolean> {
  try {
    const conf = JSON.parse(String(await $.fs.read(`${await home($)}/.claude.json`))) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> }
    const projects = conf.projects ?? {}

    // A parent folder trusted covers its subfolders.
    return Object.entries(projects).some(([path, p]) => p?.hasTrustDialogAccepted === true && (dir === path || dir.startsWith(`${path}/`)))
  } catch {
    return true
  }
}

/** Opens a terminal in `dir` running Claude on the review skill; says where. */
async function launch($: E$, mr: MergeRequest, dir: string): Promise<string> {
  const h = await home($)
  const claude = (await $.fs.exists(`${h}/.local/bin/claude`).catch(() => false)) ? `${h}/.local/bin/claude` : 'claude'
  const allowed = cfg.allowed.length > 0 ? ` --allowed ${cfg.allowed.join(',')}` : ''
  const claudeArgv = [claude, '--permission-mode', 'auto', `/git-review:review-mr ${mr.webUrl}${allowed}`]
  const name = `mr-${lastSegment(mr.projectPath).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16)}-${mr.iid}-${Date.now().toString(36).slice(-3)}`

  // The Herdr app: its helper starts a terminal that shows in the app.
  if (await $.env.get('HC_TERMINAL_SOCKET')) {
    const hc = await hcPath($)
    const place = await herdrPlace($, hc)
    const r = await runTool($, [hc, 'run', '--bg', '--no-notify', '--no-parent', '--outlive-parent', '--name', name, '--cwd', dir, '--label', `git-review=${mr.key}`, ...place, ...claudeArgv], 30_000)
    if (r.exitCode === 0) {
      const where = await ensureShown($, hc, name, place)

      return where ? `a new Herdr terminal in ${where} (${name})` : `a Herdr terminal that Herdr has not placed yet (${name}): find it with hc ls`
    }
  }
  // The Herdr CLI's own server: split the current pane.
  if (await $.env.get('HERDR_ENV')) {
    const split = await runTool($, ['herdr', 'pane', 'split', '--current', '--direction', 'right', '--cwd', dir], 30_000)
    const id = /"id"\s*:\s*"([^"]+)"/.exec(split.stdout)?.[1] ?? split.stdout.trim().split(/\s+/).pop() ?? ''
    if (split.exitCode === 0 && id) {
      const run = await runTool($, ['herdr', 'pane', 'run', id, ...claudeArgv], 30_000)
      if (run.exitCode === 0) return 'a new Herdr pane on the right'
    }
  }
  // Anywhere else on macOS: a Terminal window.
  const line = `cd ${shellQuote(dir)} && ${claudeArgv.map(shellQuote).join(' ')}`
  const r = await runTool($, ['osascript', '-e', `tell application "Terminal" to do script ${JSON.stringify(line)}`, '-e', 'tell application "Terminal" to activate'], 30_000)
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'could not open a terminal')

  return 'a new Terminal window'
}

async function startReview($: E$, key: string): Promise<void> {
  const mr = (await read($, mrs)).find(m => m.key === key)
  if (!mr) return
  await update($, cursor, () => `mr#${key}`)
  // A second click while this one is still starting: ignore it.
  if (starting.has(key)) return
  starting.add(key)
  try {
    // Already under review in a live terminal: say where (and show it) instead of starting another.
    if (await $.env.get('HC_TERMINAL_SOCKET')) {
      const hc = await hcPath($)
      const live = await runningReview($, hc, mr)
      if (live) {
        if (!live.where) {
          const place = await herdrPlace($, hc)
          const pairs = place.filter((_, i) => i % 2 === 1)
          if (pairs.length) await runTool($, [hc, 'label', live.address, ...pairs], 15_000).catch(() => undefined)
        }
        const said = `A review of ${lastSegment(mr.projectPath)} !${mr.iid} is already running in terminal ${live.address}${live.where ? ` (${live.where})` : ''}.`
        await update($, note, () => said)
        await closeDialog($)
        $.ui.toast(said)

        return
      }
    }
    await update($, note, () => `Looking for ${lastSegment(mr.projectPath)} on this Mac…`)
    const dir = await findLocal($, mr.projectPath)
    if (!dir) {
      const first = await expand($, cfg.roots[0] ?? '~')
      await update($, ask, () => ({ key, value: `${first}/${lastSegment(mr.projectPath)}`, error: '', isWorking: false }))
      await update($, view, () => 'ask-path')
      await update($, note, () => '')

      return
    }
    await launchAndSay($, mr, dir)
  } catch (err) {
    await update($, note, () => `Could not start the review: ${errorText(err)}`)
  } finally {
    starting.delete(key)
  }
}

async function launchAndSay($: E$, mr: MergeRequest, dir: string): Promise<void> {
  const trusted = await isTrusted($, dir)
  const where = await launch($, mr, dir)
  const said =
    `Review of ${lastSegment(mr.projectPath)} !${mr.iid} started in ${where}.` +
    (trusted ? '' : ` It first asks whether you trust ${dir}: answer "Yes, I trust this folder" there, once.`)
  await update($, note, () => said)
  // Close the dialog: it holds toasts while open, and the new terminal is what to look at now.
  await closeDialog($)
  $.ui.toast(said)
}

/** The ask-path step: use the typed folder, after checking it is a clone of the project. */
async function useFolder($: E$): Promise<void> {
  const a = await read($, ask)
  if (!a) return
  const mr = (await read($, mrs)).find(m => m.key === a.key)
  if (!mr) return
  const dir = (await expand($, a.value)).replace(/\/+$/, '')
  const fail = (error: string) => update($, ask, cur => (cur ? { ...cur, error, isWorking: false } : cur))
  if (!dir) return void (await fail('Type the folder path first.'))
  if (!(await $.fs.exists(dir).catch(() => false))) return void (await fail('No such folder. Press "Clone here" to clone the project into it.'))
  if (!(await $.fs.exists(`${dir}/.git`).catch(() => false))) return void (await fail('That folder is not a git clone. Pick the clone, or an empty folder to clone into.'))
  if (!(await isCloneOf($, dir, mr.projectPath))) return void (await fail(`That clone's origin is not ${mr.projectPath}.`))
  await rememberPath($, mr.projectPath, dir)
  await update($, ask, () => null)
  await update($, view, () => 'list')
  await launchAndSay($, mr, dir)
}

/** The ask-path step: clone the project into the typed folder, then review. */
async function cloneHere($: E$): Promise<void> {
  const a = await read($, ask)
  if (!a) return
  const mr = (await read($, mrs)).find(m => m.key === a.key)
  if (!mr) return
  const dir = (await expand($, a.value)).replace(/\/+$/, '')
  const fail = (error: string) => update($, ask, cur => (cur ? { ...cur, error, isWorking: false } : cur))
  if (!dir) return void (await fail('Type the folder path first.'))
  if (await $.fs.exists(dir).catch(() => false)) {
    const inside = await $.fs.list(dir).catch(() => [])
    if (inside.some(e => e.name !== '.DS_Store')) return void (await fail('That folder is not empty. Pick a new or empty folder to clone into.'))
  }
  await update($, ask, cur => (cur ? { ...cur, error: '', isWorking: true } : cur))
  try {
    const info = (await glab($, `projects/${mr.projectId}`)) as { ssh_url_to_repo: string }
    const r = await runTool($, ['git', 'clone', info.ssh_url_to_repo, dir], 600_000)
    if (r.exitCode !== 0) return void (await fail(`Clone failed: ${r.stderr.trim().split('\n').pop()}`))
    await rememberPath($, mr.projectPath, dir)
    await update($, ask, () => null)
    await update($, view, () => 'list')
    await launchAndSay($, mr, dir)
  } catch (err) {
    await fail(`Clone failed: ${errorText(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Opening and closing the dialog
// ---------------------------------------------------------------------------

async function openDialog($: E$): Promise<void> {
  await update($, isOpen, () => true)
  await update($, view, () => 'list')
  await update($, top, () => 0)
  const opened = await $.ui.open({
    id: PANE,
    title: 'Git Review',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: 34,
    columns: 96,
    backgroundColor: C.sheet,
  })
  if (!opened.isPlaced) {
    await update($, isOpen, () => false)
    await $.ui.close({ id: PANE }).catch(() => undefined)
    $.ui.toast(`Git Review could not open: ${opened.reason}`)

    return
  }
  await pinWindow($)
  refreshTimer?.cancel()
  refreshTimer = $.clock.every(REFRESH_MS, () => void refresh($))
  const last = await read($, loadedAt)
  // Loading takes a while: after the press, not inside it.
  if (last === 0 || Date.now() - last > REFRESH_MS) $.clock.after(0, () => void refresh($))
}

async function closeDialog($: E$): Promise<void> {
  refreshTimer?.cancel()
  refreshTimer = null
  await update($, isOpen, () => false)
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

async function pinWindow($: E$): Promise<void> {
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

async function openInBrowser($: E$, key: string): Promise<void> {
  const mr = (await read($, mrs)).find(m => `mr#${m.key}` === key || m.key === key)
  if (mr) await runTool($, ['open', mr.webUrl], 10_000).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// The list: filtering, grouping, the window, and moving through it
// ---------------------------------------------------------------------------

type Filters = { typed: string; sc: Scope; so: SortBy; pi: PipeFilter; pr: string; hd: boolean }

async function filtersNow($: E$): Promise<Filters> {
  return {
    typed: await read($, query),
    sc: await read($, scope),
    so: await read($, sortBy),
    pi: await read($, pipe),
    pr: await read($, project),
    hd: await read($, hideDrafts),
  }
}

function pipeKind(status: string): PipeFilter | '' {
  if (status === 'success') return 'success'
  if (status === 'failed') return 'failed'
  if (RUNNING.has(status)) return 'running'

  return ''
}

function shownMrs(list: MergeRequest[], f: Filters): MergeRequest[] {
  const q = f.typed.trim().toLowerCase()

  return list
    .filter(m => {
      const mine = m.roles.includes('assignee') || m.roles.includes('reviewer')
      if (f.sc === 'mine' && !mine) return false
      if (f.sc === 'group' && !m.roles.includes('group')) return false
      if (f.pr && m.projectPath !== f.pr) return false
      if (f.hd && m.isDraft) return false
      if (f.pi !== 'any' && pipeKind(m.pipeline) !== f.pi) return false
      if (!q) return true
      const hay = `${m.title} !${m.iid} ${m.author} ${m.projectPath} ${m.sourceBranch} ${m.targetBranch}`.toLowerCase()

      return q.split(/\s+/).every(w => hay.includes(w))
    })
    .sort((a, b) => {
      if (f.so === 'created') return b.createdAt.localeCompare(a.createdAt)
      if (f.so === 'oldest') return a.createdAt.localeCompare(b.createdAt)

      return b.updatedAt.localeCompare(a.updatedAt)
    })
}

type Group = { path: string; members: MergeRequest[] }

function groupsOf(list: MergeRequest[]): Group[] {
  const groups: Group[] = []
  for (const m of list) {
    const g = groups.find(x => x.path === m.projectPath)
    if (g) g.members.push(m)
    else groups.push({ path: m.projectPath, members: [m] })
  }

  return groups.sort((a, b) => lastSegment(a.path).localeCompare(lastSegment(b.path)))
}

/** One drawn line of the list. */
type Line =
  | { kind: 'group'; g: Group; isOpen: boolean }
  | { kind: 'gap'; key: string }
  | { kind: 'mr'; m: MergeRequest }
  | { kind: 'meta'; m: MergeRequest }

function layout(groups: Group[], folded: string[]): Line[] {
  const lines: Line[] = []
  groups.forEach((g, i) => {
    if (i > 0) lines.push({ kind: 'gap', key: `gap-${g.path}` })
    const open = !folded.includes(g.path)
    lines.push({ kind: 'group', g, isOpen: open })
    if (open) for (const m of g.members) lines.push({ kind: 'mr', m }, { kind: 'meta', m })
  })

  return lines
}

/** The focusable entries, in order: group headers and the MRs of open groups. */
function entriesOf(lines: Line[]): string[] {
  return lines.flatMap(l => (l.kind === 'group' ? [`grp#${l.g.path}`] : l.kind === 'mr' ? [`mr#${l.m.key}`] : []))
}

let geom = { listRows: 14 }
/** The key holding the dialog's focus ring, as the last ui.focus left it. */
let ring = ''
/** A fold waiting to see whether the ring move was a click. */
let armed: { cancel: () => void } | null = null
const ARROW_MS = 150

async function linesNow($: E$): Promise<Line[]> {
  return layout(groupsOf(shownMrs(await read($, mrs), await filtersNow($))), await read($, collapsed))
}

async function keepInView($: E$, entry: string): Promise<void> {
  const lines = await linesNow($)
  const at = lines.findIndex(l => (l.kind === 'group' ? `grp#${l.g.path}` : l.kind === 'mr' ? `mr#${l.m.key}` : '') === entry)
  if (at < 0) return
  const rows = geom.listRows
  await update($, top, cur => {
    const now = cur ?? 0
    if (at <= now) return Math.max(0, at)
    if (at + 2 > now + rows) return at + 2 - rows

    return now
  })
}

async function scrollList($: E$, by: number): Promise<void> {
  const lines = await linesNow($)
  const max = Math.max(0, lines.length - geom.listRows)
  await update($, top, cur => Math.min(max, Math.max(0, (cur ?? 0) + by)))
}

async function moveTo($: E$, entry: string): Promise<void> {
  await update($, cursor, () => entry)
  await keepInView($, entry)
  await $.ui.focus({ requestId: PANE, key: entry }).catch(() => {})
}

/** Moves the highlight `by` entries (a page or the ends for the bigger keys). */
async function moveBy($: E$, by: number, contentRows: number): Promise<void> {
  const entries = entriesOf(await linesNow($))
  if (entries.length === 0) return
  const at = Math.max(0, entries.indexOf(await read($, cursor)))
  const page = Math.max(1, Math.floor(geom.listRows / 3))
  const steps = Math.abs(by) >= contentRows ? Math.sign(by) * entries.length : Math.abs(by) > 1 ? Math.sign(by) * page : by
  await moveTo($, entries[Math.min(entries.length - 1, Math.max(0, at + steps))]!)
}

async function setFolded($: E$, path: string, isFolded: boolean): Promise<void> {
  await update($, collapsed, ids => {
    const has = (ids ?? []).includes(path)
    if (isFolded && !has) return [...(ids ?? []), path]
    if (!isFolded && has) return (ids ?? []).filter(x => x !== path)

    return ids ?? []
  })
  await $.store.set('collapsed', await read($, collapsed)).catch(() => undefined)
}

/** Left folds the group of the highlighted entry, right unfolds it. */
async function foldFromArrow($: E$, entry: string, isOpening: boolean): Promise<void> {
  const path = entry.startsWith('grp#') ? entry.slice(4) : ((await read($, mrs)).find(m => `mr#${m.key}` === entry)?.projectPath ?? '')
  if (!path) return
  await setFolded($, path, !isOpening)
  await moveTo($, isOpening ? entry : `grp#${path}`)
}

/** Enter on an entry: a group folds or unfolds, an MR starts its review. */
async function enterOn($: E$, entry: string): Promise<void> {
  if (entry.startsWith('grp#')) {
    const path = entry.slice(4)
    await setFolded($, path, !(await read($, collapsed)).includes(path))
    await update($, cursor, () => entry)

    return
  }
  await startReview($, entry.slice(3))
}

/** Rows a wrapped row of chips takes: each label drawn about 5 wider. */
function chipRows(labels: string[], width: number): number {
  let rows = 1
  let used = 0
  for (const label of labels) {
    const w = label.length + 5
    if (used > 0 && used + w > width) {
      rows++
      used = 0
    }
    used += w
  }

  return rows
}

const PIPE_MARK: Record<string, { mark: string; color: string }> = {
  success: { mark: '✓', color: C.green },
  failed: { mark: '✗', color: C.red },
  running: { mark: '●', color: C.amber },
  '': { mark: '·', color: C.muted },
}

function verdictColor(v: string): string {
  if (/^approve/i.test(v)) return C.green
  if (/^blocked/i.test(v)) return C.red

  return C.amber
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Record<string, unknown>
  if (typeof o.group === 'string' && o.group.trim()) cfg = { ...cfg, group: o.group.trim().replace(/^https?:\/\/gitlab\.com\//, '').replace(/\/+$/, '') }
  if (typeof o.codeRoots === 'string' && o.codeRoots.trim()) cfg = { ...cfg, roots: o.codeRoots.split(/[\s,]+/).filter(Boolean) }
  if (typeof o.allowedPaths === 'string') cfg = { ...cfg, allowed: o.allowedPaths.split(/[\s,]+/).filter(Boolean) }

  on('session.start', async ($, e, next) => {
    await watchSwitch($, 'git-review', 'Git Review')
    const r = await next(e)
    await $.command.register({ name: 'git-review', description: 'Open the Git Review dialog of GitLab merge requests' })
    await update($, isOpen, () => false)
    const kept = await $.store.get('collapsed').catch(() => undefined)
    if (Array.isArray(kept)) await update($, collapsed, () => kept.filter((x): x is string => typeof x === 'string'))
    seededStatuses = false
    await readStatuses($).catch(() => undefined)
    $.clock.every(STATUS_POLL_MS, () => void readStatuses($).catch(() => undefined))

    return r
  })

  on('command.run', { command: 'git-review' }, async $ => {

    if (switchedOff()) return offCommand() /* switch-guarded */
    await openDialog($)

    return { text: 'Opening Git Review.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const done = await next(e)
    refreshTimer?.cancel()
    refreshTimer = null
    await update($, isOpen, () => false)

    return done
  })

  // Up and down (and the page keys) move the highlight; the wheel scrolls the list.
  on('ui.scroll', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE) return next(e)
    const isList = (await read($, view)) === 'list'
    if (isList && e.origin.kind === 'person' && e.by !== 0) {
      if (e.pointer) await scrollList($, e.by)
      else await moveBy($, e.by, e.contentRows)
    }

    return next({ ...e, offset: isList ? 1 : e.offset })
  })

  // Left and right walk the ring off the highlighted entry: read them as fold
  // and unfold. A click also moves the ring, but its press cancels the fold.
  on('ui.focus', async ($, e, next) => {
    if (e.component !== 'Pane' || e.requestId !== PANE) return next(e)
    const from = ring
    const done = await next(e)
    if (done.deny) return done
    ring = e.element ?? ''
    if (e.origin.kind === 'person' && /^(grp|mr)#/.test(from) && e.element && e.element !== from) {
      const entries = entriesOf(await linesNow($))
      const a = entries.indexOf(from)
      const b = entries.indexOf(e.element)
      const isRight = b >= 0 ? b > a : !/^(search|scope|sort|pipe|proj|drafts)/.test(e.element)
      armed?.cancel()
      armed = $.clock.after(ARROW_MS, () => {
        armed = null
        void foldFromArrow($, from, isRight)
      })
    }

    return done
  })

  on('ui.press', async ($, e, next) => {
    if (e.requestId === PANE) {
      armed?.cancel()
      armed = null
    }

    return next(e)
  })

  // The status-bar button.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (switchedOff() || switchedHidden()) return next(e) /* switch-guarded */
    const { Box, Button, Text } = $.ui.resolve(e)
    const below = await next(e)
    const open = await read($, isOpen)
    const list = await read($, mrs)
    const mine = list.filter(m => m.roles.includes('assignee') || m.roles.includes('reviewer')).length
    const fill = open ? C.greenBright : C.green
    const modes = e.props.modes

    // Every mod's status-bar button goes in one shared grid (status-grid.tsx).
    return statusGrid(
      { Box, Text },
      below,
      modes,
      <Button
          key="open-git-review"
          plain
          onPress={async () => {
            // Opened within the press, so it counts as asked for (seated from
            // 110 columns, not the 144 an unasked pane needs).
            if (await read($, isOpen)) await closeDialog($)
            else await openDialog($)
          }}
        >
          <Text color={fill}>▐</Text>
          <Text backgroundColor={fill} color={C.ink} bold>
            {mine > 0 ? `⎇ Git Review ${mine}` : '⎇ Git Review'}
          </Text>
          <Text color={fill}>▌</Text>
        </Button>,
    ) as never
  })

  // The dialog.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (switchedOff()) return offPane($, e) /* switch-guarded */
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    // The mobile app may draw no dropdown: chips there instead.
    const Select = 'Select' in elements ? elements.Select : undefined
    const width = Math.max(40, e.props.bodyColumns ?? 96)
    const bodyRows = Math.max(14, e.props.scroll?.bodyRows ?? 34)
    const last = await read($, note)

    // --- Where is the project? ---------------------------------------------
    if ((await read($, view)) === 'ask-path') {
      const a = await read($, ask)
      const mr = a ? (await read($, mrs)).find(m => m.key === a.key) : undefined
      if (!a || !mr) return <Text dimColor>Nothing to locate.</Text>

      return (
        <Box flexDirection="column">
          <Text bold color={C.green}>
            ⎇ Where is {lastSegment(mr.projectPath)} on this Mac?
          </Text>
          <Text dimColor wrap="wrap">
            {`No local clone of ${mr.projectPath} was found under ${cfg.roots.join(', ')}. Type the folder of your clone, or an empty folder to clone it into. It is remembered for next time.`}
          </Text>
          {Input ? (
            <Box marginTop={1}>
              <Input
                key="path"
                label="Folder"
                value={a.value}
                placeholder="/Users/you/Documents/Projects/…"
                submitLabel="use"
                autoFocus
                onInput={(value: string) => update($, ask, cur => (cur ? { ...cur, value, error: '' } : cur))}
                onSubmit={(value: string) => {
                  void (async () => {
                    await update($, ask, cur => (cur ? { ...cur, value } : cur))
                    await useFolder($)
                  })()
                }}
              />
            </Box>
          ) : (
            <Text dimColor>Typing is not available here.</Text>
          )}
          {a.error !== '' && <Text color={C.red}>{a.error}</Text>}
          {a.isWorking && <Text color={C.amber}>Cloning… this can take a few minutes.</Text>}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Button key="path-use" label="Use this folder" variant="primary" onPress={() => void useFolder($)} />
            <Button key="path-clone" label="Clone here" onPress={() => $.clock.after(0, () => void cloneHere($))} />
            <Button
              key="path-cancel"
              label="Back"
              onPress={async () => {
                await update($, ask, () => null)
                await update($, view, () => 'list')
                await pinWindow($)
              }}
            />
          </Box>
        </Box>
      )
    }

    // --- The list --------------------------------------------------------------
    const list = await read($, mrs)
    const f = await filtersNow($)
    const shown = shownMrs(list, f)
    const groups = groupsOf(shown)
    const folded = await read($, collapsed)
    const lines = layout(groups, folded)
    const entries = entriesOf(lines)
    const at = await read($, cursor)
    const current = entries.includes(at) ? at : (entries[0] ?? '')
    const loading = await read($, isLoading)
    const loaded = await read($, loadedAt)
    const known = await read($, statuses)
    const now = Date.now()
    const projects = [...new Set(list.map(m => m.projectPath))].sort((a, b) => lastSegment(a).localeCompare(lastSegment(b)))

    const filterTo = async (apply: () => Promise<unknown>) => {
      await apply()
      await update($, top, () => 0)
    }
    const chip = (key: string, label: string, isOn: boolean, onPress: () => unknown) => (
      <Button key={key} label={label} variant={isOn ? 'primary' : 'secondary'} onPress={onPress} />
    )

    // Sizes: everything but the list is fixed; the list gets the rest.
    const rowA = ['Show', 'Mine', 'Group', 'All', 'Sort', 'Updated', 'Created', 'Oldest', 'Hide drafts']
    const rowB = ['Pipeline', 'Any', '✓ Passed', '✗ Failed', '● Running']
    const rowC = Select ? ['Project', 'All projects'] : ['Project', 'All', ...projects.map(lastSegment)]
    const topRows = 1 + (Input ? 4 : 0) + 1 + chipRows(rowA, width) + chipRows(rowB, width) + chipRows(rowC, width)
    const footRows = 1 + chipRows(['↑', '↓', 'Fold all', 'Unfold all', 'PgUp', 'PgDn', 'Search', '· ↑↓ move · ←→ fold · Enter review · Esc closes'], width) + 1
    const listRows = Math.max(4, bodyRows - topRows - footRows - 3)
    geom = { listRows }
    const maxTop = Math.max(0, lines.length - listRows)
    const first = Math.min(maxTop, Math.max(0, await read($, top)))
    const visible = lines.slice(first, first + listRows)
    const below = Math.max(0, lines.length - first - listRows)

    const drawLine = (l: Line) => {
      if (l.kind === 'gap') return <Text key={l.key}> </Text>
      if (l.kind === 'group') {
        const key = `grp#${l.g.path}`
        const isCursor = current === key
        const parent = l.g.path.split('/').slice(0, -1).join('/')

        return (
          <Button key={key} plain autoFocus={isCursor ? true : undefined} label={`${l.isOpen ? 'Fold' : 'Unfold'} ${lastSegment(l.g.path)}`} onPress={() => void enterOn($, key)}>
            <Text color={C.green} bold>
              {isCursor ? '▶ ' : '  '}
              {l.isOpen ? '▾ ' : '▸ '}
              {lastSegment(l.g.path)}
            </Text>
            <Text dimColor>{fit(`  ${l.g.members.length} · ${parent}`, Math.max(0, width - lastSegment(l.g.path).length - 6))}</Text>
          </Button>
        )
      }
      const m = l.m
      if (l.kind === 'meta') {
        const roles = m.roles.filter(r => r !== 'group')
        const s = known[m.key]
        const pipeText = m.pipeline ? `pipeline ${m.pipeline}` : 'no pipeline'
        const meta = `@${m.author} · ${m.targetBranch} ← ${m.sourceBranch} · ${ago(m.updatedAt, now)} ago · ${pipeText}${roles.length ? ` · you: ${roles.join(', ')}` : ''}`

        return (
          <Box key={`meta-${m.key}`} flexDirection="row" marginLeft={7}>
            {s?.verdict ? (
              <Text color={verdictColor(s.verdict)} bold>
                {`[${s.verdict}] `}
              </Text>
            ) : s?.stage ? (
              <Text color={C.blue}>{`[${s.stage}] `}</Text>
            ) : null}
            <Text dimColor wrap="truncate-end">
              {fit(meta, Math.max(10, width - 8 - (s?.verdict ? s.verdict.length + 3 : s?.stage ? s.stage.length + 3 : 0)))}
            </Text>
          </Box>
        )
      }
      const key = `mr#${m.key}`
      const isCursor = current === key
      const p = PIPE_MARK[pipeKind(m.pipeline)] ?? PIPE_MARK['']!
      const titleWidth = Math.max(10, width - 16)

      return (
        <Button key={key} plain autoFocus={isCursor ? true : undefined} label={`Review !${m.iid} ${m.title}`} onPress={() => void enterOn($, key)}>
          <Text color={C.green} bold>
            {isCursor ? '  ▶ ' : '    '}
          </Text>
          <Text color={p.color} bold>
            {p.mark}
          </Text>
          <Text color={m.hasConflicts ? C.red : C.muted}>{m.hasConflicts ? ' ⚠ ' : '   '}</Text>
          <Text color={C.violet}>{`!${m.iid} `}</Text>
          {m.isDraft && <Text dimColor>[draft] </Text>}
          <Text bold={isCursor}>{fit(m.title, titleWidth - String(m.iid).length - (m.isDraft ? 8 : 0))}</Text>
        </Button>
      )
    }

    const status = loading ? 'Loading…' : loaded ? `Updated ${ago(new Date(loaded).toISOString(), now)} ago` : 'Not loaded yet'

    return (
      <Box flexDirection="column">
        {/* Spare rows above and below, never shown: with them the up and down
            keys arrive as scrolls, which move the highlight. */}
        <Text key="pad-top"> </Text>
        <Box flexDirection="column" height={bodyRows}>
          <Box flexDirection="column" flexShrink={0}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold color={C.green}>
                ⎇ Git Review
              </Text>
              <Text dimColor>{`${shown.length} of ${list.length} open · ${status}`}</Text>
            </Box>
            {Input && (
              <Box marginTop={1}>
                <Input
                  key="search"
                  placeholder="Search title, !id, author, branch or project…"
                  value={f.typed}
                  submitLabel="find"
                  onInput={(value: string) => filterTo(() => update($, query, () => value))}
                  onSubmit={(value: string) => filterTo(() => update($, query, () => value))}
                />
              </Box>
            )}
            <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
              <Text dimColor>Show</Text>
              {chip('scope-mine', 'Mine', f.sc === 'mine', () => filterTo(() => update($, scope, () => 'mine')))}
              {chip('scope-group', 'Group', f.sc === 'group', () => filterTo(() => update($, scope, () => 'group')))}
              {chip('scope-all', 'All', f.sc === 'all', () => filterTo(() => update($, scope, () => 'all')))}
              <Text dimColor> Sort</Text>
              {chip('sort-updated', 'Updated', f.so === 'updated', () => filterTo(() => update($, sortBy, () => 'updated')))}
              {chip('sort-created', 'Created', f.so === 'created', () => filterTo(() => update($, sortBy, () => 'created')))}
              {chip('sort-oldest', 'Oldest', f.so === 'oldest', () => filterTo(() => update($, sortBy, () => 'oldest')))}
              {chip('drafts', 'Hide drafts', f.hd, () => filterTo(() => update($, hideDrafts, cur => !cur)))}
            </Box>
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Text dimColor>Pipeline</Text>
              {chip('pipe-any', 'Any', f.pi === 'any', () => filterTo(() => update($, pipe, () => 'any')))}
              {chip('pipe-success', '✓ Passed', f.pi === 'success', () => filterTo(() => update($, pipe, () => 'success')))}
              {chip('pipe-failed', '✗ Failed', f.pi === 'failed', () => filterTo(() => update($, pipe, () => 'failed')))}
              {chip('pipe-running', '● Running', f.pi === 'running', () => filterTo(() => update($, pipe, () => 'running')))}
            </Box>
            {Select ? (
              <Box flexDirection="row" gap={1}>
                <Select
                  key="project"
                  label="Project"
                  value={projects.includes(f.pr) ? f.pr : ''}
                  options={[
                    { value: '', label: `All projects (${list.length})` },
                    ...projects.map(p => {
                      const name = lastSegment(p)
                      // Two projects of one name: say where each lives.
                      const isTwin = projects.some(q => q !== p && lastSegment(q) === name)
                      const count = list.filter(m => m.projectPath === p).length

                      return { value: p, label: `${isTwin ? p.split('/').slice(-2).join('/') : name} (${count})` }
                    }),
                  ]}
                  onSelect={(value: string) => void filterTo(() => update($, project, () => value))}
                />
              </Box>
            ) : (
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                <Text dimColor>Project</Text>
                {chip('proj#', 'All', f.pr === '', () => filterTo(() => update($, project, () => '')))}
                {projects.map(p => chip(`proj#${p}`, lastSegment(p), f.pr === p, () => filterTo(() => update($, project, cur => (cur === p ? '' : p)))))}
              </Box>
            )}
          </Box>

          <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={4} overflow="hidden" marginTop={1}>
            <Text key="more-above" dimColor>
              {first > 0 ? `  ↑ ${first} more line${first === 1 ? '' : 's'}` : ' '}
            </Text>
            {list.length === 0 && !loading && <Text dimColor>No merge requests loaded. Press r to refresh.</Text>}
            {list.length > 0 && shown.length === 0 && <Text dimColor>No merge requests match.</Text>}
            {visible.map(drawLine)}
            <Text key="more-below" dimColor>
              {below > 0 ? `  ↓ ${below} more line${below === 1 ? '' : 's'}` : ' '}
            </Text>
          </Box>

          <Box flexDirection="column" flexShrink={0}>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="review" label="Review" hotkey="v" variant="primary" onPress={() => void (current.startsWith('mr#') ? $.clock.after(0, () => void startReview($, current.slice(3))) : enterOn($, current))} />
              <Button key="open-web" label="Open in GitLab" hotkey="o" onPress={() => void openInBrowser($, current)} />
              <Button key="refresh" label={loading ? 'Refreshing…' : 'Refresh'} hotkey="r" onPress={() => $.clock.after(0, () => void refresh($))} />
              <Button key="close" label="Close" onPress={() => void closeDialog($)} />
            </Box>
            <Box flexDirection="row" gap={1} flexWrap="wrap">
              <Button key="up" label="↑" hotkey="k" plain onPress={() => void moveBy($, -1, Number.MAX_SAFE_INTEGER)} />
              <Button key="down" label="↓" hotkey="j" plain onPress={() => void moveBy($, 1, Number.MAX_SAFE_INTEGER)} />
              <Button key="fold-all" label="Fold all" hotkey="f" plain onPress={async () => {
                await update($, collapsed, () => groups.map(g => g.path))
                await $.store.set('collapsed', groups.map(g => g.path)).catch(() => undefined)
                await update($, top, () => 0)
              }} />
              <Button key="unfold-all" label="Unfold all" hotkey="u" plain onPress={async () => {
                await update($, collapsed, () => [])
                await $.store.set('collapsed', []).catch(() => undefined)
              }} />
              <Button key="page-up" label="PgUp" hotkey="p" plain onPress={() => void scrollList($, -Math.max(1, geom.listRows - 2))} />
              <Button key="page-down" label="PgDn" hotkey="n" plain onPress={() => void scrollList($, Math.max(1, geom.listRows - 2))} />
              <Button key="find" label="Search" hotkey="s" plain onPress={() => void $.ui.focus({ requestId: PANE, key: 'search' }).catch(() => {})} />
              <Text dimColor>· ↑↓ move · ←→ fold · Enter review · Esc closes</Text>
            </Box>
            <Text dimColor wrap="truncate-end">
              {last !== '' ? last : ' '}
            </Text>
          </Box>
        </Box>
        <Text key="pad-bottom"> </Text>
      </Box>
    )
  })
}
