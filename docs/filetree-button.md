# Files button: user guide

A small Claude Code mod that adds a **▤ Files** button to the status bar. One click shows or hides the file tree from the separate **filetree** mod, the same as typing `/filetree`. The tree itself, and everything you do in it, belongs to filetree: this mod only adds the button.

**This mod does nothing on its own. The filetree mod must be installed and turned on.**

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install filetree-button@my-mods --scope user`. The code is in [`filetree-button/`](../filetree-button/).

---

## Contents

- [What you need](#what-you-need)
- [The button](#the-button)
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
| The **filetree** mod, installed and on | It draws the file tree and owns the `/filetree` command. It is a separate mod and is not part of this marketplace. |
| The **mod-manager** mod (optional) | Its `/mods` panel turns this button off, or hides it, in every chat. |

## The button

**▤ Files** sits in the status bar, in teal. It shares a grid of status-bar buttons with the other mods from this marketplace: the buttons are laid out in three rows, in a fixed order, at the right edge of the bar, so they never push each other off.

## What a press does

1. The button looks for the `/filetree` command, preferring the one that comes from the plugin named `filetree`.
2. It runs that command, exactly as if you had typed `/filetree`. filetree shows its tree in a sidebar, or hides it when it is already showing.

What the tree shows and how you move around in it is up to filetree; see that mod's own documentation.

## Messages you may see

| Message | Meaning |
| --- | --- |
| *filetree is not on. Turn it on in Mods, then /reload-plugins.* | No `/filetree` command was found: filetree is not installed, or it is turned off. |
| filetree's own explanation | When filetree says it cannot show the tree right now (for example because of the layout or the window width), its reply is passed on as a pop-up message. |
| *The file tree could not open (…)* | Something went wrong while running the command; the reason is in brackets. |

## Slash commands and keyboard

This mod adds no slash commands and no keys. To show or hide the tree without the button, type `/filetree` (filetree's own command).

## Settings

None. There are no `userConfig` fields in `plugin.json` and no settings inside the mod.

## Turning the button off or hiding it

The button reads the on/off switches that the **mod-manager** mod's `/mods` panel writes to `~/.claude/mods/switches.json` (it appears there as **Files button**). A change reaches every open chat within about 3 seconds, with no reload. Since this mod only draws a button, **Off** and **Hidden** both simply remove the button. filetree itself is not affected.

## What it stores

Nothing. The mod keeps no data and writes no files.

## Limits and good to know

- Turning filetree on or off only takes effect after `/reload-plugins` (or a restart), as the message says.
- If another installed mod also has a command named `filetree`, the button prefers the one from the filetree plugin, but falls back to any command with that name.
