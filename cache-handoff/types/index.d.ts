/** Where the handoff stands: building it, showing it, or why it failed. */
export type HandoffState = {
  phase: 'idle' | 'waiting' | 'running' | 'ready' | 'failed'
  /** The step under way (1 to 5); 6 once all are done. */
  step: number
  /** Each step's figure: messages, files, skills/links, seconds, file name. */
  figures: string[]
  /** What it waits for while the phase is `waiting`. */
  waitingFor: string
  /** When step 4 (the writing) started, for its live seconds. */
  writingSince: number
  text: string
  words: number
  /** Where it was saved: absolute, and as shown (relative to the project). */
  path: string
  shownPath: string
  costUsd: number
  /** The saving per message in the new chat, as the ready card says it. */
  saving: string
  error: string
}

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
      /** The handoff under way or shown. */
      handoff: Shaped<HandoffState>
      /** The context size at which the 250k banner was hidden; it shows again 50k later. */
      bannerHiddenAt: number
      /** The lastRequestAt whose cold period the cold banner was hidden for. */
      coldBannerHiddenFor: number
      /** The ready card's list of earlier handoffs, newest first; empty while folded. */
      recent: string[]
    }
  }
}
