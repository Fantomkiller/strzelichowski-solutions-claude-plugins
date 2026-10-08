// What /context-guard-setup writes to ~/.claude/settings.json: for each capped model, the
// compaction window that makes Claude Code compact its subagents at the plugin's
// compaction point. Claude Code compacts at the window less a fixed buffer, whatever
// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE says. The hooks that call it live in register.tsx.

// Claude Code's own autocompact buffer, as /context shows it ("Autocompact buffer").
export const COMPACT_BUFFER = 33_000
// The window settings take.
const MIN_WINDOW = 100_000
const MAX_WINDOW = 1_000_000

type Settings = { modelSettings?: Record<string, Record<string, unknown>> } & Record<string, unknown>

export type SetupPlan = {
  // The settings file as it should read, or undefined when nothing changes.
  text?: string
  // One line per model: what it was and what it becomes.
  changes: string[]
  // Why the file could not be changed (it does not parse).
  error?: string
}

// A model id fragment as the subagent ceiling takes it (haiku-5-5) to the settings key (claude-haiku-5-5).
export const settingsKeyOf = (fragment: string) => (fragment.startsWith('claude-') ? fragment : `claude-${fragment}`)

export const windowFor = (compactAt: number) => Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, compactAt + COMPACT_BUFFER))

const parse = (text: string): Settings | string => {
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Settings) : 'not a JSON object'
  } catch (error) {
    return String(error)
  }
}

// Whether every capped model already compacts between the compaction point (less a little) and the ceiling.
export const isConfigured = (text: string, fragments: readonly string[], compactAt: number, ceiling: number) => {
  const settings = parse(text)
  if (typeof settings === 'string') return true // not ours to judge: setup reports it when run
  return fragments.every(f => {
    const window = settings.modelSettings?.[settingsKeyOf(f)]?.autoCompactWindow
    if (typeof window !== 'number') return false
    const point = window - COMPACT_BUFFER
    return point >= compactAt - 5_000 && point <= ceiling
  })
}

export const planSetup = (text: string, fragments: readonly string[], compactAt: number): SetupPlan => {
  const settings = parse(text)
  if (typeof settings === 'string') return { changes: [], error: settings }
  const window = windowFor(compactAt)
  const modelSettings = { ...(settings.modelSettings ?? {}) }
  const changes: string[] = []
  for (const fragment of fragments) {
    const key = settingsKeyOf(fragment)
    const before = modelSettings[key]?.autoCompactWindow
    if (before === window) continue
    modelSettings[key] = { ...(modelSettings[key] ?? {}), autoCompactWindow: window }
    changes.push(`modelSettings.${key}.autoCompactWindow: ${before === undefined ? 'unset' : String(before)} -> ${window}`)
  }
  if (changes.length === 0) return { changes }
  return { text: `${JSON.stringify({ ...settings, modelSettings }, null, 2)}\n`, changes }
}
