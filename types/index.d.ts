export type Usage = {
  tokens?: number
  window: number
  percent?: number
  usd?: number
  fiveHour?: Limit
  weekly?: Limit
}

export type Limit = { percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'claude-mods': { usage: Usage; armed: string | null; isShooting: boolean }
  }
}
