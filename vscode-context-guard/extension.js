// Context Guard status: shows what the context-guard Claude Code plugin writes to
// ~/.claude/context-guard/sessions/*.json (one file per working directory) on the
// VS Code status bar, and reminds you to hand off once the context passes the
// plugin's reminder threshold.
const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = path.join(os.homedir(), '.claude', 'context-guard', 'sessions')
const POLL_MS = 3000
// Entries older than this are from sessions long gone.
const STALE_MS = 12 * 3_600_000
// A usage limit at or past this shows as a warning.
const LIMIT_WARN_PERCENT = 80
const LIMIT_LABELS = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

const until = (iso, now) => {
  const ms = iso ? Date.parse(iso) - now : NaN
  if (!(ms > 0)) return ''
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `${Math.floor(h / 24)}d${h % 24}h` : h > 0 ? `${h}h${m}m` : `${m}m`
}

const k = n => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`)

const readEntries = () => {
  let names = []
  try {
    names = fs.readdirSync(DIR).filter(n => n.endsWith('.json'))
  } catch {
    return []
  }
  const now = Date.now()
  const entries = []
  for (const name of names) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'))
      if (now - entry.updatedAt < STALE_MS) entries.push(entry)
    } catch {
      // a file mid-write: next poll reads it
    }
  }
  return entries
}

// The session of this window's workspace (deepest matching folder, most recent),
// else the most recently updated one: usage limits are the account's either way.
const pick = entries => {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
  const inWorkspace = entries.filter(e => folders.some(f => e.cwd === f || e.cwd.startsWith(f + path.sep)))
  const pool = inWorkspace.length > 0 ? inWorkspace : entries
  return pool.sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

const isReminderDue = e =>
  e.isWatched && e.reminderEnabled && e.context.percent !== undefined && e.context.percent >= e.reminderPercent

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  item.command = 'contextGuard.copyHandoff'
  context.subscriptions.push(item)

  let current
  // Working directories whose reminder was already shown for the current crossing.
  const reminded = new Set()

  const copyHandoff = async () => {
    const command = current?.command ?? '/context-guard:handoff'
    await vscode.env.clipboard.writeText(command)
    vscode.window.setStatusBarMessage(`Copied ${command}`, 3000)
  }

  const render = () => {
    current = pick(readEntries())
    if (current === undefined) {
      item.hide()
      return
    }
    const now = Date.now()
    const e = current
    const parts = []
    if (e.context.percent !== undefined) parts.push(`ctx ${e.context.percent}%`)
    for (const limit of e.rateLimits ?? []) {
      const left = until(limit.resetsAt, now)
      parts.push(`${LIMIT_LABELS[limit.kind] ?? limit.kind} ${limit.percentUsed}%${left ? ` ${left}` : ''}`)
    }

    const due = isReminderDue(e)
    const limitHigh = (e.rateLimits ?? []).some(l => l.percentUsed >= LIMIT_WARN_PERCENT)
    item.text = `${due || limitHigh ? '$(warning)' : '$(sparkle)'} ${parts.join(' · ')}`
    item.backgroundColor = due || limitHigh ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined

    const tooltip = new vscode.MarkdownString(undefined, true)
    tooltip.appendMarkdown(`**Claude Code** · ${e.model || 'model unknown'}\n\n`)
    if (e.context.percent !== undefined) {
      tooltip.appendMarkdown(`Context: ${e.context.percent}% (${k(e.context.tokens ?? 0)} / ${k(e.context.window)})\n\n`)
    }
    for (const limit of e.rateLimits ?? []) {
      const left = until(limit.resetsAt, now)
      tooltip.appendMarkdown(`${LIMIT_LABELS[limit.kind] ?? limit.kind}: ${limit.percentUsed}%${left ? `, resets in ${left}` : ''}\n\n`)
    }
    if (e.costUsd !== null && e.costUsd !== undefined) tooltip.appendMarkdown(`Session cost: $${e.costUsd.toFixed(2)}\n\n`)
    if (e.isWatched) {
      tooltip.appendMarkdown(
        `Handoff reminder: ${e.reminderEnabled ? `${e.reminderPercent}%` : 'off'} · auto-compact: ${e.compactEnabled ? `${e.compactPercent}%` : 'off'}\n\n`,
      )
    }
    tooltip.appendMarkdown(`${e.cwd} · updated ${new Date(e.updatedAt).toLocaleTimeString()}\n\n`)
    tooltip.appendMarkdown(`Click to copy \`${e.command}\``)
    item.tooltip = tooltip
    item.show()

    if (!due) {
      reminded.delete(e.cwd)
    } else if (!reminded.has(e.cwd)) {
      reminded.add(e.cwd)
      const auto = e.compactEnabled ? ` Auto-compact at ${e.compactPercent}%.` : ''
      vscode.window
        .showWarningMessage(`Claude context at ${e.context.percent}%: run ${e.command}, then /clear.${auto}`, 'Copy command')
        .then(choice => (choice === 'Copy command' ? copyHandoff() : undefined))
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('contextGuard.copyHandoff', copyHandoff),
    vscode.commands.registerCommand('contextGuard.refresh', render),
  )

  const timer = setInterval(render, POLL_MS)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
  render()
}

function deactivate() {}

module.exports = { activate, deactivate }
