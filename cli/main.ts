import process from 'node:process'
import { createInterface } from 'node:readline/promises'

import {
  companionStopReason, companionTriggers, companionWindow, fmt, matchTrigger, limitName, pace, parseArgs, turnEffort,
} from '../hooks/logic.js'
import type { Limit } from '../hooks/logic.js'
import { openCodex } from './codex.js'
import { openCopilot } from './copilot.js'
import type { Provider, Route } from './provider.js'

type Active = {
  mode: 'smart' | 'advise' | 'max'
  until: number
  hardUntil: number
  duration: number
  exact: boolean
  first: boolean
  failed: boolean
}

const help = `Usage: node <path-to-repo>/dist/cli/main.js <codex|copilot> [--model ID] [--heavy-model ID] [--prompt TEXT] [Berserk arguments]
Example: node dist/cli/main.js codex smart 30m

Type a prompt to run a turn. Commands:
  /berserk [smart|advise|max] [week|5hour|month|30m] [test]
  /berserk status | off | help
  /exit
On Codex, $berserk works the same as /berserk.
Use "exact" for a fixed duration or "2h up to 3h" for a soft deadline and hard cap.
Default reset window: weekly on Codex, monthly on Copilot.`

const quotaText = (limits: readonly Limit[]): string => limits.length
  ? limits.map(limit => `${limitName(limit.kind)} ${Math.round(limit.percentUsed)}%`).join(', ')
  : 'usage unavailable'

const run = async () => {
  const [, , name, ...args] = process.argv
  if (!name || name === '--help' || name === '-h') {
    console.log(help)
    return
  }
  if (name !== 'codex' && name !== 'copilot') throw new Error('Choose codex or copilot.')
  const options = new Map<string, string>()
  const initial: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--model' || arg === '--heavy-model' || arg === '--prompt') {
      const value = args[++index]
      if (!value || (arg !== '--prompt' && value.startsWith('-'))) throw new Error(`Missing value for ${arg}.`)
      options.set(arg, value)
    } else if (arg?.startsWith('--') && arg !== '--help') {
      throw new Error(`Unknown option: ${arg}`)
    } else if (arg) {
      initial.push(arg)
    }
  }
  if (initial.includes('--help')) {
    console.log(help)
    return
  }
  const interactive = process.stdin.isTTY === true
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: interactive })
  const output = (text: string) => { process.stdout.write(text) }
  let closed = false
  let provider: Provider | undefined
  let active: Active | undefined
  let busy = false
  let approval = new AbortController()
  let approvalQueue = Promise.resolve(false)
  let deadline: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    active = undefined
    clearTimeout(deadline)
  }
  const stop = () => {
    approval.abort()
    if (busy) {
      void provider?.interrupt().catch((error: unknown) => { console.error(error) })
    } else {
      input.close()
    }
  }
  input.on('close', () => { closed = true })
  input.on('SIGINT', stop)
  process.on('SIGINT', stop)
  try {
    const approve = (description: string) => {
      const signal = approval.signal
      approvalQueue = approvalQueue.then(async () => {
        if (!interactive || closed || signal.aborted) return false
        console.log(`\n${description}`)
        try {
          return /^y(?:es)?$/i.test((await input.question('Approve once? [y/N] ', { signal })).trim())
        } catch {
          return false
        }
      })
      return approvalQueue
    }
    const open = name === 'codex' ? openCodex : openCopilot
    const engine = await open({ approve, output }, options.get('--model'))
    provider = engine
    const heavy = options.get('--heavy-model')
    if (heavy && !engine.models.some(model => model.id === heavy)) throw new Error(`Model unavailable: ${heavy}`)
    if ([engine.defaultModel, heavy].some(model => model && /fable/i.test(model))) {
      throw new Error('Choose a model other than Fable with --model or --heavy-model.')
    }
    const limits = async (): Promise<Limit[] | undefined> => {
      try {
        return await engine.limits()
      } catch {
        return undefined
      }
    }
    const finish = (reason: string) => {
      clear()
      console.log(`Berserk off: ${reason}.`)
    }
    const schedule = (current: Active, when: number) => {
      clearTimeout(deadline)
      deadline = setTimeout(() => {
        if (active !== current) return
        if (Date.now() < when) {
          schedule(current, when)
        } else if (busy && when < current.hardUntil) {
          schedule(current, current.hardUntil)
        } else {
          if (busy) {
            approval.abort()
            void engine.interrupt().catch((error: unknown) => { console.error(error) })
          }
          finish('time window ended')
        }
      }, Math.min(when - Date.now(), 2_147_483_647))
      deadline.unref()
    }
    const command = async (raw: string) => {
      const args = parseArgs(raw)
      if (args.action === 'help') {
        console.log(help)
        return
      }
      if (args.action === 'off') {
        finish('disabled')
        return
      }
      if (args.action === 'egg') {
        console.log('Use /berserk help for supported commands.')
        return
      }
      const usage = await limits()
      const now = Date.now()
      if (args.action === 'status') {
        console.log(active ? `Berserk ${active.mode} | ${fmt(active.until - now)} left | ${quotaText(usage ?? [])}`
          : `Berserk off | ${quotaText(usage ?? [])}`)
        return
      }
      const mode = args.mode ?? 'smart'
      if (mode === 'fable' || mode === 'full') throw new Error('Use smart, advise, or max with Codex and Copilot.')
      if (args.exact && !args.customMs) throw new Error('Exact mode needs a duration.')
      if (name === 'copilot' && args.slots !== undefined) throw new Error('Five-hour limits are only available on Codex.')
      const window = args.window ?? (name === 'codex' ? 'week' : 'month')
      const kind = window === 'week' ? 'seven_day' : window === 'hours5' ? 'five_hour' : 'spend_limit'
      if (window !== 'custom' && !usage?.some(limit => limit.kind === kind)) {
        throw new Error(`No reported ${limitName(kind)} quota. Use a fixed duration if appropriate.`)
      }
      const timing = companionWindow(now, name, window, usage ?? [], args)
      const { until } = timing
      const next: Active = {
        ...timing, mode, exact: args.exact, first: true, failed: false,
      }
      const reason = companionStopReason(now, until, next.exact, usage)
      if (reason) throw new Error(`Berserk cannot start: ${reason}.`)
      console.log(`${args.dry ? 'Dry run' : 'Berserk on'} | ${mode} | ${fmt(until - now)} | ${quotaText(usage ?? [])}`)
      if (!args.dry) {
        active = next
        schedule(next, until)
      }
    }
    const triggers = companionTriggers(name)
    const runTurn = async (prompt: string) => {
      let route: Route | undefined
      if (active) {
        const usage = await limits()
        const now = Date.now()
        const current = active
        if (current) {
          const reason = companionStopReason(now, current.until, current.exact, usage)
          if (reason) {
            finish(reason)
          } else {
            const percent = Math.max(0, ...(usage ?? []).map(limit => limit.percentUsed))
            const pacing = pace(percent, current.until - now, current.duration)
            const model = ((current.mode !== 'advise' && pacing === 'under') || current.first || current.failed)
              ? heavy ?? engine.defaultModel
              : engine.defaultModel
            const efforts = engine.models.find(entry => entry.id === model)?.efforts ?? []
            const effort = turnEffort(current.mode, current.first, current.failed, pacing, efforts)
            if (model) route = { model, effort }
          }
        }
      }
      const current = active
      approval = new AbortController()
      busy = true
      let success = false
      try {
        success = await engine.turn(prompt, route)
      } finally {
        busy = false
        approval.abort()
        output('\n')
        if (current && active === current) {
          current.first = false
          current.failed = !success
          const usage = await limits()
          if (active === current) {
            const reason = companionStopReason(Date.now(), current.until, current.exact, usage)
            if (reason) finish(reason)
          }
        }
      }
    }
    if (initial.length) {
      await command(initial.join(' '))
      if (!active) return
    }
    const prompt = options.get('--prompt')
    if (prompt) {
      await runTurn(prompt)
      return
    }
    console.log(`Berserk for ${name}. Type ${triggers.join(' or ')} help for commands.`)
    if (!interactive) throw new Error('Run this command in a terminal to enter prompts.')
    while (!closed) {
      let line: string
      try {
        line = (await input.question('> ')).trim()
      } catch (error) {
        if (closed) break
        throw error
      }
      if (!line) continue
      if (line === '/exit') break
      try {
        const matched = matchTrigger(triggers, line)
        if (matched) {
          await command(matched.rest)
        } else {
          await runTurn(line)
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    clear()
    input.close()
    process.off('SIGINT', stop)
    await provider?.close()
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
