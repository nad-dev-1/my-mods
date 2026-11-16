# Mods: user guide

A Claude Code mod that lists every mod you have installed in a side pane called **Mods**, with one switch each. For the mods in this repository, **Off** and **Hidden** reach every open chat within 3 seconds, with no reload. Other mods are enabled or disabled for real and apply after a plugin reload.

**Off means off in every chat. Hidden keeps a mod working, but out of sight.**

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install mod-manager@my-mods --scope user`. The code is in [`mod-manager/`](../mod-manager/).

---

## Contents

- [What you need](#what-you-need)
- [Opening the pane](#opening-the-pane)
- [The pane at a glance](#the-pane-at-a-glance)
- [Which mods are listed](#which-mods-are-listed)
- [A mod's row](#a-mods-row)
- [The switchboard: how On, Off and Hidden work](#the-switchboard-how-on-off-and-hidden-work)
- [Other mods and Apply](#other-mods-and-apply)
- [Search and filters](#search-and-filters)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Settings](#settings)
- [What it stores and where](#what-it-stores-and-where)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| Claude Code 2.1.287 or later, with the `claude` command on your path | The list comes from `claude plugin list --json`. Enabling and disabling other mods runs `claude plugin enable` / `disable`. |

## Opening the pane

- **≡ Mods** in the status bar opens the pane, or closes it when it is open. It shows how many mods are on out of how many are listed, for example `≡ Mods 9/12`. A **•** after the count means a change is waiting for a plugin reload.
- `/mods` does the same, and replies with the count and the keys.
- **Esc** closes the pane.

If the pane cannot be placed yet (not enough room), a short message says why. The status-bar button shares a three-row button grid on the right of the status bar with the other mods from this repository.

## The pane at a glance

```
≡ Mods  9 on · 1 off                             [All] [On] [Off]
Search mods…
Your mods
▶ ◷ Cache Clock & Handoff                          ◉ Shown   ● On
    A Cache Clock card above the prompt (…)
    /handoff-new to run
  ▤ Chat Inventory                         Open    ◌ Hidden  ● On
    A side pane, In this chat, with live cards (…)
    /inventory to open
  ≡ Mods                                                this pane
Other mods · on/off applies after a reload
  ↻ Reflect                                                  ○ Off
    applies after reload
↑  ↓  Switch  Hide/Show  Open

Chat Inventory is hidden in every chat. It keeps working, out of sight.
Off means off in every chat. Hidden keeps it on but out of sight.
Changes apply within 3 seconds. New mods appear here by themselves.
```

| Part | What it is |
| --- | --- |
| **Header** | How many mods are on and off, the **All / On / Off** filters, and **Apply** when a reload is waiting. |
| **Search mods…** | Narrows the list as you type. |
| **Your mods** | Mods installed from this repository's marketplace (`my-mods`), A to Z. |
| **Other mods** | Every other installed mod, A to Z. |
| **Bottom row** | **↑**, **↓**, **Switch**, **Hide/Show** and **Open**, which act on the highlighted row (marked **▶**). |
| **Footer** | The last change made (in green), then a fixed reminder of how the switches work. |

While the list is loading the pane says *Looking for your mods…*. When a search or filter matches nothing it says *No mods match.*

## Which mods are listed

Only **mods**: installed plugins whose `hooks/hooks.json` loads a hooks module. Skills packs, language servers and MCP-only plugins are left to `/plugin`.

- A plugin installed for a **project or local** scope shows only in chats inside that project's folder.
- **New mods appear by themselves**: while the pane is open, the list is read again every 10 seconds.

## A mod's row

| Part | What it shows |
| --- | --- |
| **Icon and name** | A friendly title and icon for known mods (for example **◷ Cache Clock & Handoff**, **▤ Chat Inventory**). Others get their package name in title case and **◆**. Greyed out when off. |
| **Description** | The first sentence of the mod's own description. |
| **Hint** | How to reach it: `/inventory to open` for a mod with a pane, `/handoff-new to run` for one with a command. It reads *applies after reload* (in yellow) once you changed it through the CLI. |
| **Open** | On mods that have a pane and a command, while they are on. Runs that command. |
| **◉ Shown / ◌ Hidden** | The eye. Only on your mods that read the switch file **and** draw something outside a pane (a card above the prompt, a status-bar button, and so on). |
| **● On / ○ Off** | The switch. Shows **···** in yellow while a CLI call runs. |
| **this pane** | Shown instead of a switch on the Mods row itself. The Mods pane always stays on: it is how you switch the others. |

Pressing a mod's name also flips its switch.

## The switchboard: how On, Off and Hidden work

Your mods share one small file: **`~/.claude/mods/switches.json`**. The Mods pane writes it; every mod from this repository reads it every 3 seconds. That is why a change reaches every open chat, in every terminal, within 3 seconds and with no reload.

### The file

```json
{
  "chat-inventory": false,
  "cache-handoff:hidden": true
}
```

| Entry | Meaning |
| --- | --- |
| `"<mod>": false` | The mod is **off** in every chat. |
| `"<mod>:hidden": true` | The mod is **hidden** in every chat: it keeps working but draws nothing. |
| No entry | On and shown. This is the default. |

Turning a mod back on, or showing it again, removes its entry. A missing, empty or broken file reads as "everything on". Before each write the pane reads the file again, so a change made from another chat is kept.

### What Off does

A mod that is switched off:

- stops acting: its hooks pass everything through untouched;
- draws nothing: no card, no status-bar button;
- answers its own commands with *"<Mod> is off. Turn it on in /mods."*;
- shows *"<Mod> is off in every chat. Turn it on in /mods."* in its pane, if it has one.

The footer confirms, for example *Chat Inventory is off in every chat.*

If you switch one of your mods **on** while its plugin is disabled in Claude Code, the pane also enables the plugin through the CLI. That part applies after a reload.

### What Hidden does

A hidden mod keeps doing its job but draws nothing outside its pane. For example, a hidden Cache Clock keeps auto-warming the cache with its card gone, and a hidden Chat Inventory keeps counting with its status-bar button gone (its pane still opens with `/inventory`). The footer confirms: *Chat Inventory is hidden in every chat. It keeps working, out of sight.*

A mod with nothing to hide (no eye) replies *"<Mod> has nothing to hide from the Mods panel."* to `/mods hide`.

### Which mods follow the switchboard

A mod follows it when its hooks code starts the shared switch reader (each such mod carries an identical copy of `hooks/switch.tsx`). Today that covers most mods in this repository. A mod that does not read the file, even one from this repository, is switched through the CLI like the [other mods](#other-mods-and-apply).

## Other mods and Apply

Mods that do not read the switch file are enabled or disabled for real:

1. The switch runs `claude plugin enable <id> --scope <scope>` (or `disable`). The switch shows **···** meanwhile.
2. The row's hint turns to *applies after reload*, the footer says *Reflect is disabled. It applies after a reload: press Apply.*, and **≡ Mods** gets a **•**.
3. **Apply** (key `a`) runs `/reload-plugins`. The footer says *Plugins reloaded.* `/mods reload` does the same.

If the CLI call fails, the footer shows its error, for example *Could not disable …*.

## Search and filters

- **Search mods…** matches the mod's id, title and description. (The search box shows only where the surface has a text field.)
- **All**, **On** and **Off** (keys `1`, `2`, `3`) show every mod, only those on, or only those off.

## Slash commands

`<name>` can be the mod's name (`chat-inventory`), its full id (`chat-inventory@my-mods`) or its title (`Chat Inventory`), in any case. If a name matches several mods, use the full id.

| Command | Does |
| --- | --- |
| `/mods` | Opens or closes the pane (`/mods ui` too). |
| `/mods list` | Prints every mod and its state, for example `[ON ] Chat Inventory (chat-inventory@my-mods v0.1.1, hidden)`. |
| `/mods status <name>` | Prints one mod's line. |
| `/mods enable <name>` | Turns a mod on. |
| `/mods disable <name>` | Turns a mod off. |
| `/mods toggle <name>` | Flips a mod. |
| `/mods hide <name>` | Keeps a mod on but out of sight. |
| `/mods show <name>` | Shows a hidden mod again. |
| `/mods reload` | Applies plugin changes to this session (`/reload-plugins`). |
| `/mods help` | Prints the usage. Any unknown word, or a missing name, prints it too. |

Enable, disable and toggle follow the same rules as the switch: instant through the switch file for your mods, through the CLI (then reload) for the others.

## Keyboard

While the pane has focus:

| Key | Does |
| --- | --- |
| `j` / `k` | Move the highlight down / up |
| `t` | Switch the highlighted mod on or off |
| `h` | Hide or show the highlighted mod |
| `o` | Open the highlighted mod's pane |
| `1` `2` `3` | All, On, Off filter |
| `a` | Apply (when a reload is waiting) |
| Tab, arrows, Enter | Move between buttons and press; the highlight follows |
| Esc | Close the pane |

## Settings

None. The mod has no settings screen and no `userConfig` fields. The filter, search and highlighted row last for the session.

## What it stores and where

| What | Where |
| --- | --- |
| Off and hidden switches for your mods | `~/.claude/mods/switches.json` |
| Enabled or disabled state of other mods | Claude Code's own plugin settings, changed through `claude plugin enable` / `disable` |

Nothing else is written. The mod list is read from `claude plugin list --json` and each mod's own files.

## Limits and good to know

- **Your mods** means mods installed from a marketplace named `my-mods`. Installed under another marketplace name, they show under **Other mods**, but still follow the switch file if their code reads it.
- **The pane keeps itself up to date only while it is open**: the switch file every 3 seconds, the mod list every 10 seconds. While it is closed, the **≡ Mods** count is the one read when the session started or the pane was last open.
- **The Mods pane cannot switch itself off.** Uninstall it with `/plugin` if you no longer want it.
- **CLI calls** can take a few seconds; the switch shows **···** meanwhile and ignores further presses until done.
