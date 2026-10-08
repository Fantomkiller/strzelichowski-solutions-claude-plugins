# Strzelichowski Solutions: Claude Code plugins

Marketplace `strzelichowski-solutions` with one plugin, `context-guard`, plus an optional VS Code extension that shows its status. Requires Claude Code 2.1.292 or later (`claude --version`).

## Install

In Claude Code (terminal or VS Code panel):

```
/plugin marketplace add Fantomkiller/strzelichowski-solutions-claude-plugins
/plugin install context-guard@strzelichowski-solutions
```

In VS Code you can also open this link, which goes straight to the plugin's install dialog:
`vscode://anthropic.claude-code/install-plugin?plugin=context-guard&marketplace=Fantomkiller/strzelichowski-solutions-claude-plugins`

From a local copy (unzipped or cloned), pass its path to `/plugin marketplace add` instead. Start a new session afterwards.

Optionally, VS Code users can also install the status bar extension, which shows the same figures on VS Code's own status bar:

```
gh release download --repo Fantomkiller/strzelichowski-solutions-claude-plugins --pattern '*.vsix'   # or take it from vscode-context-guard/ in a clone
code --install-extension context-guard-status.vsix
```

## What it does

| Feature | Terminal | VS Code |
| --- | --- | --- |
| `/context-guard:handoff`: writes `~/.claude/handoffs/<repo>/<branch>.md` and prints an opener for a fresh session; never commits, pushes, stages or stashes | yes | yes |
| Handoff reminder once the main conversation passes **60%** of the model's context | yellow band above the prompt + a notice in the chat | the same band above the prompt in the Claude Code panel + the notice; optionally the status bar extension |
| Auto-compact of the main conversation at **65%** | yes | yes |
| Context fill, 5-hour and weekly usage limits with time to reset, session cost | line in the band above the prompt and on the status line | line in the band above the prompt in the Claude Code panel; optionally the status bar extension (hover for bars, click for a menu) |
| Notice in the chat when a 5-hour or weekly limit passes **80%** | yes | yes |
| Token ceiling for subagents (default Claude Haiku 5.5, **100k**): an oversized tool result is cut so the next request stays under the ceiling; the subagent keeps working | yes | yes |

Usage limits appear on a Claude subscription only; with an API key the line shows context and cost. Everything refreshes after each turn.

## Settings

`/config`, plugin `context-guard` (in VS Code: `/plugins`, gear icon on the plugin's row):

| Option | Default | Meaning |
| --- | --- | --- |
| Handoff reminder | on | band, notification and VS Code warning |
| Handoff reminder threshold (%) | 60 | when the reminder shows |
| Auto-compact | on | compact the main conversation |
| Auto-compact threshold (%) | 65 | when it compacts |
| Models for reminder and auto-compact | `opus` | comma-separated model id fragments; empty = every model |
| Usage line above the prompt | on | context, limits and cost in the band above the prompt (terminal and VS Code panel) |
| Usage status line | on | the same line on the status line under the prompt (terminal only) |
| Usage limit warning (%) | 80 | notice in the chat when a limit reaches it; 0 = off |
| Reminder through Claude | off | also ask Claude to mention the reminder in its next reply |
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
- VS Code extension: plain JavaScript, no dependencies. Rebuild the `.vsix` with `npx @vscode/vsce package --allow-missing-repository --skip-license -o context-guard-status.vsix` in `vscode-context-guard/`.
