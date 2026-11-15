export type ModInfo = {
  /** `<name>@<marketplace>`, as `claude plugin list` names it. */
  id: string
  scope: string
  version: string
  isEnabled: boolean
  /** The first sentence of the mod's own description; '' when it has none. */
  description: string
}

/** Which rows the panel shows. */
export type ModFilter = 'all' | 'on' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'mod-manager': {
      mods: Shaped<ModInfo[]>
      /** The last thing that happened, shown under the list. */
      note: string
      /** An id or `reload` while a CLI call runs; empty when idle. */
      busy: string
      /** Settings changed since the session last reloaded its plugins. */
      isReloadPending: boolean
      filter: ModFilter
      /** Text typed in the panel's search box. */
      query: string
      /** The highlighted row's key (`<id>#<scope>`), moved by j/k or the arrows. */
      cursor: string
      /** True while the Mods sheet is open, so the status-bar button toggles it. */
      isSheetOpen: boolean
      /** Ids of the groups folded in the sheet; mirrored to `$.store`. */
      collapsed: string[]
    }
  }
}
