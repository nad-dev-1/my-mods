# Replay button: user guide

A small Claude Code mod that adds a **▶ Replay** button to the status bar. The button shows how many file edits Claude made in its last turn that changed files, and one click opens **Replay Theater**, the separate mod that steps through those edits one by one. The replay pane, the diffs and the stepping all belong to Replay Theater: this mod only counts the edits and adds the button.

**This mod does nothing useful on its own. The Replay Theater mod must be installed and turned on.**

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install replay-button@my-mods --scope user`. The code is in [`replay-button/`](../replay-button/).

---

## Contents

- [What you need](#what-you-need)
- [The button](#the-button)
- [How edits are counted](#how-edits-are-counted)
- [What a press does](#what-a-press-does)
- [Messages you may see](#messages-you-may-see)
- [Slash commands and keyboard](#slash-commands-and-keyboard)
- [Settings](#settings)
- [Turning the button off or hiding it](#turning-the-button-off-or-hiding-it)
- [What it stores](#what-it-stores)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| The **Replay Theater** mod, installed and on | It draws the replay and owns the `/replay` command. It is a separate mod and is not part of this marketplace. |
| The **mod-manager** mod (optional) | Its `/mods` panel turns this button off, or hides it, in every chat. |

## The button

The button sits in the status bar. It shares a grid of status-bar buttons with the other mods from this marketplace: the buttons are laid out in three rows, in a fixed order, at the right edge of the bar, so they never push each other off.

| Looks like | Means |
| --- | --- |
| **▶ Replay** in grey | No edits counted yet in this session. |
| **▶ Replay 4** in pink | Claude's last turn that changed files made 4 edits. |

## How edits are counted

- Every file edit or file write Claude makes during a turn adds one. A multi-edit call adds one per edit inside it.
- When the turn ends, the count becomes that turn's total.
- **A turn with no edits keeps the last count**, so the button still points at the last set of changes.
- A new turn that does edit files replaces the count.
- The count starts at zero each time the session starts or the mod reloads.

## What a press does

1. The button looks for the `/replay` command, preferring the one that comes from the plugin named `replay-theater`.
2. It runs that command, exactly as if you had typed `/replay`. Replay Theater then opens its step-through of the last turn's file edits.

How the replay looks and how you step through it is up to Replay Theater; see that mod's own documentation.

## Messages you may see

| Message | Meaning |
| --- | --- |
| *Replay Theater is not on. Turn it on in Mods, then /reload-plugins.* | No `/replay` command was found: Replay Theater is not installed, or it is turned off. |
| *Replay: no file edits to show yet.* | Replay Theater answered that it has no edits to show. |
| *Replay could not open (…)* | Something went wrong while running the command; the reason is in brackets. |

## Slash commands and keyboard

This mod adds no slash commands and no keys. To open the replay without the button, type `/replay` (Replay Theater's own command).

## Settings

None. There are no `userConfig` fields in `plugin.json` and no settings inside the mod.

## Turning the button off or hiding it

The button reads the on/off switches that the **mod-manager** mod's `/mods` panel writes to `~/.claude/mods/switches.json` (it appears there as **Replay button**). A change reaches every open chat within about 3 seconds, with no reload.

| Switch | Effect |
| --- | --- |
| **Off** | The button is gone and edits are no longer counted. |
| **Hidden** | The button is gone, but edits are still counted, so the number is right when you show it again. |

Replay Theater itself is not affected either way.

## What it stores

Nothing on disk. The edit count is kept only for the running session.

## Limits and good to know

- The number on the button is this mod's own count of edit calls, taken as each call starts. An edit that was refused or failed is still counted, and edits made by helper agents during the turn are counted too, so the number may not match what Replay Theater shows.
- Turning Replay Theater on or off only takes effect after `/reload-plugins` (or a restart), as the message says.
- If another installed mod also has a command named `replay`, the button prefers the one from Replay Theater, but falls back to any command with that name.
