# Inject Prompt: user guide

A Claude Code mod for prompts you use again and again. Keep them in one file, grouped by category and tagged. Open the dialog, tick one or more, fill in any blanks, and the text goes into the prompt box where your cursor was.

**Nothing is sent.** The text only lands in the prompt box. You read it, change it if you like, and press Enter yourself.

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install inject-prompt@my-mods --scope user`. The code is in [`inject-prompt/`](../inject-prompt/).

---

## Contents

- [What you need](#what-you-need)
- [Opening it](#opening-it)
- [The dialog at a glance](#the-dialog-at-a-glance)
- [Finding a prompt](#finding-a-prompt)
- [Picking and injecting](#picking-and-injecting)
- [Placeholders](#placeholders)
- [Adding a prompt](#adding-a-prompt)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Settings](#settings)
- [Where the prompts live](#where-the-prompts-live)
- [Turning it off or hiding it](#turning-it-off-or-hiding-it)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| Claude Code with mods (plugins with hooks) | The mod is a hooks module. |
| The fullscreen layout (`/tui fullscreen`) to click the status-bar button | Status-bar buttons only take clicks there. `/inject` works in any layout. |

Nothing else: no accounts, no network, no model calls.

## Opening it

- **» Inject** (blue) in the status bar opens the dialog. It turns a lighter blue while the dialog is open; press it again to close the dialog.
- `/inject` opens it too.
- The first time it opens, the mod creates the prompts file with a few starter prompts and says so under the list.

Your draft stays in the prompt box while the dialog is open. When the box already has text in it, the dialog opens **without the keyboard** (a dialog only takes the keyboard over an empty prompt box). The dialog then says **Your draft stays in the prompt box. Click in here to use the keys.** Click anywhere in the dialog to use its keys.

## The dialog at a glance

```
 » Inject prompt                              7 of 7 · 1 ticked
 [ Search title, text or #tag…                              ]

 Category  All  Debug  Review  Style  Testing  Understand  Workflow
 Tag       All  #bug  #explain  #git  #planning  #review  #style  #tests

   ↑ 2 more lines
 DEBUG  1
 ▶ [ ]  ▸ Find a bug's root cause  #bug
         There is a bug: {{symptom}}. Steps to reproduce: {{steps}}. Find…

 REVIEW  1
   [1]  ▸ Review this branch  #review #git
         Review the changes on this branch for bugs, missing tests and…
   ↓ 14 more lines
 Inject  Add  Clear  Close
 ↑  ↓  Tick  Expand  PgUp  PgDn  Search  · ↑↓ move · ←→ fold · Enter injects ticked · Esc closes
 Saved "Explain a file" in Understand.
```

| Part | What it is |
| --- | --- |
| **Header** | How many prompts are shown out of all of them, and how many are ticked. |
| **Search box** | Narrows the list as you type. |
| **Category** chips | **All**, then every category, A to Z. |
| **Tag** chips | **All**, then every tag, A to Z. Only shown when at least one prompt has a tag. |
| **The list** | Prompts grouped by category (A to Z), each group headed by its name in capitals and a count. Within a group, prompts keep the order of the file. |
| **Each row** | `▶` marks the highlighted prompt. `[ ]` is its tick box; a ticked prompt shows its number, `[1]`, `[2]`, in the order you ticked. `▸` / `▾` folds or unfolds it. Then the title and its tags. |
| **Preview line** | Under a folded prompt: the start of its text on one line. An unfolded prompt shows its full text instead. |
| **↑ / ↓ more lines** | How much of the list is out of view above and below. |
| **Buttons at the bottom** | Always in view; only the list scrolls. |
| **Note line** | The last thing that happened (saved, created, an error). |

When there are no prompts at all, the list says **No saved prompts yet. Press a to add one.** When a filter hides everything, it says **No prompts match.**

## Finding a prompt

- **Search**: type words. A prompt shows when **every** word appears somewhere in its title, text, category or tags. `#review` searches for the tag word `review`. Case does not matter.
- **Category** chip: shows one category. Press the same chip again, or **All**, to show every category.
- **Tag** chip: shows prompts with that tag. Press it again, or **All**, to clear it.
- Search, category and tag work together.
- **Clear** (`c`) empties the search, both filters and every tick.

## Picking and injecting

1. **Highlight** a prompt with ↑ / ↓ (or `k` / `j`).
2. **Read it**: unfold it with → , `e`, or its `▸` mark. Fold it again with ← , `e`, or `▾`.
3. **Tick** it with `x` or its `[ ]` box. Tick more if you want several.
4. Press **Inject** (`i`), or Enter.

| What is ticked | What Inject puts in the box |
| --- | --- |
| Nothing | The highlighted prompt. |
| One prompt | That prompt. |
| Several | All of them, in the order you ticked them, a blank line apart. The button reads **Inject 3** and so on. |

The text goes in **at your cursor** in the prompt box, with your draft kept around it. Anything you typed in the box while the dialog was open is kept too. Ticks are cleared after an inject.

**Enter on a row**: with prompts ticked, it injects them. With nothing ticked, it folds or unfolds the highlighted prompt. Clicking a prompt's title does the same.

## Placeholders

Write `{{name}}` in a prompt to mark a value you fill in each time, for example `Explain what {{file}} does.`

When you inject a prompt with placeholders, the dialog asks for each one before inserting:

```
 » Inject prompt                                      value 1 of 2
 ▶ {{symptom}}
   {{steps}}

 symptom [ Value for symptom                               ]
 Leave as is  Back
```

- Values are asked **one at a time**, in the order they first appear. Answered ones show `✓ {{name}} = value`.
- Type the value and press Enter (**next**, or **inject** on the last one).
- **Leave as is** keeps `{{name}}` in the text unchanged.
- **Back** returns to the list without inserting anything.
- A name used several times, or in several ticked prompts, is asked **once** and filled in everywhere.

### Defaults

Write `{{name|default}}` to give a placeholder a default, for example `{{branch|main}}`.

- The field starts filled with the default, and its hint reads **Enter keeps: main**.
- A **Use default (main)** button appears beside **Leave as is**.
- When the same name has defaults in several places, the first one is used.

## Adding a prompt

Press **Add** (`a`). A form opens with four fields:

| Field | Notes |
| --- | --- |
| **Title** | A short name. When empty, the first line of the prompt is used (up to 50 characters). |
| **Category** | When empty, **General**. |
| **Tags** | Comma or space separated. A leading `#` is removed. |
| **Prompt** | The text. Starts with what was in the prompt box, if anything. `{{name}}` marks a value to ask for. |

Enter in a field keeps what you typed. Enter in **Prompt**, or the **Save** button, saves the prompt. **Cancel** clears the form and goes back to the list.

The new prompt is added to the end of the file. The note line says **Saved "Title" in Category.** A prompt with no text is not saved: the form says **Write the prompt text first.**

## Slash commands

| Command | Does |
| --- | --- |
| `/inject` | Open the dialog of saved prompts. Takes no arguments. |

## Keyboard

These work once the dialog has the keyboard (see [Opening it](#opening-it)).

| Key | Does |
| --- | --- |
| ↑ / ↓, or `k` / `j` | Move the highlight one prompt |
| → / ← | Unfold / fold the highlighted prompt |
| `x` | Tick or untick the highlighted prompt |
| `e` | Unfold or fold the highlighted prompt |
| `u` / `d` | Scroll the list a page up / down |
| `s` | Jump to the search box |
| `i` | Inject |
| `a` | Add a prompt |
| `c` | Clear search, filters and ticks |
| Enter | Inject the ticked prompts; with none ticked, fold or unfold |
| Mouse wheel | Scroll the list |
| Esc | Close the dialog |

On screen, the bottom row repeats these as buttons: **↑**, **↓**, **Tick**, **Expand**, **PgUp**, **PgDn**, **Search**.

## Settings

The mod has no install-time settings and no settings screen. What it shows is controlled by the prompts file below.

## Where the prompts live

All prompts are in one file: **`~/.claude/inject-prompts.json`**.

- It is created the first time the dialog opens, with seven starters: *Plan before coding*, *Review this branch*, *Explain a file*, *Find a bug's root cause*, *Write tests*, *Commit the changes* and *Keep it short*.
- Edit it by hand whenever you like. It is read again **each time the dialog opens**, and again just before **Add** saves.

### File format

```json
{
  "prompts": [
    {
      "id": "explain-file",
      "title": "Explain a file",
      "category": "Understand",
      "tags": ["explain"],
      "text": "Explain what {{file}} does, who calls it, and anything surprising in it."
    },
    {
      "title": "Release notes",
      "category": "Writing",
      "tags": ["release", "docs"],
      "text": "Write release notes for {{version|the next release}} from the merged changes."
    }
  ]
}
```

| Field | Required | If missing |
| --- | --- | --- |
| `text` | Yes | The entry is skipped. Use `\n` for a new line. |
| `title` | No | The first line of the text, up to 50 characters. |
| `category` | No | `General`. |
| `tags` | No | No tags. A list of words. |
| `id` | No | Made from the title (lower case, dashes). Two entries with the same id get `-2` added. |

A plain list of prompts, without the `{ "prompts": … }` wrapper, is read too.

**A file that does not parse is never overwritten.** The dialog says **Could not read … Fix the file, then reopen.** with the reason, and Add will not save until the file is fixed.

## Turning it off or hiding it

The mod reads a shared switch file used by the **Mods** mod (`mod-manager`). In its pane (`/mods`):

- **Off** stops the mod in every open chat within about 3 seconds. `/inject` then answers **Inject Prompt is off. Turn it on in /mods.**
- **Hidden** keeps the mod working but removes the **» Inject** button. `/inject` still opens the dialog.

The status-bar button sits in a grid shared by all the mods in this collection, in the "prompt tools" column next to **✦ Upgrade** (Prompt Upgrade).

## Limits and good to know

- **Clicking the status-bar button needs `/tui fullscreen`.** `/inject` works anywhere.
- **Your draft is never removed** from the prompt box. Closing the dialog without injecting (Esc, **Close**, or the button) leaves it as it was.
- **If the prompt box will not take the text** right away, the mod tries again for about 3 seconds. If it still fails, the text is copied to the clipboard and a message says to paste it.
- **Add rewrites the whole file** in a tidy form: two-space indents, an `id` on every entry, and entries with no text left out. Any extra fields you added by hand are not kept.
- **Tags cannot contain spaces**: in the Add form, a space separates tags.
- **Leave as is** on a placeholder with a default keeps it as `{{name}}`, without the default.
- **If the dialog cannot open** (for example the window is too small), a message says **Inject could not open:** and why.
- The dialog is 72 columns wide and 30 rows tall when there is room.
