/** Why an MR is listed: assigned to me, asking me to review, or in the group. */
export type MrRole = 'assignee' | 'reviewer' | 'group'

export type MergeRequest = {
  /** `<project path>!<iid>`: unique across projects. */
  key: string
  projectId: number
  projectPath: string
  iid: number
  title: string
  author: string
  isDraft: boolean
  hasConflicts: boolean
  sourceBranch: string
  targetBranch: string
  webUrl: string
  createdAt: string
  updatedAt: string
  roles: MrRole[]
  /** The newest pipeline's status; '' when there is none or it was not read. */
  pipeline: string
}

/** What a review running in another terminal last wrote to its status file. */
export type ReviewStatus = { stage: string; verdict: string; report: string; at: string }

export type Scope = 'mine' | 'group' | 'all'
export type SortBy = 'updated' | 'created' | 'oldest'
export type PipeFilter = 'any' | 'success' | 'failed' | 'running'
export type GrView = 'list' | 'ask-path'

/** The "where is this project on disk?" step. */
export type AskPath = { key: string; value: string; error: string; isWorking: boolean }

declare module 'claude-code' {
  interface PluginState {
    'git-review': {
      mrs: Shaped<MergeRequest[]>
      isLoading: boolean
      /** When the list was last fetched (ms); 0 never. */
      loadedAt: number
      isOpen: boolean
      view: GrView
      query: string
      scope: Scope
      sort: SortBy
      pipe: PipeFilter
      /** A project path to show alone; '' for all. */
      project: string
      hideDrafts: boolean
      /** Project paths whose group is folded. */
      collapsed: string[]
      /** The highlighted MR's key. */
      cursor: string
      /** The first list line in view. */
      top: number
      statuses: Shaped<Record<string, ReviewStatus>>
      ask: Shaped<AskPath | null>
      note: string
    }
  }
}
