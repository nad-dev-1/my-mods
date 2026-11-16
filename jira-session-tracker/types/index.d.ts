// The Jira Session Tracker's own value types and its $.state contract.

/** Per-project behaviour (spec §11). */
export type ProjectCfg = {
  key: string
  /** Repo names or folder paths, `*` allowed (`selfcare-*`). */
  folders: string[]
  prefix: string
  /** `feature/{KEY}-{slug}` */
  branchPattern: string
  issueType: string
  template: string
  usesEstimates: boolean
  /** The status chosen last time, for the "used before" mark only. */
  lastStatus: string
}

export type Settings = {
  cloudId: string
  site: string
  accountId: string
  projects: ProjectCfg[]
  hoursPerDay: number
  /** 0 = Sunday ... 6 = Saturday */
  workDays: number[]
  endOfDay: string
  idleMin: number
  refreshMin: number
  daysOff: string[]
  /** Toast once a day when unlinked work passes this many minutes. */
  unlinkedAlertMin: number
  /** Count headless runs (`claude -p`) that had no typed prompt. */
  includeHeadless: boolean
  setupDone: boolean
}

export type Commit = {
  sha: string
  at: number
  subject: string
  added: number
  removed: number
  files: number
  branch: string
}

/** One session's work on one day, or one chunk of it after a split. */
export type Unit = {
  id: string
  sid: string
  day: string
  part: number
  parts: number
  startMs: number
  endMs: number
  minutes: number
  repo: string
  root: string
  cwd: string
  branch: string
  label: string
  keys: string[]
  files: string[]
  prompts: string[]
  commits: Commit[]
  project: string
  /** The linked ticket, or ''. */
  ticket: string
  /** A ticket remembered for this branch, offered but never applied by itself. */
  suggested: string
  loggedMin: number
  isLogged: boolean
  /** Closed by hand with no ticket: kept out of every list and count. */
  isIgnored: boolean
}

export type Ticket = {
  key: string
  summary: string
  status: string
  statusCat: string
  type: string
  project: string
  parentKey: string
  parentSummary: string
  updated: string
  remainingSec: number
}

export type Story = { key: string; summary: string; type: string; project: string; score: number }

export type DayInfo = {
  day: string
  targetMin: number
  loggedMin: number
  toLogMin: number
  isOff: boolean
  linked: Unit[]
}

export type Week = {
  start: string
  days: DayInfo[]
  unlinked: Unit[]
  loggedMin: number
  toLogMin: number
  isClosed: boolean
}

export type LooseEnd = {
  kind: 'uncommitted' | 'unpushed' | 'no-mr' | 'no-ticket' | 'not-logged' | 'status-behind'
  text: string
  repo: string
  root: string
  unitId: string
  key: string
  command: string
}

export type WriteRec = {
  id: string
  at: number
  kind: 'worklog' | 'create' | 'transition' | 'parent' | 'rename' | 'edit-worklog' | 'link'
  key: string
  unitIds: string[]
  worklogId: string
  startedMs: number
  minutes: number
  text: string
}

export type TimeOpt = { code: 'A' | 'B' | 'C' | 'D'; startMs: number; minutes: number; why: string }

export type Transition = { id: string; name: string; to: string }

export type Action = {
  id: string
  kind: 'create' | 'link' | 'parent' | 'rename' | 'worklog' | 'transition' | 'edit-worklog'
  isOn: boolean
  /** Ticket key, or a NEW# placeholder filled in once the create ran. */
  key: string
  unitIds: string[]
  // create
  project?: string
  issueType?: string
  summary?: string
  description?: string
  labels?: string[]
  parent?: string
  assignee?: string
  // parent
  parentKey?: string
  // rename
  root?: string
  from?: string
  to?: string
  isPushed?: boolean
  // worklog / edit-worklog
  options?: TimeOpt[]
  pick?: 'A' | 'B' | 'C' | 'D'
  customStart?: string
  customDur?: string
  comment?: string
  worklogId?: string
  isRemove?: boolean
  remainingSec?: number
  // transition
  transitions?: Transition[]
  transitionId?: string
  usedBefore?: string
  error?: string
}

export type Chunk = { label: string; share: number; ticket: string; branch: string }

export type Snapshot = {
  day: string
  sessions: number
  linkedMin: number
  unlinkedMin: number
  loggedMin: number
  targetMin: number
  looseEnds: number
  byProject: Record<string, number>
  byRepo: Record<string, number>
  byTicket: Record<string, number>
}

export type Model = {
  loadedAt: number
  weeks: Week[]
  units: Unit[]
  tickets: Ticket[]
  inProgress: string[]
  recent: string[]
  error: string
  currentSid: string
}

export type Tab = 'log' | 'tickets' | 'new' | 'dash'
export type View =
  | 'main'
  | 'link'
  | 'split'
  | 'log-one'
  | 'preview'
  | 'check'
  | 'wrapup'
  | 'standup'
  | 'timesheet'
  | 'history'
  | 'setup'
  | 'add-time'

export type NewForm = {
  unitId: string
  project: string
  issueType: string
  types: string[]
  parent: string
  stories: Story[]
  summary: string
  description: string
  labels: string
  assignee: string
  rename: boolean
}

export type Ui = {
  tab: Tab
  view: View
  /** The unit a Link / Split / New / Log flow is for. */
  unitId: string
  projectFilter: string
  search: string
  searchHits: Ticket[]
  form: NewForm
  chunks: Chunk[]
  actions: Action[]
  /** Where the preview returns to after send or back. */
  backTo: View
  check: LooseEnd[]
  text: string
  dashDay: string
  dashRange: number
  dashProject: string
  dashRepo: string
  setupDraft: string
  addTime: { key: string; date: string; start: string; dur: string; comment: string }
  /** Collapsed groups of unlinked work: `<week>|<repo>|<branch>`. */
  collapsed: string[]
  /** Weeks whose ignored sessions are listed. */
  showIgnored: string[]
  /** The units a Link or Create ticket flow covers when started from a group; empty for one session. */
  groupIds: string[]
  /** Weeks whose fold is flipped from the default (this week open, older folded). */
  weekToggled: string[]
  /** The ⚙ tools menu is showing. */
  toolsOpen: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'jira-session-tracker': {
      model: Shaped<Model>
      ui: Shaped<Ui>
      busy: string
      note: string
      queueSize: number
    }
  }
}
