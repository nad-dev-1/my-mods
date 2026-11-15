export type Kind = 'emails' | 'images' | 'documents' | 'research' | 'other'

/** One calendar day: tasks finished per kind and per model. */
export type DayRecord = {
  kinds: Record<Kind, number>
  models: Record<string, number>
}

export type Settings = {
  /** Dollars per hour. */
  rate: number
  /** Minutes saved per task, by kind. */
  minutes: Record<Kind, number>
}

export type Tab = 'today' | 'week' | 'month' | 'year'

declare module 'claude-code' {
  interface PluginState {
    'work-report': {
      /** Every kept day by its local date key (YYYY-MM-DD), mirrored from the store. */
      days: Record<string, DayRecord>
      settings: Settings
      tab: Tab
    }
  }
}
