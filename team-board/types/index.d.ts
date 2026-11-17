// Team Board's $.state contract.

declare module 'claude-code' {
  interface PluginState {
    'team-board': {
      /** Bumped whenever the cache or the status line is redrawn, so the pane reads again. */
      version: number
      /** A short note under the pane's header (what a button just did). */
      note: string
    }
  }
}

/** The note shown under the pane header. */
export type BoardNote = string
