import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionCost, SessionRateLimit } from 'claude-code'

import type { Fill } from '../types'
import { createSubagentCap } from './subagent-cap'

const fill = atom({ plugin: 'context-guard', key: 'fill' } as const, null)
const isHidden = atom({ plugin: 'context-guard', key: 'isHidden' } as const, false)

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

type Settings = {
  usageStatus: boolean
  statusFile: boolean
  reminderEnabled: boolean
  reminderPercent: number
  compactEnabled: boolean
  compactPercent: number
}

type Usage = {
  context: SessionContextUsage
  rateLimits: readonly SessionRateLimit[]
  cost?: SessionCost | undefined
}

// What the Context Guard VS Code extension reads: one file per working directory.
type StatusEntry = Usage & {
  cwd: string
  model: string
  isWatched: boolean
  reminderEnabled: boolean
  reminderPercent: number
  compactEnabled: boolean
  compactPercent: number
  command: string
  updatedAt: number
}

// Time left until an ISO timestamp, as 3d4h / 2h13m / 9m; '' when unknown or past.
const until = (iso: string | undefined, now: number) => {
  const ms = iso === undefined ? NaN : Date.parse(iso) - now
  if (!(ms > 0)) return ''
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h >= 24 ? `${Math.floor(h / 24)}d${h % 24}h` : h > 0 ? `${h}h${m}m` : `${m}m`
}

const k = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`)

// Context fill, usage limits and session cost on this plugin's status line.
const showUsage = ($: EngineInterface, usage: Usage) => {
  const now = Date.now()
  const parts: string[] = []
  if (usage.context.percent !== undefined) parts.push(`ctx ${usage.context.percent}%`)
  for (const limit of usage.rateLimits) {
    const left = until(limit.resetsAt, now)
    parts.push(`${LIMIT_LABELS[limit.kind] ?? limit.kind} ${limit.percentUsed}%${left ? ` (reset ${left})` : ''}`)
  }
  if (usage.cost !== undefined) parts.push(`$${usage.cost.usd.toFixed(2)}`)
  $.ui.status(parts.length > 0 ? parts.join(' | ') : undefined)
}

const writeStatus = async ($: EngineInterface, settings: Settings, usage: Usage, model: string, isWatched: boolean) => {
  const home = await $.env.get('HOME')
  if (home === undefined) return
  const cwd = await $.session.cwd()
  const entry: StatusEntry = {
    ...usage,
    cwd,
    model,
    isWatched,
    reminderEnabled: settings.reminderEnabled,
    reminderPercent: settings.reminderPercent,
    compactEnabled: settings.compactEnabled,
    compactPercent: settings.compactPercent,
    command: `/${$.plugin.name}:handoff`,
    updatedAt: Date.now(),
  }
  const name = cwd.replace(/[^A-Za-z0-9._-]+/g, '_')
  await $.fs.write(`${home}/.claude/context-guard/sessions/${name}.json`, JSON.stringify(entry, null, 2))
}

// Status line and status file from one reading of the session's usage.
const report = async ($: EngineInterface, settings: Settings, usage: Usage, model: string, isWatched: boolean) => {
  if (settings.usageStatus) showUsage($, usage)
  if (settings.statusFile) await writeStatus($, settings, usage, model, isWatched).catch(() => undefined)
}

export const register: Register = (on, options) => {
  const subagentCap = createSubagentCap(options)

  const settings: Settings = {
    usageStatus: options.usage_status !== false,
    statusFile: options.status_file !== false,
    reminderEnabled: options.reminder_enabled !== false,
    reminderPercent: Number(options.reminder_percent ?? 60),
    compactEnabled: options.compact_enabled !== false,
    compactPercent: Number(options.compact_percent ?? 65),
  }
  const models = String(options.models ?? 'opus')
    .split(',')
    .map(m => m.trim().toLowerCase())
    .filter(m => m !== '')
  const appliesTo = (model: string) => models.length === 0 || models.some(m => model.toLowerCase().includes(m))

  // The main loop's model, as its last request named it: the context figures
  // below are the main conversation's, and the thresholds apply per model.
  let mainModel = ''
  let lastPercent = 0
  let isCompacting = false

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    if (!settings.usageStatus && !settings.statusFile) return r
    const usage = await $.session.usage()
    await report($, settings, usage, mainModel, appliesTo(mainModel))
    return r
  }).catch(($, e, next) => next(e)) // a failed first reading must not hold the session up

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      mainModel = e.model
      return yield* next(e)
    }
    const r = yield* next(e)
    subagentCap.observeStep(e.agentId, e.model, r.usage)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined || r.messages === undefined) return r
    if (subagentCap.observeCompaction(e.agentId, r.tokensAfter)) {
      const sizes =
        r.tokensBefore !== undefined && r.tokensAfter !== undefined ? `: ${k(r.tokensBefore)} -> ${k(r.tokensAfter)}` : ''
      $.ui.toast(`Subagent compacted${sizes}`)
    }
    return r
  }).catch(($, e, next) => next(e)) // a broken observer must not stop the compaction

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined || !subagentCap.isEnabled) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.text === undefined) return ran
    const deny = subagentCap.checkResult(e.agentId, e.tool, ran.text)
    // A deny after next() does not undo the call: the model reads it in place of the result.
    return deny === undefined ? ran : { deny }
  }).catch(($, e, next) => next(e)) // a broken guard must not take the subagent's tools down

  // Fires after each main-thread turn: the only point the fill is read and acted on.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await report($, settings, e, mainModel, appliesTo(mainModel))

    const { percent, tokens, window } = e.context
    if (percent === undefined) return r

    if (!appliesTo(mainModel)) {
      await update($, fill, () => null)
      return r
    }

    const now: Fill = { percent, tokens: tokens ?? 0, window }
    await update($, fill, () => now)

    if (percent < settings.reminderPercent) {
      await update($, isHidden, () => false)
    } else if (settings.reminderEnabled && lastPercent < settings.reminderPercent) {
      $.ui.toast(`Context ${percent}%: time for /${$.plugin.name}:handoff`)
    }
    lastPercent = percent

    if (settings.compactEnabled && percent >= settings.compactPercent && !isCompacting) {
      isCompacting = true
      $.ui.toast(`Context ${percent}% passed ${settings.compactPercent}%: compacting`)
      // Between turns, as /compact runs; rejected while a turn runs, so the next measure retries.
      try {
        await $.session.compact()
      } catch {
        // a turn started meanwhile: the next measure tries again
      } finally {
        isCompacting = false
      }
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!settings.reminderEnabled || e.props.hasSurvey) return next(e)

    const now = await read($, fill)
    if (now === null || now.percent < settings.reminderPercent || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const fallback = settings.compactEnabled ? ` Auto-compact at ${settings.compactPercent}%.` : ''

    return (
      <Box>
        <Text color="yellow">
          Context {now.percent}% ({k(now.tokens)}/{k(now.window)}): run /{$.plugin.name}:handoff, then /clear.
          {fallback}{' '}
        </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
