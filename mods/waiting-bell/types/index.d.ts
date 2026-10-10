// 'turn': the main session finished and waits for a prompt. 'dialog': a
// permission prompt, question or plan approval waits for an answer.
export type WaitingKind = 'turn' | 'dialog'

export type Waiting = {
  kind: WaitingKind
  reason: string
  since: number
  rings: number
  isFlashOn: boolean
  // The session went back to work on its own (a background task's notice):
  // quiet until that turn ends, then the same wait resumes.
  isPaused: boolean
  agentId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'waiting-bell': { waiting: Waiting | null }
  }
}
