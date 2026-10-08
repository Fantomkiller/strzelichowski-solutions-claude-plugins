export type Fill = { percent: number; tokens: number; window: number }

// One figure of the usage line and its color on the green-to-red scale.
export type UsagePart = { text: string; color: string }

declare module 'claude-code' {
  interface PluginState {
    'context-guard': {
      fill: Fill | null
      isHidden: boolean
      // The usage line the band shows, figure by figure: context and plan limits.
      usageLine: UsagePart[] | null
      // Whether the current crossing of the reminder threshold was announced; kept across reloads.
      isReminded: boolean
    }
  }
}
