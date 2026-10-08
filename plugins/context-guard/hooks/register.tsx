import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Fill, Level, UsagePart } from '../types'
import { createSubagentCap } from './subagent-cap'

const fill = atom({ plugin: 'context-guard', key: 'fill' } as const, null)
const isHidden = atom({ plugin: 'context-guard', key: 'isHidden' } as const, false)
const usageLine = atom({ plugin: 'context-guard', key: 'usageLine' } as const, null)
const isReminded = atom({ plugin: 'context-guard', key: 'isReminded' } as const, false)

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

type Settings = {
  usageStatus: boolean
  usageBand: boolean
  statusFile: boolean
  reminderEnabled: boolean
  reminderPercent: number
  compactEnabled: boolean
  compactPercent: number
}

type Usage = {
  context: SessionContextUsage
  rateLimits: readonly SessionRateLimit[]
}

type Session = {
  sessionId: string
  model: string
  isWatched: boolean
  // When the person last used this chat (a prompt sent, a turn ended): tells the
  // chat in front of them apart from the others in the same folder.
  activeAt: number
  // Set when the session ended (exit, /clear, resume): the VS Code extension drops it.
  endedAt?: number
}

// What the Context Guard VS Code extension reads: one file per session, so each chat
// and each VS Code window shows its own figures.
type StatusEntry = Usage &
  Session & {
    cwd: string
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

// A usage limit at or past these shows yellow, then red; the context goes yellow at the
// reminder threshold and red at the auto-compact one.
const LIMIT_WARN_PERCENT = 80
const LIMIT_DANGER_PERCENT = 95
const LEVEL_COLORS: Record<Level, string> = { ok: 'green', warn: 'yellow', danger: 'red' }

const levelOf = (percent: number, warn: number, danger: number): Level =>
  percent >= danger ? 'danger' : percent >= warn ? 'warn' : 'ok'

// Context fill and usage limits, each figure with its level.
const usageParts = (usage: Usage, settings: Settings): UsagePart[] => {
  const now = Date.now()
  const parts: UsagePart[] = []
  if (usage.context.percent !== undefined) {
    const level = levelOf(usage.context.percent, settings.reminderPercent, settings.compactPercent)
    parts.push({ text: `ctx ${usage.context.percent}%`, level })
  }
  for (const limit of usage.rateLimits) {
    const left = until(limit.resetsAt, now)
    parts.push({
      text: `${LIMIT_LABELS[limit.kind] ?? limit.kind} ${limit.percentUsed}%${left ? ` (reset ${left})` : ''}`,
      level: levelOf(limit.percentUsed, LIMIT_WARN_PERCENT, LIMIT_DANGER_PERCENT),
    })
  }
  return parts
}

const usageText = (parts: readonly UsagePart[]) => parts.map(p => p.text).join(' | ')

// The session's status file; its id is the current one unless given (an ended session's).
const writeStatus = async ($: EngineInterface, settings: Settings, usage: Usage, session: Omit<Session, 'sessionId'> & { sessionId?: string }) => {
  if (!settings.statusFile) return
  const home = await $.env.get('HOME')
  if (home === undefined) return
  const entry: StatusEntry = {
    context: usage.context,
    rateLimits: usage.rateLimits,
    ...session,
    sessionId: session.sessionId ?? (await $.session.id()),
    cwd: await $.session.cwd(),
    reminderEnabled: settings.reminderEnabled,
    reminderPercent: settings.reminderPercent,
    compactEnabled: settings.compactEnabled,
    compactPercent: settings.compactPercent,
    command: `/${$.plugin.name}:handoff`,
    updatedAt: Date.now(),
  }
  const name = entry.sessionId.replace(/[^A-Za-z0-9._-]+/g, '_')
  await $.fs.write(`${home}/.claude/context-guard/sessions/${name}.json`, JSON.stringify(entry, null, 2))
}

// A row in the conversation itself, the one place every surface (terminal, VS Code,
// desktop) shows: a notice the model never reads, so it adds nothing to the context.
const tell = async ($: EngineInterface, notice: string) => {
  await $.session.append({ message: { type: 'system', content: [{ type: 'text', text: notice }] } }).catch(() => undefined)
}

// Status line and band from one reading of the session's usage.
const report = async ($: EngineInterface, settings: Settings, usage: Usage) => {
  const parts = usageParts(usage, settings)
  if (settings.usageStatus) $.ui.status(usageText(parts) || undefined)
  if (settings.usageBand) await update($, usageLine, () => (parts.length > 0 ? parts : null))
}

export const register: Register = (on, options) => {
  const subagentCap = createSubagentCap(options)

  const settings: Settings = {
    usageStatus: options.usage_status !== false,
    usageBand: options.usage_band !== false,
    statusFile: options.status_file !== false,
    reminderEnabled: options.reminder_enabled !== false,
    reminderPercent: Number(options.reminder_percent ?? 60),
    compactEnabled: options.compact_enabled !== false,
    compactPercent: Number(options.compact_percent ?? 65),
  }
  const limitWarnPercent = Number(options.limit_warn_percent ?? 80)
  const delegationGuidance = options.delegation_guidance !== false
  const models = String(options.models ?? 'opus')
    .split(',')
    .map(m => m.trim().toLowerCase())
    .filter(m => m !== '')
  const appliesTo = (model: string) => models.length === 0 || models.some(m => model.toLowerCase().includes(m))

  // The main loop's model, as its last request named it: the context figures
  // below are the main conversation's, and the thresholds apply per model.
  let mainModel = ''
  let isCompacting = false
  // After a compaction, the next one waits until the context grew this many points
  // past the size it came back at, so a conversation that stays above the threshold
  // is not compacted turn after turn.
  const RECOMPACT_GROWTH = 5
  let isAfterCompaction = false
  let compactFloor = 0
  // Usage-limit windows already warned about, by kind and reset time.
  const warnedLimits = new Set<string>()

  // The session's last reading and last use, for its status file.
  let lastUsage: Usage | null = null
  let activeAt = Date.now()
  const sessionNow = () => ({ model: mainModel, isWatched: appliesTo(mainModel), activeAt })

  on('session.start', async ($, e, next) => {
    activeAt = Date.now()
    const r = await next(e)
    if (!settings.usageStatus && !settings.usageBand && !settings.statusFile) return r
    const usage = await $.session.usage()
    lastUsage = usage
    await report($, settings, usage)
    await writeStatus($, settings, usage, sessionNow()).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e)) // a failed first reading must not hold the session up

  // A prompt sent makes this the chat in front of the person: its file says so at once,
  // before the turn's figures arrive.
  on('prompt.submit', async ($, e, next) => {
    activeAt = Date.now()
    if (lastUsage !== null) await writeStatus($, settings, lastUsage, sessionNow()).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Exit, /clear or resume: the file is marked ended and the VS Code extension drops it.
  // After a /clear the process goes on under a new id, whose file the next reading writes.
  on('session.end', async ($, e, next) => {
    if (lastUsage !== null) await writeStatus($, settings, lastUsage, { ...sessionNow(), sessionId: e.sessionId, endedAt: Date.now() }).catch(() => undefined)
    lastUsage = null
    return next(e)
  }).catch(($, e, next) => next(e))

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
    if (r.messages === undefined) return r
    if (e.agentId === undefined) {
      // The main conversation shrank: the band's figures are stale until the next measure.
      await update($, fill, () => null)
      isAfterCompaction = true
      return r
    }
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

  // Sizing work for capped subagents: in the orchestrator's system prompt (the models the
  // reminder watches), and in each capped subagent's task.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!delegationGuidance || !subagentCap.isEnabled || !appliesTo(e.model)) return r
    return { sections: [...r.sections, { id: `${$.plugin.name}:delegation`, text: subagentCap.orchestratorNote, scope: 'session' }] }
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (!delegationGuidance || !subagentCap.isEnabled || !subagentCap.isCappedTarget(e.model ?? e.parentModel)) return next(e)
    return next({ ...e, prompt: `${e.prompt}\n\n${subagentCap.subagentNote}` })
  }).catch(($, e, next) => next(e))

  // Fires after each main-thread turn: the only point the fill is read and acted on.
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    const usage: Usage = { context: e.context, rateLimits: e.rateLimits }
    lastUsage = usage
    activeAt = Date.now()
    await report($, settings, usage)
    await writeStatus($, settings, usage, sessionNow()).catch(() => undefined)

    for (const limit of e.rateLimits) {
      const key = `${limit.kind}@${limit.resetsAt ?? ''}`
      if (limitWarnPercent > 0 && limit.percentUsed >= limitWarnPercent && !warnedLimits.has(key)) {
        warnedLimits.add(key)
        const left = until(limit.resetsAt, Date.now())
        const label = LIMIT_LABELS[limit.kind] ?? limit.kind
        await tell($, `⚠ [context-guard] ${label} usage limit at ${limit.percentUsed}%${left ? `, resets in ${left}` : ''}.`)
      }
    }

    const { percent, tokens, window } = e.context
    if (percent === undefined) return r

    if (!appliesTo(mainModel)) {
      await update($, fill, () => null)
      return r
    }

    const now: Fill = { percent, tokens: tokens ?? 0, window }
    await update($, fill, () => now)

    if (isAfterCompaction) {
      isAfterCompaction = false
      compactFloor = percent + RECOMPACT_GROWTH
    } else if (percent < settings.compactPercent) {
      compactFloor = 0
    }

    if (percent < settings.reminderPercent) {
      await update($, isHidden, () => false)
      await update($, isReminded, () => false)
    } else if (settings.reminderEnabled && !(await read($, isReminded))) {
      await update($, isReminded, () => true)
      const command = `/${$.plugin.name}:handoff`
      const fallback = settings.compactEnabled ? ` Auto-compact at ${settings.compactPercent}%.` : ''
      $.ui.toast(`Context ${percent}%: time for ${command}`)
      await tell($, `⚠ [context-guard] Context at ${percent}% (${k(now.tokens)}/${k(now.window)}): run ${command}, then /clear.${fallback}`)
    }

    if (settings.compactEnabled && percent >= Math.max(settings.compactPercent, compactFloor) && !isCompacting) {
      isCompacting = true
      $.ui.toast(`Context ${percent}% passed ${settings.compactPercent}%: compacting`)
      await tell($, `⚠ [context-guard] Context at ${percent}% passed ${settings.compactPercent}%: compacting the conversation.`)
      // Between turns, as /compact runs; rejected while a turn runs, so the next measure retries.
      try {
        // The plugin's own session.compact hook is skipped for its own call: mark it here.
        const done = await $.session.compact()
        if (done.messages !== undefined) {
          isAfterCompaction = true
          await update($, fill, () => null)
        }
      } catch {
        // a turn started meanwhile: the next measure tries again
      } finally {
        isCompacting = false
      }
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const now = await read($, fill)
    const isDue =
      settings.reminderEnabled && now !== null && now.percent >= settings.reminderPercent && !(await read($, isHidden))
    const line = settings.usageBand ? await read($, usageLine) : null
    if (!isDue && line === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const fallback = settings.compactEnabled ? ` Auto-compact at ${settings.compactPercent}%.` : ''

    return (
      <Box flexDirection="column">
        {isDue && now !== null ? (
          <Box>
            <Text color="yellow">
              Context {now.percent}% ({k(now.tokens)}/{k(now.window)}): run /{$.plugin.name}:handoff, then /clear.
              {fallback}{' '}
            </Text>
            <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
          </Box>
        ) : null}
        {line !== null ? (
          <Box>
            {line.map((part, i) => (
              <Text key={`part${i}`} color={LEVEL_COLORS[part.level]}>
                {i > 0 ? ' | ' : ''}
                {part.text}
              </Text>
            ))}
          </Box>
        ) : null}
      </Box>
    )
  })
}
