import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Waiting, WaitingKind } from '../types'

const REPEAT_MS = 5 * 60 * 1000
// After each ring the terminal banner flashes this many times, this fast.
const FLASH_MS = 500
const FLASHES = 20
// How long the on-screen alert stays, where the OS lets us say.
const OVERLAY_MS = 15_000
// Tools that stop and wait for an answer while they run.
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
// Notification types the engine raises when a dialog is waiting on the person.
const WAITING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog'])
// Prompts the person sends; every other origin is the session waking itself.
const PERSON = new Set(['composer', 'bridge'])
// Agents still at work will wake the main session again when they finish.
const BUSY_AGENTS = new Set(['pending', 'running'])

const waiting = atom({ plugin: 'waiting-bell', key: 'waiting' } as const, null)

let repeat: Timer | undefined
let flashing: Timer | undefined

function flash($: EngineInterface) {
  flashing?.cancel()
  let left = FLASHES
  flashing = $.clock.every(FLASH_MS, () => {
    left -= 1
    const isOn = left > 0 && left % 2 === 1
    void update($, waiting, w => (w ? { ...w, isFlashOn: isOn } : w))
    if (left <= 0) flashing?.cancel()
  })
}

type Os = 'linux' | 'mac' | 'windows'
type Alert = { title: string; body: string }

let os: Os | undefined
let isHyprland = false

// No platform noun on $: Windows (and WSL, whose alerts go through Windows)
// says so in its environment; elsewhere uname tells Linux from macOS.
async function detectOs($: EngineInterface): Promise<Os> {
  if (os) return os
  const [winOs, wsl, hypr] = await Promise.all([
    $.env.get('OS'),
    $.env.get('WSL_DISTRO_NAME'),
    $.env.get('HYPRLAND_INSTANCE_SIGNATURE'),
  ])
  isHyprland = Boolean(hypr)
  if (winOs === 'Windows_NT' || wsl) return (os = 'windows')
  const uname = await $.process.run(['uname', '-s']).catch(() => undefined)
  return (os = uname?.stdout.trim() === 'Darwin' ? 'mac' : 'linux')
}

// Runs the first command that starts and exits 0; a missing tool falls through.
async function firstThatWorks($: EngineInterface, commands: readonly (readonly string[])[]) {
  for (const argv of commands) {
    const ran = await $.process.run(argv, { timeoutMs: OVERLAY_MS + 10_000 }).catch(() => undefined)
    if (ran?.exitCode === 0) return argv[0]
  }
  return undefined
}

const ps = (text: string) => `'${text.replaceAll("'", "''")}'`
const applescript = (text: string) => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

function sound($: EngineInterface, on: Os) {
  if (on === 'mac') {
    return firstThatWorks($, [['afplay', '/System/Library/Sounds/Glass.aiff']])
  }
  if (on === 'windows') {
    return firstThatWorks($, [
      ['powershell.exe', '-NoProfile', '-Command', "(New-Object Media.SoundPlayer \"$env:WINDIR\\Media\\Windows Notify System Generic.wav\").PlaySync()"],
      ['powershell.exe', '-NoProfile', '-Command', '[System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 800'],
    ])
  }
  return firstThatWorks($, [
    ['pw-play', '/usr/share/sounds/freedesktop/stereo/bell.oga'],
    ['paplay', '/usr/share/sounds/freedesktop/stereo/bell.oga'],
    ['canberra-gtk-play', '-i', 'bell'],
    ['aplay', '-q', '/usr/share/sounds/alsa/Front_Center.wav'],
  ])
}

function screen($: EngineInterface, on: Os, { title, body }: Alert) {
  if (on === 'mac') {
    return firstThatWorks($, [
      ['osascript', '-e', `display notification ${applescript(body)} with title ${applescript(title)} sound name "Glass"`],
    ])
  }
  if (on === 'windows') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Warning',
      '$n.Visible = $true',
      `$n.ShowBalloonTip(${OVERLAY_MS}, ${ps(title)}, ${ps(body)}, 'Warning')`,
      `Start-Sleep -Milliseconds ${OVERLAY_MS}`,
      '$n.Dispose()',
    ].join('; ')
    return firstThatWorks($, [['powershell.exe', '-NoProfile', '-Command', script]])
  }
  return Promise.all([
    isHyprland
      ? firstThatWorks($, [['hyprctl', 'notify', '0', String(OVERLAY_MS), 'rgb(ffcc00)', `fontsize:30 ${title}: ${body}`]])
      : undefined,
    firstThatWorks($, [
      ['notify-send', '--urgency=critical', '--app-name=Claude Code', `--expire-time=${OVERLAY_MS}`, title, body],
    ]),
  ])
}

async function ring($: EngineInterface, reason: string) {
  const project = (await $.session.cwd()).split(/[\\/]/).pop() ?? ''
  $.ui.toast(`🔔 Waiting for you: ${reason}`, { timeoutMs: 8000 })
  $.ui.status(`🔔 WAITING FOR YOU — ${reason}`)
  flash($)
  // Off the hook's own dispatch: a Windows balloon holds its process for its
  // whole life, and the turn must not wait on it.
  $.clock.after(0, () => {
    void detectOs($).then(on =>
      Promise.allSettled([
        sound($, on),
        screen($, on, { title: `🔔 Claude is waiting — ${project}`, body: reason }),
      ]),
    )
  })
}

async function start($: EngineInterface, kind: WaitingKind, reason: string, agentId?: string) {
  repeat?.cancel()
  const since = await $.clock.now()
  await update($, waiting, (): Waiting => ({ kind, reason, since, rings: 1, isFlashOn: true, isPaused: false, agentId }))
  await ring($, reason)
  keepRinging($, reason)
}

function keepRinging($: EngineInterface, reason: string) {
  repeat?.cancel()
  repeat = $.clock.every(REPEAT_MS, () => {
    void update($, waiting, w => (w ? { ...w, rings: w.rings + 1, isFlashOn: true } : w))
    void ring($, reason)
  })
}

function quiet($: EngineInterface) {
  repeat?.cancel()
  repeat = undefined
  flashing?.cancel()
  flashing = undefined
  $.ui.status(undefined)
}

async function stop($: EngineInterface) {
  quiet($)
  await update($, waiting, () => null)
}

// The session works on a background task's notice: silent until that turn ends.
async function pause($: EngineInterface) {
  quiet($)
  await update($, waiting, w => (w ? { ...w, isPaused: true, isFlashOn: false } : w))
}

async function hasBusyAgents($: EngineInterface) {
  const list = await $.agent.list().catch(() => [])
  return list.some(a => BUSY_AGENTS.has(a.status))
}

export const register: Register = on => {
  // The person typed: whatever was waiting has its answer. A prompt from a
  // background task's notice or a schedule is the session going back to work.
  on('prompt.submit', async ($, e, next) => {
    if (PERSON.has(e.origin.kind)) await stop($)
    else await pause($)
    return next(e)
  })

  // The main session finished its turn. It is the person's turn only when
  // nothing it started is still running; a finished agent wakes it again.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason === 'aborted') return result
    if (await hasBusyAgents($)) return result
    const w = await read($, waiting)
    if (w?.kind === 'turn') {
      // Already waiting on the person since before a notice woke the session.
      await update($, waiting, x => (x ? { ...x, isPaused: false } : x))
      keepRinging($, w.reason)
      return result
    }
    await start($, 'turn', e.reason === 'answer' ? 'your turn' : `turn ended (${e.reason})`)
    return result
  })

  // A permission dialog or MCP elicitation is up.
  on('classic.Notification', async ($, e, next) => {
    if (WAITING_NOTIFICATIONS.has(e.notification_type)) {
      await start($, 'dialog', e.message || 'permission needed', e.agent_id)
    }
    return next(e)
  })

  // A question or plan approval waits while the tool runs. A dialog is
  // answered once a tool in the same loop finishes; a turn's wait is not.
  on('tool.call', async ($, e, next) => {
    if (ASKING_TOOLS.has(e.tool)) {
      await start($, 'dialog', e.tool === 'ExitPlanMode' ? 'plan approval' : 'a question for you', e.agentId)
    }
    const result = await next(e)
    const w = await read($, waiting)
    if (w?.kind === 'dialog' && w.agentId === e.agentId) await stop($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const w = await read($, waiting)
    if (w === null || w.isPaused || e.props.hasSurvey || e.props.isWorking) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const at = new Date(w.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const accent = w.isFlashOn ? 'red' : 'yellow'
    return (
      <Box flexDirection="column" borderStyle="double" borderColor={accent} paddingX={1}>
        <Box justifyContent="space-between">
          <Text color={accent} bold inverse>
            {'  🔔  WAITING FOR YOU  🔔  '}
          </Text>
          <Button key="silence" label="Silence" onPress={() => stop($)} />
        </Box>
        <Text color={accent} bold>
          {w.reason}
        </Text>
        <Text color="yellow">{`since ${at} · rang ${w.rings}× · rings again every 5 min until you answer`}</Text>
      </Box>
    )
  })
}
