import type { ModelUsage, PluginOptions } from 'claude-code'

// Keeps a subagent's requests under a token ceiling (default: Claude Haiku 5.5's
// 100k price step, past which a whole request bills at 5x). The engine compacts
// the subagent itself (settings: modelSettings.<model>.autoCompactWindow with
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE); this keeps a single oversized tool result from
// carrying a request past the ceiling before that compaction runs. The hooks that
// feed it live in register.tsx.

// Headroom kept below the ceiling for the next request's own overhead.
const HEADROOM = 3_000
// A result is never cut below this, so the subagent always gets something to work with.
const MIN_RESULT_TOKENS = 2_000
// Conservative chars-per-token for estimating tool results before the API counts them.
const CHARS_PER_TOKEN = 3

type Budget = {
  // Whether this loop runs on a capped model (known from its first request).
  isCapped: boolean
  // Context size as the API reported it after the loop's last request.
  reported: number
  // Tokens of tool results added since then (estimated).
  pending: number
}

export type SubagentCap = {
  isEnabled: boolean
  // After each subagent request: which model it ran on and what the API reported.
  observeStep: (agentId: string, model: string, usage: ModelUsage | null) => void
  // After a subagent compaction; true when the loop is a capped one.
  observeCompaction: (agentId: string, tokensAfter: number | undefined) => boolean
  // A tool result's text, checked against the ceiling: undefined to pass it on,
  // or the deny text that replaces it.
  checkResult: (agentId: string, tool: string, text: string) => string | undefined
}

const contextOf = (u: ModelUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens

const estimate = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN)

const k = (n: number) => `${Math.round(n / 1000)}k`

export const createSubagentCap = (options: PluginOptions): SubagentCap => {
  const isEnabled = options.subagent_cap_enabled !== false
  const ceiling = Number(options.subagent_cap_tokens ?? 100_000)
  const models = String(options.subagent_cap_models ?? 'haiku-5-5')
    .split(',')
    .map(m => m.trim().toLowerCase())
    .filter(m => m !== '')
  const isCappedModel = (model: string) => models.length === 0 || models.some(m => model.toLowerCase().includes(m))

  const budgets = new Map<string, Budget>()
  const budgetOf = (agentId: string): Budget => {
    let b = budgets.get(agentId)
    if (!b) {
      b = { isCapped: false, reported: 0, pending: 0 }
      budgets.set(agentId, b)
    }
    return b
  }

  return {
    isEnabled,

    observeStep: (agentId, model, usage) => {
      if (!isEnabled) return
      const b = budgetOf(agentId)
      b.isCapped = isCappedModel(model)
      if (b.isCapped && usage) {
        b.reported = contextOf(usage)
        b.pending = 0
      }
    },

    observeCompaction: (agentId, tokensAfter) => {
      const b = budgets.get(agentId)
      if (!isEnabled || !b?.isCapped) return false
      b.reported = tokensAfter ?? 0
      b.pending = 0
      return true
    },

    checkResult: (agentId, tool, text) => {
      const b = budgets.get(agentId)
      if (!isEnabled || !b?.isCapped) return undefined

      const used = b.reported + b.pending
      const cost = estimate(text)
      const room = Math.max(MIN_RESULT_TOKENS, ceiling - HEADROOM - used)
      if (cost <= room) {
        b.pending += cost
        return undefined
      }

      // The result would carry the next request past the ceiling: hand the model
      // a head of it instead. The call has already run, so the note says so.
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
