import type { LimitSample, RateLimit, ShellStatus } from '../types'

const MIN = 60_000
// A forecast needs this much history in the current window before it means anything.
const FORECAST_MIN_SPAN = 5 * MIN
// And looks back no further than this, so it follows the current pace.
const FORECAST_LOOKBACK = 60 * MIN

export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}`
}

export function tokens(n: number) {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function clock(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// "resets 16:00" today, "resets Sat 00:00" on another day.
export function resetLabel(iso: string | undefined, now: number) {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const isToday = new Date(at).toDateString() === new Date(now).toDateString()
  if (isToday) return `resets ${clock(at)}`
  return `resets ${new Date(at).toLocaleDateString('en-US', { weekday: 'short' })} ${clock(at)}`
}

export function modelName(model: string) {
  return model.replace(/^claude-/, '')
}

export function clip(text: string, width: number) {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (width <= 1) return flat.slice(0, Math.max(0, width))
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat
}

export function bar(percent: number, width: number) {
  const full = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return { full: '█'.repeat(full), empty: '░'.repeat(width - full) }
}

export const LIMIT_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7d' }

export function limitLabel(kind: string) {
  return LIMIT_LABEL[kind] ?? kind.replace(/_/g, ' ')
}

// Keeps a short history per window, restarted whenever the window resets.
export function addSamples(samples: readonly LimitSample[], limits: readonly RateLimit[], at: number) {
  let next = samples.filter(s => at - s.at <= FORECAST_LOOKBACK)
  for (const l of limits) {
    next = next.filter(s => s.kind !== l.kind || s.resetsAt === l.resetsAt)
    const last = next.filter(s => s.kind === l.kind).at(-1)
    if (last && last.percentUsed === l.percentUsed && at - last.at < MIN) continue
    next.push({ kind: l.kind, at, percentUsed: l.percentUsed, resetsAt: l.resetsAt })
  }
  return next
}

export type Forecast = { kind: 'full'; at: number } | { kind: 'ok' } | undefined

// When the window fills at the pace of the samples, or 'ok' when it resets first.
export function forecast(samples: readonly LimitSample[], limit: RateLimit, now: number): Forecast {
  const mine = samples.filter(s => s.kind === limit.kind && s.resetsAt === limit.resetsAt)
  const first = mine[0]
  if (!first || now - first.at < FORECAST_MIN_SPAN) return undefined
  const rate = (limit.percentUsed - first.percentUsed) / (now - first.at)
  if (rate <= 0) return { kind: 'ok' }
  const at = now + (100 - limit.percentUsed) / rate
  const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (!Number.isNaN(resets) && at >= resets) return { kind: 'ok' }
  return { kind: 'full', at }
}

export function burnRate(costUsd: number | undefined, startedAt: number, now: number) {
  const hours = (now - startedAt) / (60 * MIN)
  if (costUsd === undefined || hours < 5 / 60) return undefined
  return costUsd / hours
}

export type TaskNotice = { id: string; status: ShellStatus; summary: string; outputPath?: string }

const tag = (text: string, name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()

// The <task-notification> the engine delivers when a background task ends.
export function parseTaskNotice(text: string): TaskNotice | undefined {
  const id = tag(text, 'task-id')
  if (!id) return undefined
  const raw = tag(text, 'status') ?? 'completed'
  const status: ShellStatus = raw === 'failed' || raw === 'killed' ? raw : 'completed'
  return { id, status, summary: tag(text, 'summary') ?? '', outputPath: tag(text, 'output-file') }
}

// Bash's result names where a backgrounded command writes its output.
export function outputPathOf(text: string | undefined) {
  return text?.match(/written to:\s*(\S+?\.output)\b/)?.[1]
}

export function exitCodeOf(summary: string) {
  return summary.match(/exit code (-?\d+)/)?.[1]
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

// The last `count` lines as a terminal would show them: colors dropped, a
// carriage return keeping only what came after it.
export function tail(text: string, count: number) {
  const lines = text.replace(ANSI, '').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.slice(-count).map(line => line.slice(line.lastIndexOf('\r') + 1).replace(/\t/g, '  '))
}

export function lastLine(text: string) {
  return text.split('\n').map(l => l.trim()).filter(Boolean).at(-1) ?? ''
}

export function parentDir(path: string) {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')))
}
