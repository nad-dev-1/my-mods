/** A model family the panel offers, by the alias `/model` takes. */
export type Alias = 'fable' | 'opus' | 'sonnet' | 'haiku'

/** An effort level `/effort` takes. */
export type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** One main-session pick: what was asked for and how it went. */
export type Pick = {
  /** The alias or level asked for. */
  value: string
  /** pending: queued or running; applied: in force; error: refused. */
  state: 'pending' | 'applied' | 'error'
  /** Why it failed, when it did. */
  text: string
  /** Which pick this is; only the newest of a kind updates the status. */
  seq: number
}

/** The latest main-session pick of each kind; null before any. */
export type MainPicks = { model: Pick | null; effort: Pick | null }

/** The subagent overrides for this project; '' is Auto. */
export type SubPicks = { model: string; effort: string }

/** Tokens the main session's replies used, summed this session. */
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** The working folder's git state, refreshed after replies and on a timer. */
export type GitInfo = { branch: string; added: number; removed: number }

declare module 'claude-code' {
  interface PluginState {
    'employee-control-panel': {
      isOpen: boolean
      /** A main-loop turn is running, so a switch waits for it to end. */
      isBusy: boolean
      /** Bumped when the model or effort may have changed, to redraw. */
      tick: number
      main: Shaped<MainPicks>
      /** The effort last set with /effort, by the model it was set on. */
      seen: Shaped<Record<string, string>>
      sub: Shaped<SubPicks>
      tokens: Shaped<Tokens>
      git: Shaped<GitInfo>
    }
  }
}
