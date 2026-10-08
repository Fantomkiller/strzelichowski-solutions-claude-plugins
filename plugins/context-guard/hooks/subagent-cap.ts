import type { ModelUsage, PluginOptions } from 'claude-code'

// Keeps a subagent's requests under a token ceiling (default: Claude Haiku 5.5's
// 100k price step, past which a whole request bills at 5x). The engine compacts the
// subagent itself, before the request that would pass its compaction point (settings:
// modelSettings.<model>.autoCompactWindow, less the engine's 33k buffer); that request
// then holds the agent's starting context, a summary and the new result. This cuts only
// a tool result that would carry a request past the ceiling even so. The hooks that
// feed it live in register.tsx.

// Headroom kept below the ceiling for the next request's own overhead.
const HEADROOM = 3_000
// A result is never cut below this, so the subagent always gets something to work with.
const MIN_RESULT_TOKENS = 2_000
// Conservative chars-per-token for estimating tool results before the API counts them.
const CHARS_PER_TOKEN = 3
// What a compaction's summary and the messages it keeps add to the agent's starting context.
const SUMMARY_TOKENS = 8_000

type Budget = {
  // Whether this loop runs on a capped model (known from its first request).
  isCapped: boolean
  // Context size as the API reported it after the loop's last request.
  reported: number
  // The loop's starting context (system prompt, tools, task), what a compaction comes back to.
  floor: number
  // Tokens of tool results added since then (estimated).
  pending: number
}

export type SubagentCap = {
  isEnabled: boolean
  // The ceiling, the compaction point and the capped models' id fragments, as configured.
  ceiling: number
  compactAt: number
  models: readonly string[]
  // After each subagent request: which model it ran on and what the API reported.
  observeStep: (agentId: string, model: string, usage: ModelUsage | null) => void
  // After a subagent compaction; true when the loop is a capped one.
  observeCompaction: (agentId: string, tokensAfter: number | undefined) => boolean
  // A tool result's text, checked against the ceiling: undefined to pass it on,
  // or the deny text that replaces it.
  checkResult: (agentId: string, tool: string, text: string) => string | undefined
  // Whether a spawn's model (a full id or an alias such as haiku) is a capped one.
  isCappedTarget: (model: string) => boolean
  // For the orchestrator's system prompt: how to size work for capped subagents.
  orchestratorNote: string
  // Added to a capped subagent's task: its budget, and to carry on after a compaction.
  subagentNote: string
}

const contextOf = (u: ModelUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens

const estimate = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN)

const k = (n: number) => `${Math.round(n / 1000)}k`

export const createSubagentCap = (options: PluginOptions): SubagentCap => {
  const isEnabled = options.subagent_cap_enabled !== false
  const ceiling = Number(options.subagent_cap_tokens ?? 100_000)
  const compactAt = Number(options.subagent_compact_tokens ?? 95_000)
  const models = String(options.subagent_cap_models ?? 'haiku-5-5')
    .split(',')
    .map(m => m.trim().toLowerCase())
    .filter(m => m !== '')
  const isCappedModel = (model: string) => models.length === 0 || models.some(m => model.toLowerCase().includes(m))

  const budgets = new Map<string, Budget>()
  const budgetOf = (agentId: string): Budget => {
    let b = budgets.get(agentId)
    if (!b) {
      b = { isCapped: false, reported: 0, floor: 0, pending: 0 }
      budgets.set(agentId, b)
    }
    return b
  }

  // An alias names a family (haiku, sonnet, opus): it matches a fragment of that family.
  const isCappedTarget = (model: string) => {
    const m = model.toLowerCase()
    return m !== '' && (isCappedModel(m) || models.some(f => f.split('-')[0] === m))
  }

  // Measured: a general-purpose subagent's first request is ~30-40k tokens before it reads anything.
  const room = Math.max(10_000, compactAt - 35_000)
  const orchestratorNote = [
    '# Delegating to capped subagents (context-guard)',
    `Subagents on ${models.length > 0 ? models.join(', ') : 'any model'} (Claude Haiku 5.5 bills a whole request at 5x once its prompt passes 100k tokens) are kept under ${k(ceiling)} tokens per request: Claude Code compacts them at about ${k(compactAt)} and they carry on. Each one starts with about 30-40k tokens already in use (system prompt, tool definitions, its task), which leaves it roughly ${k(room)} for its own reading before a compaction.`,
    'This changes neither whether you delegate nor which model you pick: use these subagents when the user asks for them, or when you judge them worth it (a large, mechanical or parallel job), as you otherwise would. Once you do delegate to them:',
    `- Split the work into several small subagents, each with one narrow, self-contained task whose reading fits in about ${k(room)}, rather than one subagent that reads everything; start independent ones in parallel.`,
    '- A larger task still finishes: the subagent compacts and continues. But each compaction costs a summary request and loses detail, and Claude Code stops a subagent that refills its window within three turns of a compaction. So never give one subagent inputs that are each a large share of that room: split them, or tell it to Grep first and read in slices (offset/limit).',
    '- Ask for a compact answer (findings, file:line references, a verdict), not raw content, so its reply stays small in your own context.',
    '- Put the paths and facts it needs in its prompt, so it does not spend its room rediscovering them.',
  ].join('\n')
  const subagentNote =
    `[context-guard] Your context starts with about 30-40k tokens in use and is compacted automatically at about ${k(compactAt)}, ` +
    `so each request stays under ${k(ceiling)} tokens. After a compaction, carry on with the task from the summary; do not start over. ` +
    'Grep before reading whole files and read large files in slices (offset/limit); a tool result too large to fit comes back cut, with a note saying so.'

  return {
    isEnabled,
    ceiling,
    compactAt,
    models,
    isCappedTarget,
    orchestratorNote,
    subagentNote,

    observeStep: (agentId, model, usage) => {
      if (!isEnabled) return
      const b = budgetOf(agentId)
      b.isCapped = isCappedModel(model)
      if (b.isCapped && usage) {
        b.reported = contextOf(usage)
        b.floor = b.floor === 0 ? b.reported : Math.min(b.floor, b.reported)
        b.pending = 0
      }
    },

    observeCompaction: (agentId, tokensAfter) => {
      const b = budgets.get(agentId)
      if (!isEnabled || !b?.isCapped) return false
      b.reported = b.floor + (tokensAfter ?? SUMMARY_TOKENS)
      b.pending = 0
      return true
    },

    checkResult: (agentId, tool, text) => {
      const b = budgets.get(agentId)
      if (!isEnabled || !b?.isCapped) return undefined

      const limit = ceiling - HEADROOM
      const used = b.reported + b.pending
      const cost = estimate(text)
      if (used + cost <= limit) {
        b.pending += cost
        return undefined
      }

      // Past the compaction point the engine compacts before the next request, which
      // then holds the starting context, a summary and this result.
      const isCompacting = used + cost > compactAt
      const base = isCompacting ? b.floor + SUMMARY_TOKENS : used
      const room = Math.max(MIN_RESULT_TOKENS, limit - base)
      if (isCompacting) {
        b.reported = base
        b.pending = 0
      }
      if (cost <= room) {
        b.pending += cost
        return undefined
      }

      // The result would carry the next request past the ceiling even so: hand the
      // model a head of it instead. The call has already run, so the note says so.
      const head = text.slice(0, (room - 300) * CHARS_PER_TOKEN)
      b.pending += estimate(head) + 100
      return (
        `[context-guard] The ${tool} call DID run, but its full result (~${k(cost)} tokens) ` +
        `would push this context past ${k(ceiling)} tokens. First ${head.length} of ` +
        `${text.length} characters:\n${head}\n[...truncated]\n` +
        `Context is compacted automatically near the limit; read the rest in smaller pieces ` +
        `(offset/limit, grep -m, head) if you still need it.`
      )
    },
  }
}
