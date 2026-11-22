import process from 'node:process'

import { copilotLimits } from '../hooks/logic.js'
import type { Interaction, Provider, Route } from './provider.js'

export const openCopilot = async (interaction: Interaction, model: string | undefined): Promise<Provider> => {
  const { CopilotClient } = await import('@microsoft/copilot-sdk')
  const client = new CopilotClient({ mode: 'coding-agent' })
  try {
    const auth = await client.getAuthStatus()
    if (!auth.isAuthenticated) throw new Error('Sign in with GitHub Copilot CLI first.')
    const catalog = await client.listModels()
    if (model && !catalog.some(entry => entry.id === model)) throw new Error(`Copilot model unavailable: ${model}`)
    const session = await client.createSession({
      ...(model ? { model } : {}),
      workingDirectory: process.cwd(),
      git: { coauthorEnabled: false },
      events: { streaming: true },
      permissions: {
        onRequest: async request => ({
          kind: await interaction.approve(JSON.stringify(request, null, 2)) ? 'approved' : 'denied-interactively-by-user',
        }),
      },
    })
    const current = await session.rpc.model.getCurrent()
    session.on('assistant.message_delta', event => interaction.output(event.data.deltaContent))
    const routeState: { current?: Route | undefined } = {}
    let interrupted = false
    return {
      defaultModel: current.modelId ?? model ?? '',
      defaultEffort: current.reasoningEffort,
      models: catalog.map(entry => ({ id: entry.id, efforts: entry.supportedReasoningEfforts ?? [] })),
      limits: async () => copilotLimits((await session.rpc.quota.refresh()).snapshots),
      async turn(prompt, route) {
        interrupted = false
        const target = route ?? { model: current.modelId ?? model ?? '', effort: current.reasoningEffort }
        const previous = routeState.current
        if ((route || previous) && target.model &&
          (previous?.model !== target.model || previous.effort !== target.effort)) {
          await session.setModel(target.model, target.effort ? { reasoningEffort: target.effort } : {})
        }
        routeState.current = route
        if (interrupted) return false
        return (await session.sendAndWait(prompt, 86_400_000)) !== undefined
      },
      async interrupt() {
        interrupted = true
        await session.abort()
      },
      close: async () => { await client.stop() },
    }
  } catch (error) {
    await client.stop()
    throw error
  }
}
