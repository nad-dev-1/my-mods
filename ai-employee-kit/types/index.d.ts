export type HelperState = 'queued' | 'working' | 'done' | 'stuck'

export type Helper = {
  /** The Agent call's tool_use_id. */
  id: string
  /** 3 to 5 words, from the Agent call's description. */
  name: string
  state: HelperState
  /** Last reported percent; null until the helper reports. */
  percent: number | null
  startedAt: number | null
  endedAt: number | null
  /** Seat number, for its color and headshot. */
  seat: number
}

export type Run = {
  id: string
  /** The first clause of the request, about 40 characters. */
  job: string
  /** Team Size when the request was sent. */
  size: number
  startedAt: number
  endedAt: number | null
  status: 'live' | 'complete'
  helpers: Helper[]
  /** Agent calls let through for this request. */
  accepted: number
  nudged: boolean
}

export type HelperModel = 'fast' | 'same'

// ---------------------------------------------------------------------------
// Clean View: readable by any mod as $.state 'ai-employee-kit' / 'checklist'
// ---------------------------------------------------------------------------

export type CleanTask = {
  id: string
  /** Plain English, at most 40 characters, no paths, code or tool names. */
  name: string
  status: 'done' | 'active' | 'upcoming'
  /** The last reported percent; null until reported. */
  percent: number | null
  hasReported: boolean
}

export type CleanPhase = 'working' | 'needsYou' | 'stuck' | 'stopped' | 'done'

export type Checklist = {
  jobId: string
  /** The job's name, 2 to 6 plain words. */
  title: string
  phase: CleanPhase
  tasks: CleanTask[]
  needsYouReason: string | null
  stuckReason: string | null
  startedAt: number
  finishedAt: number | null
  /** All done, shrunk to one line. */
  isCollapsed: boolean
  /** True once a real plan (plan_steps, a report, or the to-do list) replaced the placeholders. */
  hasPlan: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'ai-employee-kit': {
      size: number
      /** A size above 20 waiting for Continue. */
      pending: number | null
      customOpen: boolean
      helperModel: HelperModel
      run: Run | null
      /** Agent Dock's animation frame; advances only while helpers are live. */
      dockTick: number
      /** Absolute paths of headshot PNGs, if any. */
      headshots: string[]
      atOnce: number
      /** The pane is folded to the status-bar badge. */
      folded: boolean
      /** Clean View: tool rows hidden and the checklist shown. Starts on. */
      cleanViewEnabled: boolean
      /** Clean View's checklist for the current job; null when none has started. */
      checklist: Checklist | null
      /** Clean View's animation frame; advances every 250ms only while a job is working or needs you. */
      tick: number
    }
  }
}
