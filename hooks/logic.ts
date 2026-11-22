// Pure helpers for /berserk: no `$`, no engine. Unit-tested in logic.test.ts.

export type Mode = 'smart' | 'advise' | 'max' | 'fable' | 'full'
export type Tier = 'heavy' | 'mid' | 'fast'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type WindowKind = 'week' | 'hours5' | 'month' | 'custom'

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
export const FALLBACK_MS = 24 * HOUR // weekly reset unknown (API-key billing)
export const MONTH_MS = 30 * DAY // monthly reset unknown
export const STOP_AT_PERCENT = 98 // never push a window past this
export const FABLE = 'claude-fable-5-2'

type Route = { model: string; effort?: Effort }

export const MODE_INFO: Record<Mode, { label: string; blurb: string; routes: Record<Tier, Route> }> = {
  smart: {
    label: 'Smart',
    blurb: 'opus bursts, sonnet/haiku for routine steps',
    routes: {
      heavy: { model: 'opus', effort: 'high' },
      mid: { model: 'sonnet', effort: 'medium' },
      fast: { model: 'haiku' },
    },
  },
  advise: {
    label: 'Advise',
    blurb: 'sonnet does the work, opus only plans and rescues failures',
    routes: {
      heavy: { model: 'opus', effort: 'high' },
      mid: { model: 'sonnet', effort: 'high' },
      fast: { model: 'sonnet', effort: 'low' },
    },
  },
  max: {
    label: 'Max',
    blurb: 'opus xhigh bursts, sonnet for the rest',
    routes: {
      heavy: { model: 'opus', effort: 'xhigh' },
      mid: { model: 'sonnet', effort: 'high' },
      fast: { model: 'sonnet', effort: 'low' },
    },
  },
  fable: {
    label: 'Fable',
    blurb: 'Fable bursts (expensive), opus/haiku for the rest',
    routes: {
      heavy: { model: FABLE, effort: 'high' },
      mid: { model: 'opus', effort: 'medium' },
      fast: { model: 'haiku' },
    },
  },
  full: {
    label: 'FULL',
    blurb: 'Fable max effort, opus xhigh, workflows everywhere (burns quota fast)',
    routes: {
      heavy: { model: FABLE, effort: 'max' },
      mid: { model: 'opus', effort: 'xhigh' },
      fast: { model: 'sonnet', effort: 'medium' },
    },
  },
}

export const routeFor = (mode: Mode, tier: Tier): Route => MODE_INFO[mode].routes[tier]

const SCOUT = /explore|search|guide/i
const THINKER = /plan|review|architect/i

/** The model a subagent runs on when its spawn named none. */
export const agentModel = (mode: Mode, type: string): string => {
  if (mode === 'full') return SCOUT.test(type) ? 'sonnet' : FABLE
  if (mode === 'advise') return THINKER.test(type) ? 'opus' : 'sonnet'
  if (mode === 'max') return SCOUT.test(type) ? 'sonnet' : 'opus'
  if (mode === 'fable') return SCOUT.test(type) ? 'haiku' : THINKER.test(type) ? FABLE : 'opus'
  return SCOUT.test(type) ? 'haiku' : THINKER.test(type) ? 'opus' : 'sonnet'
}

const READ_ONLY = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch|TaskList|TaskGet|mcp__.*(search|get|list|read|query))/i
const WRITES = /^(Edit|Write|NotebookEdit|MultiEdit|Bash|PowerShell|Agent|Workflow)$/

/** What the next model step should run as, from the tool that just finished. */
export const tierAfter = (tool: string, isError: boolean, isReadOnly: boolean, current: Tier): Tier => {
  if (isError) return 'heavy'
  if (isReadOnly || READ_ONLY.test(tool)) return 'fast'
  if (WRITES.test(tool)) return 'mid'
  return current
}

export const stepTier = (index: number, tier: Tier): Tier => (index === 0 ? 'heavy' : tier)

/** Pacing nudge: behind pace goes one tier up, ahead of pace one tier down. */
export const nudge = (tier: Tier, p: 'under' | 'on' | 'over'): Tier => {
  const order: Tier[] = ['fast', 'mid', 'heavy']
  const i = order.indexOf(tier) + (p === 'under' ? 1 : p === 'over' ? -1 : 0)
  return order[Math.min(2, Math.max(0, i))] ?? tier
}

/** Closest supported reasoning effort at or below the desired level. */
export const turnEffort = (
  mode: 'smart' | 'advise' | 'max',
  firstTurn: boolean,
  failed: boolean,
  pacing: ReturnType<typeof pace>,
  supported: readonly string[],
): string | undefined => {
  const routine = mode === 'advise' ? 'fast' : 'mid'
  const tier = firstTurn || failed ? 'heavy' : mode === 'advise' ? routine : nudge(routine, pacing)
  const desired = routeFor(mode, tier).effort ?? 'low'
  const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
  return efforts.slice(0, efforts.indexOf(desired) + 1).reverse().find(effort => supported.includes(effort))
}

// ---- time -----------------------------------------------------------------

export const fmt = (ms: number): string => {
  const m = Math.max(0, Math.ceil(ms / MIN))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m % 60}m`
  return `${m}m`
}

/** `10m`, `2h`, `1.5d` to milliseconds; undefined for anything else. */
export const parseDuration = (s: string): number | undefined => {
  const hit = /^(\d+(?:\.\d+)?)(m|h|d)$/i.exec(s)
  if (!hit) return undefined
  const n = Number(hit[1])
  const unit = (hit[2] ?? 'h').toLowerCase()
  const ms = n * (unit === 'm' ? MIN : unit === 'h' ? HOUR : DAY)
  return ms > 0 ? ms : undefined
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const limitAt = (kind: string, percentUsed: number, resetMs: unknown): Limit => {
  const reset = typeof resetMs === 'number' ? new Date(resetMs) : undefined
  return reset && Number.isFinite(reset.getTime())
    ? { kind, percentUsed, resetsAt: reset.toISOString() }
    : { kind, percentUsed }
}

export const codexLimits = (snapshot: unknown): Limit[] => {
  const data = asRecord(snapshot)
  return [data['primary'], data['secondary']].flatMap(value => {
    const window = asRecord(value)
    const minutes = window['windowDurationMins']
    const percent = window['usedPercent']
    const reset = window['resetsAt']
    const kind = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'seven_day' : undefined
    if (!kind || typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return []
    return [limitAt(kind, percent, typeof reset === 'number' ? reset * 1000 : undefined)]
  })
}

export const copilotLimits = (snapshots: unknown): Limit[] =>
  Object.entries(asRecord(snapshots)).flatMap(([name, value]) => {
    if (name !== 'chat' && name !== 'premium-interactions') return []
    const snapshot = asRecord(value)
    const remaining = snapshot['remainingPercentage']
    if (snapshot['isUnlimitedEntitlement'] === true || snapshot['hasQuota'] === false ||
      typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0 || remaining > 100) return []
    const reset = snapshot['resetDateEstimated'] === true ? undefined : snapshot['resetDateEpochMs']
    return [limitAt('spend_limit', 100 - remaining, reset)]
  })

export const findLimit = (limits: readonly Limit[], kind: 'seven_day' | 'five_hour' | 'spend_limit'): Limit | undefined =>
  limits.find(l => l.kind === kind)

/** When berserk ends: the chosen window's reset, or the typed duration, or a 24h fallback. */
export const computeUntil = (
  now: number,
  window: WindowKind,
  customMs: number | undefined,
  limits: readonly Limit[],
  exact = false,
  slots?: number,
): { until: number; basis: 'reset' | 'custom' | 'fallback' } => {
  // The end of the Nth 5-hour quota window, counting the current one as the first.
  const fiveReset = findLimit(limits, 'five_hour')?.resetsAt
  const five = fiveReset ? Date.parse(fiveReset) : NaN
  const slotEnd =
    slots === undefined
      ? undefined
      : Number.isFinite(five) && five > now
        ? { until: five + (slots - 1) * FIVE_HOUR_MS, basis: 'reset' as const }
        : { until: now + slots * FIVE_HOUR_MS, basis: 'fallback' as const }
  if (window === 'custom' && customMs !== undefined) {
    const end = now + customMs
    const weekly = findLimit(limits, 'seven_day')?.resetsAt
    const reset = weekly ? Date.parse(weekly) : NaN
    // A typed time is "up to": it ends early when the weekly quota renews, unless it is exact.
    const timed =
      !exact && Number.isFinite(reset) && reset > now && reset < end
        ? { until: reset, basis: 'reset' as const }
        : { until: end, basis: 'custom' as const }
    return slotEnd && slotEnd.until < timed.until ? slotEnd : timed
  }
  if (window === 'hours5' && slotEnd) return slotEnd
  const limit = findLimit(limits, window === 'hours5' ? 'five_hour' : window === 'month' ? 'spend_limit' : 'seven_day')
  const reset = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN
  if (Number.isFinite(reset) && reset > now) return { until: reset, basis: 'reset' }
  return { until: now + (customMs ?? (window === 'month' ? MONTH_MS : FALLBACK_MS)), basis: 'fallback' }
}

/** The limits berserk watches for its 98% stop: its own window's (custom: both). */
export const watchedLimits = (window: WindowKind, limits: readonly Limit[]): Limit[] =>
  limits.filter(l =>
    window === 'week'
      ? l.kind === 'seven_day'
      : window === 'hours5'
        ? l.kind === 'five_hour'
        : window === 'month'
          ? l.kind === 'spend_limit'
          : l.kind === 'seven_day' || l.kind === 'five_hour',
  )

export const limitName = (kind: string): string => (kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? 'weekly' : 'monthly')

/** Why berserk should stop now, or undefined to carry on. */
export const stopReason = (
  now: number,
  until: number,
  window: WindowKind,
  limits: readonly Limit[],
  exact = false,
): string | undefined => {
  if (now >= until) return 'the window closed.'
  if (exact) return undefined
  const over = watchedLimits(window, limits).find(l => l.percentUsed >= STOP_AT_PERCENT)
  if (over) return `${limitName(over.kind)} quota is ${over.percentUsed}% used.`
  return undefined
}

/** Under pace means quota will go unused: berserk can afford to push harder. */
export const pace = (percentUsed: number, left: number, windowMs: number): 'under' | 'on' | 'over' => {
  const elapsed = Math.min(1, Math.max(0, 1 - left / windowMs)) * 100
  if (percentUsed + 10 < elapsed) return 'under'
  if (percentUsed > elapsed + 15) return 'over'
  return 'on'
}

export const WINDOW_MS: Record<'week' | 'hours5' | 'month', number> = { week: 7 * DAY, hours5: 5 * HOUR, month: MONTH_MS }

export const companionWindow = (
  now: number,
  provider: 'codex' | 'copilot',
  window: WindowKind,
  limits: readonly Limit[],
  args: { customMs?: number | undefined; hardMs?: number | undefined; slots?: number | undefined; exact: boolean },
): { until: number; hardUntil: number; duration: number } => {
  let { until } = computeUntil(now, window, args.customMs, limits, args.exact, args.slots)
  if (!args.exact && provider === 'copilot') {
    for (const limit of limits) {
      const reset = Date.parse(limit.resetsAt ?? '')
      if (reset > now) until = Math.min(until, reset)
    }
  }
  const duration = args.customMs ?? (window === 'custom' ? until - now : WINDOW_MS[window])
  const hardUntil = args.hardMs === undefined || until < now + duration ? until : now + args.hardMs
  if (!Number.isFinite(until) || !Number.isFinite(hardUntil)) throw new Error('Duration is too large.')
  return { until, hardUntil, duration }
}

export const companionStopReason = (
  now: number,
  until: number,
  exact: boolean,
  limits: readonly Limit[] | undefined,
): string | undefined => {
  if (now >= until) return 'time window ended'
  if (exact) return undefined
  if (!limits?.length) return 'quota unavailable'
  const full = limits.find(limit => limit.percentUsed >= STOP_AT_PERCENT)
  return full ? `${limitName(full.kind)} quota reached ${Math.round(full.percentUsed)}%` : undefined
}

// ---- looks ----------------------------------------------------------------

export const bar = (pct: number, width = 10): string => {
  const p = Math.min(100, Math.max(0, pct))
  const full = Math.round((p / 100) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

export const FLAME: Record<Mode, string> = { smart: '🔥', advise: '🧭', max: '🔥🔥', fable: '🔮', full: '☄️' }

/** How worked up berserk is, by the share of quota burned since it started. */
export const STAGES: readonly (readonly [number, string])[] = [
  [0, 'Simmering'],
  [10, 'Growling'],
  [25, 'Raging'],
  [45, 'Frenzy'],
  [65, 'Blood-red'],
  [85, 'Ragnarok'],
  [95, 'VALHALLA'],
]

export const stage = (burned: number): string => {
  let name = 'Simmering'
  for (const [from, label] of STAGES) if (burned >= from) name = label
  return name
}

export const CRIES = [
  'RAAAAGH!',
  'No quota left behind.',
  'Odin sees your diff.',
  'Ship it before the reset.',
  'Bear shirt on.',
  'Tokens fall like rain.',
  'For Valhalla!',
  'The ravens approve.',
] as const

/** A battle cry that changes with each tick. */
export const cry = (beat: number): string => CRIES[Math.abs(beat) % CRIES.length] ?? CRIES[0]

/** The flame flickers: it swaps with a spark on odd beats. */
export const flicker = (mode: Mode, beat: number): string => (beat % 2 === 0 ? FLAME[mode] : FLAME[mode].replace('🔥', '🌋'))

export const statusLine = (mode: Mode, left: number, pct: number | undefined, tier: Tier, flair?: { burned: number; beat: number }): string => {
  const heat = tier === 'heavy' ? '▲' : tier === 'mid' ? '■' : '▼'
  const quota = pct === undefined ? '' : ` | ${bar(pct, 8)} ${Math.round(pct)}%`
  const mood = flair === undefined ? '' : ` | ${stage(flair.burned)}`
  const icon = flair === undefined ? FLAME[mode] : flicker(mode, flair.beat)
  return `${icon} BERSERK ${MODE_INFO[mode].label.toUpperCase()} ${heat} | ${fmt(left)} left${quota}${mood}`
}

/** Two bars for the band above the prompt: time elapsed vs quota used. */
export const bandText = (mode: Mode, left: number, total: number, pct: number | undefined, beat?: number): string => {
  const elapsed = Math.min(100, Math.max(0, (1 - left / Math.max(1, total)) * 100))
  const quota = pct === undefined ? '' : `  quota ${bar(pct)} ${Math.round(pct)}%`
  const shout = beat === undefined ? '' : `  « ${cry(beat)} »`
  return `${FLAME[mode]} ${MODE_INFO[mode].label}  time ${bar(elapsed)} ${fmt(left)} left${quota}${shout}`
}

/** Milestone toast text every 10% of the window's quota burned since start. */
export const milestone = (startPct: number, nowPct: number, lastShown: number): { shown: number; text?: string } => {
  const burned = Math.floor((nowPct - startPct) / 10) * 10
  if (burned > lastShown && burned > 0) {
    return { shown: burned, text: nowPct >= STOP_AT_PERCENT - 10 ? `${burned}% burned. The end is near. RAAAH.` : `${burned}% of the window burned.` }
  }
  return { shown: lastShown }
}

// ---- command line -----------------------------------------------------------

export type Parsed =
  | { action: 'off' }
  | { action: 'status' }
  | { action: 'help' }
  | { action: 'egg'; egg: string }
  | {
      action: 'start'
      mode?: Mode | undefined
      window?: WindowKind | undefined
      customMs?: number | undefined
      /** Hard cap: with a typed duration, a turn still running at its end may carry on until this. */
      hardMs?: number | undefined
      /** Dry run: show what would happen, change nothing. */
      dry: boolean
      /** Stop at the end of this many 5-hour quota windows, the current one counting as the first. */
      slots?: number | undefined
      /** Run the typed time in full, ignoring quota renewal and the 98% stop. */
      exact: boolean
    }

export const EGGS = ['rage', 'odin', 'valhalla', 'bear', 'rest', 'berserk', 'ragnarok', 'thor', 'loki', 'freya', 'skol', 'coffee', '42'] as const

const UNIT = /(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/g

/** Weeks and months turn into days first: "2 weeks" is 14d, "1 month" is 30d. A bare "week" or "month" is a window, not a number. */
const BIG_UNIT = /(\d+(?:\.\d+)?)\s*(weeks?|w|months?|mo)\b/g

const FIVE_HOUR_MS = 5 * HOUR

/** "3 windows", "3x5hour" and "3 x 5 hours" become "#3": stop after the third 5-hour quota window. */
const SLOTS = /(\d+)\s*(?:x\s*5\s*-?\s*hours?|windows?)\b/g

/** "10 min", "2 hours", "5hour" and "2h-3h" become tokens parseArgs can read: 10m, 2h, window, "2h 3h". */
export const normalize = (args: string): string =>
  args
    .toLowerCase()
    .replace(SLOTS, (_m, n: string) => `#${n}`)
    .replace(/\b5-?hours?\b|\b5 hours?\s+(?:quota|window|limit)\b/g, 'window')
    .replace(BIG_UNIT, (_m, num: string, u: string) => `${Number(num) * (u.startsWith('w') ? 7 : 30)}d`)
    .replace(UNIT, (_m, num: string, u: string) => `${num}${u.startsWith('m') ? 'm' : u.startsWith('h') ? 'h' : 'd'}`)
    .replace(/(\d[mhd])-(\d)/g, '$1 $2')

export const parseArgs = (args: string): Parsed => {
  const words = normalize(args).trim().split(/\s+/).filter(Boolean)
  const first = words[0]
  if (first === 'off' || first === 'stop') return { action: 'off' }
  if (first === 'status') return { action: 'status' }
  if (first === 'help' || first === '?') return { action: 'help' }
  const egg = words.find(w => (EGGS as readonly string[]).includes(w))
  if (egg) return { action: 'egg', egg }
  const mode = words.find((w): w is Mode => w === 'smart' || w === 'advise' || w === 'max' || w === 'fable' || w === 'full')
  const durations = words.map(parseDuration).filter((d): d is number => d !== undefined)
  const customMs = durations[0]
  const longest = Math.max(0, ...durations)
  const hardMs = durations.length > 1 && longest > (customMs ?? 0) ? longest : undefined
  const slotWord = words.map(w => /^#(\d+)$/.exec(w)?.[1]).find((n): n is string => n !== undefined)
  const slotCount = slotWord === undefined ? undefined : Number(slotWord)
  const slots = slotCount !== undefined && slotCount >= 1 ? slotCount : undefined
  const window: WindowKind | undefined =
    customMs !== undefined
      ? 'custom'
      : slots !== undefined
        ? 'hours5'
        : words.some(w => w === 'week' || w === 'weekly')
        ? 'week'
        : words.some(w => w === 'month' || w === 'monthly')
          ? 'month'
          : words.some(w => w === 'window' || w === 'session')
            ? 'hours5'
            : undefined
  return { action: 'start', mode, window, customMs, hardMs, slots, dry: words.some(w => w === 'test' || w === 'dry'),
    exact: words.some(w => w === 'exact' || w === 'exactly' || w === 'fixed'),
  }
}

export const eggText = (egg: string): string => {
  switch (egg) {
    case 'odin':
      return 'Odin sees all. Three agents at most; the ravens are already reading your repo.'
    case 'valhalla':
      return 'Only those who ship before the reset enter Valhalla.'
    case 'bear':
      return 'Berserker means "bear shirt". Growl accepted. Tokens will be eaten.'
    case 'rest':
      return 'Even berserkers sleep. Use /berserk off.'
    case 'ragnarok':
      return 'The end of the window comes for everyone. Commit before the wolf.'
    case 'thor':
      return 'Mjölnir is a force-push. Do not.'
    case 'loki':
      return 'Loki renamed one variable. Check your tests.'
    case 'freya':
      return 'Freya takes half the fallen, and half the quota. Spend wisely.'
    case 'skol':
      return 'Skål! A horn of coffee, then back to the diff.'
    case 'coffee':
      return 'Berserkers run on coffee. The model runs on quota.'
    case '42':
      return 'The answer is 42 percent. Burn on.'
    case 'berserk':
      return 'ᛒᛖᚱᛊᛖᚱᚲ  The brand is burned in. Nothing else happens. Yet.'
    default:
      return 'RAAAAAGH. (Quota is a renewable resource. Probably.)'
  }
}

export const describeRoutes = (mode: Mode): string =>
  (['heavy', 'mid', 'fast'] as const)
    .map(t => {
      const r = routeFor(mode, t)
      return `  ${t}: ${r.model}${r.effort ? ` (${r.effort})` : ''}`
    })
    .join('\n')

export const HELP = [
  '/berserk [smart|advise|max|fable|full] [week|month|window|10m|2h|3d]',
  '  smart   opus bursts, sonnet/haiku routine (default)',
  '  advise  sonnet works, opus only plans and rescues',
  '  max     opus xhigh bursts',
  '  fable   Fable bursts (expensive, opt-in)',
  '  full    best of everything + workflows; asks first',
  '  week    until the weekly reset (default)',
  '  window  until the 5-hour reset (also: 5hour)',
  '  month   until the monthly reset (30 days if unknown)',
  '  2h / 2days / 2weeks    up to that long: stops early if the quota renews or hits 98%',
  '  1day 3windows          also stop after the third 5-hour quota window (also: 3x5hour)',
  '  2h exact             exactly that long, whatever the quota does',
  '  2h up to 3h            2h, and a running turn may finish by 3h',
  '  test    show what would happen, change nothing',
  '/berserk status | off | help',
].join('\n')

export const companionTriggers = (provider: 'codex' | 'copilot'): readonly string[] =>
  provider === 'codex' ? ['/berserk', '$berserk'] : ['/berserk']

export const matchTrigger = (
  triggers: readonly string[],
  line: string,
): { trigger: string; rest: string } | undefined => {
  const trigger = triggers.find(word => line === word || line.startsWith(`${word} `))
  return trigger ? { trigger, rest: line.slice(trigger.length) } : undefined
}
