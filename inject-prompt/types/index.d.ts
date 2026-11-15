/** One saved prompt, as kept in ~/.claude/inject-prompts.json. */
export type SavedPrompt = {
  id: string
  title: string
  category: string
  tags: string[]
  text: string
}

/** The prompt box as it was when the dialog opened, put back on close. */
export type Stash = { text: string; cursor: number }

/** The placeholder step: the values asked for, one at a time. */
export type FillStep = {
  /** The prompts to insert, in the order they were ticked. */
  ids: string[]
  /** Each `{{name}}` they use, in order of first use. */
  names: string[]
  /** Each name's default, from `{{name|default}}`; '' when it has none. */
  defaults: Record<string, string>
  values: Record<string, string>
  /** The name being asked for now. */
  index: number
}

/** The Add form's fields. */
export type AddForm = { title: string; category: string; tags: string; text: string }

export type InjectView = 'list' | 'add' | 'fill'

declare module 'claude-code' {
  interface PluginState {
    'inject-prompt': {
      prompts: Shaped<SavedPrompt[]>
      isOpen: boolean
      view: InjectView
      query: string
      /** The category chip picked; '' for all. */
      category: string
      /** The tag chip picked; '' for all. */
      tag: string
      /** Ids of prompts shown in full. */
      expanded: string[]
      /** Ids ticked for injection, in tick order. */
      selected: string[]
      /** The highlighted prompt's id, moved by j/k. */
      cursor: string
      /** The first list line in view; the list scrolls, the buttons stay. */
      top: number
      stash: Shaped<Stash | null>
      fill: Shaped<FillStep | null>
      form: Shaped<AddForm>
      /** The last thing that happened, under the list. */
      note: string
    }
  }
}
