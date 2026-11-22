import { spawn } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline'

import { codexLimits } from '../hooks/logic.js'
import type { Interaction, Provider } from './provider.js'

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined

export const openCodex = async (interaction: Interaction, model: string | undefined): Promise<Provider> => {
  const server = spawn('codex', ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map<number, {
    method: string
    resolve: (value: Record<string, unknown>) => void
    reject: (error: Error) => void
  }>()
  let sequence = 0
  let failure: Error | undefined
  let onEvent: (method: string, params: Record<string, unknown>) => void = () => undefined
  let rejectTurn: ((error: Error) => void) | undefined
  const fail = (error: Error) => {
    failure = error
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    rejectTurn?.(error)
  }
  server.on('error', fail)
  server.stdin.on('error', fail)
  server.on('close', code => fail(new Error(`Codex app server closed (${code ?? 'signal'}).`)))

  const send = (message: object) => { server.stdin.write(`${JSON.stringify(message)}\n`) }
  const request = (method: string, params?: object): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure)
        return
      }
      const id = ++sequence
      pending.set(id, { method, resolve, reject })
      send({ id, method, params })
    })

  const handleRequest = async (id: string | number, method: string, params: Record<string, unknown>) => {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const details = JSON.stringify(params, null, 2)
      const decision = await interaction.approve(`${method}\n${details}`) ? 'accept' : 'decline'
      send({ id, result: { decision } })
      return
    }
    send({ id, error: { code: -32601, message: `Unsupported client request: ${method}` } })
  }

  createInterface({ input: server.stdout }).on('line', line => {
    try {
      const parsed: unknown = JSON.parse(line)
      const message = record(parsed)
      const id = message['id']
      const method = string(message['method'])
      if (method) {
        if (typeof id === 'number' || typeof id === 'string') {
          void handleRequest(id, method, record(message['params'])).catch(fail)
        } else {
          onEvent(method, record(message['params']))
        }
      } else if (typeof id === 'number') {
        const operation = pending.get(id)
        pending.delete(id)
        if (message['error']) {
          const error = string(record(message['error'])['message']) ?? 'Request failed.'
          operation?.reject(new Error(`${operation.method}: ${error}`))
        } else {
          operation?.resolve(record(message['result']))
        }
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })

  try {
    await request('initialize', { clientInfo: { name: 'berserk', version: '0.2.0' } })
    send({ method: 'initialized' })
    const { data } = await request('model/list', {})
    const models = (Array.isArray(data) ? data : []).map((value: unknown) => {
      const entry = record(value)
      const options = entry['supportedReasoningEfforts']
      const efforts = (Array.isArray(options) ? options : []).flatMap((option: unknown) => {
        const effort = string(record(option)['reasoningEffort'])
        return effort ? [effort] : []
      })
      return { id: string(entry['model']) ?? '', efforts }
    }).filter(entry => entry.id)
    if (model && !models.some(entry => entry.id === model)) throw new Error(`Codex model unavailable: ${model}`)
    const thread = await request('thread/start', { cwd: process.cwd(), model, sandbox: 'workspace-write', approvalPolicy: 'on-request' })
    const threadId = string(record(thread['thread'])['id'])
    if (!threadId) throw new Error('Codex did not return a thread ID.')
    const defaultModel = string(thread['model']) ?? ''
    const defaultEffort = string(thread['reasoningEffort'])
    let turnId: string | undefined
    let interruptRequested = false
    const interrupt = async () => {
      if (interruptRequested) return
      interruptRequested = true
      if (turnId) await request('turn/interrupt', { threadId, turnId })
    }
    return {
      defaultModel,
      defaultEffort,
      models,
      async limits() {
        const response = await request('account/rateLimits/read')
        const buckets = record(response['rateLimitsByLimitId'])
        return codexLimits(buckets['codex'] ?? response['rateLimits'])
      },
      async turn(prompt, route) {
        interruptRequested = false
        const { promise: done, resolve: settle, reject } = Promise.withResolvers<boolean>()
        rejectTurn = reject
        // The server can emit the completion notification before the RPC response arrives.
        onEvent = (method, params) => {
          if (params['threadId'] !== threadId) return
          if (method === 'item/agentMessage/delta') interaction.output(string(params['delta']) ?? '')
          if (method === 'turn/started') {
            turnId = string(record(params['turn'])['id'])
            if (interruptRequested && turnId) void request('turn/interrupt', { threadId, turnId }).catch(fail)
          }
          if (method === 'turn/completed') {
            const result = record(params['turn'])
            const error = string(record(result['error'])['message'])
            if (error) interaction.output(`\n${error}\n`)
            settle(result['status'] === 'completed')
          }
        }
        try {
          const started = request('turn/start', {
            threadId, input: [{ type: 'text', text: prompt }],
            model: route?.model ?? (defaultModel || undefined),
            effort: route ? route.effort ?? null : defaultEffort,
          })
          const [, completed] = await Promise.all([started, done])
          return completed
        } finally {
          turnId = undefined
          rejectTurn = undefined
          onEvent = () => undefined
        }
      },
      interrupt,
      close: () => {
        server.kill()
        return Promise.resolve()
      },
    }
  } catch (error) {
    server.kill()
    throw error
  }
}
