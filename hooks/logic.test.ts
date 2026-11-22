import { expect, test } from 'claude-code/testing'

import {
  DAY,
  FABLE,
  FALLBACK_MS,
  HOUR,
  MIN,
  agentModel,
  bandText,
  bar,
  cry,
  flicker,
  stage,
  computeUntil,
  codexLimits,
  copilotLimits,
  companionStopReason,
  companionTriggers,
  matchTrigger,
  companionWindow,
  turnEffort,
  describeRoutes,
  fmt,
  milestone,
  nudge,
  pace,
  parseArgs,
  parseDuration,
  routeFor,
  statusLine,
  stepTier,
  stopReason,
  tierAfter,
} from './logic.js'

test('Codex usage maps reported windows and ignores incomplete window durations', () => {
  const limits = codexLimits({
    primary: { usedPercent: 53, windowDurationMins: 300, resetsAt: 1720000000 },
    secondary: { usedPercent: 84, windowDurationMins: 10080, resetsAt: null },
  })
  expect(limits).toEqual([
    { kind: 'five_hour', percentUsed: 53, resetsAt: '2024-07-03T09:46:40.000Z' },
    { kind: 'seven_day', percentUsed: 84 },
  ])
  expect(codexLimits({ primary: { usedPercent: 31, windowDurationMins: null } })).toEqual([])
})

test('Copilot usage watches finite chat and premium quota even if overage is allowed', () => {
  const limits = copilotLimits({
    chat: { remainingPercentage: 2, resetDateEpochMs: 1720000000000 },
    completions: { remainingPercentage: 0 },
    'premium-interactions': { remainingPercentage: 0, isUnlimitedEntitlement: true },
    unsupported: { remainingPercentage: '5' },
  })
  expect(limits).toEqual([
    { kind: 'spend_limit', percentUsed: 98, resetsAt: '2024-07-03T09:46:40.000Z' },
  ])
  expect(stopReason(0, DAY, 'month', limits)).toBe('monthly quota is 98% used.')
})

test('turn routing selects only supported effort and escalates after failure', () => {
  const efforts = ['low', 'medium', 'high', 'xhigh']
  expect(turnEffort('advise', false, false, 'on', efforts)).toBe('low')
  expect(turnEffort('advise', false, true, 'on', efforts)).toBe('high')
  expect(turnEffort('max', true, false, 'on', ['low', 'medium'])).toBe('medium')
  expect(turnEffort('smart', true, false, 'on', [])).toBeUndefined()
})

test('a timed Copilot run ends at the first reported monthly reset', () => {
  const limits = copilotLimits({
    chat: { remainingPercentage: 50, resetDateEpochMs: 2 * HOUR },
    'premium-interactions': { remainingPercentage: 60, resetDateEpochMs: HOUR },
  })
  expect(companionWindow(0, 'copilot', 'custom', limits, { customMs: 3 * HOUR, hardMs: 4 * HOUR, exact: false }))
    .toEqual({ until: HOUR, hardUntil: HOUR, duration: 3 * HOUR })
  expect(companionWindow(0, 'copilot', 'custom', limits, { customMs: 3 * HOUR, hardMs: 4 * HOUR, exact: true }))
    .toEqual({ until: 3 * HOUR, hardUntil: 4 * HOUR, duration: 3 * HOUR })
})

test('companion mode stops at 98% on any known quota or when usage is unavailable', () => {
  expect(companionStopReason(0, HOUR, false, undefined)).toBe('quota unavailable')
  expect(companionStopReason(0, HOUR, false, [
    { kind: 'seven_day', percentUsed: 30 },
    { kind: 'five_hour', percentUsed: 98 },
  ])).toBe('5-hour quota reached 98%')
  expect(companionStopReason(0, HOUR, true, undefined)).toBeUndefined()
  expect(companionStopReason(HOUR, HOUR, true, undefined)).toBe('time window ended')
})

test('parseDuration reads m, h and d', () => {
  expect(parseDuration('10m')).toBe(10 * MIN)
  expect(parseDuration('2h')).toBe(2 * HOUR)
  expect(parseDuration('1.5d')).toBe(1.5 * DAY)
  expect(parseDuration('0m')).toBeUndefined()
  expect(parseDuration('soon')).toBeUndefined()
})

test('fmt shows the two largest units', () => {
  expect(fmt(5 * MIN)).toBe('5m')
  expect(fmt(90 * MIN)).toBe('1h 30m')
  expect(fmt(DAY + 3 * HOUR)).toBe('1d 3h')
  expect(fmt(-5)).toBe('0m')
})

test('parseArgs covers modes, windows, durations and eggs', () => {
  expect(parseArgs('off')).toEqual({ action: 'off' })
  expect(parseArgs('status')).toEqual({ action: 'status' })
  expect(parseArgs('?')).toEqual({ action: 'help' })
  expect(parseArgs('rage')).toEqual({ action: 'egg', egg: 'rage' })
  expect(parseArgs('full week')).toMatchObject({ action: 'start', mode: 'full', window: 'week', customMs: undefined })
  expect(parseArgs('max window')).toMatchObject({ mode: 'max', window: 'hours5' })
  expect(parseArgs('fable 10m')).toMatchObject({ mode: 'fable', window: 'custom', customMs: 10 * MIN })
  expect(parseArgs('')).toMatchObject({ action: 'start', mode: undefined, window: undefined, customMs: undefined })
})

test('routing: errors escalate, reads go fast, writes go mid', () => {
  expect(tierAfter('Bash', true, false, 'fast')).toBe('heavy')
  expect(tierAfter('Read', false, true, 'heavy')).toBe('fast')
  expect(tierAfter('Grep', false, false, 'heavy')).toBe('fast')
  expect(tierAfter('Edit', false, false, 'heavy')).toBe('mid')
  expect(tierAfter('Custom', false, false, 'mid')).toBe('mid')
  expect(stepTier(0, 'fast')).toBe('heavy')
  expect(stepTier(3, 'fast')).toBe('fast')
})

test('modes: Fable only in fable and full', () => {
  expect(routeFor('smart', 'heavy').model).toBe('opus')
  expect(routeFor('max', 'heavy').effort).toBe('xhigh')
  expect(routeFor('fable', 'heavy').model).toBe(FABLE)
  expect(routeFor('full', 'heavy')).toEqual({ model: FABLE, effort: 'max' })
  for (const t of ['heavy', 'mid', 'fast'] as const) {
    expect(routeFor('smart', t).model).not.toBe(FABLE)
    expect(routeFor('max', t).model).not.toBe(FABLE)
  }
  expect(agentModel('smart', 'Explore')).toBe('haiku')
  expect(agentModel('full', 'general-purpose')).toBe(FABLE)
})

test('nudge moves a tier by pace and clamps', () => {
  expect(nudge('mid', 'under')).toBe('heavy')
  expect(nudge('heavy', 'under')).toBe('heavy')
  expect(nudge('mid', 'over')).toBe('fast')
  expect(nudge('fast', 'over')).toBe('fast')
  expect(nudge('mid', 'on')).toBe('mid')
})

test('computeUntil: reset, custom, fallback', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const week = { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-01-03T00:00:00Z' }
  expect(computeUntil(now, 'week', undefined, [week])).toEqual({ until: now + 2 * DAY, basis: 'reset' })
  expect(computeUntil(now, 'custom', 10 * MIN, [week])).toEqual({ until: now + 10 * MIN, basis: 'custom' })
  expect(computeUntil(now, 'hours5', undefined, [week])).toEqual({ until: now + FALLBACK_MS, basis: 'fallback' })
  expect(computeUntil(now, 'week', undefined, [{ ...week, resetsAt: '2025-01-01T00:00:00Z' }]).basis).toBe('fallback')
})

test('stopReason: window end and 98% quota', () => {
  const now = 1000
  const week = { kind: 'seven_day', percentUsed: 99 }
  const five = { kind: 'five_hour', percentUsed: 10 }
  expect(stopReason(now, now, 'week', [])).toMatch(/window closed/)
  expect(stopReason(now, now + 1, 'week', [week, five])).toMatch(/weekly quota is 99%/)
  expect(stopReason(now, now + 1, 'hours5', [week, five])).toBeUndefined()
  expect(stopReason(now, now + 1, 'custom', [week, five])).toMatch(/weekly/)
})

test('pace compares quota used with time elapsed', () => {
  expect(pace(10, 2 * DAY, 4 * DAY)).toBe('under') // half gone, 10% used
  expect(pace(50, 2 * DAY, 4 * DAY)).toBe('on')
  expect(pace(90, 2 * DAY, 4 * DAY)).toBe('over')
})

test('looks: bar, status and band text', () => {
  expect(bar(50, 10)).toBe('█████░░░░░')
  expect(bar(150, 4)).toBe('████')
  expect(statusLine('smart', 90 * MIN, 40, 'heavy')).toContain('BERSERK SMART ▲ | 1h 30m left')
  expect(statusLine('full', MIN, undefined, 'fast')).not.toContain('%')
  expect(bandText('max', HOUR, 2 * HOUR, 20)).toContain('quota')
})

test('milestone fires once per ten percent', () => {
  expect(milestone(10, 15, 0)).toEqual({ shown: 0 })
  expect(milestone(10, 21, 0).shown).toBe(10)
  expect(milestone(10, 22, 10)).toEqual({ shown: 10 })
  expect(milestone(0, 95, 0).text).toMatch(/end is near/)
})

test('advise: Opus only on the heavy tier, Sonnet does the work, never Fable', () => {
  expect(routeFor('advise', 'heavy').model).toBe('opus')
  expect(routeFor('advise', 'mid')).toEqual({ model: 'sonnet', effort: 'high' })
  expect(routeFor('advise', 'fast').model).toBe('sonnet')
  expect(agentModel('advise', 'general-purpose')).toBe('sonnet')
  expect(agentModel('advise', 'Plan')).toBe('opus')
  expect(parseArgs('advise 2h')).toMatchObject({ mode: 'advise', window: 'custom' })
})

test('natural durations: "10min", "2 hours", "3 days"', () => {
  expect(parseArgs('10min')).toMatchObject({ window: 'custom', customMs: 10 * MIN })
  expect(parseArgs('10 minutes')).toMatchObject({ window: 'custom', customMs: 10 * MIN })
  expect(parseArgs('2 hours')).toMatchObject({ window: 'custom', customMs: 2 * HOUR })
  expect(parseArgs('smart 3 days')).toMatchObject({ mode: 'smart', customMs: 3 * DAY })
})

test('"5hour" means the 5-hour quota window, "5 hours" a fixed time', () => {
  expect(parseArgs('5hour')).toMatchObject({ window: 'hours5', customMs: undefined })
  expect(parseArgs('smart 5hour')).toMatchObject({ mode: 'smart', window: 'hours5' })
  expect(parseArgs('5 hour quota')).toMatchObject({ window: 'hours5' })
  expect(parseArgs('window')).toMatchObject({ window: 'hours5' })
  expect(parseArgs('5 hours')).toMatchObject({ window: 'custom', customMs: 5 * HOUR })
  expect(parseArgs('5h')).toMatchObject({ window: 'custom', customMs: 5 * HOUR })
})

test('week and month windows', () => {
  expect(parseArgs('week')).toMatchObject({ window: 'week' })
  expect(parseArgs('monthly')).toMatchObject({ window: 'month' })
  expect(parseArgs('smart')).toMatchObject({ mode: 'smart', window: undefined })
})

test('"2 hours up to 3 hours" sets a soft end and a hard cap', () => {
  expect(parseArgs('2 hours up to 3 hours')).toMatchObject({ customMs: 2 * HOUR, hardMs: 3 * HOUR })
  expect(parseArgs('2h-3h')).toMatchObject({ customMs: 2 * HOUR, hardMs: 3 * HOUR })
  expect(parseArgs('2h or more if not finished up to 3h')).toMatchObject({ customMs: 2 * HOUR, hardMs: 3 * HOUR })
  expect(parseArgs('2h')).toMatchObject({ customMs: 2 * HOUR, hardMs: undefined })
  expect(parseArgs('3h 2h')).toMatchObject({ customMs: 3 * HOUR, hardMs: undefined })
})

test('"test" is a dry run', () => {
  expect(parseArgs('test')).toMatchObject({ action: 'start', dry: true })
  expect(parseArgs('smart week')).toMatchObject({ dry: false })
})

test('month uses the spend limit and falls back to 30 days', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const spend = { kind: 'spend_limit', percentUsed: 5, resetsAt: '2026-01-11T00:00:00Z' }
  expect(computeUntil(now, 'month', undefined, [spend])).toEqual({ until: now + 10 * DAY, basis: 'reset' })
  expect(computeUntil(now, 'month', undefined, [])).toEqual({ until: now + 30 * DAY, basis: 'fallback' })
  expect(stopReason(now, now + 1, 'month', [{ ...spend, percentUsed: 99 }])).toMatch(/monthly quota is 99%/)
})

test('describeRoutes lists the three tiers', () => {
  expect(describeRoutes('smart')).toContain('heavy: opus (high)')
  expect(describeRoutes('full')).toContain(FABLE)
})

test('days, weeks and months: "2days", "2 weeks", "1.5w", "3 months"', () => {
  expect(parseArgs('2days')).toMatchObject({ window: 'custom', customMs: 2 * DAY })
  expect(parseArgs('2weeks')).toMatchObject({ window: 'custom', customMs: 14 * DAY })
  expect(parseArgs('smart 2 weeks')).toMatchObject({ mode: 'smart', customMs: 14 * DAY })
  expect(parseArgs('1.5w')).toMatchObject({ customMs: 10.5 * DAY })
  expect(parseArgs('3 months')).toMatchObject({ customMs: 90 * DAY })
  expect(parseArgs('2d up to 1 week')).toMatchObject({ customMs: 2 * DAY, hardMs: 7 * DAY })
  expect(parseArgs('week')).toMatchObject({ window: 'week', customMs: undefined })
})

test('a typed time is "up to": it ends at the weekly reset unless exact', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const week = { kind: 'seven_day', percentUsed: 40, resetsAt: '2026-01-03T00:00:00Z' }
  expect(computeUntil(now, 'custom', 5 * DAY, [week])).toEqual({ until: now + 2 * DAY, basis: 'reset' })
  expect(computeUntil(now, 'custom', 5 * DAY, [week], true)).toEqual({ until: now + 5 * DAY, basis: 'custom' })
  expect(computeUntil(now, 'custom', DAY, [week])).toEqual({ until: now + DAY, basis: 'custom' })
  expect(computeUntil(now, 'custom', DAY, [])).toEqual({ until: now + DAY, basis: 'custom' })
})

test('exact ignores the 98% stop; the default does not', () => {
  const week = { kind: 'seven_day', percentUsed: 99 }
  expect(stopReason(1000, 2000, 'custom', [week])).toMatch(/weekly/)
  expect(stopReason(1000, 2000, 'custom', [week], true)).toBeUndefined()
  expect(stopReason(2000, 2000, 'custom', [week], true)).toMatch(/window closed/)
})

test('"exact" and "fixed" set exact', () => {
  expect(parseArgs('2h exact')).toMatchObject({ customMs: 2 * HOUR, exact: true })
  expect(parseArgs('fixed 2h')).toMatchObject({ exact: true })
  expect(parseArgs('2h')).toMatchObject({ exact: false })
})

test('"3windows" and "3x5hour" stop after the third 5-hour window', () => {
  expect(parseArgs('1day 3windows')).toMatchObject({ window: 'custom', customMs: DAY, slots: 3 })
  expect(parseArgs('1day 3x5hour')).toMatchObject({ customMs: DAY, slots: 3 })
  expect(parseArgs('3 x 5 hours')).toMatchObject({ window: 'hours5', slots: 3 })
  expect(parseArgs('5hour')).toMatchObject({ window: 'hours5', slots: undefined })
  expect(parseArgs('1day')).toMatchObject({ slots: undefined })
})

test('slots end at the reset of the 5-hour window plus the rest, or the time if sooner', () => {
  const now = Date.parse('2026-01-01T00:00:00Z')
  const five = { kind: 'five_hour', percentUsed: 10, resetsAt: '2026-01-01T02:00:00Z' }
  // current window ends at +2h; the third ends at +12h
  expect(computeUntil(now, 'custom', DAY, [five], false, 3)).toEqual({ until: now + 12 * HOUR, basis: 'reset' })
  expect(computeUntil(now, 'custom', 6 * HOUR, [five], false, 3)).toEqual({ until: now + 6 * HOUR, basis: 'custom' })
  expect(computeUntil(now, 'custom', DAY, [five], true, 3)).toEqual({ until: now + 12 * HOUR, basis: 'reset' })
  expect(computeUntil(now, 'hours5', undefined, [five], false, 1)).toEqual({ until: now + 2 * HOUR, basis: 'reset' })
  expect(computeUntil(now, 'custom', DAY, [], false, 3)).toEqual({ until: now + 15 * HOUR, basis: 'fallback' })
})

test('rage stages climb with the quota burned', () => {
  expect(stage(0)).toBe('Simmering')
  expect(stage(30)).toBe('Raging')
  expect(stage(90)).toBe('Ragnarok')
  expect(stage(100)).toBe('VALHALLA')
})

test('the flame flickers and the battle cry rotates', () => {
  expect(flicker('smart', 0)).toBe('🔥')
  expect(flicker('smart', 1)).toBe('🌋')
  expect(cry(0)).not.toBe(cry(1))
  expect(cry(800)).toBeTruthy()
  expect(statusLine('smart', HOUR, 50, 'heavy', { burned: 30, beat: 1 })).toMatch(/🌋 BERSERK SMART .*Raging$/)
  expect(bandText('smart', HOUR, 2 * HOUR, 20, 0)).toContain(`« ${cry(0)} »`)
})

test('every egg word is recognised', () => {
  for (const e of ['ragnarok', 'thor', 'loki', 'freya', 'skol', 'coffee', '42']) {
    expect(parseArgs(e)).toEqual({ action: 'egg', egg: e })
  }
})

test('$berserk is a trigger on Codex only', () => {
  expect(companionTriggers('codex')).toEqual(['/berserk', '$berserk'])
  expect(companionTriggers('copilot')).toEqual(['/berserk'])
  expect(matchTrigger(companionTriggers('codex'), '$berserk max 2h')).toEqual({ trigger: '$berserk', rest: ' max 2h' })
  expect(matchTrigger(companionTriggers('codex'), '/berserk')).toEqual({ trigger: '/berserk', rest: '' })
  expect(matchTrigger(companionTriggers('copilot'), '$berserk max')).toBeUndefined()
  expect(matchTrigger(companionTriggers('codex'), '$berserkx')).toBeUndefined()
})
