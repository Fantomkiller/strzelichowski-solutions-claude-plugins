// Context Guard status: shows what the context-guard Claude Code plugin writes to
// ~/.claude/context-guard/sessions/*.json (one file per working directory) on the
// VS Code status bar, with a detailed hover, a click menu and a usage panel, and
// reminds you to hand off once the context passes the plugin's reminder threshold.
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
const LIMIT_LABELS = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }
const LIMIT_SHORT = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }
// The Claude Code extension's own command that focuses its prompt box.
const CLAUDE_FOCUS = 'claude-vscode.focus'

const until = (iso, now) => {
  const ms = iso ? Date.parse(iso) - now : NaN
  if (!(ms > 0)) return ''
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `${Math.floor(h / 24)}d${h % 24}h` : h > 0 ? `${h}h${m}m` : `${m}m`
}

// Reset time as the clock shows it: 14:30 today, "Mon 09:00" further out.
const resetAt = (iso, now) => {
  if (!iso) return ''
  const at = new Date(iso)
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return at.getTime() - now < 20 * 3_600_000 ? time : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

const k = n => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`)

const bar = (percent, cells = 12) => {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)))
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled)
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

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
  return entries.sort((a, b) => b.updatedAt - a.updatedAt)
}

// The session of this window's workspace (most recent first), else the most
// recently updated one: usage limits are the account's either way.
const pick = entries => {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
  const inWorkspace = entries.filter(e => folders.some(f => e.cwd === f || e.cwd.startsWith(f + path.sep)))
  return (inWorkspace.length > 0 ? inWorkspace : entries)[0]
}

const isReminderDue = e =>
  e.isWatched && e.reminderEnabled && e.context.percent !== undefined && e.context.percent >= e.reminderPercent

const tooltipFor = (e, all, now) => {
  const t = new vscode.MarkdownString(undefined, true)
  t.isTrusted = { enabledCommands: ['contextGuard.showDetails', 'contextGuard.copyHandoff', 'contextGuard.openUsage', CLAUDE_FOCUS] }
  t.supportThemeIcons = true
  t.appendMarkdown(`**Claude Code** · ${e.model || 'model unknown'}\n\n`)
  if (e.context.percent !== undefined) {
    t.appendMarkdown(`\`${bar(e.context.percent)}\` **Context ${e.context.percent}%** · ${k(e.context.tokens ?? 0)} / ${k(e.context.window)}\n\n`)
  }
  for (const limit of e.rateLimits ?? []) {
    const left = until(limit.resetsAt, now)
    const at = resetAt(limit.resetsAt, now)
    t.appendMarkdown(
      `\`${bar(limit.percentUsed)}\` **${LIMIT_LABELS[limit.kind] ?? limit.kind} ${limit.percentUsed}%**${at ? ` · resets ${at} (in ${left})` : ''}\n\n`,
    )
  }
  if ((e.rateLimits ?? []).length === 0) t.appendMarkdown(`_No plan limits reported (API key or not yet measured)_\n\n`)
  if (e.costUsd !== null && e.costUsd !== undefined) t.appendMarkdown(`Session cost: $${e.costUsd.toFixed(2)}\n\n`)
  if (e.isWatched) {
    t.appendMarkdown(
      `Handoff reminder ${e.reminderEnabled ? `at ${e.reminderPercent}%` : 'off'} · auto-compact ${e.compactEnabled ? `at ${e.compactPercent}%` : 'off'}\n\n`,
    )
  }
  const others = all.filter(o => o !== e && o.context.percent !== undefined)
  if (others.length > 0) {
    t.appendMarkdown(`---\n\nOther sessions:\n\n`)
    for (const o of others.slice(0, 5)) t.appendMarkdown(`- ${path.basename(o.cwd)}: context ${o.context.percent}%\n`)
    t.appendMarkdown('\n')
  }
  t.appendMarkdown(`---\n\n${path.basename(e.cwd)} · updated ${new Date(e.updatedAt).toLocaleTimeString()}\n\n`)
  t.appendMarkdown(
    `[$(graph) Details](command:contextGuard.showDetails) · [$(copy) Copy handoff](command:contextGuard.copyHandoff) · ` +
      `[$(pulse) /usage](command:contextGuard.openUsage) · [$(comment-discussion) Open Claude](command:${CLAUDE_FOCUS})`,
  )
  return t
}

const detailsHtml = (e, all, now) => {
  const row = (label, percent, sub) => `
    <div class="row">
      <div class="label"><span>${escapeHtml(label)}</span><span>${percent}%</span></div>
      <div class="track"><div class="fill${percent >= LIMIT_WARN_PERCENT ? ' warn' : ''}" style="width:${Math.min(100, percent)}%"></div></div>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
    </div>`
  let body = ''
  if (e === undefined) {
    body = '<p>No Claude Code session has reported yet. Run a turn in a session with the context-guard plugin.</p>'
  } else {
    body += `<h2>${escapeHtml(path.basename(e.cwd))} <span class="muted">· ${escapeHtml(e.model || 'model unknown')}</span></h2>`
    if (e.context.percent !== undefined) {
      body += row('Context', e.context.percent, `${k(e.context.tokens ?? 0)} of ${k(e.context.window)} tokens`)
    }
    for (const limit of e.rateLimits ?? []) {
      const at = resetAt(limit.resetsAt, now)
      body += row(LIMIT_LABELS[limit.kind] ?? limit.kind, limit.percentUsed, at ? `Resets ${at} (in ${until(limit.resetsAt, now)})` : '')
    }
    if ((e.rateLimits ?? []).length === 0) body += '<p class="muted">No plan limits reported (API key, or not measured yet).</p>'
    if (e.costUsd !== null && e.costUsd !== undefined) body += `<p>Session cost: <b>$${e.costUsd.toFixed(2)}</b></p>`
    if (e.isWatched) {
      body += `<p class="muted">Handoff reminder ${e.reminderEnabled ? `at ${e.reminderPercent}%` : 'off'} · auto-compact ${
        e.compactEnabled ? `at ${e.compactPercent}%` : 'off'
      } · handoff command <code>${escapeHtml(e.command)}</code></p>`
    }
    const others = all.filter(o => o !== e)
    if (others.length > 0) {
      body += '<h3>Other sessions</h3>'
      for (const o of others) {
        if (o.context.percent !== undefined) body += row(path.basename(o.cwd), o.context.percent, `${o.model || ''} · ${o.cwd}`)
      }
    }
    body += `<p class="muted">Updated ${escapeHtml(new Date(e.updatedAt).toLocaleTimeString())}. Plan limits are the account's; the breakdown of what uses them is in Claude Code's /usage.</p>`
  }
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 20px; max-width: 640px; }
  h2 { font-size: 1.2em; } h3 { font-size: 1em; margin-top: 24px; }
  .muted { color: var(--vscode-descriptionForeground); font-weight: normal; }
  .row { margin: 14px 0; }
  .label { display: flex; justify-content: space-between; font-weight: 600; }
  .track { height: 8px; border-radius: 4px; background: var(--vscode-editorWidget-border, #444); margin-top: 6px; overflow: hidden; }
  .fill { height: 100%; background: var(--vscode-progressBar-background, #0a84ff); }
  .fill.warn { background: var(--vscode-editorWarning-foreground, #e5a50a); }
  .sub { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px; }
  code { font-family: var(--vscode-editor-font-family); }
</style></head><body>${body}</body></html>`
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  item.command = 'contextGuard.menu'
  context.subscriptions.push(item)

  let current
  let all = []
  let panel
  // Working directories whose reminder was already shown for the current crossing.
  const reminded = new Set()

  const copyHandoff = async () => {
    const command = current?.command ?? '/context-guard:handoff'
    await vscode.env.clipboard.writeText(command)
    vscode.window.setStatusBarMessage(`Copied ${command}: paste it into Claude`, 4000)
  }

  // The Claude Code extension has no command that runs /usage: copy it and focus its prompt box.
  const openUsage = async () => {
    await vscode.env.clipboard.writeText('/usage')
    await vscode.commands.executeCommand(CLAUDE_FOCUS).then(undefined, () => undefined)
    vscode.window.setStatusBarMessage('Copied /usage: paste it into the Claude prompt (Cmd+V, Enter)', 5000)
  }

  const showDetails = () => {
    if (panel) {
      panel.reveal()
    } else {
      panel = vscode.window.createWebviewPanel('contextGuard.details', 'Claude usage', vscode.ViewColumn.Active, {})
      panel.onDidDispose(() => (panel = undefined))
    }
    panel.webview.html = detailsHtml(current, all, Date.now())
  }

  const menu = async () => {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(graph) Usage details', run: showDetails },
        { label: '$(copy) Copy handoff command', description: current?.command, run: copyHandoff },
        { label: '$(pulse) Copy /usage and open Claude', run: openUsage },
        { label: '$(comment-discussion) Open Claude', run: () => vscode.commands.executeCommand(CLAUDE_FOCUS) },
      ],
      { placeHolder: 'Claude Code context and usage' },
    )
    if (choice) await choice.run()
  }

  const render = () => {
    all = readEntries()
    current = pick(all)
    if (panel) panel.webview.html = detailsHtml(current, all, Date.now())
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
      parts.push(`${LIMIT_SHORT[limit.kind] ?? limit.kind} ${limit.percentUsed}%${left ? ` ${left}` : ''}`)
    }

    const due = isReminderDue(e)
    const limitHigh = (e.rateLimits ?? []).some(l => l.percentUsed >= LIMIT_WARN_PERCENT)
    item.text = `${due || limitHigh ? '$(warning)' : '$(sparkle)'} ${parts.join(' · ')}`
    item.backgroundColor = due || limitHigh ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
    item.tooltip = tooltipFor(e, all, now)
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
    vscode.commands.registerCommand('contextGuard.menu', menu),
    vscode.commands.registerCommand('contextGuard.showDetails', showDetails),
    vscode.commands.registerCommand('contextGuard.copyHandoff', copyHandoff),
    vscode.commands.registerCommand('contextGuard.openUsage', openUsage),
    vscode.commands.registerCommand('contextGuard.refresh', render),
  )

  const timer = setInterval(render, POLL_MS)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
  render()
}

function deactivate() {}

module.exports = { activate, deactivate }
