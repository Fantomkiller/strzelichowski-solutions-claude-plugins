export type Fill = { percent: number; tokens: number; window: number }

export type Level = 'ok' | 'warn' | 'danger'
// One figure of the usage line; the cost carries no level.
export type UsagePart = { text: string; level: Level | null }

declare module 'claude-code' {
  interface PluginState {
    'context-guard': {
      fill: Fill | null
      isHidden: boolean
      // The usage line the band shows, figure by figure: context, plan limits, cost.
      usageLine: UsagePart[] | null
      // Whether the current crossing of the reminder threshold was announced; kept across reloads.
      isReminded: boolean
    }
  }
}
