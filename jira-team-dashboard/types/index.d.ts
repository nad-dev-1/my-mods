// The Jira Team Dashboard's value types and its $.state contract.

export type Member = {
  name: string
  email: string
  /** Found through Jira on the first pull; '' until then. */
  accountId: string
  teams: string[]
}

export type TeamCfg = {
  cloudId: string
  site: string
  members: Member[]
  /** Team names in the order the filter shows them. */
  teams: string[]
  /** Jira project keys to include; empty = every project the team works in. */
  projects: string[]
  hoursPerDay: number
  /** 0 = Sunday ... 6 = Saturday */
  workDays: number[]
  endOfDay: string
  /** email → days off (YYYY-MM-DD) */
  leave: Record<string, string[]>
  /** In the same status longer than this many days counts as stuck. */
  stuckDays: number
  /** The team made of members of the native teams. */
  flutterTeam: string
  /** Project keys or words (in a project key, summary or label) that mark Flutter work. */
  flutterMatch: string[]
}

/** A worklog by a team member. */
export type WL = {
  id: string
  key: string
  summary: string
  project: string
  story: string
  storySummary: string
  email: string
  seconds: number
  started: number
  comment: string
  isFlutter: boolean
}

/** A status move made by a team member. */
export type Move = {
  key: string
  summary: string
  project: string
  email: string
  from: string
  to: string
  at: number
  isBounce: boolean
}

export type Issue = {
  key: string
  summary: string
  project: string
  type: string
  status: string
  statusCat: string
  /** The assignee's email when they are a member, else their name. */
  assignee: string
  reporter: string
  parent: string
  parentSummary: string
  estimateSec: number
  spentSec: number
  remainingSec: number
  statusSince: number
  created: number
  labels: string[]
}

export type StoryInfo = {
  key: string
  summary: string
  project: string
  type: string
  children: number
  byStatus: Record<string, number>
  estimateSec: number
  spentSec: number
}

export type Hygiene = { key: string; summary: string; project: string; assignee: string; reasons: string[] }

/** One day's pull: the day's activity, plus the open work as it stood then. */
export type Snapshot = {
  day: string
  takenAt: number
  worklogs: WL[]
  moves: Move[]
  created: Issue[]
  inProgress: Issue[]
  open: Issue[]
  stories: StoryInfo[]
  hygiene: Hygiene[]
  errors: string[]
}

export type Filters = { team: string; dev: string; project: string }

export type Section = 'cards' | 'live' | 'devs' | 'projects' | 'flutter' | 'attention' | 'timeline' | 'trends'

export type DashUi = {
  day: string
  range: number
  filters: Filters
  folded: Section[]
  expanded: string[]
  view: 'main' | 'setup' | 'text'
  /** The text shown by the text view (a reminder, an export, the digest). */
  textTitle: string
  text: string
  textFile: string
  setupDraft: string
  newMember: string
  leaveFor: string
  leaveDay: string
}

declare module 'claude-code' {
  interface PluginState {
    'jira-team-dashboard': {
      ui: Shaped<DashUi>
      busy: string
      note: string
      /** Bumped whenever a snapshot is written, so drawings read again. */
      snapVersion: number
    }
  }
}
