export type Trigger =
  | { kind: 'manual' }
  | { kind: 'model' }
  | { kind: 'chained'; from: string }
  | { kind: 'subagent'; agentType: string }
  | { kind: 'hook'; event: string }

export type Activation = {
  id: number
  at: number
  name: string
  plugin?: string
  source: 'skill' | 'mcp' | 'hook'
  trigger: Trigger
  loop: string
  turnId?: string
  injected: number
  steps: number
  isCompacted: boolean
  /** Real cost in input-token equivalents: cache writes 2x, reads at the model's ratio. */
  effective: number
  /** The part of `effective` paid as cache writes (first request, cache misses). */
  written: number
  /** Real cost in dollars (models with a known price only). */
  dollars: number
  /** False once a step ran on a model with no known price. */
  isPriced: boolean
}

export type SortMode = 'time' | 'cumulative'

declare module 'claude-code' {
  interface PluginState {
    'skill-trace': { activations: Activation[]; sort: SortMode }
  }
}
