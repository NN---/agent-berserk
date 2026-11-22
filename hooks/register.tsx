import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookFor, MatchedHook, Register, ThemeColor, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'
import {
  FALLBACK_MS,
  HELP,
  MIN,
  MODE_INFO,
  STOP_AT_PERCENT,
  WINDOW_MS,
  agentModel,
  bandText,
  computeUntil,
  describeRoutes,
  eggText,
  findLimit,
  fmt,
  limitName,
  milestone,
  nudge,
  pace,
  parseArgs,
  routeFor,
  statusLine,
  stepTier,
  stopReason,
  tierAfter,
  watchedLimits,
} from './logic.js'
import type { Limit, Mode, Tier, WindowKind } from './logic.js'

const line = atom({ plugin: 'berserk', key: 'line' } as const, null)

const { theme } = makeColors({
  label: 'Berserk ember',
  roles: { accent: '#ff5a1f', danger: '#e5252a', success: '#e8a317', warning: '#ffb020', pro: '#c2410c' },
  light: {
    gray: {
      anchors: {
        'surface-0': '#f6e3d6',
        'surface-1': '#fbede3',
        'surface-2': '#fff6ef',
        'text-primary': '#2a1410',
        'text-secondary': '#54281c',
        'text-muted': '#6a3a2c',
      },
    },
  },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#140a08',
        'surface-1': '#1a0d0a',
        'surface-2': '#1e0f0c',
        'surface-3': '#221210',
        'text-primary': '#ffe9dc',
        'text-secondary': '#f0c9b4',
        'text-muted': '#c79a84',
      },
    },
  },
})

const GLOW: Record<Mode, readonly ThemeColor[]> = {
  smart: ['#3a1208', '#140a08'],
  advise: ['#102a3a', '#0a1218'],
  max: ['#5a1606', '#1a0806'],
  fable: ['#2d1450', '#120a1c'],
  full: ['#7a0c0c', '#200404'],
}

type Saved = {
  mode: Mode
  window: WindowKind
  until: number
  hardUntil?: number | undefined
  exact?: boolean | undefined
  startedAt: number
  startPct: number
  themed: boolean
}

// Module-level state; a reload starts it over and session.start restores it from the store.
let active: Saved | undefined
let tier: Tier = 'heavy'
let pct: number | undefined
let limits: Limit[] = []
let busy = false
let extended = false
let warned = false
let shown = 0
let tick: { cancel: () => void } | undefined
let end: { cancel: () => void } | undefined

const SYSTEM: Record<Mode, string> = {
  advise:
    'Berserk ADVISE mode is on: a smaller model does the routine work and a stronger one steps in only for planning and failures. Make small verified steps, and state plainly when a problem needs deeper thought.',
  smart:
    'Berserk mode is on: the user wants to finish current work quickly before the quota window resets. Be decisive, batch independent tool calls, and skip optional commentary.',
  max: 'Berserk MAX mode is on: finish the current work quickly before the quota resets. Think hard on hard parts, batch independent tool calls in parallel, and skip optional commentary.',
  fable:
    'Berserk FABLE mode is on: finish the current work quickly before the quota resets. Batch independent tool calls in parallel and skip optional commentary.',
  full: 'Berserk FULL mode is on and the user has explicitly confirmed it: use the strongest reasoning, prefer the Workflow tool and parallel subagents for independent work, and verify results. Finish the current work quickly before the quota resets.',
}

async function load($: EngineInterface): Promise<Saved | undefined> {
  const v = (await $.store.get('berserk')) as Saved | undefined
  return v && typeof v.until === 'number' && v.mode in MODE_INFO ? v : undefined
}

async function sample($: EngineInterface): Promise<void> {
  const u = await $.session.usage()
  limits = u.rateLimits
}

function left(now: number): number {
  return active ? active.until - now : 0
}

/** The soft end, or the hard cap while a turn is still running past it. */
function endsAt(now: number): number {
  if (!active) return 0
  return active.hardUntil !== undefined && busy && now >= active.until ? active.hardUntil : active.until
}

let beat = 0

async function paint($: EngineInterface): Promise<void> {
  if (!active) {
    $.ui.status(undefined)
    await update($, line, () => null)
    return
  }
  const now = await $.clock.now()
  const total = active.until - active.startedAt
  const burned = pct === undefined ? 0 : Math.max(0, pct - active.startPct)
  $.ui.status(statusLine(active.mode, left(now), pct, tier, { burned, beat }))
  await update($, line, () => bandText(active ? active.mode : 'smart', left(now), total, pct, beat))
}

function pctFor(window: WindowKind): number | undefined {
  const kind = window === 'hours5' ? 'five_hour' : window === 'week' ? 'seven_day' : window === 'month' ? 'spend_limit' : undefined
  return kind === undefined ? undefined : findLimit(limits, kind)?.percentUsed
}

async function finish($: EngineInterface, why: string): Promise<void> {
  tick?.cancel()
  end?.cancel()
  tick = undefined
  end = undefined
  const was = active
  active = undefined
  await $.store.delete('berserk')
  if (was?.themed) await $.theme.clear()
  await paint($)
  const burned = pct !== undefined && was ? Math.max(0, Math.round(pct - was.startPct)) : undefined
  const report = burned === undefined ? '' : ` Burned ${burned}% over ${fmt((await $.clock.now()) - (was?.startedAt ?? 0))}.`
  $.ui.toast(`Berserk over: ${why}${report}`)
}

async function onTick($: EngineInterface): Promise<void> {
  if (!active) return
  await sample($)
  beat += 1
  const now = await $.clock.now()
  pct = pctFor(active.window)
  const why = stopReason(now, endsAt(now), active.window, limits, active.exact === true)
  if (why) {
    await finish($, why)
    return
  }
  if (!warned && left(now) <= 15 * MIN && active.until - active.startedAt > 30 * MIN) {
    warned = true
    $.ui.toast(`Berserk ends in ${fmt(left(now))}. Wrap up.`)
  }
  if (pct !== undefined) {
    const m = milestone(active.startPct, pct, shown)
    shown = m.shown
    if (m.text) $.ui.toast(m.text)
    const w = active.window === 'custom' ? 'week' : active.window
    const p = pace(pct, left(now), WINDOW_MS[w])
    tier = active.mode === 'advise' && p === 'under' ? tier : nudge(tier, p)
  }
  await paint($)
}

async function onWindowEnd($: EngineInterface): Promise<void> {
  if (!active) return
  const now = await $.clock.now()
  if (active.hardUntil !== undefined && busy && now < active.hardUntil) {
    if (!extended) {
      extended = true
      $.ui.toast(`Work still running: berserk extends until ${fmt(active.hardUntil - now)} from now at most.`)
    }
    end = $.clock.after(MIN, () => void onWindowEnd($))
    return
  }
  await finish($, 'the window closed.')
}

async function startTimers($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  tick?.cancel()
  end?.cancel()
  if (!active) return
  tick =$.clock.every(MIN, () => void onTick($))
  end = $.clock.after(Math.max(0, active.until - now), () => void onWindowEnd($))
}

async function look($: EngineInterface, mode: Mode): Promise<boolean> {
  const args: ThemeSetArgs = { colors: theme, backdrop: { gradient: { shape: 'radial', stops: GLOW[mode] } } }
  const set = await $.theme.set(args)
  if (!set.isDrawn) $.ui.status(set.reason)
  return set.isDrawn
}

async function activate(
  $: EngineInterface,
  mode: Mode,
  window: WindowKind,
  customMs: number | undefined,
  hardMs: number | undefined,
  exact: boolean,
  slots: number | undefined,
): Promise<string> {
  await sample($)
  const now = await $.clock.now()
  const hot = exact ? undefined : watchedLimits(window, limits).find(l => l.percentUsed >= STOP_AT_PERCENT)
  if (hot) return `Refusing: ${limitName(hot.kind)} quota is already ${hot.percentUsed}% used.`
  const { until, basis } = computeUntil(now, window, customMs, limits, exact, slots)
  const startPct = pctFor(window) ?? limits[0]?.percentUsed ?? 0
  const themed = await look($, mode)
  active = { mode, window, until, hardUntil: hardMs === undefined ? undefined : now + hardMs, exact, startedAt: now, startPct, themed }
  tier = 'heavy'
  pct = pctFor(window)
  warned = false
  extended = false
  shown = 0
  await $.store.set('berserk', active)
  await startTimers($)
  await paint($)
  const note = basis === 'fallback' ? ` (reset unknown, using ${fmt(FALLBACK_MS)})` : ''
  const cap = hardMs === undefined ? '' : `, up to ${fmt(hardMs)} if work is still running`
  return `BERSERK ${MODE_INFO[mode].label}: ${MODE_INFO[mode].blurb}. Ends in ${fmt(until - now)}${cap}${note}. /berserk off to stop.`
}

async function chooseMode($: EngineInterface): Promise<Mode | undefined> {
  const labels = ['Smart (recommended)', 'Advise (Sonnet works, Opus advises)', 'Max', 'Fable (expensive)']
  const a = await $.ui.ask('Which berserk? (Other: type full)', labels)
  const i = labels.indexOf(a)
  if (i >= 0) return (['smart', 'advise', 'max', 'fable'] as const)[i]
  const typed = parseArgs(a)
  return typed.action === 'start' ? typed.mode : undefined
}

async function dryRun(
  $: EngineInterface,
  mode: Mode,
  window: WindowKind,
  customMs: number | undefined,
  hardMs: number | undefined,
  exact: boolean,
  slots: number | undefined,
): Promise<string> {
  await sample($)
  const now = await $.clock.now()
  const { until, basis } = computeUntil(now, window, customMs, limits, exact, slots)
  const cap = hardMs === undefined ? '' : ` (up to ${fmt(hardMs)} if work is still running)`
  return `Test only, nothing changed. BERSERK ${MODE_INFO[mode].label} would end in ${fmt(until - now)}${cap}, basis: ${basis}.\n${describeRoutes(mode)}`
}

async function run($: EngineInterface, args: string): Promise<string> {
  const p = parseArgs(args)
  if (p.action === 'help') return HELP
  if (p.action === 'egg') return eggText(p.egg)
  if (p.action === 'off') {
    if (!active) return 'Berserk is not on.'
    await finish($, 'stopped by you.')
    return 'Berserk stopped.'
  }
  if (p.action === 'status') {
    if (!active) return 'Berserk is off.'
    return statusLine(active.mode, left(await $.clock.now()), pct, tier)
  }
  if (active) return `Berserk already on (${MODE_INFO[active.mode].label}). /berserk off first.`
  const bare = args.trim() === ''
  const mode = p.mode ?? (bare ? await chooseMode($) : 'smart')
  if (!mode) return 'Cancelled.'
  if (mode === 'full') {
    const a = await $.ui.ask('FULL berserk: Fable at max effort, workflows and parallel agents. It burns quota fast. Continue?', [
      'Yes, unleash it',
      'Cancel',
    ])
    if (a !== 'Yes, unleash it') return 'Cancelled. Probably wise.'
  }
  const window = p.window ?? 'week'
  if (p.dry) return dryRun($, mode, window, p.customMs, p.hardMs, p.exact, p.slots)
  return activate($, mode, window, p.customMs, p.hardMs, p.exact, p.slots)
}

// Concrete signatures keep promise linting from expanding the engine's generic matchers.
type BerserkHooks = {
  (event: 'session.start', hook: HookFor<'session.start'>): void
  (event: 'command.run', matcher: { command: 'berserk' }, hook: MatchedHook<'command.run', { command: 'berserk' }>): void
  (event: 'session.measure', hook: HookFor<'session.measure'>): void
  (event: 'prompt.compose', hook: HookFor<'prompt.compose'>): void
  (event: 'tool.call', hook: HookFor<'tool.call'>): void
  (event: 'turn.start', hook: HookFor<'turn.start'>): void
  (event: 'turn.complete', hook: HookFor<'turn.complete'>): void
  (event: 'turn.step', hook: HookFor<'turn.step'>): void
  (event: 'agent.spawn', hook: HookFor<'agent.spawn'>): void
  (event: 'ui.render', matcher: { component: 'AbovePrompt' }, hook: MatchedHook<'ui.render', { component: 'AbovePrompt' }>): void
}

export const register: Register = (on: BerserkHooks) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'berserk', description: 'Burn leftover quota: /berserk [smart|max|fable|full] [week|window|10m|2h|3d]' })
    const saved = await load($)
    if (saved) {
      const now = await $.clock.now()
      if (saved.until > now) {
        active = saved
        tier = 'heavy'
        await sample($)
        pct = pctFor(saved.window)
        await startTimers($)
        if (saved.themed) await look($, saved.mode)
        await paint($)
      } else {
        await $.store.delete('berserk')
        if (saved.themed) await $.theme.clear()
      }
    }
    return next(e)
  })

  on('command.run', { command: 'berserk' }, async ($, e) => ({ text: await run($, e.args) }))

  on('session.measure', (_$, e, next) => {
    limits = e.rateLimits
    if (active) pct = pctFor(active.window)
    return next(e)
  })

  on('prompt.compose', async (_$, e, next) => {
    const r = await next(e)
    if (!active) return r
    const sections = r.sections.filter(s => s.id !== 'berserk:mode')
    return { sections: [...sections, { id: 'berserk:mode', text: SYSTEM[active.mode], scope: 'session' as const }] }
  })

  on('tool.call', async (_$, e, next) => {
    const r = await next(e)
    if (active && r.deny === undefined) {
      tier = tierAfter(e.tool, r.isError === true, r.isReadOnly === true, tier)
    }
    return r
  })

  on('turn.start', (_$, e, next) => {
    if (e.agentId === undefined) busy = true
    if (active && e.agentId === undefined) tier = 'heavy'
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) busy = false
    if (active && (await $.clock.now()) >= active.until) await finish($, 'the window closed.')
    return next(e)
  })

  on('turn.step', async function* (_$, e, next) {
    if (!active) return yield* next(e)
    const r = routeFor(active.mode, stepTier(e.index, tier))
    return yield* next({ ...e, model: r.model, ...(r.effort ? { effort: r.effort } : {}) })
  })

  on('agent.spawn', (_$, e, next) => (active ? next({ ...e, model: agentModel(active.mode, e.subagentType) }) : next(e)))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, line)
    if (e.props.hasSurvey || text === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text color="accent" bold>
          {text}
        </Text>
      </Box>
    )
  })
}
