import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const MIN = 60_000
const SURFACES = ['terminal', 'desktop'] as const

const PANE = (bodyColumns = 46, isFocused = false) => ({
  plugin: 'session-radar',
  component: 'Pane' as const,
  requestId: 'session-radar',
  props: {
    title: 'Radar', isFocused, bodyColumns, placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 60 }, view: {},
  },
  viewport: { columns: 160, rows: 60 },
})

// Stands in for the engine beneath the plugin.
function world(on: On, { files = {}, now = 1_000_000 }: { files?: Record<string, string>; now?: number } = {}) {
  const clock = mock.clock(on, { now })
  const toasts: string[] = []
  const opened: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  on('ui.close', (_$, e) => {
    opened.splice(opened.indexOf(e.id), 1)
    return { value: undefined }
  })
  on('agent.list', () => ({ value: [] }))
  on('session.cwd', () => ({ value: '/home/me/app' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.stat', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('missing')
    return { value: { kind: 'file', size: text.length, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('missing')
    return { value: text }
  })
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('classic.Notification', () => ({}))
  return { toasts, opened, clock }
}

const background = (id: string, command: string) => ({
  command,
  run_in_background: true,
})

function answerBash(on: On, id: string) {
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id },
    text: `Command running in background with ID: ${id}. Output is being written to: /tmp/claude/tasks/${id}.output. You will be notified when it completes.`,
  }))
}

const notice = (id: string, status: string, summary: string) => ({
  origin: { kind: 'task-notification' as const },
  text: `<task-notification>\n<task-id>${id}</task-id>\n<output-file>/tmp/claude/tasks/${id}.output</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
})

test('a background shell is listed, then marked done with a toast', async ($, on) => {
  const w = world(on)
  answerBash(on, 'b1')

  await $.tool.call({ tool: 'Bash', ...background('b1', 'npm run dev') })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE(), surface })
    expect(await ui.find({ key: 'shell-b1' })).toBeDefined()
    expect((await ui.find({ text: /1 running/ }))).toBeDefined()
    await ui.unmount()
  }

  await $.session.receive(notice('b1', 'completed', 'Background command "npm run dev" completed (exit code 0)'))
  expect(w.toasts.at(-1)).toBe('✓ shell completed: npm run dev (exit 0)')

  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ text: /1 running/ })).toBeUndefined()
  expect(await ui.find({ key: 'shell-b1' })).toBeDefined()
})

test('a foreground Bash call is not listed', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))

  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ text: /nothing in the background/ })).toBeDefined()
})

test('opening a shell shows its latest output and goes back', async ($, on) => {
  world(on, { files: { '/tmp/claude/tasks/b2.output': 'one\n\x1b[32mready\x1b[0m in 400ms\nprogress 10%\rprogress 100%\n' } })
  answerBash(on, 'b2')
  await $.tool.call({ tool: 'Bash', ...background('b2', 'vite') })

  const ui = await $.ui.mount({ ...PANE(46, true), surface: 'terminal' })
  await ui.press({ key: 'shell-b2' })

  expect(await ui.find({ text: 'ready in 400ms' })).toBeDefined()
  expect(await ui.find({ text: 'progress 100%' })).toBeDefined()
  expect(await ui.find({ key: 'stop' })).toBeDefined()

  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'shell-b2' })).toBeDefined()
})

test('limits show the windows and forecast when the 5h window fills', async ($, on) => {
  const { clock } = world(on, { now: Date.parse('2026-10-10T12:00:00Z') })
  const resetsAt = '2026-10-10T16:00:00Z'
  const measure = (pct: number) => $.session.measure({
    context: { tokens: 90_000, window: 200_000, percent: 45 },
    rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt }, { kind: 'seven_day', percentUsed: 12 }],
    cost: { usd: 3 },
    changed: ['rateLimits'],
  })

  await measure(40)
  await clock.advance(30 * MIN)
  await measure(55)

  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ text: /5h .* 55%/ })).toBeDefined()
  expect(await ui.find({ text: /7d .* 12%/ })).toBeDefined()
  // 15 points in 30 min leaves 45 points: 90 min more, before the 16:00 reset.
  expect(await ui.find({ text: /5h full ≈/ })).toBeDefined()
  expect(await ui.find({ text: /45%/ })).toBeDefined()
})

test('a slow pace says the window lasts until reset', async ($, on) => {
  const { clock } = world(on, { now: Date.parse('2026-10-10T12:00:00Z') })
  const measure = (pct: number) => $.session.measure({
    context: { tokens: 1000, window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: '2026-10-10T13:00:00Z' }],
    changed: ['rateLimits'],
  })
  await measure(20)
  await clock.advance(10 * MIN)
  await measure(21)

  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ text: /lasts until reset/ })).toBeDefined()
})

test('a permission prompt pins NEEDS YOU until the next prompt', async ($, on) => {
  world(on)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })

  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ text: /NEEDS YOU/ })).toBeDefined()

  await $.prompt.submit({ text: 'yes', wait: false, origin: { kind: 'composer' } })
  expect(await ui.find({ text: /NEEDS YOU/ })).toBeUndefined()
})

test('the todo list becomes the progress section', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Scaffold', status: 'completed', activeForm: 'Scaffolding' },
      { content: 'Wire agents', status: 'in_progress', activeForm: 'Wiring agents' },
      { content: 'Tests', status: 'pending', activeForm: 'Testing' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ text: /1\/3/ })).toBeDefined()
  expect(await ui.find({ text: 'Wiring agents' })).toBeDefined()
  expect(await ui.find({ text: 'Tests' })).toBeDefined()
})

test('sections fold from their header', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] } }))
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Only step', status: 'pending', activeForm: 'Stepping' }] })

  const ui = await $.ui.mount({ ...PANE(46, true), surface: 'terminal' })
  expect(await ui.find({ text: 'Only step' })).toBeDefined()
  await ui.press({ key: 'fold-progress' })
  expect(await ui.find({ text: 'Only step' })).toBeUndefined()
  await ui.press({ key: 'fold-progress' })
  expect(await ui.find({ text: 'Only step' })).toBeDefined()
})

const RADAR = { command: 'radar', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }

test('/radar opens and closes the pane', async ($, on) => {
  const w = world(on)
  const first = await $.command.run(RADAR)
  expect(w.opened).toEqual(['session-radar'])
  expect(first.text).toContain('opened')
  const second = await $.command.run(RADAR)
  expect(w.opened).toEqual([])
  expect(second.text).toContain('closed')
})

const SPAWN = {
  tool_use_id: 'tu1', prompt: 'find fixtures', description: 'find test fixtures', subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false,
}

test('agents are listed with their tool calls, context and last words', async ($, on) => {
  const w = world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'ag1' }))
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: { filePath: 'a', content: '', numLines: 0, startLine: 1, totalLines: 0 } } }))
  on('turn.step', async function* () {
    return {
      turnId: 't', index: 0, answer: 'Looking around.\nFound 4 fixture dirs under tests/', toolUses: [], stopReason: 'end_turn' as const,
      usage: { model: 'claude-haiku-4-5', input_tokens: 2000, output_tokens: 10, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 0 },
    }
  })

  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Read', file_path: '/a', agentId: 'ag1' } as Parameters<typeof $.tool.call>[0])
  await $.tool.call({ tool: 'Read', file_path: '/b', agentId: 'ag1' } as Parameters<typeof $.tool.call>[0])
  for await (const _ of $.turn.step({ turnId: 't', index: 0, model: 'claude-haiku-4-5', messageCount: 3, agentId: 'ag1' })) void _

  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ key: 'agent-ag1', text: /Explore: find test fixtures/ })).toBeDefined()
  expect(await ui.find({ text: /ctx 62k · 2 tools/ })).toBeDefined()
  expect(await ui.find({ text: /1 running · 0 done/ })).toBeDefined()

  await $.session.receive(notice('ag1', 'completed', 'Agent "find test fixtures" completed'))
  expect(w.toasts.at(-1)).toBe('✓ agent completed: find test fixtures')
  expect(await ui.find({ text: /0 running · 1 done/ })).toBeDefined()

  // Done agents fold to one line; pressing one shows its last words.
  expect(await ui.find({ text: /Found 4 fixture dirs/ })).toBeUndefined()
  await ui.press({ key: 'agent-ag1' })
  expect(await ui.find({ text: /Found 4 fixture dirs under tests/ })).toBeDefined()
})

test('cron jobs and wakeups show as scheduled work', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'CronCreate' }, () => ({ result: { id: 'c1', humanSchedule: 'every 5 minutes', recurring: true } }))
  on('tool.call', { tool: 'CronDelete' }, () => ({ result: { id: 'c1' } }))
  on('tool.call', { tool: 'ScheduleWakeup' }, () => ({ result: {} }))

  await $.tool.call({ tool: 'CronCreate', cron: '*/5 * * * *', prompt: '/babysit-prs' })
  await $.tool.call({ tool: 'ScheduleWakeup', delaySeconds: 600, reason: 'watching CI run' })

  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ text: /↻ \/babysit-prs · every 5 minutes/ })).toBeDefined()
  expect(await ui.find({ text: /↻ watching CI run · at / })).toBeDefined()

  await $.tool.call({ tool: 'CronDelete', id: 'c1' })
  await $.prompt.submit({ text: '/loop check CI', wait: false, origin: { kind: 'scheduled-trigger' } })
  expect(await ui.find({ text: /babysit-prs/ })).toBeUndefined()
  expect(await ui.find({ text: /watching CI run/ })).toBeUndefined()
})

test('a stopped shell is marked killed', async ($, on) => {
  world(on)
  answerBash(on, 'b6')
  on('tool.call', { tool: 'TaskStop' }, () => ({ result: { message: 'stopped', task_id: 'b6', task_type: 'local_bash' } }))
  await $.tool.call({ tool: 'Bash', ...background('b6', 'tail -f log') })
  await $.tool.call({ tool: 'TaskStop', task_id: 'b6' })

  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ text: /1 running/ })).toBeUndefined()
  await ui.press({ key: 'shell-b6' })
  expect(await ui.find({ text: /killed/ })).toBeDefined()
})

test('the pane fits a narrow sidebar', async ($, on) => {
  world(on)
  answerBash(on, 'b3')
  await $.tool.call({ tool: 'Bash', ...background('b3', 'npm run a-very-long-script-name -- --with --many --flags --that --never --end') })
  const ui = await $.ui.mount({ ...PANE(30), surface: 'terminal' })
  const row = await ui.find({ key: 'shell-b3' })
  expect(row?.text.length).toBeLessThanOrEqual(30)
  expect(row?.text.endsWith('…')).toBe(true)
})

test('a notice delivered as a prompt marks the shell done', async ($, on) => {
  const w = world(on)
  answerBash(on, 'b4')
  await $.tool.call({ tool: 'Bash', ...background('b4', 'make build') })

  const n = notice('b4', 'failed', 'Background command "make build" failed (exit code 2)')
  await $.prompt.submit({ text: n.text, wait: false, origin: { kind: 'task-notification' } })

  expect(w.toasts).toEqual(['✗ shell failed: make build (exit 2)'])
  const ui = await $.ui.mount({ ...PANE(), surface: 'terminal' })
  expect(await ui.find({ text: /1 running/ })).toBeUndefined()
})
