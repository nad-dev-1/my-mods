# Inject Prompt

A Claude Code mod for prompts you use again and again. The blue **» Inject** button in the status bar (or `/inject`) opens a dialog of your saved prompts, grouped by category. Tick one or more, press **Inject**, and the text goes into the prompt box where your cursor was. Nothing is sent: you read it, edit it and press Enter yourself.

## The dialog

- **Filter** by category or tag with the chips, or type in the search box (title, text, category or `#tag`).
- **Expand** a prompt to read it in full: press its title, or `e`. Press again to collapse.
- **Tick** prompts with their `[ ]` box, or `x`. Ticked prompts are numbered; several are inserted in that order, a blank line apart. With none ticked, Inject takes the highlighted one.
- **Placeholders**: `{{name}}` in a prompt is asked for before inserting, one value at a time. "Leave as is" keeps the `{{name}}`.
- **Add** (`a`) saves a new prompt with a title, category, tags and text. It starts from what was in the prompt box.
- Keys: ↑/↓ (or `j`/`k`) move, → unfolds and ← folds the highlighted prompt, Enter injects the ticked prompts (with none ticked it folds or unfolds), `x` tick, `e` expand, `u`/`d` page, `s` search, `i` inject, `a` add, `c` clear filters and ticks, Esc closes and puts your draft back as it was.
- The Inject, Add, Clear and Close buttons stay at the bottom of the dialog; only the list scrolls (wheel, arrows, or `u`/`d`).

## Where the prompts live

`~/.claude/inject-prompts.json`, created with a few starters the first time. Edit it by hand any time; it is re-read each time the dialog opens:

```json
{
  "prompts": [
    { "title": "Explain a file", "category": "Understand", "tags": ["explain"], "text": "Explain what {{file}} does." }
  ]
}
```

A file that does not parse is never overwritten: the dialog says why, and you fix it.

## Notes

- Clicking status-bar buttons needs the fullscreen layout (`/tui fullscreen`); `/inject` works anywhere.
- While the dialog is open your draft is set aside (a dialog only takes the keyboard over an empty prompt box) and comes back on close, with the injected text at the cursor.
