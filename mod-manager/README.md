# Mods

A Claude Code mod: a side pane that lists every mod you have installed, with one switch each. The look and behaviour follow "Mod #9" (Switchboard) of Ben AI's *9 Insane Claude Mods* video; this is an independent build.

```
≡ Mods  9 on · 1 off                                   All  On  Off
Your mods
▶ ◷ Cache Clock & Handoff                          ◉ Shown   ● On
    A Cache Clock card above the prompt (…)
    /handoff-new to run
  ▤ Chat Inventory                         Open    ◌ Hidden  ● On
    A side pane, In this chat, with live cards (…)
    /inventory to open
Other mods · on/off applies after a reload
  ↻ Reflect                                                  ○ Off
    applies after reload                                     [Apply]

Chat Inventory is hidden in every chat. It keeps working, out of sight.
Off means off in every chat. Hidden keeps it on but out of sight.
Changes apply within 3 seconds. New mods appear here by themselves.
```

## What it lists

Only mods (plugins with a hooks module): yours first, then the others. Skills packs, language servers and MCP-only plugins are left to `/plugin`. Each row has an icon, the mod's name, the first sentence of its description, and how to reach it (`/inventory to open`).

## The switches

- **Your mods** (this repository's mods) read a shared switch file, `~/.claude/mods/switches.json`, every 3 seconds. **On/Off** turns a mod off in every open chat within 3 seconds, with no reload: it stops acting and drawing, and its commands say it is off. Each mod carries an identical `hooks/switch.tsx` and guards its hooks with it.
- **The eye** (Shown/Hidden), on mods that draw something outside a pane: Hidden keeps the mod working but draws nothing (no card, no status-bar button). Cache Clock keeps auto-warming the cache with its card gone, for example.
- **Other mods** are enabled or disabled for real through `claude plugin enable/disable`; the row says *applies after reload* and **Apply** runs `/reload-plugins`.
- The Mods row itself has no switch.

## More

- **Open** on mods with a pane runs their command (`/inventory`, `/dock`, `/report`, …).
- **New mods appear by themselves**: while the pane is open the list is read again every 10 seconds.
- **Search** and the **All / On / Off** filter narrow the list.
- **Keys**: `j`/`k` move, `t` switches, `h` hides or shows, `o` opens, `a` applies, Esc closes.
- **Commands**: `/mods` opens or closes the pane; `/mods list`, `/mods status <name>`, `/mods enable|disable|toggle <name>`, `/mods hide|show <name>`, `/mods reload`. A name can be the mod's name, its id or its title.
- The **≡ Mods** button in the status bar shows how many are on and opens or closes the pane.

## Install

```bash
claude plugin marketplace add nad-dev-1/my-mods
claude plugin install mod-manager@my-mods --scope user
```
