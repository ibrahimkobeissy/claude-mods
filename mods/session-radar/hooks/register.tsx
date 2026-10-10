import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, AgentStatusName, Cron, Main, ProgressItem, ShellRow, Usage, View } from '../types'
import {
  addSamples, clip, clock, connector, duration, effortMeter, gauge, modelName, shortPath, stopwatch, exitCodeOf, forecast, lastLine, limitLabel,
  outputPathOf, parentDir, parseTaskNotice, resetLabel, tail, tokens,
} from './lib'
import type { TaskNotice } from './lib'

const PANE = 'session-radar'
const WAKEUP = 'wakeup'
const TICK_MS = 5000
const OUTPUT_MS = 2000
// Branches are read with git, so not on every tick.
const BRANCH_EVERY_TICKS = 6
const MAX_OUTPUT_LINES = 200
const MAX_CARDS = 6
const C = {
  main: '#d97757', agents: '#a5b4fc', shells: '#4ade80', progress: '#c084fc',
  warn: '#facc15', bad: '#f87171', branch: '#7ab7ff',
} as const
const FINISHED_SHELLS_SHOWN = 3
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

let ticker: Timer | undefined
let outputTimer: Timer | undefined
let ticks = 0
// Agent tool calls that asked for a worktree, until agent.spawn names the agent.
const worktreeCalls = new Set<string>()
const branchOf = new Map<string, { branch?: string; isWorktree: boolean }>()

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
  if (ticks % BRANCH_EVERY_TICKS === 0) await refreshBranches($)
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

  // Every tool call: counts per agent, and a question or a dialog answered.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) await patchAgent($, e.agentId, a => ({ ...a, tools: a.tools + 1 }))
    if (e.tool === 'AskUserQuestion') await setNeeds($, e.agentId, 'a question for you')
    if (e.tool === 'ExitPlanMode') await setNeeds($, e.agentId, 'plan approval')
    const ran = await next(e)
    if (e.agentId && ran.isError === true) await patchAgent($, e.agentId, a => ({ ...a, errors: a.errors + 1 }))
    await clearNeeds($, e.agentId)
    return ran
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
    else await clearNeeds($, null)
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    if (e.last_assistant_message) {
      await patchAgent($, e.agent_id, a => ({ ...a, lastMessage: lastLine(e.last_assistant_message ?? '') }))
    }
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
    const joint = (key: string, color: string, dots = 2) => {
      const parts = connector(W, dots)
      return (
        <Text key={key} dimColor wrap="truncate-end">
          {parts.map((part, i) => (
            <Text key={`${key}-${i}`}>
              <Text dimColor>{part}</Text>
              {i < parts.length - 1 ? <Text color={color}>•</Text> : null}
            </Text>
          ))}
        </Text>
      )
    }
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
          {joint('j-out', C.shells)}
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
    const shown = [...running, ...done.slice(0, Math.max(0, MAX_CARDS - running.length))]
    // Cards sit inside the agents box, so they share its inner width.
    const cols = IN >= 62 ? 3 : IN >= 40 ? 2 : 1
    const cardW = Math.floor((IN - (cols - 1)) / cols)
    const cardIn = cardW - 4
    const card = (a: AgentRow, index: number) => {
      const isEnded = ENDED.has(a.status)
      const isBad = a.status === 'failed' || a.status === 'killed'
      const isOpen = v.expanded === a.id
      const glyph = isBad ? '✗' : isEnded ? '✓' : a.status === 'waiting' ? '◐' : '◐'
      const glyphColor = isBad ? C.bad : isEnded ? C.shells : a.status === 'waiting' ? C.warn : C.agents
      const facts = [a.contextTokens !== undefined ? `ctx ${tokens(a.contextTokens)}` : '', `${a.tools} tools`].filter(Boolean).join(' · ')
      return (
        <Box key={`card-${a.id}`} flexDirection="column" borderStyle="round" borderColor={C.agents} borderDimColor={isEnded} paddingX={1} width={cardW}>
          <Button key={`agent-${a.id}`} plain label={clip(`${index + 1}: ${a.description.trim()}`, cardIn)} onPress={() => void update($, view, x => ({ ...x, expanded: x.expanded === a.id ? undefined : a.id }))} />
          <Text dimColor wrap="truncate-end">{clip(a.type, cardIn)}</Text>
          <Text dimColor wrap="truncate-end">
            {clip(facts, cardIn)}
            {a.errors > 0 ? <Text color={C.bad}>{` · ${a.errors} err`}</Text> : null}
          </Text>
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
        {liveShells.map(shellRow)}
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
        </Box>
        <Box justifyContent="center" width={W} gap={2}>
          <Text><Text color={C.main}>■</Text><Text dimColor> main</Text></Text>
          <Text><Text color={C.agents}>■</Text><Text dimColor> agents</Text></Text>
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

        {joint('j-agents', C.main)}
        {box('agents', C.agents, 'AGENTS', agentRows.length ? `${running.length} running · ${agentRows.length} total` : '', (
          <Box flexDirection="column">
            {shown.length === 0 ? <Text dimColor>none yet</Text> : null}
            {shown.length ? (
              <Box flexDirection="row" flexWrap="wrap" columnGap={1} width={IN}>
                {shown.map(card)}
              </Box>
            ) : null}
            {agentRows.length > shown.length ? <Text dimColor>{`+ ${agentRows.length - shown.length} more done`}</Text> : null}
          </Box>
        ))}

        {joint('j-background', C.agents)}
        {box('background', C.shells, 'BACKGROUND', backgroundCount(liveShells), bgBody)}
        {items.length || prog.plan ? joint('j-progress', C.shells) : null}
        {items.length || prog.plan ? box('progress', C.progress, 'PROGRESS', items.length ? `${finished}/${items.length}` : '', progBody) : null}

        {hint('tab next · ⏎ open · ↑↓ scroll · esc prompt')}
      </Box>
    )
  })
}
