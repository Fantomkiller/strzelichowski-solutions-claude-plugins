import { test, expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const AGENT = 'sub-1'
const MAIN = null

// Stands in for the API: every request reports `context` tokens.
const fakeModel = (on: On, context: () => number) =>
  on('turn.step', async function* (_$, e) {
    const usage = {
      model: e.model,
      input_tokens: context(),
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }
    yield { kind: 'stop', stopReason: 'tool_use', usage }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage }
  })

// Stands in for a tool whose output is `chars` characters long.
const fakeTool = (on: On, chars: () => number) =>
  on('tool.call', () => ({ result: {}, text: 'x'.repeat(chars()) }))

// Drains the stream; returns the text the loop would record and the reported usage.
const step = async ($: Engine, index: number, agentId: string | null = AGENT, model = 'claude-haiku-5-5') => {
  const stream = $.turn.step({ turnId: 't', index, model, messageCount: 1, agentId: agentId ?? undefined })
  let text = ''
  let usage: unknown = undefined
  for await (const chunk of stream) {
    if (chunk.kind === 'text') text += chunk.text
    if (chunk.kind === 'stop') usage = chunk.usage
  }
  return { text, usage }
}

// The engine stamps agentId on a subagent's calls; the typed call input leaves it out.
const read = ($: Engine, agentId: string | null = AGENT) =>
  $.tool.call({ tool: 'Read', file_path: '/tmp/x', ...(agentId ? { agentId } : {}) } as { tool: 'Read'; file_path: string })

test('small results pass through under the price step', async ($, on) => {
  fakeModel(on, () => 20_000)
  fakeTool(on, () => 3_000)
  await step($, 0)
  const r = await read($)
  expect(r.deny).toBeUndefined()
  expect(r.text?.length).toBe(3_000)
})

test('a result that would cross the price step comes back truncated', async ($, on) => {
  fakeModel(on, () => 70_000)
  fakeTool(on, () => 120_000) // ~40k tokens
  await step($, 0)
  const r = await read($)
  expect(r.deny).toMatch(/DID run/)
  // 70k used, 97k ceiling: at most ~27k tokens (~81k chars) of the result survive.
  expect((r.deny ?? '').length).toBeLessThan(82_000)
})

test('near the limit the subagent keeps working: tools still run, results are cut to the minimum', async ($, on) => {
  fakeModel(on, () => 96_000)
  fakeTool(on, () => 30_000)
  await step($, 0)
  const r = await read($)
  expect(r.deny).toMatch(/DID run/)
  expect((r.deny ?? '').length).toBeGreaterThan(5_000)
  const s = await step($, 1)
  expect(s.text).toBe('')
  expect(s.usage).toMatchObject({ input_tokens: 96_000 })
})

test('past the compaction point a result that fits after compacting passes whole', async ($, on) => {
  let context = 38_000 // the subagent's starting context
  fakeModel(on, () => context)
  fakeTool(on, () => 39_000) // ~13k tokens: 85k + 13k passes 97k, 38k + 8k + 13k does not
  await step($, 0)
  context = 85_000
  await step($, 1)
  const r = await read($)
  expect(r.deny).toBeUndefined()
  expect(r.text?.length).toBe(39_000)
})

test('without a compaction point under the ceiling the same result is cut', { options: { subagent_compact_tokens: 1_000_000 } }, async ($, on) => {
  let context = 38_000
  fakeModel(on, () => context)
  fakeTool(on, () => 39_000)
  await step($, 0)
  context = 85_000
  await step($, 1)
  const r = await read($)
  expect(r.deny).toMatch(/DID run/)
})

test('the main conversation is never touched', async ($, on) => {
  fakeModel(on, () => 150_000)
  fakeTool(on, () => 600_000)
  await step($, 0, MAIN)
  const r = await read($, MAIN)
  expect(r.deny).toBeUndefined()
})

test('the ceiling is configurable', { options: { subagent_cap_tokens: 50_000 } }, async ($, on) => {
  fakeModel(on, () => 40_000)
  fakeTool(on, () => 60_000) // ~20k tokens: fits 100k, not 50k
  await step($, 0)
  const r = await read($)
  expect(r.deny).toMatch(/past 50k tokens/)
})

test('the ceiling can be switched off', { options: { subagent_cap_enabled: false } }, async ($, on) => {
  fakeModel(on, () => 96_000)
  fakeTool(on, () => 300_000)
  await step($, 0)
  const r = await read($)
  expect(r.deny).toBeUndefined()
})

test('the ceiling follows the model list', { options: { subagent_cap_models: 'sonnet' } }, async ($, on) => {
  fakeModel(on, () => 96_000)
  fakeTool(on, () => 300_000)
  await step($, 0, AGENT, 'claude-sonnet-5-5')
  const r = await read($)
  expect(r.deny).toMatch(/DID run/)
})

test('subagents on other models are never touched', async ($, on) => {
  fakeModel(on, () => 400_000)
  fakeTool(on, () => 600_000)
  await step($, 0, AGENT, 'claude-sonnet-5-5')
  const r = await read($)
  expect(r.deny).toBeUndefined()
})

// Stands in for the engine's system prompt: one section of its own.
const composed = async ($: Engine, on: On, model: string) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' as const }] }))
  const r = await $.prompt.compose({ model, promptModel: model, surfaces: [], tools: [], outputStyle: null, traits: [] })
  return r.sections.find(s => s.id === 'context-guard:delegation')?.text
}

test('the orchestrator is told how to size work for capped subagents', async ($, on) => {
  const note = await composed($, on, 'claude-opus-5-5')
  expect(note).toMatch(/several small subagents/)
  expect(note).toMatch(/changes neither whether you delegate nor which model you pick/)
  expect(note).toMatch(/compacts them at about 95k/)
  expect(note).toMatch(/roughly 60k/)
})

test('capped subagents themselves get no orchestrator guidance', async ($, on) => {
  expect(await composed($, on, 'claude-haiku-5-5')).toBeUndefined()
})

test('the guidance can be switched off', { options: { delegation_guidance: false } }, async ($, on) => {
  expect(await composed($, on, 'claude-opus-5-5')).toBeUndefined()
})

// Stands in for the Agent tool: records the task each subagent starts with.
const spawner = (on: On) => {
  const prompts: string[] = []
  on('agent.spawn', (_$, e) => {
    prompts.push(e.prompt)
    return { model: e.model ?? e.parentModel }
  })
  return async ($: Engine, model: string | undefined) => {
    await $.agent.spawn({
      tool_use_id: 'toolu_1',
      prompt: 'Read the files.',
      description: 'read',
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
      ...(model ? { model } : {}),
    })
    return prompts.at(-1) ?? ''
  }
}

test('a capped subagent is told its budget and to carry on after compacting', async ($, on) => {
  const prompt = await spawner(on)($, 'haiku')
  expect(prompt).toMatch(/^Read the files\.\n\n\[context-guard\]/)
  expect(prompt).toMatch(/compacted automatically at about 95k/)
  expect(prompt).toMatch(/do not start over/)
})

test('other subagents start with their task as given', async ($, on) => {
  const spawn = spawner(on)
  expect(await spawn($, 'sonnet')).toBe('Read the files.')
  expect(await spawn($, undefined)).toBe('Read the files.')
})
