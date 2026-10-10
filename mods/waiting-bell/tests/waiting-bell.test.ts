import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const FIVE_MIN = 5 * 60 * 1000
const SOUNDS = new Set(['pw-play', 'paplay', 'canberra-gtk-play', 'aplay', 'afplay'])

type World = { uname?: string; env?: Readonly<Record<string, string>>; missing?: string[] }

// Stands in for the engine beneath the plugin: records the commands run and
// the status line, and answers the events the plugin passes down.
function world(on: On, { uname = 'Linux', env = {}, missing = [] }: World = {}) {
  const runs: string[][] = []
  const status: (string | undefined)[] = []
  mock.env(on, env)
  on('process.run', (_$, e) => {
    const cmd = e.argv[0] ?? ''
    if (missing.includes(cmd)) return { value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }
    runs.push([...e.argv])
    const stdout = cmd === 'uname' ? `${uname}\n` : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', (_$, e) => {
    status.push(e.text)
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/home/me/project' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('classic.Notification', () => ({}))
  const commands = () => runs.map(r => r[0])
  const rings = () => commands().filter(c => SOUNDS.has(c ?? '') || (c === 'powershell.exe' && /Sound/.test(runs.find(r => r[0] === c)?.[3] ?? ''))).length
  return { runs, status, commands, rings }
}

const answered = { answer: 'done', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' } as const

test('rings when the turn ends, again every 5 minutes, and stops when a turn starts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  const w = world(on)

  await $.turn.complete(answered)
  await clock.settle()
  expect(w.rings()).toBe(1)
  expect(w.commands()).toContain('notify-send')

  await clock.advance(FIVE_MIN)
  expect(w.rings()).toBe(2)

  await $.turn.start({ text: 'hi', turnId: 't2' })
  expect(w.status.at(-1)).toBe(undefined)

  await clock.advance(FIVE_MIN * 3)
  expect(w.rings()).toBe(2)
})

test('subagent turns and interrupts do not ring', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)

  await $.turn.complete({ ...answered, agentId: 'a1' })
  await $.turn.complete({ ...answered, isAborted: true, reason: 'aborted' })
  await clock.settle()
  expect(w.runs).toEqual([])
})

test('a permission prompt rings; an idle notice does not', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on)

  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' })
  await clock.settle()
  expect(w.rings()).toBe(0)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  await clock.settle()
  expect(w.rings()).toBe(1)
})

test('Linux under Hyprland adds the screen overlay', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { env: { HYPRLAND_INSTANCE_SIGNATURE: 'x' } })
  await $.turn.complete(answered)
  await clock.settle()
  expect(w.commands()).toEqual(expect.arrayContaining(['pw-play', 'hyprctl', 'notify-send']))
})

test('Linux without PipeWire falls back to the next player', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { missing: ['pw-play'] })
  await $.turn.complete(answered)
  await clock.settle()
  expect(w.commands()).toContain('paplay')
  expect(w.commands()).not.toContain('hyprctl')
})

test('macOS uses afplay and a notification', async ($, on) => {
  const clock = mock.clock(on)
  const w = world(on, { uname: 'Darwin' })
  await $.turn.complete(answered)
  await clock.settle()
  expect(w.commands()).toEqual(expect.arrayContaining(['afplay', 'osascript']))
  expect(w.commands()).not.toContain('notify-send')
})

for (const [name, env] of [
  ['Windows', { OS: 'Windows_NT' }],
  ['WSL', { WSL_DISTRO_NAME: 'Ubuntu' }],
] as const) {
  test(`${name} uses PowerShell for sound and a balloon`, async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, { env })
    await $.turn.complete(answered)
    await clock.settle()
    const scripts = w.runs.filter(r => r[0] === 'powershell.exe').map(r => r[3] ?? '')
    expect(scripts.some(s => s.includes('SoundPlayer'))).toBe(true)
    expect(scripts.some(s => s.includes('ShowBalloonTip'))).toBe(true)
    expect(w.commands()).not.toContain('uname')
  })
}
