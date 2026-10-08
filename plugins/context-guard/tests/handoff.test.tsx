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
  const compactions = { count: 0 }
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
