export type Waiting = { reason: string; since: number; rings: number; isFlashOn: boolean }

declare module 'claude-code' {
  interface PluginState {
    'waiting-bell': { waiting: Waiting | null }
  }
}
