import { expect, test } from 'claude-code/testing'
import type { HookFor } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const NOW = Date.parse('2026-01-01T00:00:00Z')

type StubHooks = {
  (name: 'command.register', hook: HookFor<'command.register'>): void
  (name: 'session.start', hook: HookFor<'session.start'>): void
  (name: 'clock.now', hook: HookFor<'clock.now'>): void
  (name: 'clock.every', hook: HookFor<'clock.every'>): void
  (name: 'clock.after', hook: HookFor<'clock.after'>): void
  (name: 'session.usage', hook: HookFor<'session.usage'>): void
  (name: 'theme.set', hook: HookFor<'theme.set'>): void
  (name: 'theme.clear', hook: HookFor<'theme.clear'>): void
  (name: 'ui.status', hook: HookFor<'ui.status'>): void
  (name: 'ui.toast', hook: HookFor<'ui.toast'>): void
  (name: 'state.get', hook: HookFor<'state.get'>): void
  (name: 'state.set', hook: HookFor<'state.set'>): void
  (name: 'store.get', hook: HookFor<'store.get'>): void
  (name: 'store.set', hook: HookFor<'store.set'>): void
  (name: 'store.delete', hook: HookFor<'store.delete'>): void
}

function command($: Engine, args: string) {
  return $.command.run({
    command: 'berserk', args, origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })
}

function stub(on: StubHooks, kv: Map<string, unknown>, resets = true, used = 40) {
  on('command.register', () => ({ value: { command: 'berserk' } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: NOW }))
  // A resolved wait fires its callback. Keep the timers pending in command tests.
  const pendingTimer = new Promise<{ value: undefined }>(() => {})
  on('clock.every', () => pendingTimer)
  on('clock.after', () => pendingTimer)
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 100_000 },
      rateLimits: resets ? [{ kind: 'seven_day', percentUsed: used, resetsAt: '2026-01-03T00:00:00Z' }] : [],
    },
  }))
  on('theme.set', () => ({ value: { isDrawn: true, requestId: 'test' } }))
  on('theme.clear', () => ({ value: { isDrawn: false, reason: 'cleared' } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('state.get', () => ({ value: { value: null, version: 0 } }))
  on('state.set', () => ({ value: { isSet: true, version: 1 } }))
  on('store.get', (_$, e) => ({ value: kv.get(e.key) }))
  on('store.set', (_$, e) => {
    kv.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    kv.delete(e.key)
    return { value: undefined }
  })
}

test('/berserk smart week runs to the weekly reset', async ($, on) => {
  const kv = new Map<string, unknown>()
  stub(on, kv)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await command($, 'smart week')

  expect(r.text).toMatch(/BERSERK Smart/)
  expect(r.text).toMatch(/2d 0h/)
  expect(kv.get('berserk')).toMatchObject({ mode: 'smart' })
})

test('/berserk off clears it', async ($, on) => {
  const kv = new Map<string, unknown>()
  stub(on, kv)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await command($, 'max week')

  const r = await command($, 'off')

  expect(r.text).toBe('Berserk stopped.')
  expect(kv.has('berserk')).toBe(false)
})

test('a custom duration works without reset data', async ($, on) => {
  const kv = new Map<string, unknown>()
  stub(on, kv, false)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await command($, 'smart 10m')

  expect(r.text).toMatch(/Ends in 10m/)
})

test('help and eggs answer without starting berserk', async ($, on) => {
  const kv = new Map<string, unknown>()
  stub(on, kv)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  expect((await command($, 'help')).text).toMatch(/smart\|advise\|max\|fable\|full/)
  expect((await command($, 'odin')).text).toMatch(/Odin/)
  expect(kv.has('berserk')).toBe(false)
})

test('a start is refused when the window is at 98% or more', async ($, on) => {
  const kv = new Map<string, unknown>()
  stub(on, kv, true, 98)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await command($, 'smart week')

  expect(r.text).toMatch(/Refusing/)
  expect(kv.has('berserk')).toBe(false)
})

test('with no window typed, berserk defaults to the week', async ($, on) => {
  const kv = new Map<string, unknown>()
  stub(on, kv)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await command($, 'max')

  expect(kv.get('berserk')).toMatchObject({ window: 'week' })
  expect(r.text).toMatch(/2d 0h/)
})

test('"2 hours up to 3 hours" stores a hard cap', async ($, on) => {
  const kv = new Map<string, unknown>()
  stub(on, kv)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await command($, '2 hours up to 3 hours')

  expect(r.text).toMatch(/Ends in 2h 0m, up to 3h 0m/)
  expect(kv.get('berserk')).toMatchObject({ hardUntil: NOW + 3 * 3_600_000 })
})

test('test changes nothing', async ($, on) => {
  const kv = new Map<string, unknown>()
  stub(on, kv)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const r = await command($, 'max 10m test')

  expect(r.text).toMatch(/Test only, nothing changed/)
  expect(r.text).toMatch(/heavy: opus \(xhigh\)/)
  expect(kv.has('berserk')).toBe(false)
})

test('a typed time past the weekly reset ends at the reset; exact runs it all', async ($, on) => {
  const kv = new Map<string, unknown>()
  stub(on, kv)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const up = await command($, '5days')
  expect(up.text).toMatch(/Ends in 2d 0h/)
  await command($, 'off')

  const exact = await command($, '5days exact')
  expect(exact.text).toMatch(/Ends in 5d 0h/)
  expect(kv.get('berserk')).toMatchObject({ exact: true })
})
