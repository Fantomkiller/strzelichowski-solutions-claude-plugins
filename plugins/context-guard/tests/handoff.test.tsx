import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const WINDOW = 1_000_000

const BAND = {
  plugin: 'context-guard',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// One main-loop request on `model`, so the plugin knows which model the figures belong to.
const mainStep = async ($: Engine, model: string) => {
  const stream = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1 })
  for await (const _ of stream) {
    // drain
  }
}

const measure = ($: Engine, percent: number) =>
  $.session.measure({
    context: { percent, tokens: (percent * WINDOW) / 100, window: WINDOW },
    rateLimits: [],
    changed: ['context'],
  })

// Stands in for the engine beneath: a model that answers nothing, and a compaction counter.
const engine = (on: On) => {
  const compactions = { count: 0, rows: [] as { type: string; text: string }[] }
  on('session.append', (_$, e, next) => {
    const block = e.message.content[0] as { text?: string } | undefined
    compactions.rows.push({ type: e.message.type, text: block?.text ?? '' })
    return next(e)
  })
  on('turn.step', async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.compact', () => {
    compactions.count += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }
  })
  // The engine's own band: an empty box.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="engine" />
  })
  return compactions
}

const bandText = async ($: Engine, surface: 'terminal' | 'desktop' | 'vscode') => {
  const ui = await $.ui.mount({ ...BAND, surface })
  const text = (await ui.find({ type: 'Text', text: /Context/ }))?.text
  await ui.unmount()
  return text
}

test('below the reminder threshold nothing shows and nothing compacts', async ($, on) => {
  const compactions = engine(on)
  await mainStep($, 'claude-opus-5-5')
  await measure($, 55)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    expect(await bandText($, surface)).toBeUndefined()
  }
  expect(compactions.count).toBe(0)
})

test('at 60% the band asks for a handoff on every surface', async ($, on) => {
  const compactions = engine(on)
  await mainStep($, 'claude-opus-5-5')
  await measure($, 61)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    expect(await bandText($, surface)).toMatch(/Context 61%.*handoff/)
  }
  expect(compactions.count).toBe(0)
})

test('at 65% the main conversation is compacted', async ($, on) => {
  const compactions = engine(on)
  await mainStep($, 'claude-opus-5-5')
  await measure($, 66)
  expect(compactions.count).toBe(1)
})

test('models outside the list are left alone', async ($, on) => {
  const compactions = engine(on)
  await mainStep($, 'claude-sonnet-5-5')
  await measure($, 80)
  expect(await bandText($, 'terminal')).toBeUndefined()
  expect(compactions.count).toBe(0)
})

test('both can be switched off', { options: { reminder_enabled: false, compact_enabled: false } }, async ($, on) => {
  const compactions = engine(on)
  await mainStep($, 'claude-opus-5-5')
  await measure($, 90)
  expect(await bandText($, 'terminal')).toBeUndefined()
  expect(compactions.count).toBe(0)
})

test('thresholds and models are configurable', { options: { reminder_percent: 40, compact_percent: 50, models: 'sonnet' } }, async ($, on) => {
  const compactions = engine(on)
  await mainStep($, 'claude-sonnet-5-5')
  await measure($, 45)
  expect(await bandText($, 'terminal')).toMatch(/Context 45%/)
  expect(compactions.count).toBe(0)
  await measure($, 51)
  expect(compactions.count).toBe(1)
})

test('the status line shows context, the usage limits and cost', async ($, on) => {
  engine(on)
  const lines: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  const now = Date.now()
  await $.session.measure({
    context: { percent: 12, tokens: 120_000, window: WINDOW },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42.5, resetsAt: new Date(now + 2 * 3_600_000 + 10 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 18, resetsAt: new Date(now + 3 * 86_400_000 + 5 * 3_600_000).toISOString() },
    ],
    cost: { usd: 3.456 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  expect(lines.at(-1)).toMatch(/^ctx 12% \| 5h 42\.5% \(reset 2h\d+m\) \| week 18% \(reset 3d\d+h\) \| \$3\.46$/)
})

test('the status line can be switched off', { options: { usage_status: false } }, async ($, on) => {
  engine(on)
  const lines: (string | undefined)[] = []
  on('ui.status', (_$, e) => {
    lines.push(e.text)
    return { value: undefined }
  })
  await measure($, 12)
  expect(lines).toEqual([])
})

test('crossing the reminder posts a notice in the chat and a note for Claude', { options: { reminder_tell_model: true } }, async ($, on) => {
  const engineSide = engine(on)
  await mainStep($, 'claude-opus-5-5')
  await measure($, 61)
  const notice = engineSide.rows.find(r => r.type === 'system')
  const note = engineSide.rows.find(r => r.type === 'user')
  expect(notice?.text).toMatch(/Context at 61%.*context-guard:handoff/)
  expect(note?.text).toMatch(/Start your next reply/)
  await measure($, 62)
  expect(engineSide.rows.length).toBe(2)
})

test('a usage limit past the warning level posts one notice', async ($, on) => {
  const engineSide = engine(on)
  const limits = [{ kind: 'five_hour', percentUsed: 85, resetsAt: new Date(Date.now() + 3_600_000).toISOString() }]
  await $.session.measure({ context: { percent: 10, tokens: 100_000, window: WINDOW }, rateLimits: limits, changed: ['rateLimits'] })
  await $.session.measure({ context: { percent: 11, tokens: 110_000, window: WINDOW }, rateLimits: limits, changed: ['context'] })
  const notices = engineSide.rows.filter(r => /usage limit/.test(r.text))
  expect(notices.length).toBe(1)
  expect(notices[0]?.text).toMatch(/5h usage limit at 85%/)
})

test('the band above the prompt always carries the usage line, on every surface', async ($, on) => {
  engine(on)
  await mainStep($, 'claude-opus-5-5')
  await $.session.measure({
    context: { percent: 30, tokens: 300_000, window: WINDOW },
    rateLimits: [{ kind: 'five_hour', percentUsed: 63, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString() }],
    changed: ['context', 'rateLimits'],
  })
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^ctx 30% \| 5h 63%/ }))?.text).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /handoff/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the reminder is announced once per crossing, even across reloads of the state', async ($, on) => {
  const engineSide = engine(on)
  await mainStep($, 'claude-opus-5-5')
  await measure($, 61)
  await measure($, 62)
  await measure($, 40)
  await measure($, 63)
  expect(engineSide.rows.filter(r => r.type === 'system' && /Context at/.test(r.text)).length).toBe(2)
})

test('a conversation still above the threshold after compacting is not compacted again each turn', async ($, on) => {
  const compactions = engine(on)
  await mainStep($, 'claude-opus-5-5')
  await measure($, 66)
  expect(compactions.count).toBe(1)
  await measure($, 66) // came back at 66%: the floor is now 71%
  await measure($, 68)
  expect(compactions.count).toBe(1)
  await measure($, 71)
  expect(compactions.count).toBe(2)
})

const completeTurn = async ($: Engine, answer: string) =>
  $.turn.complete({ turnId: 't', answer, durationMs: 1000, isAborted: false, reason: 'answer' })

test('beneath each answer: the usage line, and the reminder past the threshold', { options: { answer_footer: 'always' } }, async ($, on) => {
  engine(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { percent: 61, tokens: 610_000, window: WINDOW },
      rateLimits: [{ kind: 'seven_day', percentUsed: 59, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }],
    },
  }))
  await mainStep($, 'claude-opus-5-5')
  const r = await completeTurn($, 'the answer')
  expect(r.text).toMatch(/^⚠ Context 61%: run \/context-guard:handoff, then \/clear\. Auto-compact at 65%\.\nctx 61% \| week 59% \(reset (1d23h|2d0h)\)$/)
})

test('no line beneath answers when switched off', { options: { answer_footer: 'off' } }, async ($, on) => {
  engine(on)
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  const r = await completeTurn($, 'the answer')
  expect(r.text).toBe('the answer')
})
