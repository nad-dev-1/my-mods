# Prompt Upgrade: user guide

A Claude Code mod that turns a rough prompt into a clear one before it is sent. It opens a side pane, asks up to three quick multiple-choice questions, rewrites the prompt, and shows your original and the upgrade side by side.

**Nothing is sent until you press Run it.** Cancel, Esc or closing the pane puts your original prompt back in the prompt box.

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install prompt-upgrade@my-mods --scope user`. The code is in [`prompt-upgrade/`](../prompt-upgrade/).

---

## Contents

- [What you need](#what-you-need)
- [Opening it](#opening-it)
- [The four steps](#the-four-steps)
- [Step 1: Your prompt](#step-1-your-prompt)
- [Step 2: Questions](#step-2-questions)
- [Step 3: Rewrite](#step-3-rewrite)
- [Step 4: Review](#step-4-review)
- [When a step fails](#when-a-step-fails)
- [History](#history)
- [Automatic mode](#automatic-mode)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Settings](#settings)
- [Cost and data](#cost-and-data)
- [Turning it off or hiding it](#turning-it-off-or-hiding-it)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| Claude Code, signed in | Each upgrade calls the `haiku` model through your Claude Code account. |
| A window wide enough for a side pane | If the pane cannot open, your prompt goes back in the box and nothing happens. |
| The fullscreen layout (`/tui fullscreen`) to click the status-bar button | Status-bar buttons only take clicks there. `/better` works in any layout. |

## Opening it

There are three ways in.

| Way | What happens |
| --- | --- |
| `/better <rough prompt>` | Upgrades that prompt. |
| `/better` on its own | Opens the pane with a box to type a prompt. |
| **✦ Upgrade** (gold) in the status bar | With text in the prompt box: takes that text out of the box and upgrades it, as `/better <text>` would. With an empty box: opens the pane to type a prompt. |

While an upgrade is under way, the button turns amber and reads **✦ Upgrade …**. Pressing it then brings the pane back instead of starting a new upgrade.

You can also let the mod catch prompts as you type them: see [Automatic mode](#automatic-mode).

## The four steps

The top of the pane shows where you are:

```
 PROMPT UPGRADE
 ━━━━━━━━━━━━━━──────────────────────────────────────────────
 ✓ YOUR PROMPT ── ● QUESTIONS ── ○ REWRITE ── ○ REVIEW
```

`✓` is done, `●` is the current step, `○` is still to come. On a narrow pane the labels shorten to **PROMPT, ASK, WRITE, REVIEW**, or to **1 2 3 4**.

## Step 1: Your prompt

- With `/better <text>` or the button, the mod already has your prompt. The pane shows it in a **YOUR PROMPT** card with the line **Reading your prompt and picking the questions that would help most.**
- With `/better` on its own (or the button over an empty box), the pane shows a box: **Type the rough prompt you want to upgrade**. Type it and press Enter (**upgrade**). An empty box does nothing.
- **Cancel** is always there.

## Step 2: Questions

The model picks up to **three** questions whose answers would most improve the result. It only asks about what your prompt leaves open: the goal, who it is for, the format, the scope, what "done" looks like, or limits.

```
 Your prompt: "add a dark mode"
 QUESTIONS ───────────────────────────────────────────────────
 0 of 2 answered

  1  Which part should support dark mode?
     Whole app   Settings only   Other (type it)   Skip

  2  How is it turned on?
     Follows system   Manual toggle   Both   Other (type it)   Skip

 Skip the rest, upgrade now   Cancel
```

| Choice | What it does |
| --- | --- |
| An **option** (2 to 4 per question) | Picks it. The chip turns gold and the number becomes `✓`. |
| **Other (type it)** | Opens a field: **Type your answer, then Enter**. The chip then reads **Other: your answer**. Pressing Enter on an empty field closes it. |
| **Skip** | Leaves that question out. The chip reads **Skipped** and the number becomes `–`. |
| **Skip the rest, upgrade now** | Skips every question still open and moves on. |
| **Cancel** | Stops, and puts your prompt back in the box. |

The line under the heading counts answers: **1 of 2 answered**. You can change an answer until the last question is answered or skipped. Then the rewrite **starts by itself**.

If no question would clearly help, this step is skipped and the mod goes straight to the rewrite.

## Step 3: Rewrite

The pane shows your prompt and **Writing the upgrade from your prompt and 2 answers.** The model rewrites it under these rules:

- Keep exactly what you meant. Do not change the task.
- Add a clear goal, who it is for, the format of the result, and what "done" looks like.
- Use your answers. Leave out anything you skipped.
- **Never invent** facts, names, numbers, prices, file paths or versions. Where something needed is unknown, write a `[placeholder]` in square brackets.
- Write it as one request you could have typed yourself: plain language, first person, no headings.

## Step 4: Review

```
 ╭──────────────╮ ╭──────────────╮ ╭───────────────╮
 │      4       │ │      58      │ │       6       │
 │ WORDS BEFORE │ │  WORDS AFTER │ │ DETAILS ADDED │
 ╰──────────────╯ ╰──────────────╯ ╰───────────────╯
  Run it   Edit   Copy   Cancel

 WHAT I ADDED ────────────────────────────────────────────────
 + Clear goal
 + Definition of done
 ...
 ╭ YOUR PROMPT ────────╮ ╭ UPGRADE ────────────╮
 │ ...                 │ │ ...                 │
```

| Part | What it is |
| --- | --- |
| **Tiles** | Words before, words after, and how many details were added, in large digits. On a narrow pane they become one line: `4 words before · 58 after · 6 added`. |
| **Run it** | Sends the upgraded prompt to Claude, as if you had typed it, and closes the pane. |
| **Edit** | Opens the upgrade in a field (**EDIT THE UPGRADE**). Enter in the field runs your edited prompt. **Stop editing** keeps your changes and goes back to the buttons. |
| **Copy** | Copies the upgraded prompt. Says **Copied the upgraded prompt.**, or **Could not copy here. Select the text instead.** |
| **Cancel** | Puts your original prompt back in the box. Nothing is sent. |
| **What I added** | Up to 8 short items, each with `+`. Or **Nothing new was needed.** |
| **The two versions** | Your prompt and the upgrade, side by side when the pane is at least 64 columns wide, one above the other when it is narrower. |

## When a step fails

If a model call does not work, the pane shows an amber card:

```
 ╭ That did not go through ─────────────────────────╮
 │ Your prompt is safe. Nothing has been sent.      │
 │ The model is rate limited right now.             │
 ╰──────────────────────────────────────────────────╯
  Try again   Send my original   Cancel
```

| Button | Does |
| --- | --- |
| **Try again** | Repeats the step that failed (questions or rewrite). |
| **Send my original** | Sends your prompt as you wrote it. |
| **Cancel** | Puts your prompt back in the box. |

The reason line is one of: the model took too long (over 60 seconds), is rate limited, is overloaded, the call was not signed in, the answer was empty, the reply came back in a form the mod could not read, the request could not be sent, or a failed call with its error code.

## History

`/better history` opens a list of your **last 20 upgrades**, newest first:

```
 LAST 20 UPGRADES ────────────────────────────────────────────
 11-16 14:05  4>58 words  add a dark mode
 11-16 09:40  8>71 words  write a script that cleans old log files
```

- Each row: month-day and time, words before `>` words after, and the start of your original prompt.
- **Pick a row** to reopen its review, with **Run it**, **Edit**, **Copy** and **Cancel**.
- **Back** returns to the upgrade under way (only shown when there is one). **Close** closes the list.
- An upgrade is saved to history as soon as its rewrite is ready, even if you then cancel.
- If you edit an upgrade and run it, history keeps your edited version. (This does not apply to an upgrade you reopened from history.)

When the pane is open with no upgrade under way, it shows this list.

## Automatic mode

`/better on` makes the mod catch prompts you type in the prompt box. Instead of going to Claude, they open in the pane first, with the message **Opened in Prompt Upgrade. Nothing is sent until you press Run.** `/better off` turns it off.

Automatic mode is **off** until you turn it on, and it stays on (across chats) until you turn it off.

It **leaves these alone** and sends them as usual:

| Left alone | Example |
| --- | --- |
| Slash commands | `/help` |
| Prompts with files or images attached | |
| Messages typed while Claude is working | |
| Short replies | `yes`, `ok`, `keep going`, `lgtm`, `try again`, a one- or two-digit number, or any single word up to 14 letters |
| Prompts not typed in the prompt box | Text sent by another mod |
| Anything starting with `>` | `> just run the tests` is sent as `just run the tests` |

The `>` is removed before the prompt is sent. A lone `>` is sent unchanged.

## Slash commands

| Command | Does |
| --- | --- |
| `/better <rough prompt>` | Upgrade that prompt in the pane. |
| `/better` | Open the pane with a box to type a prompt. |
| `/better on` | Turn automatic mode on. |
| `/better off` | Turn automatic mode off. |
| `/better history` | Show your last 20 upgrades. |

`on`, `off` and `history` are read in any letter case. A prompt that is exactly one of those words cannot be upgraded with `/better`.

## Keyboard

| Key | Does |
| --- | --- |
| Esc | Close the pane. Same as **Cancel**: your prompt goes back in the box. |
| Enter | In a text field: submit it. On a button: press it. |

The pane puts the keyboard on the most likely next button: the first option of the first open question, **Run it** on the review, **Try again** on a failure.

## Settings

The mod has no install-time settings and no settings screen. The only switch is automatic mode (`/better on` / `/better off`). The model (`haiku`) and the limits (three questions, 20 history entries, 60-second wait) are fixed.

## Cost and data

- **Cost**: each upgrade makes up to **two** calls to the `haiku` model: one for the questions, one for the rewrite. **Try again** makes another. They are billed to your Claude Code account like any other request.
- **Stored**: your last 20 upgrades (original, upgrade, the list of what was added, and the time) and whether automatic mode is on. Both are kept in the mod's own store under your Claude Code configuration folder. Nothing else is kept.

## Turning it off or hiding it

The mod reads a shared switch file used by the **Mods** mod (`mod-manager`). In its pane (`/mods`):

- **Off** stops the mod in every open chat within about 3 seconds, automatic mode included. `/better` then answers **Prompt Upgrade is off. Turn it on in /mods.**
- **Hidden** keeps the mod working (commands and automatic mode) but removes the **✦ Upgrade** button.

The status-bar button sits in a grid shared by all the mods in this collection, in the "prompt tools" column next to **» Inject** (Inject Prompt).

## Limits and good to know

- **Your prompt is never lost.** Cancel, Esc and closing the pane all put the original back in the prompt box. Note that this **replaces** whatever is in the box at that moment.
- **The button takes your draft out of the box** while it works on it. It comes back on Cancel.
- **If the window is too narrow** for the pane, you see **Prompt Upgrade needs a wider window, so your prompt is back in the box.**
- **A reload in the middle of a step** picks the step back up and repeats its model call. Text typed in the Edit field and not yet run is lost on a reload.
- **Only one upgrade at a time.** Starting a new one with `/better` replaces the one under way.
- **Work Report** (another mod in this collection) counts a prompt you send with **Run it** as your own task.
