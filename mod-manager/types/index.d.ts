export type ModInfo = {
  /** `<name>@<marketplace>`, as `claude plugin list` names it. */
  id: string
  /** The part before the @: the key in the switch file. */
  name: string
  title: string
  icon: string
  scope: string
  version: string
  /** Installed and enabled (the plugin itself, not the switch). */
  isEnabled: boolean
  /** The first sentence of the mod's own description; '' when it has none. */
  description: string
  /** One of yours (the my-mods marketplace). */
  isOwn: boolean
  /** Reads the shared switch file, so On/Off and Hidden apply within 3 seconds. */
  isSwitchable: boolean
  /** Draws something outside a pane (a card, a status-bar button), so it has the eye. */
  draws: boolean
  /** Has a pane, so it has Open. */
  hasPane: boolean
  /** Its first slash command; '' when none. */
  command: string
}

/** Which rows the panel shows. */
export type ModFilter = 'all' | 'on' | 'off'

declare module 'claude-code' {
  interface PluginState {
    'mod-manager': {
      mods: Shaped<ModInfo[]>
      /** The shared switch file as last read. */
      switches: Shaped<Record<string, unknown>>
      /** The last change, as the footer confirms it. */
      note: string
      /** An id or `reload` while a CLI call runs; empty when idle. */
      busy: string
      /** Plugins enabled or disabled since the session last reloaded them. */
      isReloadPending: boolean
      /** Ids changed through the CLI: their rows say "applies after reload". */
      pendingIds: string[]
      filter: ModFilter
      /** Text typed in the panel's search box. */
      query: string
      /** The highlighted row's id, moved by j/k or the arrows. */
      cursor: string
      /** True while the Mods pane is open, so the status-bar button toggles it. */
      isSheetOpen: boolean
    }
  }
}
