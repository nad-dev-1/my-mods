declare module 'claude-code' {
  interface PluginState {
    'cache-handoff': {
      /** When the main conversation last sent a model request (ms); 0 before any. */
      lastRequestAt: number
      /** The Auto-warm switch; mirrored to `$.store` so it outlives the session. */
      isKeepOn: boolean
      /** True from a main turn's start to its end: no ping is sent meanwhile. */
      isTurnRunning: boolean
      /** The clock, moved by a timer so the countdown redraws. */
      now: number
      /** True while the bar shows the two handoff choices. */
      isChoosingHandoff: boolean
      /** When the last keep-warm ping went out (ms); 0 before any. */
      lastKeepAliveAt: number
      /** A short line about the last thing that went wrong; empty when none. */
      note: string
      /** The card folded to one line; mirrored to `$.store`. */
      isHidden: boolean
      /** Keep-warm pings sent this conversation. */
      pingCount: number
      /** Cached tokens the last ping read. */
      lastPingRead: number
      /** What this conversation's pings cost, in US dollars, from list prices. */
      pingsUsd: number
      /** Why pinging stopped (the safety check or a failure); empty while it runs. */
      pausedReason: string
      /** The lastRequestAt whose cold period the guard already held a message back for. */
      guardedFor: number
      /** The lastRequestAt the cold warning already went out for. */
      warnedFor: number
    }
  }
}

/** ctx-handoff's two ways: `now` hands off and clears the chat, `dry` only writes it. */
export type HandoffMode = 'now' | 'dry'
