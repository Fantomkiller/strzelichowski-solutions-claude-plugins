export type Fill = { percent: number; tokens: number; window: number }

declare module 'claude-code' {
  interface PluginState {
    'context-guard': {
      fill: Fill | null
      isHidden: boolean
      // The usage line the band shows: context, plan limits, cost.
      usageLine: string | null
      // Whether the current crossing of the reminder threshold was announced; kept across reloads.
      isReminded: boolean
    }
  }
}
