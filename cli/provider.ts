import type { Limit } from '../hooks/logic.js'

export type Model = { id: string; efforts: readonly string[] }
export type Route = { model: string; effort: string | undefined }
export type Interaction = {
  approve: (description: string) => Promise<boolean>
  output: (text: string) => void
}

export interface Provider {
  defaultModel: string
  defaultEffort: string | undefined
  models: Model[]
  limits(): Promise<Limit[]>
  turn(prompt: string, route?: Route): Promise<boolean>
  interrupt(): Promise<void>
  close(): Promise<void>
}
