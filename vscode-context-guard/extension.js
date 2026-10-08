// Context Guard status: shows what the context-guard Claude Code plugin writes to
// ~/.claude/context-guard/sessions/*.json (one file per session) on the VS Code
// status bar, for the chat of this window used last: each figure colored green to red,
// with a detailed hover (a click opens the same in a panel), and a reminder to hand off
// once the context passes the plugin's reminder threshold.
const vscode = require('vscode')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = path.join(os.homedir(), '.claude', 'context-guard', 'sessions')
const POLL_MS = 3000
// Entries older than this are from sessions long gone.
const STALE_MS = 12 * 3_600_000
// One color scale for every figure: a score from 0 (green) to 1 (red), through yellow and
// orange. A copy of the plugin's plugins/context-guard/hooks/scale.ts: keep the two alike.
// A limit's own usage warms from 30% and is red at 95%; its pace (the usage at reset if it
// goes on as it has) warms past 70% and is deepest at 150%, never red on pace alone, read
// once a tenth of the window has passed. The context warms from half the reminder
// threshold and is red at the compaction one.
const WINDOW_MS = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }
const clamp01 = x => Math.max(0, Math.min(1, x))
const contextScore = e => {
  const percent = e.context.percent
  if (percent === undefined) return 0
  const from = (e.reminderPercent ?? 60) / 2
  return clamp01((percent - from) / Math.max(1, (e.compactPercent ?? 65) - from))
}
// { score, limitInMs }: limitInMs, at the pace so far, when the limit comes before its reset.
const limitScore = (limit, now) => {
  const usage = clamp01((limit.percentUsed - 30) / 65)
  const window = WINDOW_MS[limit.kind]
  const left = limit.resetsAt ? Date.parse(limit.resetsAt) - now : NaN
  if (window === undefined || !(left > 0) || left >= window) return { score: usage }
  const elapsed = window - left
  if (elapsed < window * 0.1 || limit.percentUsed <= 0) return { score: usage }
  const projected = (limit.percentUsed * window) / elapsed
  const pace = 0.9 * clamp01((projected - 70) / 80)
  const limitInMs = limit.percentUsed < 100 && projected > 100 ? ((100 - limit.percentUsed) * elapsed) / limit.percentUsed : undefined
  return { score: Math.max(usage, pace), limitInMs }
}
// Hue 120 (green) to 0 (red), bright enough on dark and light backgrounds.
const colorOf = score => {
  const h = 120 * (1 - clamp01(score))
  const s = 0.75
  const l = 0.48
  const f = n => {
    const k = (n + h / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}
// From here a figure is past its line (the context past auto-compact, a limit at 95%): a red background.
const SCORE_ALARM = 1
// From here the first item carries a warning icon.
const SCORE_WARN = 0.6
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

// Hover text in a score's color (the hover keeps a span's color style).
const colored = (score, html) => `<span style="color:${colorOf(score)};">${html}</span>`

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
  return { chat, limits: entries[0]?.rateLimits ?? [] }
}

const isReminderDue = e =>
  e.isWatched && e.reminderEnabled && e.context.percent !== undefined && e.context.percent >= e.reminderPercent

const tooltipFor = ({ chat: e, limits }, now) => {
  const t = new vscode.MarkdownString(undefined, true)
  t.isTrusted = { enabledCommands: ['contextGuard.showDetails', 'contextGuard.copyHandoff', CLAUDE_FOCUS] }
  t.supportThemeIcons = true
  t.supportHtml = true
  t.appendMarkdown(`**Claude Code** · ${e ? titleOf(e) || e.model || 'model unknown' : 'no reading for this chat yet'}\n\n`)
  if (e?.context.percent !== undefined) {
    t.appendMarkdown(
      `${colored(contextScore(e), `${bar(e.context.percent)} <b>Context ${e.context.percent}%</b>`)} · ${k(e.context.tokens ?? 0)} / ${k(e.context.window)}\n\n`,
    )
  }
  for (const limit of limits) {
    const left = until(limit.resetsAt, now)
    const at = resetAt(limit.resetsAt, now)
    const label = `${LIMIT_LABELS[limit.kind] ?? limit.kind} ${limit.percentUsed}%`
    const { score, limitInMs } = limitScore(limit, now)
    const soon = limitInMs !== undefined ? until(new Date(now + limitInMs).toISOString(), now) : ''
    t.appendMarkdown(
      `${colored(score, `${bar(limit.percentUsed)} <b>${label}</b>`)}${at ? ` · resets ${at} (in ${left})` : ''}${soon ? ` · ${colored(score, `limit in ~${soon} at this pace`)}` : ''}\n\n`,
    )
  }
  if (limits.length === 0) t.appendMarkdown(`_No plan limits reported (API key or not yet measured)_\n\n`)
  if (e?.isWatched) {
    t.appendMarkdown(
      `Handoff reminder ${e.reminderEnabled ? `at ${e.reminderPercent}%` : 'off'} · auto-compact ${e.compactEnabled ? `at ${e.compactPercent}%` : 'off'}\n\n`,
    )
  }
  t.appendMarkdown('---\n\n')
  t.appendMarkdown(
    `[$(graph) Details](command:contextGuard.showDetails) · [$(copy) Copy handoff](command:contextGuard.copyHandoff) · ` +
      `[$(comment-discussion) Open Claude](command:${CLAUDE_FOCUS})`,
  )
  return t
}

// The same as the hover, in a panel that stays open and refreshes.
const detailsHtml = ({ chat: e, limits }, now) => {
  const row = (label, percent, sub, score) => `
    <div class="row">
      <div class="label"><span>${escapeHtml(label)}</span><span style="color:${colorOf(score)}">${percent}%</span></div>
      <div class="track"><div class="fill" style="width:${Math.min(100, percent)}%;background:${colorOf(score)}"></div></div>
      ${sub ? `<div class="sub">${escapeHtml(sub)}</div>` : ''}
    </div>`
  let body = ''
  if (e === undefined) {
    body = '<p>No Claude Code chat in this window has reported yet. Send a prompt in a chat with the context-guard plugin.</p>'
  } else {
    body += `<h2>${escapeHtml(titleOf(e) || e.model || 'model unknown')}</h2>`
    if (e.context.percent !== undefined) {
      body += row('Context', e.context.percent, `${k(e.context.tokens ?? 0)} of ${k(e.context.window)} tokens`, contextScore(e))
    }
  }
  for (const limit of limits) {
    const at = resetAt(limit.resetsAt, now)
    const { score, limitInMs } = limitScore(limit, now)
    const soon = limitInMs !== undefined ? `; limit in ~${until(new Date(now + limitInMs).toISOString(), now)} at this pace` : ''
    body += row(LIMIT_LABELS[limit.kind] ?? limit.kind, limit.percentUsed, at ? `Resets ${at} (in ${until(limit.resetsAt, now)})${soon}` : '', score)
  }
  if (limits.length === 0) body += '<p class="muted">No plan limits reported (API key, or not measured yet).</p>'
  if (e !== undefined) {
    if (e.isWatched) {
      body += `<p class="muted">Handoff reminder ${e.reminderEnabled ? `at ${e.reminderPercent}%` : 'off'} · auto-compact ${
        e.compactEnabled ? `at ${e.compactPercent}%` : 'off'
      } · handoff command <code>${escapeHtml(e.command)}</code></p>`
    }
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
  .sub { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 4px; }
  code { font-family: var(--vscode-editor-font-family); }
</style></head><body>${body}</body></html>`
}

function activate(context) {
  // Left to right: context, then each limit; a higher priority sits further left.
  const items = Array.from({ length: ITEM_COUNT }, (_, i) => {
    const item = vscode.window.createStatusBarItem(`contextGuard.figure${i}`, vscode.StatusBarAlignment.Right, 100 - i / 100)
    item.name = 'Context Guard'
    item.command = 'contextGuard.showDetails'
    context.subscriptions.push(item)
    return item
  })

  let view = { chat: undefined, limits: [] }
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

  const showDetails = () => {
    if (panel) {
      panel.reveal()
    } else {
      panel = vscode.window.createWebviewPanel('contextGuard.details', 'Claude usage', vscode.ViewColumn.Active, {})
      panel.onDidDispose(() => (panel = undefined))
    }
    panel.webview.html = detailsHtml(view, Date.now())
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
    if (e?.context.percent !== undefined) figures.push({ text: `ctx ${e.context.percent}%`, score: contextScore(e) })
    for (const limit of view.limits) {
      const left = until(limit.resetsAt, now)
      figures.push({ text: `${LIMIT_SHORT[limit.kind] ?? limit.kind} ${limit.percentUsed}%${left ? ` ${left}` : ''}`, score: limitScore(limit, now).score })
    }

    const due = e !== undefined && isReminderDue(e)
    const worst = Math.max(0, ...figures.map(f => f.score))
    const tooltip = tooltipFor(view, now)
    items.forEach((item, i) => {
      const figure = figures[i]
      if (figure === undefined) return item.hide()
      const icon = i === 0 ? `${worst >= SCORE_WARN ? '$(warning)' : '$(sparkle)'} ` : ''
      item.text = `${icon}${figure.text}`
      // Its color on the scale; past its line, the theme's error background instead.
      const isAlarm = figure.score >= SCORE_ALARM
      item.backgroundColor = isAlarm ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined
      item.color = isAlarm ? undefined : colorOf(figure.score)
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
    vscode.commands.registerCommand('contextGuard.showDetails', showDetails),
    vscode.commands.registerCommand('contextGuard.copyHandoff', copyHandoff),
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
