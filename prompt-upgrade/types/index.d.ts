export type Question = { id: string; text: string; options: string[] }

export type Answer =
  | { kind: 'option'; value: string }
  | { kind: 'other'; value: string }
  | { kind: 'skip' }

export type Step = 'compose' | 'reading' | 'questions' | 'rewrite' | 'review' | 'error'

export type FlowSource = 'command' | 'auto' | 'compose' | 'history'

export type Notice = { tone: 'good' | 'warn'; text: string }

export type Flow = {
  /** Shape tag: a value without `v: 1` is read as no flow. */
  v: 1
  id: string
  original: string
  step: Step
  questions: Question[]
  answers: Record<string, Answer>
  /** The question whose "Other" field is open, if any. */
  otherOpen: string | null
  upgraded: string
  added: string[]
  editing: boolean
  error: { at: 'questions' | 'rewrite'; message: string } | null
  notice: Notice | null
  /** Token of the model call this flow waits on; a result with another token is dropped. */
  pending: string | null
  source: FlowSource
}

export type HistoryEntry = {
  id: string
  at: number
  original: string
  upgraded: string
  added: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': {
      flow: Flow | null
      history: HistoryEntry[]
      view: 'flow' | 'history'
    }
  }
}
