declare module 'claude-code' {
  interface PluginState {
    'replay-button': {
      /** Edits Claude made in the last main turn that edited files. */
      edits: number
      /** Edits seen so far in the turn that is running. */
      pending: number
    }
  }
}

/** What a press found: the command name to run, or why there is none. */
export type ReplayTarget = { command: string } | { missing: string }
