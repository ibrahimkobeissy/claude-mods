export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  startedAt: number
  contextTokens?: number
  contextWindow: number
  contextPercent?: number
  rateLimits: RateLimit[]
}

export type LimitSample = { kind: string; at: number; percentUsed: number; resetsAt?: string }

export type Main = { model?: string; effort?: string; cwd?: string; branch?: string; isWorktree: boolean }

export type AgentStatusName = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'

export type AgentRow = {
  id: string
  type: string
  description: string
  status: AgentStatusName
  model?: string
  startedAt: number
  endedAt?: number
  tools: number
  errors: number
  contextTokens?: number
  lastMessage?: string
  cwd?: string
  branch?: string
  isWorktree: boolean
}

export type ShellStatus = 'running' | 'completed' | 'failed' | 'killed'

export type ShellRow = {
  id: string
  kind: string
  command: string
  description?: string
  startedAt: number
  status: ShellStatus
  endedAt?: number
  summary?: string
  outputPath?: string
  agentId?: string
}

export type Cron = { id: string; schedule: string; recurring: boolean; prompt: string; at?: number }

export type ProgressItem = { id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }

export type Progress = { todos: ProgressItem[]; tasks: ProgressItem[]; plan?: string }

export type Needs = { who: string; agentId?: string; what: string; since: number }

export type View = { screen: 'overview' | 'shell'; shellId?: string; expanded?: string; folded: string[] }

export type Output = { shellId: string; lines: string[]; at: number; error?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-radar': {
      usage: Usage | null
      samples: LimitSample[]
      main: Main
      agents: Record<string, AgentRow>
      shells: Record<string, ShellRow>
      crons: Cron[]
      progress: Progress
      needs: Needs | null
      view: View
      output: Output | null
      tick: number
    }
  }
}
