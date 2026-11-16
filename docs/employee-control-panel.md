# Employee Control Panel: user guide

A Claude Code mod that lets you switch the model and the effort level with a click, for Claude itself and for the subagents it starts, without typing `/model` or `/effort`. It also adds a live three-line session bar under the prompt: model, effort, context, usage limits, running agents, git branch and tokens.

> Install: `claude plugin marketplace add nad-dev-1/my-mods`, then `claude plugin install employee-control-panel@my-mods --scope user`. The code is in [`employee-control-panel/`](../employee-control-panel/).

---

## Contents

- [What you need](#what-you-need)
- [Opening the panel](#opening-the-panel)
- [The panel at a glance](#the-panel-at-a-glance)
- [Picking for the main session](#picking-for-the-main-session)
- [Picking for subagents](#picking-for-subagents)
- [The status lines](#the-status-lines)
- [The session bar](#the-session-bar)
- [Slash commands](#slash-commands)
- [Keyboard](#keyboard)
- [Settings](#settings)
- [What it stores and where](#what-it-stores-and-where)
- [Turning it off or hiding it](#turning-it-off-or-hiding-it)
- [Limits and good to know](#limits-and-good-to-know)

---

## What you need

| Need | Why |
| --- | --- |
| Claude Code 2.1.287 or later | The version the mod is written for. |
| Claude Code's fullscreen layout (`/tui fullscreen`) | Only to click the status-bar button. `/controls` works anywhere. |
| `git` (optional) | The branch and changed lines on the session bar. Outside a git folder they are simply left out. |

No connections, accounts or other tools are needed.

## Opening the panel

- Click **◆ Control Tools ∧** in the status bar. While the panel is open the button turns orange and reads **◆ Control Tools ∨**; click it again to close the panel.
- Or type `/controls`.

The panel stays open after each pick, so you can change several things in one visit. **Close** or Esc shuts it.

## The panel at a glance

```
 ◆ C O N T R O L   T O O L S                     Opus 5.5 · High

 MODEL    Haiku 5.5  Sonnet 5.5  Opus 5.5  Fable 5.2
 EFFORT   Low  Medium  High  XHigh  Max

 ── S U B A G E N T S

 MODEL    Auto  Haiku 5.5  Sonnet 5.5  Opus 5.5  Fable 5.2
 EFFORT   Auto  Low  Medium  High  XHigh  Max

 ── S T A T U S

 ● Main: Opus 5.5 · effort high · in use
 ● Subagents (this project): Auto · effort Auto
 Forks always run as the main session.

 Close                                               Esc closes
```

| Part | What it is |
| --- | --- |
| **Header** | The title, and on the right the current main-session pick: model and effort. |
| **Top MODEL and EFFORT rows** | The main session (Claude in this chat). The pick is highlighted: orange for models, pink for effort. |
| **SUBAGENTS** | The same two rows for the agents Claude starts, each with **Auto** first. |
| **STATUS** | How the last picks went (see [The status lines](#the-status-lines)). |
| **Close** | Closes the panel. |

Model buttons show the family and a version. Each picks the **latest model of that family**. The model in use shows its real version; the others show the newest version the mod knew of when it was written.

## Picking for the main session

| Row | Choices |
| --- | --- |
| **MODEL** | Haiku, Sonnet, Opus, Fable |
| **EFFORT** | Low, Medium, High, XHigh, Max |

A pick runs `/model <name>` or `/effort <level>` for you, so it lasts exactly as if you had typed it.

- **While Claude is replying**, the pick waits and is applied as soon as the reply ends. A newer pick of the same kind replaces one that is still waiting.
- **A model pick that does not take** (for example, a model your account cannot use) is shown as refused, with the reason.
- `/model` and `/effort` that **you type yourself** show up in the panel and the bar too.

**Which effort is shown.** The effort level is the last one set with `/effort` on the current model in this session. If none was set, it is the level in your Claude Code settings for that model (or that model family), then your general effort setting. With none of these, it shows **default**.

## Picking for subagents

| Row | Choices |
| --- | --- |
| **MODEL** | **Auto** (Claude Code decides, as usual), Haiku, Sonnet, Opus, Fable |
| **EFFORT** | **Auto**, Low, Medium, High, XHigh, Max |

- **Model**: applied to every subagent as it starts, even when Claude or the agent's own definition asked for another model.
- **Effort**: set on every Agent tool call Claude makes.
- **Forks** (agents that continue the main conversation) always run as the main session, so both picks leave them alone.
- **Resumed agents** keep the model they started with.
- Agents started other ways than the Agent tool (for example by a workflow) get the model pick but not the effort pick.
- **Auto** removes the override.

Subagent picks are remembered **per project folder**. A new session in the same folder starts with them; a session in another folder starts on Auto.

## The status lines

Under **STATUS**:

1. **Main**: `Main: <model> · effort <level> ·` and how it went:

   | Mark | Meaning |
   | --- | --- |
   | `●` green, `in use` | Nothing picked yet this session; this is what is running. |
   | `●` green, `applied` | Your pick is in force. |
   | `◐` amber, `pending, applies when Claude finishes` | Picked while Claude is replying; it applies when the reply ends. |
   | `◐` amber, `switching…` | The pick is being applied now. |
   | `✕` red | Refused, with the first line of the reason (for example `Fable: … not available`). |

2. **Subagents**: `Subagents (this project): <model or Auto> · effort <level or Auto>`.
3. A reminder: `Forks always run as the main session.`

## The session bar

Under the prompt, below Claude Code's own hint line, three lines show the live session:

```
◆ Subscription │ ◆ Opus 5.5 │ effort high │ ctx ▰▰▱▱▱▱▱▱▱▱ 18% · 36.4k │ ◇ 0 agents │ sub Haiku/low
5h 6% │ block 2h 10m │ week 41% │ session 1h 05m
▸ my-project │ ⎇ main +12 −4 │ in 1.2k  out 3.4k  cached 120k  total 125k │ style default
```

### Line 1: model and context

| Part | What it is |
| --- | --- |
| `◆ Subscription` / `◆ API` | How the session signs in. |
| `◆ Opus 5.5` | The model in use. Amber with `…` while a model pick is waiting. |
| `effort high` | The effort level, colour-coded: low grey, medium blue, high amber, xhigh red, max violet. |
| `ctx ▰▰▱▱… 18% · 36.4k` | How full the context window is: a 10-cell meter, the percent and the tokens. |
| `◇ 0 agents` | Subagents running now (`◆` and blue when there are any). |
| `sub Haiku/low` | The subagent override, only when one is set. |

### Line 2: usage limits and time

| Part | What it is |
| --- | --- |
| `5h 6%` | How much of the 5-hour usage limit is used. |
| `block 2h 10m` | How far into the current 5-hour window you are. |
| `week 41%` | How much of the weekly limit is used. |
| `session 1h 05m` | How long this session has been running. |

The percents (and the context percent on line 1) are green under 70%, amber from 70%, red from 90%. Limit figures appear only when Claude Code reports them, which is on a subscription.

### Line 3: where you are working

| Part | What it is |
| --- | --- |
| `▸ my-project` | The working folder. |
| `⎇ main +12 −4` | The git branch, and lines added and removed in tracked files not yet committed. |
| `in … out … cached … total …` | Tokens used by this session's replies (not counting subagents): input, output, cache (read and written) and the total. |
| `style default` | The output style. |

Any figure that is not known is left out. The bar updates when a pick lands, after each reply, as agents start and finish, and every 30 seconds for the clocks and git.

## Slash commands

| Command | Does |
| --- | --- |
| `/controls` | Opens the panel. |

The panel itself runs Claude Code's `/model` and `/effort` for you.

## Keyboard

| Key | Does |
| --- | --- |
| Esc | Closes the panel. |

The panel has no hotkeys of its own.

## Settings

The mod has no settings of its own. Its only choices are the picks in the panel.

## What it stores and where

- **Subagent picks**, one entry per project folder, in the mod's own store on your machine.
- Main-session picks are not stored by the mod: they go through `/model` and `/effort`, which keep them as Claude Code always does.

Nothing is sent anywhere.

## Turning it off or hiding it

The **Mods** panel (`/mods`, from the mod-manager mod) has a switch for Control Tools:

- **Off**: the button and the session bar go away in every chat within about 3 seconds, subagent overrides stop, and `/controls` answers "Control Tools is off. Turn it on in /mods."
- **Hidden**: the overrides keep working, but the button and the session bar are not drawn.

The **◆ Control Tools** button sits first in the shared status-bar grid: every mod in this collection puts its button in one three-row grid at the right edge of the status bar, in a fixed order.

## Limits and good to know

- **Picks apply between replies.** A main-session pick made while Claude is replying waits for the reply to end.
- **Forks are never changed.** They always run with the main session's model and effort.
- **Subagent picks belong to the project folder**, not to you globally. Set them once per project.
- **Version labels** on the model buttons other than the one in use are fixed in the mod, so they may lag behind newer releases. The button still picks the latest model of that family.
- **Clicking the status-bar button** needs the fullscreen layout (`/tui fullscreen`). `/controls` works in any layout.
- **While the mod is switched off in `/mods`**, typing `/model` or `/effort` answers "Control Tools is off. Turn it on in /mods." instead of running. Turn the mod back on to use them.
