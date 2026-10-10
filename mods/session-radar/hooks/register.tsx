import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, AgentStatusName, Cron, Main, ProgressItem, ShellRow, Usage, View } from '../types'
import {
  addSamples, bar, modelName, burnRate, clip, clock, duration, exitCodeOf, forecast, lastLine, limitLabel,
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
const DONE_AGENTS_SHOWN = 3
const FINISHED_SHELLS_SHOWN = 3
const SECTIONS = ['limits', 'main', 'agents', 'background', 'progress'] as const
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
  const ran = await $.process
    .run(['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD', '--git-dir', '--git-common-dir'], { timeoutMs: 3000 })
    .catch(() => undefined)
  if (!ran || ran.exitCode !== 0) return { isWorktree: false }
  const [head, gitDir, commonDir] = ran.stdout.trim().split('\n')
  const found = { branch: head === 'HEAD' ? 'detached' : head, isWorktree: Boolean(gitDir && commonDir && gitDir !== commonDir) }
  branchOf.set(cwd, found)
  return found
}

async function refreshBranches($: EngineInterface) {
  const cwd = await $.session.cwd()
  const found = await readBranch($, cwd)
  await update($, main, (m): Main => ({ ...m, ...found }))
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
    $.ui.toast(`${notice.status === 'completed' ? '✓' : '✗'} agent ${notice.status}: ${clip(agent.description, 40)}`)
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
        contextPercent: u.context.percent, rateLimits: u.rateLimits, costUsd: u.cost?.usd,
      }))
    }
    const model = await $.session.model().catch(() => undefined)
    await update($, main, (m): Main => ({ ...m, model: m.model ?? model }))
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void onTick($))
    void refreshBranches($)
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
      rateLimits: e.rateLimits, costUsd: e.cost?.usd,
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
    const id = ran.deny === undefined && ran.isError !== true ? ran.result?.backgroundTaskId : undefined
    if (id) {
      const known = Object.values(await read($, shells)).find(s => s.outputPath)?.outputPath
      const outputPath = outputPathOf(ran.text) ?? (known ? `${parentDir(known)}/${id}.output` : undefined)
      const startedAt = await $.clock.now()
      await update($, shells, (all): Record<string, ShellRow> => ({
        ...all,
        [id]: { id, kind: 'shell', command: e.command, startedAt, status: 'running', outputPath, agentId: e.agentId },
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

  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined && e.message.role === 'user') {
      const text = e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('\n')
      if (text.includes('<task-notification>')) await applyNotices($, text)
    }
    return next(e)
  })

  // ── drawing ────────────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const W = Math.max(24, e.props.bodyColumns)
    const v = await read($, view)
    await read($, tick)
    const now = await $.clock.now()

    const toggle = (section: string) => () =>
      void update($, view, x => ({
        ...x, folded: x.folded.includes(section) ? x.folded.filter(s => s !== section) : [...x.folded, section],
      }))
    const isFolded = (section: string) => v.folded.includes(section)
    const header = (section: (typeof SECTIONS)[number], title: string, note = '') => (
      <Box key={`h-${section}`} marginTop={1}>
        <Button key={`fold-${section}`} plain label={`${isFolded(section) ? '▸' : '▾'} ${title}`} onPress={toggle(section)} />
        {note ? <Text dimColor>{` ${clip(note, W - title.length - 3)}`}</Text> : null}
      </Box>
    )
    const footer = (hint: string) => (
      <Box key="footer" marginTop={1}>
        <Text dimColor>{clip(e.props.isFocused ? hint : 'ctrl+x tab to use · /radar to close', W)}</Text>
      </Box>
    )

    // ── one background task, opened ──
    if (v.screen === 'shell' && v.shellId) {
      const shell = (await read($, shells))[v.shellId]
      const out = await read($, output)
      if (!shell) return <Box flexDirection="column"><Button key="back" autoFocus label="‹ Back" hotkey="b" onPress={() => void back($)} /></Box>
      const room = Math.max(4, (e.viewport?.rows ?? 30) - 12)
      const lines = out?.shellId === shell.id ? out.lines.slice(-room) : []
      const ended = shell.endedAt ?? now
      const statusColor = shell.status === 'running' ? 'green' : shell.status === 'completed' ? undefined : 'red'
      const owner = shell.agentId ? ((await read($, agents))[shell.agentId]?.type ?? 'agent') : 'main'
      return (
        <Box flexDirection="column" width={W}>
          <Box>
            <Button key="back" autoFocus plain hotkey="b" label="back" onPress={() => void back($)} />
            <Text bold>{` ${clip(shell.command, W - 8)}`}</Text>
          </Box>
          <Text>
            <Text color={statusColor}>{`● ${shell.status}`}</Text>
            <Text dimColor>{` · ${clip(`${duration(ended - shell.startedAt)} · ${shell.kind} · by ${owner} · ${shell.id}`, W - shell.status.length - 5)}`}</Text>
          </Text>
          {shell.summary ? <Text dimColor>{clip(shell.summary, W)}</Text> : null}
          <Box marginTop={1}>
            <Text color="#f0a283" bold>{`last ${lines.length} lines`}</Text>
            <Text dimColor>{shell.status === 'running' ? ' · live' : ''}</Text>
          </Box>
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} width={W}>
            {out?.error ? <Text dimColor>{out.error}</Text> : null}
            {!out ? <Text dimColor>reading…</Text> : null}
            {out && !out.error && lines.length === 0 ? <Text dimColor>no output yet</Text> : null}
            {lines.map((line, i) => <Text key={`l${i}`} wrap="truncate-end">{line || ' '}</Text>)}
          </Box>
          <Box marginTop={1} gap={2}>
            <Button key="copy" hotkey="c" label="Copy" onPress={press => void $.ui.copy({ text: lines.join('\n'), surface: press.surface })} />
            {shell.status === 'running'
              ? <Button key="stop" hotkey="s" label="Stop" onPress={() => void $.tool.call({ tool: 'TaskStop', task_id: shell.id }).catch(() => undefined)} />
              : null}
          </Box>
          {shell.status === 'running' ? <Text dimColor>{clip('Stop asks for permission like any tool call.', W)}</Text> : null}
          {footer('tab next · ⏎ press · b back · c copy · esc prompt')}
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
    const BAR = Math.max(6, Math.min(14, W - 30))

    const limitRows = (u?.rateLimits ?? []).map(l => {
      const b = bar(l.percentUsed, BAR)
      const color = l.percentUsed >= 90 ? 'red' : l.percentUsed >= 70 ? 'yellow' : '#d97757'
      return (
        <Text key={`lim-${l.kind}`} wrap="truncate-end">
          <Text>{`  ${limitLabel(l.kind).padEnd(3)} `}</Text>
          <Text color={color}>{b.full}</Text>
          <Text dimColor>{b.empty}</Text>
          <Text bold>{` ${String(Math.round(l.percentUsed)).padStart(3)}%`}</Text>
          <Text dimColor>{` ${resetLabel(l.resetsAt, now)}`}</Text>
        </Text>
      )
    })
    const five = u?.rateLimits.find(l => l.kind === 'five_hour')
    const fc = five ? forecast(hist, five, now) : undefined
    const burn = u ? burnRate(u.costUsd, u.startedAt, now) : undefined
    const money = [u?.costUsd !== undefined ? `$${u.costUsd.toFixed(2)}` : '', burn !== undefined ? `$${burn.toFixed(2)}/h` : '']
      .filter(Boolean).join(' · ')

    const ctxPct = u?.contextPercent ?? (u?.contextTokens && u.contextWindow ? (u.contextTokens / u.contextWindow) * 100 : undefined)
    const ctxColor = ctxPct === undefined ? undefined : ctxPct >= 85 ? 'red' : ctxPct >= 65 ? 'yellow' : 'green'
    const ctxBar = bar(ctxPct ?? 0, BAR)

    const running = agentRows.filter(a => !ENDED.has(a.status)).sort((a, b) => a.startedAt - b.startedAt)
    const done = agentRows.filter(a => ENDED.has(a.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const liveShells = shellRows.filter(s => s.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
    const endedShells = shellRows.filter(s => s.status !== 'running').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

    const agentRow = (a: AgentRow) => {
      const isOpen = v.expanded === a.id
      const isEnded = ENDED.has(a.status)
      const glyph = a.status === 'failed' || a.status === 'killed' ? '✗' : isEnded ? '✓' : a.status === 'waiting' ? '◐' : '●'
      const glyphColor = a.status === 'failed' || a.status === 'killed' ? 'red' : isEnded ? undefined : a.status === 'waiting' ? 'yellow' : 'green'
      const time = duration((a.endedAt ?? now) - a.startedAt)
      const label = clip(`${a.type}: ${a.description}`, W - time.length - 5)
      const facts = [
        a.contextTokens !== undefined ? `ctx ${tokens(a.contextTokens)}` : '',
        `${a.tools} tools`,
        a.branch ? `⎇ ${a.branch}${a.isWorktree ? ' (wt)' : ''}` : a.isWorktree ? '⎇ worktree' : '',
      ].filter(Boolean).join(' · ')
      return (
        <Box key={`a-${a.id}`} flexDirection="column">
          <Box justifyContent="space-between" width={W}>
            <Box>
              <Text color={glyphColor} dimColor={isEnded}>{`  ${glyph} `}</Text>
              <Button
                key={`agent-${a.id}`}
                plain
                dimColor={isEnded || undefined}
                label={label}
                onPress={() => void update($, view, x => ({ ...x, expanded: x.expanded === a.id ? undefined : a.id }))}
              />
            </Box>
            <Text dimColor>{time}</Text>
          </Box>
          {!isEnded || isOpen ? (
            <Text dimColor wrap="truncate-end">
              {`    ${facts}`}
              {a.errors > 0 ? <Text color="red">{` · ${a.errors} err`}</Text> : null}
            </Text>
          ) : null}
          {isOpen && a.lastMessage ? <Text dimColor wrap="truncate-end">{`    "${clip(a.lastMessage, W - 7)}"`}</Text> : null}
          {isOpen && a.model ? <Text dimColor wrap="truncate-end">{`    ${modelName(a.model)}`}</Text> : null}
        </Box>
      )
    }

    const shellRow = (s: ShellRow) => {
      const time = duration((s.endedAt ?? now) - s.startedAt)
      const isLive = s.status === 'running'
      const glyph = isLive ? '●' : s.status === 'completed' ? '✓' : '✗'
      const color = isLive ? 'green' : s.status === 'completed' ? undefined : 'red'
      return (
        <Box key={`s-${s.id}`} justifyContent="space-between" width={W}>
          <Box>
            <Text color={color} dimColor={!isLive}>{`  ${glyph} `}</Text>
            <Button key={`shell-${s.id}`} plain dimColor={!isLive || undefined} label={clip(s.command, W - time.length - 6)} onPress={() => void openShell($, s.id)} />
          </Box>
          <Text dimColor>{time}</Text>
        </Box>
      )
    }

    const items = prog.todos.length > 0 ? prog.todos : prog.tasks
    const finished = items.filter(i => i.status === 'completed').length
    const doneShown = items.length > 8 ? items.filter(i => i.status === 'completed').slice(-2) : items.filter(i => i.status === 'completed')
    const rest = items.filter(i => i.status !== 'completed')
    const hidden = finished - doneShown.length

    return (
      <Box flexDirection="column" width={W}>
        {n ? (
          <Box key="needs" backgroundColor="#2f2814" width={W}>
            <Text color="yellow" bold>{' ⚠ NEEDS YOU '}</Text>
            <Text color="yellow">{clip(`· ${n.who}: ${n.what} · ${duration(now - n.since)}`, W - 13)}</Text>
          </Box>
        ) : null}

        {header('limits', 'LIMITS', u && u.rateLimits.length === 0 ? 'no subscription limits reported yet' : '')}
        {!isFolded('limits') ? (
          <Box flexDirection="column">
            {limitRows}
            {money || fc ? (
              <Text wrap="truncate-end">
                <Text dimColor>{`  ${money}`}</Text>
                {fc?.kind === 'full' ? <Text color="yellow">{`${money ? ' · ' : ''}5h full ≈ ${clock(fc.at)}`}</Text> : null}
                {fc?.kind === 'ok' ? <Text color="green">{`${money ? ' · ' : ''}5h lasts until reset`}</Text> : null}
              </Text>
            ) : null}
          </Box>
        ) : null}

        {header('main', 'MAIN', u ? duration(now - u.startedAt) : '')}
        {!isFolded('main') ? (
          <Box flexDirection="column">
            <Text wrap="truncate-end">{`  ${m.model ? modelName(m.model) : 'model —'}${m.effort ? ` · effort ${m.effort}` : ''}`}</Text>
            {u ? (
              <Text wrap="truncate-end">
                <Text>{'  ctx '}</Text>
                <Text color={ctxColor}>{ctxBar.full}</Text>
                <Text dimColor>{ctxBar.empty}</Text>
                <Text color={ctxColor} bold>{ctxPct !== undefined ? ` ${Math.round(ctxPct)}%` : ' —'}</Text>
                <Text dimColor>{u.contextTokens !== undefined ? ` ${tokens(u.contextTokens)}/${tokens(u.contextWindow)}` : ''}</Text>
                {ctxPct !== undefined && ctxPct >= 85 ? <Text color="red">{' compaction soon'}</Text> : null}
              </Text>
            ) : null}
            {m.branch ? <Text color="#7ab7ff" wrap="truncate-end">{`  ⎇ ${m.branch}${m.isWorktree ? ' (worktree)' : ''}`}</Text> : null}
          </Box>
        ) : null}

        {header('agents', 'AGENTS', agentRows.length ? `${running.length} running · ${done.length} done` : '')}
        {!isFolded('agents') ? (
          <Box flexDirection="column">
            {agentRows.length === 0 ? <Text dimColor>{'  none yet'}</Text> : null}
            {running.map(agentRow)}
            {done.slice(0, DONE_AGENTS_SHOWN).map(agentRow)}
            {done.length > DONE_AGENTS_SHOWN ? <Text dimColor>{`  + ${done.length - DONE_AGENTS_SHOWN} more done`}</Text> : null}
          </Box>
        ) : null}

        {header('background', 'BACKGROUND', liveShells.length ? `${liveShells.length} running` : '')}
        {!isFolded('background') ? (
          <Box flexDirection="column">
            {shellRows.length === 0 && cronRows.length === 0 ? <Text dimColor>{'  nothing in the background'}</Text> : null}
            {liveShells.map(shellRow)}
            {endedShells.slice(0, FINISHED_SHELLS_SHOWN).map(shellRow)}
            {cronRows.map(c => (
              <Text key={`c-${c.id}`} dimColor wrap="truncate-end">{`  ↻ ${clip(c.prompt, W - c.schedule.length - 8)} · ${c.schedule}`}</Text>
            ))}
          </Box>
        ) : null}

        {header('progress', 'PROGRESS', items.length ? `${finished}/${items.length}` : '')}
        {!isFolded('progress') ? (
          <Box flexDirection="column">
            {prog.plan ? <Text color="#f0a283" wrap="truncate-end">{`  plan: ${clip(prog.plan, W - 9)}`}</Text> : null}
            {items.length === 0 && !prog.plan ? <Text dimColor>{'  no todo list yet'}</Text> : null}
            {hidden > 0 ? <Text dimColor>{`  ✓ ${hidden} earlier done`}</Text> : null}
            {[...doneShown, ...rest].map(i => (
              <Text key={`p-${i.id}`} wrap="truncate-end">
                <Text color={i.status === 'completed' ? 'green' : i.status === 'in_progress' ? '#d97757' : undefined} dimColor={i.status === 'pending'}>
                  {i.status === 'completed' ? '  ✓ ' : i.status === 'in_progress' ? '  ◐ ' : '  ○ '}
                </Text>
                <Text dimColor={i.status === 'completed'} bold={i.status === 'in_progress'}>{clip(i.text, W - 4)}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        {footer('tab next · ⏎ open/fold · ↑↓ scroll · esc prompt')}
      </Box>
    )
  })
}
