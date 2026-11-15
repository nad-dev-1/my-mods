# Prompt Upgrade

A Claude Code mod that turns a rough prompt into a clear one before it is sent. It opens a pane, asks up to three quick multiple-choice questions, rewrites the prompt, and shows your original and the upgrade side by side. Nothing is sent until you press **Run it**.

## Commands

- `/better <rough prompt>`: upgrade that prompt.
- `/better`: open the pane with a box to type a prompt.
- `/better on` / `/better off`: turn automatic mode on or off. While it is on, prompts you type in the prompt box go to the pane first.
- `/better history`: show your last 20 upgrades. Pick one to reopen its review.

## The Upgrade button

The status bar has a gold **✦ Upgrade** button (click it in the fullscreen layout, `/tui fullscreen`). With text in the prompt box, it takes that text and upgrades it, as `/better <text>` would; Cancel or Esc puts it back. With an empty box, it opens the pane to type a prompt. While an upgrade is under way the button reads **✦ Upgrade …** and brings the pane back.

## What automatic mode leaves alone

Slash commands, prompts with files or images attached, messages typed while Claude is working, short replies such as "yes" or "keep going", and anything starting with `>`. The `>` is removed before the prompt is sent.

## The steps

1. **Your prompt**: the mod reads it.
2. **Questions**: up to three, each with two to four options, plus "Other (type it)" and "Skip".
3. **Rewrite**: the upgraded prompt and a list of what was added. Unknown details are left as `[placeholders]`. Nothing is invented.
4. **Review**: word counts, then **Run it**, **Edit**, **Copy** and **Cancel**, then the two versions side by side.

Cancel, Esc, or closing the pane puts your original prompt back in the prompt box.

## Cost and data

Each upgrade makes up to two calls to the `haiku` model, billed to your Claude Code account like any other request. Your last 20 upgrades are kept in the mod's own store under your Claude Code configuration directory.
