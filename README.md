# Strzelichowski Solutions: Claude Code plugins

Marketplace `strzelichowski-solutions` with one plugin, `context-guard`, plus an optional VS Code extension that shows its status. Requires Claude Code 2.1.292 or later (`claude --version`).

## Install

In Claude Code (terminal or VS Code panel):

```
/plugin marketplace add Fantomkiller/strzelichowski-solutions-claude-plugins
/plugin install context-guard@strzelichowski-solutions
```

Or from a shell, with options set at install time:

```
claude plugin marketplace add Fantomkiller/strzelichowski-solutions-claude-plugins
claude plugin install context-guard@strzelichowski-solutions --config reminder_percent=60 --config compact_percent=65
```

In VS Code you can also open this link, which goes straight to the plugin's install dialog:
`vscode://anthropic.claude-code/install-plugin?plugin=context-guard&marketplace=Fantomkiller/strzelichowski-solutions-claude-plugins`

From a local copy (unzipped or cloned), pass its path to `marketplace add` instead. Start a new session afterwards.

Optionally, VS Code users can also install the status bar extension, which shows the same figures on VS Code's own status bar (hover for bars and reset times, click for a menu with a usage panel):

```
gh release download --repo Fantomkiller/strzelichowski-solutions-claude-plugins --pattern '*.vsix'   # or take it from vscode-context-guard/ in a clone
code --install-extension context-guard-status.vsix
```

## What it does

| Feature | Where you see it |
| --- | --- |
| Context fill, 5-hour and weekly usage limits with time to reset, session cost | a line above the prompt (terminal and the Claude Code panel in VS Code); in the terminal also on the status line under the prompt |
| Handoff reminder once the main conversation passes **60%** of the model's context | yellow line above the prompt with a **Hide** button, plus a notification |
| `/context-guard:handoff`: writes `~/.claude/handoffs/<repo>/<branch>.md` and prints an opener for a fresh session; never commits, pushes, stages or stashes | in the conversation |
| Auto-compact of the main conversation at **65%**; a conversation that stays above the threshold after compacting is compacted again only after it grows 5 more points | notification, then Claude Code's own "Conversation compacted" |
| Warning when a 5-hour or weekly limit passes **80%** | notice added to the conversation |
| Token ceiling for subagents (default Claude Haiku 5.5, **100k**): an oversized tool result is cut so the next request stays under the ceiling; the subagent keeps working | in the subagent's tool result |

Usage limits appear on a Claude subscription only; with an API key the line shows context and cost. Figures refresh after each turn.

## What it looks like

Captured from a real terminal session (Claude Code 2.1.293, Claude Haiku 5.5, thresholds lowered so they trip on a short conversation). The Claude Code panel in VS Code shows the same line above its prompt box.

Usage line above the prompt and on the status line ([full capture](docs/screens/01-usage-line.txt)):

```
⏺ ready

✻ Sautéed for 1s · done 2:02 PM

ctx 5% | 5h 11% (reset 4h57m) | week 58% (reset 2d6h) | $0.01                                       [-]
─────────────────────────────────────────────────────────────────────────────────────────────────────
❯
─────────────────────────────────────────────────────────────────────────────────────────────────────
  ⚠ context-guard: ctx 5% | 5h 11% (reset 4h57m) | week 58% (reset 2d6h) | $0.01
```

Handoff reminder past the threshold ([full capture](docs/screens/02-handoff-reminder.txt)):

```
Context 5% (49k/1M): run /context-guard:handoff, then /clear. [ Hide ]                              [-]
ctx 5% | 5h 11% (reset 4h56m) | week 58% (reset 2d6h) | $0.00
─────────────────────────────────────────────────────────────────────────────────────────────────────
❯
```

Auto-compact ([running](docs/screens/03-auto-compact-running.txt), [done](docs/screens/04-auto-compact-done.txt)):

```
✢ Compacting conversation… (1s · ↓ 4 tokens)

Context 5% (49k/1M): run /context-guard:handoff, then /clear. Auto-compact at 2%. [ Hide ]
...
  ⏵⏵ auto mode on · esc to interrupt                         context-guard: Context 5% passed 2%: compacting

✻ Conversation compacted (ctrl+o for history)
```

`/context-guard:handoff` ([full capture](docs/screens/06-handoff-skill.txt), [the file it wrote](docs/examples/handoff-PFX-42-demo.md)):

```
⏺ Write(~/.claude/handoffs/demo-project/PFX-42-demo.md)
  ⎿  Wrote 37 lines to ~/.claude/handoffs/demo-project/PFX-42-demo.md

⏺ The handoff file is written to ~/.claude/handoffs/demo-project/PFX-42-demo.md. The repo is unchanged:
  nothing was added, committed, pushed or stashed.

  Working directory must be /Users/you/work/demo-project on branch PFX-42-demo (check with pwd and
  git branch --show-current; if either differs, STOP and tell me). Read
  ~/.claude/handoffs/demo-project/PFX-42-demo.md and the project's CLAUDE.md, then STOP: ...

  Safe to clear.
```

## Settings

Every option can be changed interactively:

- **`/config`**, then type `guard` to filter: each option is a row; Enter toggles a switch or edits a value ([capture](docs/screens/05-config-options.txt)).
- **`/plugin configure context-guard@strzelichowski-solutions`**: a form with all options.
- **VS Code**: `/plugins`, then the gear icon on the plugin's row.
- **`~/.claude/settings.json`**: `"pluginConfigs": { "context-guard@strzelichowski-solutions": { "options": { "reminder_percent": 50 } } }`.

```
  │ ⌕ guard                                                               │
  ❯ Handoff reminder · context-guard                      true
    Handoff reminder threshold (%) · context-guard        60
    Reminder through Claude · context-guard               false
    Auto-compact · context-guard                          true
    Auto-compact threshold (%) · context-guard            65
    Models for reminder and auto-compact · context-guard  opus
    Usage line above the prompt · context-guard           true
    Usage status line · context-guard                     true
    Usage limit warning (%) · context-guard               80 ›
    Status file for VS Code · context-guard               true
    Subagent token ceiling · context-guard                true
    Subagent token ceiling (tokens) · context-guard       100000 ›
    Subagent ceiling models · context-guard               haiku-5-5 ›
```

| Option | Default | Meaning |
| --- | --- | --- |
| Handoff reminder | on | yellow line above the prompt and a notification |
| Handoff reminder threshold (%) | 60 | when the reminder shows |
| Reminder through Claude | off | also ask Claude to mention the reminder at the start of its next reply |
| Auto-compact | on | compact the main conversation |
| Auto-compact threshold (%) | 65 | when it compacts |
| Models for reminder and auto-compact | `opus` | comma-separated model id fragments; empty = every model |
| Usage line above the prompt | on | context, limits and cost above the prompt (terminal and VS Code panel) |
| Usage status line | on | the same line on the status line under the prompt (terminal only) |
| Usage limit warning (%) | 80 | warning when a limit reaches it; 0 = off |
| Status file for VS Code | on | writes `~/.claude/context-guard/sessions/*.json` for the VS Code extension |
| Subagent token ceiling | on | the subagent guard |
| Subagent token ceiling (tokens) | 100000 | the ceiling |
| Subagent ceiling models | `haiku-5-5` | comma-separated model id fragments; empty = every model |

## Subagent compaction

The plugin cannot compact a subagent; Claude Code does that by itself. To make a Claude Haiku 5.5 subagent compact at ~95k (just below its 5x price step at 100k) and keep working, add to `~/.claude/settings.json`:

```json
{
  "modelSettings": { "claude-haiku-5-5": { "autoCompactWindow": 100000, "effortLevel": "high" } },
  "env": { "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "95" }
}
```

`autoCompactWindow` takes 100000 at least; keep the plugin's subagent ceiling at or above the point where compaction runs. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` applies to every model, so it also brings other models' automatic compaction a little earlier.

## Development

- Plugin checks: `claude plugin validate plugins/context-guard` and `claude plugin test plugins/context-guard`.
- Try a change without installing: `claude --plugin-dir plugins/context-guard`.
- VS Code extension: plain JavaScript, no dependencies. Rebuild the `.vsix` with `npx @vscode/vsce package --allow-missing-repository --skip-license -o context-guard-status.vsix` in `vscode-context-guard/`.
