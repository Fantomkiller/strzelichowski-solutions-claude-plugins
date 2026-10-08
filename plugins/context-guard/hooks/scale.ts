// One color scale for every figure: a score from 0 (green) to 1 (red), through yellow
// and orange. The VS Code extension (vscode-context-guard/extension.js) keeps a copy.

// A limit's own usage starts warming at USE_FROM and is red at USE_TO.
const USE_FROM = 30
const USE_TO = 95
// Its pace: the usage at reset if it goes on as it has, warming past PACE_FROM, deepest at
// PACE_TO, never red on pace alone; read once a tenth of the window has passed.
const PACE_FROM = 70
const PACE_TO = 150
const PACE_MAX = 0.9
const PACE_AFTER = 0.1
// The length of each limit's window.
const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 }

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

// The context warms from half the reminder threshold and is red at the compaction one.
export const contextScore = (percent: number, reminderPercent: number, compactPercent: number) => {
  const from = reminderPercent / 2
  return clamp01((percent - from) / Math.max(1, compactPercent - from))
}

export type LimitReading = {
  score: number
  // At the pace so far, how long until the limit is reached, when that comes before its reset.
  limitInMs?: number
}

export const limitScore = (kind: string, percentUsed: number, resetsAt: string | undefined, now: number): LimitReading => {
  const usage = clamp01((percentUsed - USE_FROM) / (USE_TO - USE_FROM))
  const window = WINDOW_MS[kind]
  const left = resetsAt === undefined ? NaN : Date.parse(resetsAt) - now
  if (window === undefined || !(left > 0) || left >= window) return { score: usage }
  const elapsed = window - left
  if (elapsed < window * PACE_AFTER || percentUsed <= 0) return { score: usage }
  const projected = (percentUsed * window) / elapsed
  const pace = PACE_MAX * clamp01((projected - PACE_FROM) / (PACE_TO - PACE_FROM))
  const limitInMs = percentUsed < 100 && projected > 100 ? ((100 - percentUsed) * elapsed) / percentUsed : undefined
  return { score: Math.max(usage, pace), ...(limitInMs !== undefined ? { limitInMs } : {}) }
}

// Hue 120 (green) to 0 (red), bright enough on dark and light backgrounds.
export const colorOf = (score: number) => {
  const h = 120 * (1 - clamp01(score))
  const s = 0.75
  const l = 0.48
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}
