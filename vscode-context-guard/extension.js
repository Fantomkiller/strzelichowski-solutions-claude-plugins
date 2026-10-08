// Context Guard status: shows what the context-guard Claude Code plugin writes to
// ~/.claude/context-guard/sessions/*.json (one file per session) on the VS Code
// status bar, for the chat of this window used last: each figure colored by its level,
// with a detailed hover, a click menu and a usage panel, and a reminder to hand off
// once the context passes the plugin's reminder threshold.
const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = path.join(os.homedir(), '.claude', 'context-guard', 'sessions')
const POLL_MS = 3000
// Entries older than this are from sessions long gone.
const STALE_MS = 12 * 3_600_000
// A usage limit at or past these shows as a warning, then as danger.
const LIMIT_WARN_PERCENT = 80
const LIMIT_DANGER_PERCENT = 95
// Each figure has a level of its own: ok, warn (the context past the reminder, a limit
// past 80%), danger (the context past auto-compact, a limit past 95%).
const LEVEL_HEX = { ok: '#3fb950', warn: '#d29922', danger: '#f85149' }
const LEVEL_THEME = { ok: 'charts.green', warn: 'charts.yellow', danger: 'charts.red' }
const LEVEL_BACKGROUND = { warn: 'statusBarItem.warningBackground', danger: 'statusBarItem.errorBackground' }
const LEVEL_RANK = { ok: 0, warn: 1, danger: 2 }
const limitLevel = percent => (percent >= LIMIT_DANGER_PERCENT ? 'danger' : percent >= LIMIT_WARN_PERCENT ? 'warn' : 'ok')
const contextLevel = e => {
  const percent = e.context.percent
  if (percent === undefined) return 'ok'
  return percent >= (e.compactPercent ?? 65) ? 'danger' : percent >= (e.reminderPercent ?? 60) ? 'warn' : 'ok'
}
// One status bar item per figure, so each carries its own color: context and up to three limits.
const ITEM_COUNT = 4
const LIMIT_LABELS = { five_hour: '5-hour', seven_day: 'Weekly', spend_limit: 'Spend' }
const LIMIT_SHORT = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }
// The Claude Code extension's own command that focuses its prompt box.
const CLAUDE_FOCUS = 'claude-vscode.focus'
// The view type of Claude Code's chat tabs.
const CLAUDE_PANEL = 'claudeVSCodePanel'

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

// Hover text in a level's color (the hover keeps a span's color style).
const colored = (level, html) => `<span style="color:${LEVEL_HEX[level]};">${html}</span>`

// Live sessions, freshest first. Files of ended sessions (exit, /clear), stale ones and
// the old per-folder files without a session id are removed.
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
    const file = path.join(DIR, name)
    let entry
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue // a file mid-write: next poll reads it
    }
    if (entry.sessionId && !entry.endedAt && now - entry.updatedAt < STALE_MS) {
      entries.push(entry)
    } else {
      try {
        fs.unlinkSync(file)
      } catch {
        // another window removed it first
      }
    }
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt)
}

const lastUsed = e => e.activeAt ?? e.updatedAt

// A chat's title as Claude Code names its tab: the custom title, else the AI title,
// read from the last ones in the session's transcript (only those lines are parsed).
const TITLE_CHUNK = 256 * 1024
const titles = new Map()
const titleOf = e => {
  const file = path.join(os.homedir(), '.claude', 'projects', e.cwd.replace(/[^A-Za-z0-9]/g, '-'), `${e.sessionId}.jsonl`)
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return ''
  }
  const cached = titles.get(e.sessionId)
  if (cached?.mtimeMs === stat.mtimeMs) return cached.title
  const chunks = []
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const read = (position, length) => {
      const buf = Buffer.alloc(length)
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, length, position))
    }
    chunks.push(read(Math.max(0, stat.size - TITLE_CHUNK), Math.min(TITLE_CHUNK, stat.size)))
    if (stat.size > TITLE_CHUNK) chunks.push(read(0, TITLE_CHUNK))
  } catch {
    return cached?.title ?? ''
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  const last = (text, type, key) => {
    const lines = text.split('\n').filter(l => l.includes(`"type":"${type}"`))
    for (const line of lines.reverse()) {
      try {
        const value = JSON.parse(line)[key]
        if (typeof value === 'string' && value !== '') return value
      } catch {
        // a line cut by the chunk's edge
      }
    }
    return ''
  }
  let title = ''
  for (const text of chunks) title ||= last(text, 'custom-title', 'customTitle')
  for (const text of chunks) title ||= last(text, 'ai-title', 'aiTitle')
  titles.set(e.sessionId, { mtimeMs: stat.mtimeMs, title })
  return title
}

// Claude Code shows a long title cut to 24 characters and "…".
const isTabOf = (label, title) => {
  if (!label || !title) return false
  const shown = label.endsWith('…') ? label.slice(0, -1) : label
  return title === shown || (label.endsWith('…') && title.startsWith(shown))
}

// What this window shows: the chat of its own workspace in front of the person, never
// one from another window's project; the other chats here; and the plan limits, which
// are the account's, from the freshest reading of any session.
// The chat in front: the Claude tab focused last, matched by its title, unless a chat
// was used (a prompt sent, a turn ended) after that; a focused tab no file matches yet
// (a new chat) shows no context rather than another chat's.
const pick = (entries, focused) => {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath)
  const here = entries
    .filter(e => folders.some(f => e.cwd === f || e.cwd.startsWith(f + path.sep)))
    .sort((a, b) => lastUsed(b) - lastUsed(a))
  let chat = here[0]
  if (focused !== undefined && (chat === undefined || focused.at > lastUsed(chat))) {
    chat = here.find(e => isTabOf(focused.label, titleOf(e)))
  }
  return { chat, others: here.filter(e => e !== chat), limits: entries[0]?.rateLimits ?? [] }
}

const isReminderDue = e =>
  e.isWatched && e.reminderEnabled && e.context.percent !== undefined && e.context.percent >= e.reminderPercent

const chatLabel = e => {
  const title = titleOf(e)
  return `${title ? `${title} · ` : ''}${e.model || 'model unknown'} · used ${new Date(lastUsed(e)).toLocaleTimeString()}`
}

const tooltipFor = ({ chat: e, others, limits }, now) => {
  const t = new vscode.MarkdownString(undefined, true)
  t.isTrusted = { enabledCommands: ['contextGuard.showDetails', 'contextGuard.copyHandoff', 'contextGuard.openUsage', CLAUDE_FOCUS] }
  t.supportThemeIcons = true
  t.supportHtml = true
  t.appendMarkdown(`**Claude Code** · ${e ? titleOf(e) || e.model || 'model unknown' : 'no reading for this chat yet'}\n\n`)
  if (e?.context.percent !== undefined) {
    const level = contextLevel(e)
    t.appendMarkdown(
      `${colored(level, `${bar(e.context.percent)} <b>Context ${e.context.percent}%</b>`)} · ${k(e.context.tokens ?? 0)} / ${k(e.context.window)}\n\n`,
    )
  }
  for (const limit of limits) {
    const left = until(limit.resetsAt, now)
    const at = resetAt(limit.resetsAt, now)
    const label = `${LIMIT_LABELS[limit.kind] ?? limit.kind} ${limit.percentUsed}%`
    t.appendMarkdown(
      `${colored(limitLevel(limit.percentUsed), `${bar(limit.percentUsed)} <b>${label}</b>`)}${at ? ` · resets ${at} (in ${left})` : ''}\n\n`,
    )
  }
  if (limits.length === 0) t.appendMarkdown(`_No plan limits reported (API key or not yet measured)_\n\n`)
  if (e?.isWatched) {
    t.appendMarkdown(
      `Handoff reminder ${e.reminderEnabled ? `at ${e.reminderPercent}%` : 'off'} · auto-compact ${e.compactEnabled ? `at ${e.compactPercent}%` : 'off'}\n\n`,
    )
  }
  if (others.length > 0) {
    t.appendMarkdown(`---\n\nOther chats in this window:\n\n`)
    for (const o of others.slice(0, 5)) {
      t.appendMarkdown(`- ${colored(contextLevel(o), `context ${o.context.percent ?? '?'}%`)} · ${chatLabel(o)}\n`)
    }
    t.appendMarkdown('\n')
  }
  if (e) t.appendMarkdown(`---\n\n${path.basename(e.cwd)} · ${chatLabel(e)}\n\n`)
  t.appendMarkdown(
    `[$(graph) Details](command:contextGuard.showDetails) · [$(copy) Copy handoff](command:contextGuard.copyHandoff) · ` +
      `[$(pulse) /usage](command:contextGuard.openUsage) · [$(comment-discussion) Open Claude](command:${CLAUDE_FOCUS})`,
  )
  return t
}

const detailsHtml = ({ chat: e, others, limits }, now) => {
  const row = (label, percent, sub, level) => `
    <div class="row">
      <div class="label"><span>${escapeHtml(label)}</span><span class="${level}">${percent}%</span></div>
      <div class="track"><div class="fill ${level}" style="width:${Math.min(100, percent)}%"></div></div>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
    </div>`
  let body = ''
  if (e === undefined) {
    body = '<p>No Claude Code chat in this window has reported yet. Send a prompt in a chat with the context-guard plugin.</p>'
  } else {
    body += `<h2>${escapeHtml(path.basename(e.cwd))} <span class="muted">· ${escapeHtml(e.model || 'model unknown')}</span></h2>`
    if (e.context.percent !== undefined) {
      body += row('Context', e.context.percent, `${k(e.context.tokens ?? 0)} of ${k(e.context.window)} tokens`, contextLevel(e))
    }
  }
  for (const limit of limits) {
    const at = resetAt(limit.resetsAt, now)
    body += row(LIMIT_LABELS[limit.kind] ?? limit.kind, limit.percentUsed, at ? `Resets ${at} (in ${until(limit.resetsAt, now)})` : '', limitLevel(limit.percentUsed))
  }
  if (limits.length === 0) body += '<p class="muted">No plan limits reported (API key, or not measured yet).</p>'
  if (e !== undefined) {
    if (e.isWatched) {
      body += `<p class="muted">Handoff reminder ${e.reminderEnabled ? `at ${e.reminderPercent}%` : 'off'} · auto-compact ${
        e.compactEnabled ? `at ${e.compactPercent}%` : 'off'
      } · handoff command <code>${escapeHtml(e.command)}</code></p>`
    }
    if (others.length > 0) {
      body += '<h3>Other chats in this window</h3>'
      for (const o of others) {
        if (o.context.percent !== undefined) body += row('Context', o.context.percent, chatLabel(o), contextLevel(o))
      }
    }
    body += `<p class="muted">Last used ${escapeHtml(new Date(lastUsed(e)).toLocaleTimeString())}. Plan limits are the account's; the breakdown of what uses them is in Claude Code's /usage.</p>`
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
  .fill { height: 100%; }
  .fill.ok { background: var(--vscode-charts-green, #3fb950); }
  .fill.warn { background: var(--vscode-charts-yellow, #d29922); }
  .fill.danger { background: var(--vscode-charts-red, #f85149); }
  .label .ok { color: var(--vscode-charts-green, #3fb950); }
  .label .warn { color: var(--vscode-charts-yellow, #d29922); }
  .label .danger { color: var(--vscode-charts-red, #f85149); }
  .sub { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px; }
  code { font-family: var(--vscode-editor-font-family); }
</style></head><body>${body}</body></html>`
}

function activate(context) {
  // Left to right: context, then each limit; a higher priority sits further left.
  const items = Array.from({ length: ITEM_COUNT }, (_, i) => {
    const item = vscode.window.createStatusBarItem(`contextGuard.figure${i}`, vscode.StatusBarAlignment.Right, 100 - i / 100)
    item.name = 'Context Guard'
    item.command = 'contextGuard.menu'
    context.subscriptions.push(item)
    return item
  })

  let view = { chat: undefined, others: [], limits: [] }
  // The Claude chat tab focused last in this window: its label and when.
  let focused
  let panel
  // Sessions whose reminder was already shown for the current crossing.
  const reminded = new Set()

  const copyHandoff = async () => {
    const command = view.chat?.command ?? '/context-guard:handoff'
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
    panel.webview.html = detailsHtml(view, Date.now())
  }

  const menu = async () => {
    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(graph) Usage details', run: showDetails },
        { label: '$(copy) Copy handoff command', description: view.chat?.command, run: copyHandoff },
        { label: '$(pulse) Copy /usage and open Claude', run: openUsage },
        { label: '$(comment-discussion) Open Claude', run: () => vscode.commands.executeCommand(CLAUDE_FOCUS) },
      ],
      { placeHolder: 'Claude Code context and usage' },
    )
    if (choice) await choice.run()
  }

  const render = () => {
    const entries = readEntries()
    view = pick(entries, focused)
    if (panel) panel.webview.html = detailsHtml(view, Date.now())
    if (entries.length === 0) {
      for (const item of items) item.hide()
      return
    }
    const now = Date.now()
    const e = view.chat
    const figures = []
    // No chat in this window yet: the account's limits alone, never another project's context.
    if (e?.context.percent !== undefined) figures.push({ text: `ctx ${e.context.percent}%`, level: contextLevel(e) })
    for (const limit of view.limits) {
      const left = until(limit.resetsAt, now)
      figures.push({ text: `${LIMIT_SHORT[limit.kind] ?? limit.kind} ${limit.percentUsed}%${left ? ` ${left}` : ''}`, level: limitLevel(limit.percentUsed) })
    }

    const due = e !== undefined && isReminderDue(e)
    const worst = figures.reduce((w, f) => (LEVEL_RANK[f.level] > LEVEL_RANK[w] ? f.level : w), 'ok')
    const tooltip = tooltipFor(view, now)
    items.forEach((item, i) => {
      const figure = figures[i]
      if (figure === undefined) return item.hide()
      const icon = i === 0 ? `${worst === 'ok' ? '$(sparkle)' : '$(warning)'} ` : ''
      item.text = `${icon}${figure.text}`
      // A warning or danger figure gets the theme's own background; an ok one, green text.
      const background = LEVEL_BACKGROUND[figure.level]
      item.backgroundColor = background ? new vscode.ThemeColor(background) : undefined
      item.color = background ? undefined : new vscode.ThemeColor(LEVEL_THEME[figure.level])
      item.tooltip = tooltip
      item.show()
    })

    if (e === undefined) return
    if (!due) {
      reminded.delete(e.sessionId)
    } else if (!reminded.has(e.sessionId)) {
      reminded.add(e.sessionId)
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

  // A Claude chat tab coming to the front switches the figures at once.
  const noteFocus = () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab
    if (tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_PANEL) && tab.label !== focused?.label) {
      focused = { label: tab.label, at: Date.now() }
      render()
    }
  }
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(noteFocus), vscode.window.tabGroups.onDidChangeTabGroups(noteFocus))
  noteFocus()

  const timer = setInterval(render, POLL_MS)
  context.subscriptions.push({ dispose: () => clearInterval(timer) })
  render()
}

function deactivate() {}

module.exports = { activate, deactivate }
