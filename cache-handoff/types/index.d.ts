declare module 'claude-code' {
  interface PluginState {
    'cache-handoff': {
      /** When the main conversation last sent a model request (ms); 0 before any. */
      lastRequestAt: number
      /** The Keep cache switch; mirrored to `$.store` so it outlives the session. */
      isKeepOn: boolean
      /** True from a main turn's start to its end: no "Hi" is sent meanwhile. */
      isTurnRunning: boolean
      /** The clock, moved by a timer so the countdown redraws. */
      now: number
      /** True while the bar shows the two handoff choices. */
      isChoosingHandoff: boolean
      /** When the last keep-alive "Hi" went out (ms); 0 before any. */
      lastKeepAliveAt: number
      /** A short line about the last thing that went wrong; empty when none. */
      note: string
    }
  }
}

/** ctx-handoff's two ways: `now` hands off and clears the chat, `dry` only writes it. */
export type HandoffMode = 'now' | 'dry'
