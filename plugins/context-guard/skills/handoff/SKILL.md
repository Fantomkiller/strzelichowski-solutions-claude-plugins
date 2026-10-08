---
name: handoff
description: Use when the user asks for a handoff or a resume prompt, wants to /clear or restart the session, says the context is getting full, or the context-guard reminder (band, notification or VS Code status bar) shows up.
---

# Handoff

Close this session so a fresh one, with no memory of it, continues from a file alone. The handoff changes nothing in the repository: no `git add`, commit, push or stash. Uncommitted changes stay on disk and survive `/clear`; only running tasks and unsaved results do not.

## The handoff file

Path: `~/.claude/handoffs/<repo>/<branch>.md`
- `<repo>`: basename of `git rev-parse --show-toplevel`, else of the working directory.
- `<branch>`: `git branch --show-current` with `/` replaced by `-`; `detached` when empty.

One file per repo and branch. Create the directories if needed; if the file exists, update it in place.

Sections, in this order:

1. `# Handoff: <repo> @ <branch>`, then the guard line: `Project home: <absolute path>, branch <branch>. If either differs from yours, STOP and say so.`
2. `## What this is`: 2-3 lines: the task (a ticket key like ABC-123 from the branch name, if any) and its goal.
3. `## Current state (<YYYY-MM-DD HH:MM>)`: what works, what is half-done, uncommitted files (`git status --short`), unpushed commits (`git log --oneline @{u}..` when the branch has an upstream).
4. `## Session log`: this session as one short entry, appended. Entries older than the last two shrink to one line each.
5. `## Open loops`: unfinished work; decisions waiting on the user, with enough context to decide cold; background tasks still running and the command to rerun them.
6. `## Next up`: the proposed agenda for the next session, a default to present, not permission to start.
7. `## To resume`: the opener below, verbatim.

## Stranded-work check

Run read-only commands only: `git status --short`, `git log --oneline @{u}..`, and a look at running background tasks. A task that ends soon: wait for it and record its result. A task that does not: record it in Open loops with its rerun command.

## Opener

Last in the reply, one fenced block, real values filled in:

```
Working directory must be <absolute path> on branch <branch> (check with pwd and git branch --show-current; if either differs, STOP and tell me). Read ~/.claude/handoffs/<repo>/<branch>.md and the project's CLAUDE.md, then STOP: brief me on the state, present next-step options with "Next up" as the marked default, and wait for my answer. Build nothing until I answer; anything I write below this opener counts as that answer.
```

After the block, exactly one line: `Safe to clear.` or `Not safe to clear: <reason>`.
