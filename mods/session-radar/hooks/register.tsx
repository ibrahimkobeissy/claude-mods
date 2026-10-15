import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, AgentStatusName, Catalog, Cron, InUse, Main, ProgressItem, ShellRow, Usage, View } from '../types'
import {
  addSamples, clip, clock, duration, effortMeter, gauge, modelName, shortPath, stopwatch, exitCodeOf, forecast, lastLine, limitLabel,
  mcpParts, outputPathOf, pack, parentDir, parseTaskNotice, resetLabel, tail, tokens,
} from './lib'
import type { TaskNotice } from './lib'

const PANE = 'session-radar'
const WAKEUP = 'wakeup'
const TICK_MS = 5000
const OUTPUT_MS = 2000
// Branches are read with git, so not on every tick.
const BRANCH_EVERY_TICKS = 6
const MAX_OUTPUT_LINES = 200
const MAX_CARDS = 4
// The MCP and skill lists show this many rows until unrolled.
const LIST_ROWS = 2
const ACTIVE_ROWS = 3
const C = {
  main: '#d97757', agents: '#a5b4fc', shells: '#4ade80', progress: '#c084fc',
  warn: '#facc15', bad: '#f87171', branch: '#7ab7ff', mcp: '#38bdf8', skills: '#f472b6',
} as const
const FINISHED_SHELLS_SHOWN = 3
// Beyond this the newest live tasks show and the rest are counted.
const LIVE_SHELLS_SHOWN = 8
const ENDED: ReadonlySet<AgentStatusName> = new Set(['completed', 'failed', 'killed'])
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog'])

const usage = atom({ plugin: 'session-radar', key: 'usage' } as const, null)
const samples = atom({ plugin: 'session-radar', key: 'samples' } as const, [])
const main = atom({ plugin: 'session-radar', key: 'main' } as const, { isWorktree: false })
const agents = atom({ plugin: 'session-radar', key: 'agents' } as const, {})
const shells = atom({ plugin: 'session-radar', key: 'shells' } as const, {})
const crons = atom({ plugin: 'session-radar', key: 'crons' } as const, [])
const progress = atom({ plugin: 'session-radar', key: 'progress' } as const, { todos: [], tasks: [] })
const needs = atom({ plugin: 'session-radar', key: 'needs' } as const, null)
const view = atom({ plugin: 'session-radar', key: 'view' } as const, { screen: 'overview', folded: [] })
const output = atom({ plugin: 'session-radar', key: 'output' } as const, null)
const tick = atom({ plugin: 'session-radar', key: 'tick' } as const, 0)
const catalog = atom({ plugin: 'session-radar', key: 'catalog' } as const, { servers: [], toolServer: {}, skills: [] })
const inUse = atom({ plugin: 'session-radar', key: 'inUse' } as const, {})

let ticker: Timer | undefined
let outputTimer: Timer | undefined
let ticks = 0
// The radar's own version, from its plugin.json; '' when it cannot be read.
let version: string | undefined
// Agent tool calls that asked for a worktree, until agent.spawn names the agent.
const worktreeCalls = new Set<string>()
const branchOf = new Map<string, { branch?: string; isWorktree: boolean }>()
// Skill tool calls in flight, by skill name: their skill.prompt is already counted.
const skillCalls = new Map<string, number>()

// ── reading the world ────────────────────────────────────────────────────────

async function readBranch($: EngineInterface, cwd: string) {
  // Absolute paths: from a subfolder git prints the git dir absolute and the
  // common dir relative, which would read as a worktree. Git before 2.31 lacks
  // the flag, so the branch alone is asked for then.
  const git = (args: string[]) => $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 3000 }).catch(() => undefined)
  const ran = await git(['rev-parse', '--abbrev-ref', 'HEAD', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  const out = ran?.exitCode === 0 ? ran : await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (!out || out.exitCode !== 0) return { isWorktree: false }
  const [head, gitDir, commonDir] = out.stdout.trim().split('\n')
  const found = { branch: head === 'HEAD' ? 'detached' : head, isWorktree: Boolean(gitDir && commonDir && gitDir !== commonDir) }
  branchOf.set(cwd, found)
  return found
}

async function refreshBranches($: EngineInterface) {
  const cwd = await $.session.cwd()
  const found = await readBranch($, cwd)
  await update($, main, (m): Main => ({ ...m, cwd, ...found }))
  const list = Object.values(await read($, agents)).filter(a => a.cwd && !ENDED.has(a.status))
  for (const a of list) {
    const b = await readBranch($, a.cwd!)
    await update($, agents, all => (all[a.id] ? { ...all, [a.id]: { ...all[a.id]!, ...b } } : all))
  }
}

async function saveUsage($: EngineInterface, u: Omit<Usage, 'startedAt'>) {
  const now = await $.clock.now()
  await update($, usage, (old): Usage => ({ startedAt: old?.startedAt ?? now, ...u }))
  await update($, samples, s => addSamples(s, u.rateLimits, now))
}

// The servers and skills the context lists, estimated locally (no API call).
async function refreshCatalog($: EngineInterface) {
  const b = (await $.session.usage({ breakdown: 'summary' }).catch(() => undefined))?.context.breakdown
  if (!b) return
  const count = new Map<string, number>()
  const toolServer: Record<string, string> = {}
  for (const t of b.mcpTools) {
    count.set(t.serverName, (count.get(t.serverName) ?? 0) + 1)
    toolServer[t.name] = t.serverName
  }
  const servers = [...count].map(([name, tools]) => ({ name, tools })).sort((x, y) => x.name.localeCompare(y.name))
  const skills = (b.skills?.skillFrontmatter ?? []).map(s => s.name).sort()
  await update($, catalog, (): Catalog => ({ servers, toolServer, skills }))
}

async function startUse($: EngineInterface, use: Omit<InUse, 'startedAt'>) {
  const startedAt = await $.clock.now()
  await update($, inUse, all => ({ ...all, [use.id]: { ...use, startedAt } }))
}

function endUse($: EngineInterface, keep: (x: InUse) => boolean) {
  return update($, inUse, all => {
    const gone = Object.values(all).filter(x => !keep(x))
    if (gone.length === 0) return all
    const next = { ...all }
    for (const x of gone) delete next[x.id]
    return next
  })
}

// A loop's turn is over: what it used is no longer in use.
function endTurn($: EngineInterface, agentId: string | undefined) {
  return endUse($, x => x.agentId !== agentId)
}

async function pollAgents($: EngineInterface) {
  const list = await $.agent.list().catch(() => [])
  const now = await $.clock.now()
  const before = await read($, agents)
  await update($, agents, all => {
    let next = all
    for (const info of list) {
      const row = next[info.id]
      const status = info.status as AgentStatusName
      if (!row) {
        next = {
          ...next,
          [info.id]: {
            id: info.id, type: info.type, description: info.description, status, startedAt: now,
            tools: 0, errors: 0, isWorktree: false, endedAt: ENDED.has(status) ? now : undefined,
          },
        }
      } else if (row.status !== status) {
        next = { ...next, [info.id]: { ...row, status, endedAt: ENDED.has(status) ? (row.endedAt ?? now) : undefined } }
      }
    }
    return next
  })
  for (const info of list) {
    const was = before[info.id]
    if (was && !ENDED.has(was.status) && ENDED.has(info.status as AgentStatusName)) {
      await announceAgentEnd($, was, info.status as AgentStatusName, now)
    }
  }
}

async function announceAgentEnd($: EngineInterface, agent: AgentRow, status: AgentStatusName, now: number) {
  const word = status === 'completed' ? 'completed' : status
  $.ui.toast(`${status === 'completed' ? '✓' : '✗'} agent ${word}: ${clip(agent.description, 40)}`)
  await endTurn($, agent.id)
  // The engine stops a foreground subagent's background shells with it.
  await update($, shells, all => {
    let next = all
    for (const x of Object.values(all)) {
      if (x.agentId === agent.id && x.endsWithAgent && x.status === 'running') {
        next = { ...next, [x.id]: { ...x, status: 'completed', endedAt: now, summary: 'ended with its agent' } }
      }
    }
    return next
  })
}

// A Stop names every task still in flight, the list the footer counts from: a
// row it leaves out ended without a notice reaching us (a monitor's timeout, a
// task stopped with its agent), so it is marked done.
async function reconcileShells($: EngineInterface, inFlight: readonly { id: string }[] | undefined) {
  if (!inFlight) return
  const live = new Set(inFlight.map(t => t.id))
  const now = await $.clock.now()
  await update($, shells, all => {
    let next = all
    for (const x of Object.values(all)) {
      if (x.status === 'running' && !live.has(x.id)) next = { ...next, [x.id]: { ...x, status: 'completed', endedAt: now, summary: x.summary ?? 'ended' } }
    }
    return next
  })
}

// "1 shell · 4 monitors", the way the footer counts what runs in the background.
function backgroundCount(live: readonly ShellRow[]) {
  const shells = live.filter(x => x.kind === 'shell').length
  const others = live.length - shells
  const parts = [shells ? `${shells} shell${shells === 1 ? '' : 's'}` : '', others ? `${others} monitor${others === 1 ? '' : 's'}` : '']
  return parts.filter(Boolean).join(' · ')
}

async function onTick($: EngineInterface) {
  ticks += 1
  await update($, tick, () => ticks)
  await pollAgents($)
  if (ticks % BRANCH_EVERY_TICKS === 0) {
    await refreshBranches($)
    await refreshCatalog($)
  }
}

async function readOutput($: EngineInterface, shell: ShellRow, count: number) {
  if (!shell.outputPath) return { lines: [], error: 'No output file for this task.' }
  try {
    const stat = await $.fs.stat(shell.outputPath)
    if (stat.size > 2 * 1024 * 1024) {
      const ran = await $.process.run(['tail', '-n', String(count), shell.outputPath], { timeoutMs: 3000 })
      return { lines: tail(ran.stdout, count) }
    }
    return { lines: tail(await $.fs.read(shell.outputPath), count) }
  } catch {
    return { lines: [], error: 'The output file is gone.' }
  }
}

async function refreshOutput($: EngineInterface) {
  const v = await read($, view)
  const shell = v.shellId ? (await read($, shells))[v.shellId] : undefined
  if (v.screen !== 'shell' || !shell) return
  const got = await readOutput($, shell, MAX_OUTPUT_LINES)
  const at = await $.clock.now()
  await update($, output, () => ({ shellId: shell.id, at, ...got }))
}

async function openShell($: EngineInterface, id: string) {
  await update($, output, () => null)
  await update($, view, (v): View => ({ ...v, screen: 'shell', shellId: id }))
  outputTimer?.cancel()
  outputTimer = $.clock.every(OUTPUT_MS, () => void refreshOutput($))
  await refreshOutput($)
}

async function back($: EngineInterface) {
  outputTimer?.cancel()
  outputTimer = undefined
  await update($, view, (v): View => ({ ...v, screen: 'overview', shellId: undefined }))
}

async function setNeeds($: EngineInterface, agentId: string | undefined, what: string) {
  const who = agentId ? ((await read($, agents))[agentId]?.type ?? 'agent') : 'main'
  const since = await $.clock.now()
  await update($, needs, () => ({ who, agentId, what, since }))
}

async function clearNeeds($: EngineInterface, agentId?: string | null) {
  await update($, needs, n => (n && (agentId === null || n.agentId === agentId) ? null : n))
}

function patchAgent($: EngineInterface, id: string | undefined, fn: (a: AgentRow) => AgentRow) {
  if (!id) return Promise.resolve()
  return update($, agents, all => (all[id] ? { ...all, [id]: fn(all[id]!) } : all))
}

function patchShell($: EngineInterface, id: string, fn: (s: ShellRow) => ShellRow) {
  return update($, shells, all => (all[id] ? { ...all, [id]: fn(all[id]!) } : all))
}

async function togglePane($: EngineInterface) {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return 'Radar closed.'
  }
  await $.ui.open({ id: PANE, title: 'Radar' })
  return 'Radar opened. ctrl+x tab moves the keyboard into it; Esc hands it back.'
}

async function applyNotices($: EngineInterface, text: string) {
  for (const part of text.split('</task-notification>')) {
    const notice = parseTaskNotice(part)
    if (notice) await applyNotice($, notice)
  }
}

async function applyNotice($: EngineInterface, notice: TaskNotice) {
  const now = await $.clock.now()
  const shell = (await read($, shells))[notice.id]
  const agent = (await read($, agents))[notice.id]
  if (shell && shell.status === 'running') {
    await patchShell($, notice.id, s => ({ ...s, status: notice.status, endedAt: now, summary: notice.summary, outputPath: s.outputPath ?? notice.outputPath }))
    const code = exitCodeOf(notice.summary)
    $.ui.toast(`${notice.status === 'completed' ? '✓' : '✗'} shell ${notice.status}: ${clip(shell.command, 40)}${code ? ` (exit ${code})` : ''}`)
  } else if (agent && !ENDED.has(agent.status)) {
    const status: AgentStatusName = notice.status
    await patchAgent($, notice.id, a => ({ ...a, status, endedAt: now }))
    await announceAgentEnd($, agent, status, now)
  }
}

async function readVersion($: EngineInterface) {
  const text = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => '')
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

// ── hooks ────────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'radar', description: 'Toggle the session radar sidebar' })
    const u = await $.session.usage().catch(() => undefined)
    if (u) {
      await update($, usage, (): Usage => ({
        startedAt: u.startedAt, contextTokens: u.context.tokens, contextWindow: u.context.window,
        contextPercent: u.context.percent, rateLimits: u.rateLimits,
      }))
    }
    const model = await $.session.model().catch(() => undefined)
    await update($, main, (m): Main => ({ ...m, model: m.model ?? model }))
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void onTick($))
    const cwd = await $.session.cwd().catch(() => undefined)
    await update($, main, (m): Main => ({ ...m, cwd: m.cwd ?? cwd }))
    await refreshBranches($)
    await refreshCatalog($)
    if (options.autoOpen === true) void $.ui.open({ id: PANE, title: 'Radar' })
    return result
  })

  on('command.run', { command: 'radar' }, async $ => ({ text: await togglePane($) }))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await back($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    await saveUsage($, {
      contextTokens: e.context.tokens, contextWindow: e.context.window, contextPercent: e.context.percent,
      rateLimits: e.rateLimits,
    })
    return result
  })

  // Each model request: the main loop's model and effort, an agent's context and words.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) {
      const effort = e.effort === undefined ? undefined : String(e.effort)
      await update($, main, (m): Main => ({ ...m, model: e.model, effort }))
    } else {
      const u = result.usage
      const said = lastLine(result.answer)
      await patchAgent($, e.agentId, a => ({
        ...a,
        model: a.model ?? e.model,
        contextTokens: u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : a.contextTokens,
        lastMessage: said || a.lastMessage,
      }))
    }
    return result
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    if (e.isolation === 'worktree') worktreeCalls.add(e.tool_use_id)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.agentId) {
      const id = result.agentId
      const startedAt = await $.clock.now()
      const isWorktree = worktreeCalls.delete(e.tool_use_id)
      await update($, agents, (all): Record<string, AgentRow> => ({
        ...all,
        [id]: {
          id, type: e.subagentType, description: e.description, status: 'running', model: result.model,
          startedAt, tools: all[id]?.tools ?? 0, errors: 0, isWorktree, cwd: e.cwd,
        },
      }))
    }
    return result
  })

  // Every tool call: counts per agent, a question or a dialog answered, and an
  // MCP call in use from its start until it returns.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) await patchAgent($, e.agentId, a => ({ ...a, tools: a.tools + 1 }))
    if (e.tool === 'AskUserQuestion') await setNeeds($, e.agentId, 'a question for you')
    if (e.tool === 'ExitPlanMode') await setNeeds($, e.agentId, 'plan approval')
    const mcp = mcpParts(e.tool)
    if (mcp) {
      const known = (await read($, catalog)).toolServer[e.tool]
      await startUse($, { id: e.tool_use_id, kind: 'mcp', name: known ?? mcp.server, tool: mcp.tool, agentId: e.agentId })
    }
    let ran: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      if (mcp) await endUse($, x => x.id !== e.tool_use_id)
    }
    if (e.agentId && ran.isError === true) await patchAgent($, e.agentId, a => ({ ...a, errors: a.errors + 1 }))
    await clearNeeds($, e.agentId)
    return ran
  })

  // A skill is in use from its call until the turn of the loop that called it ends.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    skillCalls.set(e.skill, (skillCalls.get(e.skill) ?? 0) + 1)
    try {
      const ran = await next(e)
      if (ran.deny === undefined && ran.isError !== true) await startUse($, { id: e.tool_use_id, kind: 'skill', name: e.skill, agentId: e.agentId })
      return ran
    } finally {
      const left = (skillCalls.get(e.skill) ?? 1) - 1
      if (left > 0) skillCalls.set(e.skill, left)
      else skillCalls.delete(e.skill)
    }
  })

  // A skill typed as /name expands with no Skill tool call: it runs in the main loop.
  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    if (!skillCalls.has(e.skill)) await startUse($, { id: `typed-${e.skill}`, kind: 'skill', name: e.skill })
    return result
  })

  // A background shell: Bash with run_in_background, or one the person backgrounded.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const result = ran.deny === undefined && ran.isError !== true ? ran.result : undefined
    const id = result?.backgroundTaskId
    if (id) {
      const known = Object.values(await read($, shells)).find(s => s.outputPath)?.outputPath
      const outputPath = outputPathOf(ran.text) ?? (known ? `${parentDir(known)}/${id}.output` : undefined)
      const startedAt = await $.clock.now()
      const endsWithAgent = result.backgroundEndsWithFinalResponse === true
      await update($, shells, (all): Record<string, ShellRow> => ({
        ...all,
        [id]: { id, kind: 'shell', command: e.command, description: e.description, startedAt, status: 'running', outputPath, agentId: e.agentId, endsWithAgent },
      }))
    }
    return ran
  })

  // A monitor: a background watch the footer counts beside the shells.
  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && ran.isError !== true ? ran.result?.taskId : undefined
    if (id) {
      const startedAt = await $.clock.now()
      const command = e.command ?? e.ws?.url ?? e.description
      await update($, shells, (all): Record<string, ShellRow> => ({
        ...all,
        [id]: { id, kind: 'monitor', command, description: e.description, startedAt, status: 'running', outputPath: outputPathOf(ran.text), agentId: e.agentId },
      }))
    }
    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const todos = e.todos.map((t, i): ProgressItem => ({
        id: String(i), text: t.status === 'in_progress' ? t.activeForm || t.content : t.content, status: t.status,
      }))
      await update($, progress, p => ({ ...p, todos }))
    }
    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = ran.deny === undefined && ran.isError !== true ? ran.result?.task : undefined
    if (e.agentId === undefined && task) {
      const item: ProgressItem = { id: task.id, text: task.subject, status: 'pending' }
      await update($, progress, p => ({ ...p, tasks: [...p.tasks, item] }))
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && ran.deny === undefined && ran.isError !== true) {
      const status = e.status
      await update($, progress, p => ({
        ...p,
        tasks: status === 'deleted'
          ? p.tasks.filter(t => t.id !== e.taskId)
          : p.tasks.map((t): ProgressItem => (t.id === e.taskId ? { ...t, text: e.subject ?? t.text, status: status ?? t.status } : t)),
      }))
    }
    return ran
  })

  on('tool.call', { tool: 'ExitPlanMode' }, async ($, e, next) => {
    const ran = await next(e)
    const plan = ran.deny === undefined && ran.isError !== true ? ran.result?.plan : undefined
    if (e.agentId === undefined && plan) {
      const title = plan.split('\n').map(l => l.replace(/^#+\s*/, '').trim()).find(Boolean)
      await update($, progress, p => ({ ...p, plan: title }))
    }
    return ran
  })

  // An agent working in a directory of its own (a worktree): its tool calls say where.
  on('classic.PostToolUse', async ($, e, next) => {
    const id = e.agent_id
    if (id) {
      const row = (await read($, agents))[id]
      if (row && row.cwd !== e.cwd) {
        const b = branchOf.get(e.cwd) ?? (await readBranch($, e.cwd))
        await patchAgent($, id, a => ({ ...a, cwd: e.cwd, ...b, isWorktree: a.isWorktree || b.isWorktree }))
      }
    }
    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (WAITING_NOTIFICATIONS.has(e.notification_type)) await setNeeds($, e.agent_id, e.message || 'permission needed')
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') await applyNotices($, e.text)
    else if (e.origin.kind === 'scheduled-trigger') await update($, crons, list => list.filter(c => c.recurring || (c.id !== WAKEUP && c.prompt.trim() !== e.text.trim())))
    else {
      await clearNeeds($, null)
      // A new prompt: the last turn is over even if it was interrupted before its Stop.
      await endTurn($, undefined)
    }
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    if (e.last_assistant_message) {
      await patchAgent($, e.agent_id, a => ({ ...a, lastMessage: lastLine(e.last_assistant_message ?? '') }))
    }
    await reconcileShells($, e.background_tasks)
    await endTurn($, e.agent_id)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await reconcileShells($, e.background_tasks)
    await endTurn($, undefined)
    return next(e)
  })

  // Scheduled work: cron jobs and /loop wakeups the model sets up.
  on('tool.call', { tool: 'CronCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const job = ran.deny === undefined && ran.isError !== true ? ran.result : undefined
    if (job) {
      const cron: Cron = { id: job.id, schedule: job.humanSchedule, recurring: job.recurring, prompt: e.prompt }
      await update($, crons, list => [...list.filter(c => c.id !== job.id), cron])
    }
    return ran
  })

  on('tool.call', { tool: 'CronDelete' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await update($, crons, list => list.filter(c => c.id !== e.id))
    return ran
  })

  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const others = (list: readonly Cron[]) => list.filter(c => c.id !== WAKEUP)
      if (e.stop || !e.delaySeconds) {
        await update($, crons, list => others(list))
      } else {
        const at = (await $.clock.now()) + Math.min(3600, Math.max(60, e.delaySeconds)) * 1000
        const cron: Cron = { id: WAKEUP, schedule: `at ${clock(at)}`, recurring: false, prompt: e.reason || e.prompt || 'wakeup', at }
        await update($, crons, list => [...others(list), cron])
      }
    }
    return ran
  })

  // A stopped task, by the model or the Stop button.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && ran.isError !== true ? (ran.result?.task_id ?? e.task_id ?? e.shell_id) : undefined
    if (id) {
      const now = await $.clock.now()
      await patchShell($, id, s => (s.status === 'running' ? { ...s, status: 'killed', endedAt: now } : s))
      await patchAgent($, id, a => (ENDED.has(a.status) ? a : { ...a, status: 'killed', endedAt: now }))
    }
    return ran
  })

  // A background task ended: its notice reaches the session one of three ways.
  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') await applyNotices($, e.text)
    return next(e)
  })

  // Notices also arrive mid-turn as queued attachments, and a subagent's own
  // shells report to that subagent: any row, in any conversation, can carry one.
  // Only rows that are a notice: a file read or a reply may quote one.
  on('session.append', async ($, e, next) => {
    if (e.message.role === 'user' && e.door !== 'tool-result') {
      const text = e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('\n').trim()
      if (text.startsWith('<task-notification>')) await applyNotices($, text)
    }
    return next(e)
  })

  // ── drawing ────────────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const W = Math.max(28, e.props.bodyColumns)
    const IN = W - 4
    const v = await read($, view)
    await read($, tick)
    const now = await $.clock.now()
    version ??= await readVersion($)

    const toggle = (section: string) => () =>
      void update($, view, x => ({
        ...x, folded: x.folded.includes(section) ? x.folded.filter(s => s !== section) : [...x.folded, section],
      }))
    const isFolded = (section: string) => v.folded.includes(section)

    // A section: a rounded box in the section's color, its title on the first row.
    const box = (section: string, color: string, title: string, right: JSX.Element | string | null, body: JSX.Element | null) => (
      <Box key={`box-${section}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={W}>
        <Box justifyContent="space-between" width={IN}>
          <Box>
            <Button key={`fold-${section}`} plain dimColor label={isFolded(section) ? '▸ ' : '▾ '} onPress={toggle(section)} />
            <Text color={color} bold>{clip(title, IN - 14)}</Text>
          </Box>
          {typeof right === 'string' ? <Text dimColor>{right}</Text> : right}
        </Box>
        {isFolded(section) ? null : body}
      </Box>
    )
    const hint = (focused: string) => (
      <Box key="hint" marginTop={1}>
        <Text dimColor>{clip(e.props.isFocused ? focused : 'ctrl+x tab to use · /radar to close', W)}</Text>
      </Box>
    )

    // ── one background task, opened ──
    if (v.screen === 'shell' && v.shellId) {
      const shell = (await read($, shells))[v.shellId]
      const out = await read($, output)
      if (!shell) return <Box flexDirection="column"><Button key="back" autoFocus plain hotkey="b" label="back" onPress={() => void back($)} /></Box>
      const room = Math.max(4, (e.viewport?.rows ?? 30) - 14)
      const lines = out?.shellId === shell.id ? out.lines.slice(-room) : []
      const isLive = shell.status === 'running'
      const statusColor = isLive ? C.shells : shell.status === 'completed' ? undefined : C.bad
      const owner = shell.agentId ? ((await read($, agents))[shell.agentId]?.type ?? 'agent') : 'main'
      const took = stopwatch((shell.endedAt ?? now) - shell.startedAt)
      return (
        <Box flexDirection="column" width={W}>
          <Box flexDirection="column" borderStyle="round" borderColor={C.shells} paddingX={1} width={W}>
            <Box justifyContent="space-between" width={IN}>
              <Box>
                <Button key="back" autoFocus plain hotkey="b" label="back" onPress={() => void back($)} />
                <Text color={C.shells} bold>{`  ${clip(shell.description || shell.command, IN - 22)}`}</Text>
              </Box>
              <Text color={statusColor}>{`${isLive ? '●' : shell.status === 'completed' ? '✓' : '✗'} ${shell.status}`}</Text>
            </Box>
            {shell.description ? <Text wrap="truncate-end">{clip(`$ ${shell.command}`, IN)}</Text> : null}
            <Text dimColor>{clip(`${took} · ${shell.kind} · by ${owner} · ${shell.id}`, IN)}</Text>
            {shell.summary ? <Text dimColor>{clip(shell.summary, IN)}</Text> : null}
          </Box>
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={W}>
            <Box justifyContent="space-between" width={IN}>
              <Text dimColor>{`output · last ${lines.length} lines`}</Text>
              <Text color={isLive ? C.shells : undefined} dimColor={!isLive}>{isLive ? '● live' : 'ended'}</Text>
            </Box>
            {out?.error ? <Text dimColor>{out.error}</Text> : null}
            {!out ? <Text dimColor>reading…</Text> : null}
            {out && !out.error && lines.length === 0 ? <Text dimColor>no output yet</Text> : null}
            {lines.map((line, i) => <Text key={`l${i}`} wrap="truncate-end">{line || ' '}</Text>)}
          </Box>
          <Box marginTop={1} gap={2}>
            <Button key="copy" hotkey="c" label="Copy" onPress={press => void $.ui.copy({ text: lines.join('\n'), surface: press.surface })} />
            {isLive ? <Button key="stop" hotkey="s" label="Stop" onPress={() => void $.tool.call({ tool: 'TaskStop', task_id: shell.id }).catch(() => undefined)} /> : null}
          </Box>
          {isLive ? <Text dimColor>{clip('Stop asks for permission like any tool call.', W)}</Text> : null}
          {hint('tab next · b back · c copy · esc prompt')}
        </Box>
      )
    }

    // ── overview ──
    const u = await read($, usage)
    const m = await read($, main)
    const n = await read($, needs)
    const hist = await read($, samples)
    const agentRows = Object.values(await read($, agents))
    const shellRows = Object.values(await read($, shells))
    const cronRows = await read($, crons)
    const prog = await read($, progress)
    const cat = await read($, catalog)
    const using = Object.values(await read($, inUse)).sort((a, b) => a.startedAt - b.startedAt)

    const model = m.model ? modelName(m.model) : 'claude'
    const home = await $.env.get('HOME').catch(() => undefined)
    const G = Math.max(6, Math.min(12, IN - 26))

    // Main
    const effort = effortMeter(m.effort)
    const ctxPct = u?.contextPercent ?? (u?.contextTokens && u.contextWindow ? (u.contextTokens / u.contextWindow) * 100 : undefined)
    const ctxColor = ctxPct === undefined ? undefined : ctxPct >= 85 ? C.bad : ctxPct >= 65 ? C.warn : C.main
    const ctx = gauge(ctxPct ?? 0, G)
    const five = u?.rateLimits.find(l => l.kind === 'five_hour')
    const fc = five ? forecast(hist, five, now) : undefined
    const limitLine = (l: { kind: string; percentUsed: number; resetsAt?: string }) => {
      const g = gauge(l.percentUsed, Math.max(4, G - 4))
      const color = l.percentUsed >= 90 ? C.bad : l.percentUsed >= 70 ? C.warn : C.main
      return (
        <Text key={`lim-${l.kind}`} wrap="truncate-end">
          <Text dimColor>{`${limitLabel(l.kind).padEnd(3)}`}</Text>
          <Text color={color}>{g.full}</Text>
          <Text dimColor>{g.empty}</Text>
          <Text bold>{` ${String(Math.round(l.percentUsed)).padStart(3)}%`}</Text>
          <Text dimColor>{` ${resetLabel(l.resetsAt, now)}`}</Text>
        </Text>
      )
    }
    const mainBody = (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text dimColor>{'effort '}</Text>
          {effort ? <Text color={C.main}>{effort.full}</Text> : null}
          {effort ? <Text dimColor>{effort.empty}</Text> : null}
          <Text bold>{` ${m.effort ?? '—'}`}</Text>
          <Text dimColor>{u ? `  session ${duration(now - u.startedAt)}` : ''}</Text>
        </Text>
        <Text wrap="truncate-end">
          <Text dimColor>{'ctx    '}</Text>
          <Text color={ctxColor}>{ctx.full}</Text>
          <Text dimColor>{ctx.empty}</Text>
          <Text bold color={ctxColor}>{ctxPct !== undefined ? ` ${Math.round(ctxPct)}%` : ' —'}</Text>
          <Text dimColor>{u?.contextTokens !== undefined ? ` ${tokens(u.contextTokens)}/${tokens(u.contextWindow)}` : ''}</Text>
          {ctxPct !== undefined && ctxPct >= 85 ? <Text color={C.bad}>{' compaction soon'}</Text> : null}
        </Text>
        {(u?.rateLimits ?? []).map(limitLine)}
        {fc?.kind === 'full' ? <Text color={C.warn} wrap="truncate-end">{`5h full ≈ ${clock(fc.at)} at this pace`}</Text> : null}
        {fc?.kind === 'ok' ? <Text color={C.shells} wrap="truncate-end">{'5h lasts until reset at this pace'}</Text> : null}
        {m.cwd ? (
          <Text wrap="truncate-end">
            <Text dimColor>{'dir    '}</Text>
            <Text>{shortPath(m.cwd, home, IN - 7)}</Text>
          </Text>
        ) : null}
        {m.branch ? <Text color={C.branch} wrap="truncate-end">{`⎇ ${m.branch}${m.isWorktree ? ' (worktree)' : ''}`}</Text> : null}
      </Box>
    )

    // Agents, as cards
    const running = agentRows.filter(a => !ENDED.has(a.status)).sort((a, b) => a.startedAt - b.startedAt)
    const done = agentRows.filter(a => ENDED.has(a.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const shown = [...running.slice(-MAX_CARDS), ...done.slice(0, Math.max(0, MAX_CARDS - running.length))]
    const moreRunning = running.length - Math.min(running.length, MAX_CARDS)
    const moreDone = done.length - (shown.length - (running.length - moreRunning))
    // Cards sit inside the agents box, so they share its inner width; four make a 2×2 grid.
    const cols = IN >= 40 ? 2 : 1
    const cardW = Math.floor((IN - (cols - 1)) / cols)
    const cardIn = cardW - 4
    const card = (a: AgentRow, index: number) => {
      const isEnded = ENDED.has(a.status)
      const isBad = a.status === 'failed' || a.status === 'killed'
      const isOpen = v.expanded === a.id
      const glyph = isBad ? '✗' : isEnded ? '✓' : a.status === 'waiting' ? '◐' : '◐'
      const glyphColor = isBad ? C.bad : isEnded ? C.shells : a.status === 'waiting' ? C.warn : C.agents
      const uses = isEnded ? [] : using.filter(x => x.agentId === a.id)
      const facts = [a.contextTokens !== undefined ? `ctx ${tokens(a.contextTokens)}` : '', `${a.tools} tools`].filter(Boolean).join(' · ')
      return (
        <Box key={`card-${a.id}`} flexDirection="column" borderStyle="round" borderColor={C.agents} borderDimColor={isEnded} paddingX={1} width={cardW}>
          <Button key={`agent-${a.id}`} plain label={clip(`${index + 1}: ${a.description.trim()}`, cardIn)} onPress={() => void update($, view, x => ({ ...x, expanded: x.expanded === a.id ? undefined : a.id }))} />
          <Text dimColor wrap="truncate-end">{clip(a.type, cardIn)}</Text>
          <Text dimColor wrap="truncate-end">
            {clip(facts, cardIn)}
            {a.errors > 0 ? <Text color={C.bad}>{` · ${a.errors} err`}</Text> : null}
          </Text>
          {uses.length ? (
            <Text wrap="truncate-end">
              {uses.map((x, i) => (
                <Text key={`use-${a.id}-${x.id}`} color={x.kind === 'mcp' ? C.mcp : C.skills}>{`${i ? ' ' : ''}${x.kind === 'mcp' ? '●' : '⚡'} ${x.name}`}</Text>
              ))}
            </Text>
          ) : null}
          {a.branch || a.isWorktree ? <Text color={C.branch} wrap="truncate-end">{clip(`⎇ ${a.branch ?? 'worktree'}`, cardIn)}</Text> : null}
          <Text wrap="truncate-end">
            <Text color={glyphColor}>{`${glyph} `}</Text>
            <Text dimColor={isEnded}>{stopwatch((a.endedAt ?? now) - a.startedAt)}</Text>
            {isBad ? <Text color={C.bad}>{` ${a.status}`}</Text> : null}
          </Text>
          {isOpen && a.lastMessage ? <Text dimColor wrap="wrap">{clip(`"${a.lastMessage}"`, cardIn * 3)}</Text> : null}
          {isOpen && a.model ? <Text dimColor wrap="truncate-end">{clip(modelName(a.model), cardIn)}</Text> : null}
        </Box>
      )
    }

    // MCP and skills: who is using one, and the list of what there is.
    const cardNo = new Map(shown.map((a, i) => [a.id, i + 1]))
    const owner = (x: InUse) => {
      if (!x.agentId) return 'main'
      const no = cardNo.get(x.agentId)
      return no ? `agent ${no}` : ((agentRows.find(a => a.id === x.agentId)?.type) ?? 'agent')
    }
    const isUnrolled = (list: string) => (v.unrolled ?? []).includes(list)
    const unroll = (list: string) => () =>
      void update($, view, x => {
        const open = x.unrolled ?? []
        return { ...x, unrolled: open.includes(list) ? open.filter(l => l !== list) : [...open, list] }
      })
    // Names laid side by side; the ones in use first and bright, the rest dim.
    const chips = (list: string, color: string, names: readonly { name: string; label: string }[], active: ReadonlySet<string>, limit: number | undefined) => {
      const ordered = [...names.filter(n => active.has(n.name)), ...names.filter(n => !active.has(n.name))]
      const words = ordered.map(n => `${active.has(n.name) ? '● ' : ''}${clip(n.label, IN)}`)
      const rows = pack(words, IN, 3)
      const seen = limit === undefined ? rows : rows.slice(0, limit)
      const hidden = rows.slice(seen.length).reduce((sum, r) => sum + r.length, 0)
      return {
        hidden,
        rows: seen.map((row, r) => (
          <Text key={`${list}-row-${r}`} wrap="truncate-end">
            {row.map((i, k) => (
              <Text key={`${list}-${i}`}>
                {k ? <Text dimColor>{' · '}</Text> : null}
                {active.has(ordered[i]!.name) ? <Text color={color} bold>{words[i]}</Text> : <Text dimColor>{words[i]}</Text>}
              </Text>
            ))}
          </Text>
        )),
      }
    }
    const useRow = (x: InUse, color: string) => {
      const time = stopwatch(now - x.startedAt)
      const who = owner(x)
      const what = x.kind === 'mcp' ? `● ${x.name}${x.tool ? ` · ${x.tool}` : ''}` : `⚡ ${x.name}`
      return (
        <Box key={`use-${x.id}`} justifyContent="space-between" width={IN}>
          <Text color={color} wrap="truncate-end">{clip(what, IN - who.length - time.length - 3)}</Text>
          <Text dimColor>{`${who} ${time}`}</Text>
        </Box>
      )
    }

    const mcpUses = using.filter(x => x.kind === 'mcp')
    const mcpActive = new Set(mcpUses.map(x => x.name))
    const mcpNames = cat.servers.map(sv => ({ name: sv.name, label: `${sv.name} (${sv.tools})` }))
    // A server the catalog has not caught up with yet still shows while in use.
    for (const name of mcpActive) if (!cat.servers.some(sv => sv.name === name)) mcpNames.push({ name, label: name })
    const mcpList = chips('mcp', C.mcp, mcpNames, mcpActive, isUnrolled('mcp') ? undefined : LIST_ROWS)
    const mcpBody = (
      <Box flexDirection="column">
        {mcpNames.length === 0 ? <Text dimColor>no MCP servers connected</Text> : null}
        {mcpList.rows}
        {mcpList.hidden > 0 || isUnrolled('mcp') ? (
          <Button key="more-mcp" plain dimColor label={isUnrolled('mcp') ? '− show less' : `+ ${mcpList.hidden} more`} onPress={unroll('mcp')} />
        ) : null}
        {mcpUses.slice(-ACTIVE_ROWS).map(x => useRow(x, C.mcp))}
        {mcpUses.length > ACTIVE_ROWS ? <Text dimColor>{`+ ${mcpUses.length - ACTIVE_ROWS} more calls`}</Text> : null}
      </Box>
    )

    const skillUses = using.filter(x => x.kind === 'skill')
    const skillActive = new Set(skillUses.map(x => x.name))
    const skillNames = [...new Set([...cat.skills, ...skillActive])].map(name => ({ name, label: name }))
    const skillList = chips('skills', C.skills, skillNames, skillActive, undefined)
    const skillsBody = (
      <Box flexDirection="column">
        {skillUses.length === 0 ? <Text dimColor>none in use</Text> : null}
        {skillUses.slice(-ACTIVE_ROWS).map(x => useRow(x, C.skills))}
        {skillUses.length > ACTIVE_ROWS ? <Text dimColor>{`+ ${skillUses.length - ACTIVE_ROWS} more`}</Text> : null}
        {skillNames.length ? (
          <Button key="more-skills" plain dimColor label={isUnrolled('skills') ? '− hide skills' : `+ ${skillNames.length} available`} onPress={unroll('skills')} />
        ) : null}
        {isUnrolled('skills') ? skillList.rows : null}
      </Box>
    )

    // Background
    const liveShells = shellRows.filter(x => x.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
    const endedShells = shellRows.filter(x => x.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const shellRow = (x: ShellRow) => {
      const time = stopwatch((x.endedAt ?? now) - x.startedAt)
      const isLive = x.status === 'running'
      const glyph = isLive ? '●' : x.status === 'completed' ? '✓' : '✗'
      const color = isLive ? C.shells : x.status === 'completed' ? undefined : C.bad
      return (
        <Box key={`s-${x.id}`} justifyContent="space-between" width={IN}>
          <Box>
            <Text color={color} dimColor={!isLive}>{`${glyph} `}</Text>
            <Button key={`shell-${x.id}`} plain dimColor={!isLive || undefined} label={clip(x.description || x.command, IN - time.length - 4)} onPress={() => void openShell($, x.id)} />
          </Box>
          <Text dimColor>{time}</Text>
        </Box>
      )
    }
    const bgBody = (
      <Box flexDirection="column">
        {shellRows.length === 0 && cronRows.length === 0 ? <Text dimColor>nothing in the background</Text> : null}
        {liveShells.slice(-LIVE_SHELLS_SHOWN).map(shellRow)}
        {liveShells.length > LIVE_SHELLS_SHOWN ? <Text dimColor>{`+ ${liveShells.length - LIVE_SHELLS_SHOWN} more running`}</Text> : null}
        {endedShells.slice(0, FINISHED_SHELLS_SHOWN).map(shellRow)}
        {cronRows.map(c => (
          <Text key={`c-${c.id}`} dimColor wrap="truncate-end">{`↻ ${clip(c.prompt, IN - c.schedule.length - 5)} · ${c.schedule}`}</Text>
        ))}
      </Box>
    )

    // Progress
    const items = prog.todos.length > 0 ? prog.todos : prog.tasks
    const finished = items.filter(i => i.status === 'completed').length
    const doneShown = items.length > 8 ? items.filter(i => i.status === 'completed').slice(-2) : items.filter(i => i.status === 'completed')
    const rest = items.filter(i => i.status !== 'completed')
    const hidden = finished - doneShown.length
    const pg = gauge(items.length ? (finished / items.length) * 100 : 0, IN)
    const progBody = (
      <Box flexDirection="column">
        {prog.plan ? <Text color={C.progress} wrap="truncate-end">{clip(`plan · ${prog.plan}`, IN)}</Text> : null}
        {items.length > 0 ? (
          <Text>
            <Text color={C.progress}>{pg.full}</Text>
            <Text dimColor>{pg.empty}</Text>
          </Text>
        ) : null}
        {hidden > 0 ? <Text dimColor>{`✓ ${hidden} earlier done`}</Text> : null}
        {[...doneShown, ...rest].map(i => (
          <Text key={`p-${i.id}`} wrap="truncate-end">
            <Text color={i.status === 'completed' ? C.shells : i.status === 'in_progress' ? C.progress : undefined} dimColor={i.status === 'pending'}>
              {i.status === 'completed' ? '✓ ' : i.status === 'in_progress' ? '◆ ' : '◇ '}
            </Text>
            <Text dimColor={i.status === 'completed'} bold={i.status === 'in_progress'}>{clip(i.text, IN - 2)}</Text>
          </Text>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column" width={W}>
        <Box justifyContent="center" width={W}>
          <Text bold>{'RADAR · '}</Text>
          <Text color={C.main} bold>{model}</Text>
          {version ? <Text dimColor>{` · v${version}`}</Text> : null}
        </Box>
        <Box justifyContent="center" flexWrap="wrap" columnGap={2} width={W}>
          <Text><Text color={C.main}>■</Text><Text dimColor> main</Text></Text>
          <Text><Text color={C.agents}>■</Text><Text dimColor> agents</Text></Text>
          <Text><Text color={C.mcp}>■</Text><Text dimColor> mcp</Text></Text>
          <Text><Text color={C.skills}>■</Text><Text dimColor> skills</Text></Text>
          <Text><Text color={C.shells}>■</Text><Text dimColor> shells</Text></Text>
          {items.length || prog.plan ? <Text><Text color={C.progress}>■</Text><Text dimColor> progress</Text></Text> : null}
        </Box>

        {n ? (
          <Box key="needs" flexDirection="column" borderStyle="round" borderColor={C.warn} paddingX={1} width={W} marginTop={1}>
            <Box justifyContent="space-between" width={IN}>
              <Text color={C.warn} bold>{`⚠ NEEDS YOU · ${clip(n.who, IN - 26)}`}</Text>
              <Text color={C.warn}>{stopwatch(now - n.since)}</Text>
            </Box>
            <Text wrap="truncate-end">{clip(n.what.trim(), IN)}</Text>
          </Box>
        ) : null}

        <Box marginTop={n ? 0 : 1} />
        {box('main', C.main, `${model} · main`, '', mainBody)}

        {box('agents', C.agents, 'AGENTS', agentRows.length ? `${running.length} running · ${agentRows.length} total` : '', (
          <Box flexDirection="column">
            {shown.length === 0 ? <Text dimColor>none yet</Text> : null}
            {shown.length ? (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={IN}>
                {shown.map(card)}
              </Box>
            ) : null}
            {agentRows.length > shown.length ? <Text dimColor>{`+ ${[moreRunning ? `${moreRunning} more running` : '', moreDone ? `${moreDone} more done` : ''].filter(Boolean).join(' · ')}`}</Text> : null}
          </Box>
        ))}

        {box('mcp', C.mcp, 'MCP', cat.servers.length ? `${mcpActive.size} in use · ${cat.servers.length} servers` : '', mcpBody)}

        {box('skills', C.skills, 'SKILLS', skillUses.length ? `${skillActive.size} in use` : '', skillsBody)}

        {box('background', C.shells, 'BACKGROUND', backgroundCount(liveShells), bgBody)}
        {items.length || prog.plan ? box('progress', C.progress, 'PROGRESS', items.length ? `${finished}/${items.length}` : '', progBody) : null}

        {hint('tab next · ⏎ open · ↑↓ scroll · esc prompt')}
      </Box>
    )
  })
}
