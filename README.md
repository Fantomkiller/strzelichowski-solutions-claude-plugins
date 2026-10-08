# Strzelichowski Solutions: Claude Code plugins

Marketplace `strzelichowski-solutions` with one plugin, `context-guard`, plus an optional VS Code extension that shows its status. Requires Claude Code 2.1.292 or later (`claude --version`).

## Install

**1. The plugin.** In Claude Code in a terminal (the Claude Code panel in VS Code does not offer `/plugin`):

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

From a local copy (unzipped or cloned), pass its path to `marketplace add` instead. Start new sessions afterwards. Later updates: `claude plugin marketplace update strzelichowski-solutions`, then `claude plugin update context-guard@strzelichowski-solutions`.

**2. Haiku 5.5 subagents (recommended).** So that they compact at ~95k, under their 5x price step at 100k, add to `~/.claude/settings.json` (details in [Subagent compaction](#subagent-compaction)):

```json
{ "modelSettings": { "claude-haiku-5-5": { "autoCompactWindow": 128000 } } }
```

**3. VS Code (optional).** The status bar extension shows context fill and the usage limits on VS Code's own status bar, each colored by its level (hover for bars and reset times, click for a menu with a usage panel). Each window shows the Claude chat in front of you: the chat tab you switched to last (matched by its title), or the chat you used last (a prompt sent, a turn ended), never one from another project; a new chat with no reading yet, or a window with no chat, shows only the account's usage limits:

```
gh release download --repo Fantomkiller/strzelichowski-solutions-claude-plugins --pattern '*.vsix'   # or take it from vscode-context-guard/ in a clone
code --install-extension context-guard-status.vsix
```

Then run "Developer: Reload Window" in each VS Code window.

## What it does

| Feature | Where you see it |
| --- | --- |
| Context fill, 5-hour and weekly usage limits with time to reset; each figure green, yellow (context past the reminder, a limit past 80%) or red (context past auto-compact, a limit past 95%) | terminal: a line above the prompt and on the status line; VS Code: the status bar extension (the Claude Code panel draws no plugin elements) |
| Handoff reminder once the main conversation passes **60%** of the model's context | terminal: yellow line above the prompt with a **Hide** button, plus a notification; VS Code: the status bar extension's warning and notification |
| `/context-guard:handoff`: writes `~/.claude/handoffs/<repo>/<branch>.md` and prints an opener for a fresh session; never commits, pushes, stages or stashes | in the conversation |
| Auto-compact of the main conversation at **65%**; a conversation that stays above the threshold after compacting is compacted again only after it grows 5 more points | notification, then Claude Code's own "Conversation compacted" |
| Warning when a 5-hour or weekly limit passes **80%** | notice added to the conversation |
| Token ceiling for subagents (default Claude Haiku 5.5, **100k**): Claude Code compacts the subagent at ~95k (see below) and it carries on; a tool result too large even after that is cut | in the subagent's tool result |
| Sizing guidance: the orchestrator is told to split work into small Haiku subagents that fit their room; each one is told its budget | system prompt, subagent's task |

Usage limits appear on a Claude subscription only; with an API key the line shows context alone. Figures refresh after each turn. The plugin writes nothing beneath Claude's answers, and its notices in the conversation are never sent to Claude, so it adds nothing to the context.

## What it looks like

Captured from a real terminal session (Claude Code 2.1.293, Claude Haiku 5.5, thresholds lowered so they trip on a short conversation). The Claude Code panel in VS Code does not draw plugin elements around its prompt box; there the status bar extension shows the same figures and the reminder.

**Usage line** above the prompt (and, in the terminal, on the status line):

![Usage line](docs/screens/01-usage-line.png)

**Handoff reminder** once the context passes the threshold:

![Handoff reminder](docs/screens/02-handoff-reminder.png)

**Auto-compact** past its threshold, then Claude Code's own compaction:

![Auto-compact running](docs/screens/03-auto-compact-running.png)

![Auto-compact done](docs/screens/04-auto-compact-done.png)

**`/context-guard:handoff`** writes the handoff file ([example](docs/examples/handoff-PFX-42-demo.md)) and prints the opener for a fresh session:

![Handoff skill](docs/screens/06-handoff-skill.png)

## Settings

Every option can be changed interactively:

- **`/config`**, then type `guard` to filter: each option is a row; Enter toggles a switch or edits a value.
- **`/plugin configure context-guard@strzelichowski-solutions`**: a form with all options.
- **VS Code**: `/plugins`, then the gear icon on the plugin's row.
- **`~/.claude/settings.json`**: `"pluginConfigs": { "context-guard@strzelichowski-solutions": { "options": { "reminder_percent": 50 } } }`.

![Plugin options in /config](docs/screens/05-config-options.png)

| Option | Default | Meaning |
| --- | --- | --- |
| Handoff reminder | on | yellow line above the prompt and a notification |
| Handoff reminder threshold (%) | 60 | when the reminder shows |
| Auto-compact | on | compact the main conversation |
| Auto-compact threshold (%) | 65 | when it compacts |
| Models for reminder and auto-compact | `opus` | comma-separated model id fragments; empty = every model |
| Usage line above the prompt | on | context and limits above the prompt (terminal) |
| Usage status line | on | the same line on the status line under the prompt (terminal only) |
| Usage limit warning (%) | 80 | warning when a limit reaches it; 0 = off |
| Status file for VS Code | on | writes one `~/.claude/context-guard/sessions/<session id>.json` per session for the VS Code extension |
| Subagent sizing guidance | on | tells the orchestrator to split work into small capped subagents, and each capped subagent its budget |
| Subagent token ceiling | on | the subagent guard |
| Subagent token ceiling (tokens) | 100000 | the ceiling |
| Subagent compaction point (tokens) | 95000 | where Claude Code compacts a capped subagent: `autoCompactWindow` less 33000 |
| Subagent ceiling models | `haiku-5-5` | comma-separated model id fragments; empty = every model |

## Subagent compaction

The plugin cannot compact a subagent; Claude Code does that by itself, before the request that would pass the model's compaction point. That point is the compaction window less a fixed 33k buffer (`/context` shows it as "Autocompact buffer"); `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` does not move it. To make a Claude Haiku 5.5 subagent compact at ~95k, just below its 5x price step at 100k, and keep working, add to `~/.claude/settings.json`:

```json
{
  "modelSettings": { "claude-haiku-5-5": { "autoCompactWindow": 128000 } }
}
```

Measured on a Haiku 5.5 subagent reading 25 files of ~13k tokens each: it compacted every four files (at ~96k, back to ~48k), its largest request was ~96k, and it finished the task. With `autoCompactWindow` at 100000 it compacts at 67k, and since a subagent starts with ~30-40k tokens in use (system prompt, tool definitions, its task) and comes back to ~48k after a compaction, it refilled within three turns and Claude Code stopped it ("Autocompact is thrashing"). Keep the compaction point well above a subagent's starting size.

The plugin's options follow the same numbers: **Subagent compaction point** (95000) is where Claude Code compacts, and a tool result that fits after that compaction passes whole; only a result too large even then is cut to stay under the **ceiling** (100000).

**Subagent sizing guidance** (on by default) adds a short section to the orchestrator's system prompt (the models for reminder and auto-compact, `opus` by default). It does not change when the orchestrator delegates or to which model: that stays its own call, or yours. Once it delegates to a capped subagent: prefer several small ones whose reading fits in their room (about 60k), split large inputs, ask for compact answers. Each capped subagent's task also gets one paragraph with its budget and an instruction to carry on after a compaction.

## Development

- Plugin checks: `claude plugin validate plugins/context-guard` and `claude plugin test plugins/context-guard`.
- Try a change without installing: `claude --plugin-dir plugins/context-guard`.
- VS Code extension: plain JavaScript, no dependencies. Rebuild the `.vsix` with `npx @vscode/vsce package --allow-missing-repository --skip-license -o context-guard-status.vsix` in `vscode-context-guard/`.
