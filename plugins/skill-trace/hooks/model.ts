import type { Activation, SortMode, Trigger } from '../types'

export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5)

export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n)
  if (n < 9950) return `${(n / 1000).toFixed(1)}k`
  if (n < 999_500) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

const MCP_PLUGIN = /^mcp__plugin_([^_]+)_(.+?)__(.+)$/

export const parseMcpTool = (tool: string) => {
  const m = MCP_PLUGIN.exec(tool)
  return m ? { plugin: m[1], server: m[2], tool: m[3] } : undefined
}

export const pluginOf = (skill: string): string | undefined =>
  skill.includes(':') ? skill.split(':')[0] : undefined

export const shortName = (skill: string): string => skill.split(':').pop() ?? skill

export const matchesCommand = (skill: string, command: string | undefined): boolean =>
  command !== undefined && (command === skill || command === shortName(skill))

export const classifyTrigger = (a: {
  skill: string
  manualCommand?: string
  pendingAgentId?: string
  agentType?: string
  activeInTurn?: string
}): Trigger => {
  if (matchesCommand(a.skill, a.manualCommand)) return { kind: 'manual' }
  if (a.pendingAgentId !== undefined) return { kind: 'subagent', agentType: a.agentType ?? 'subagent' }
  if (a.activeInTurn !== undefined) return { kind: 'chained', from: a.activeInTurn }
  return { kind: 'model' }
}

const snippet = (text: string, max = 40): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max)}…`
}

// The API names the hook's event, never the hook: name it from what it injected.
export const guessHookName = (text: string, event: string): string => {
  const named = /'([a-z0-9-]+:[a-z0-9-]+)' skill/.exec(text)?.[1] ?? /^name:\s*([\w:-]+)\s*$/m.exec(text)?.[1]
  if (named) return named
  const s = snippet(text)
  return s ? `"${s}"` : `Hook (${event})`
}

export const pruneEmptyHooks = (list: Activation[]): Activation[] =>
  list.filter(a => !(a.source === 'hook' && a.injected === 0))

export const triggerLabel = (t: Trigger): string => {
  switch (t.kind) {
    case 'manual': return 'Manual'
    case 'model': return 'Model'
    case 'chained': return `Chained ← ${shortName(t.from)}`
    case 'subagent': return `Subagent (${t.agentType})`
    case 'hook': return `Hook (${t.event})`
  }
}

// Cache prices relative to a regular input token (claude-api skill, 2026-09).
// Claude Code writes with the 1-hour TTL: 2x. Order matters: 5-5 before 5.
const WRITE = 2
const PRICES: Array<[RegExp, number, number]> = [
  [/fable-5-1|mythos-5-1/, 10, 0.025],
  [/fable-5|mythos-5/, 10, 0.1],
  [/opus-5-5/, 4, 0.05],
  [/opus-(5|4-[5-8])/, 5, 0.1],
  [/sonnet-5-5|sonnet-5/, 2, 0.1],
  [/sonnet-4/, 3, 0.1],
  [/haiku-4-5/, 1, 0.1],
]

export const modelPricing = (model: string): { inputPerM: number | undefined; readRatio: number } => {
  const hit = PRICES.find(([re]) => re.test(model))
  return hit ? { inputPerM: hit[1], readRatio: hit[2] } : { inputPerM: undefined, readRatio: 0.1 }
}

type CacheUsage = { cache_read_input_tokens: number; cache_creation_input_tokens: number }

// More written than read: the context was rewritten (TTL expired, model or tools changed).
export const isCacheMiss = (usage: CacheUsage | null | undefined): boolean =>
  !!usage && usage.cache_creation_input_tokens > usage.cache_read_input_tokens

export type StepInfo = { model: string; isMiss: boolean }

export const applyStep = (list: Activation[], loop: string, step: StepInfo = { model: '', isMiss: false }): Activation[] => {
  const { inputPerM, readRatio } = modelPricing(step.model)
  return list.map(a => {
    if (a.loop !== loop || a.isCompacted) return a
    const isWrite = a.steps === 0 || step.isMiss
    const cost = a.injected * (isWrite ? WRITE : readRatio)
    return {
      ...a,
      steps: a.steps + 1,
      effective: (a.effective ?? 0) + cost,
      written: (a.written ?? 0) + (isWrite ? cost : 0),
      dollars: (a.dollars ?? 0) + (inputPerM ? (cost * inputPerM) / 1e6 : 0),
      isPriced: (a.isPriced ?? true) && inputPerM !== undefined,
    }
  })
}

export const formatDollars = (n: number): string => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)

export const applyCompaction = (list: Activation[], loop: string): Activation[] =>
  list.map(a => (a.loop === loop ? { ...a, isCompacted: true } : a))

export const activeInTurn = (list: Activation[], loop: string, turnId: string | undefined) =>
  turnId === undefined
    ? undefined
    : [...list].reverse().find(a => a.loop === loop && a.turnId === turnId && a.source === 'skill')?.name

export const cumulative = (a: Activation): number => a.injected * a.steps

export const sortRows = (list: Activation[], mode: SortMode): Activation[] =>
  mode === 'time' ? [...list].sort((a, b) => a.id - b.id) : [...list].sort((a, b) => (b.effective ?? 0) - (a.effective ?? 0))

export const totals = (list: Activation[]) => {
  const main = list.filter(a => a.loop === 'main')
  return {
    count: main.length,
    injected: main.reduce((s, a) => s + a.injected, 0),
    cumulative: main.reduce((s, a) => s + cumulative(a), 0),
    effective: main.reduce((s, a) => s + (a.effective ?? 0), 0),
    dollars: main.reduce((s, a) => s + (a.dollars ?? 0), 0),
    isPriced: main.every(a => a.isPriced ?? true),
  }
}

export const statusText = (list: Activation[]): string => {
  const t = totals(list)
  if (t.count === 0) return '🧩 0 activation'
  return `🧩 ${t.count} activation${t.count > 1 ? 's' : ''} · ≈${formatTokens(t.injected)} injected · ≈${formatTokens(t.cumulative)} reread`
}

const cellText = (s: string) => s.replace(/\|/g, '\\|')
export const clockTime = (ms: number) => new Date(ms).toTimeString().slice(0, 5)

export const tableMarkdown = (list: Activation[], mode: SortMode): string => {
  if (list.length === 0) return '_No activations yet._'
  const rows = sortRows(list, mode).map(a => {
    const em = (s: string) => (a.loop === 'main' ? s : `_${s}_`)
    const steps = a.isCompacted ? `${a.steps} compacted` : String(a.steps)
    return `| ${clockTime(a.at)} | ${em(cellText(a.name))} | ${em(cellText(triggerLabel(a.trigger)))} | ≈${formatTokens(a.injected)} | ${steps} | ≈${formatTokens(cumulative(a))} | ≈${formatTokens(Math.round(a.effective ?? 0))} |`
  })
  const t = totals(list)
  return [
    '| Time | Skill / plugin | Trigger | Injected | Requests | Reread | Real cost |',
    '|---|---|---|--:|--:|--:|--:|',
    ...rows,
    `| | **Total (main session)** | | **≈${formatTokens(t.injected)}** | | **≈${formatTokens(t.cumulative)}** | **≈${formatTokens(Math.round(t.effective))} (${t.isPriced ? formatDollars(t.dollars) : '$?'})** |`,
  ].join('\n')
}

// Rows recorded before real costs existed: no per-step model history, so one
// write plus reads at the generic ratio, left unpriced.
export const withRealCost = (list: Activation[]): Activation[] =>
  list.map(a => {
    const firstWrite = a.steps === 0 ? 0 : a.injected * WRITE
    if (a.effective === undefined)
      return { ...a, effective: a.steps === 0 ? 0 : firstWrite + a.injected * 0.1 * (a.steps - 1), written: firstWrite, dollars: 0, isPriced: false }
    return a.written === undefined ? { ...a, written: firstWrite } : a
  })

// A nonzero cost always shows at least one block, so small rows stay visible.
export const costBar = (value: number, max: number, width: number): string => {
  const filled = max <= 0 || value <= 0 || width <= 0 ? 0 : Math.min(width, Math.max(1, Math.round((value / max) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const TRIGGER_COLORS: Record<Trigger['kind'], string> = {
  manual: '#2a78d6',
  model: '#1baf7a',
  chained: '#6250d6',
  subagent: '#eda100',
  hook: '#898781',
}

export const triggerColor = (kind: Trigger['kind']): string => TRIGGER_COLORS[kind]

// The bar is a share of the session's total real cost, so the rows add up to 100 %.
export const shareLabel = (value: number, total: number, width: number): string => {
  const share = total > 0 && value > 0 ? value / total : 0
  const pct = share === 0 ? '0' : share < 0.01 ? '<1' : String(Math.round(share * 100))
  return `${costBar(value, total, width)} ${pct}% of total cost`
}

export const writeShare = (a: Activation): number =>
  (a.effective ?? 0) > 0 ? Math.min(1, (a.written ?? 0) / a.effective) : 0

// Same track for every row (100 % = the session's total real cost). The segment
// is this row's share; inside it, solid = cache writes, hatched = rereads.
const segment = (a: Activation, width: number, total: number) => {
  const value = a.effective ?? 0
  const seg = width <= 0 || total <= 0 || value <= 0 ? 0 : Math.min(width, Math.max(1, Math.round((value / total) * width)))
  const solid = Math.min(seg, Math.round(seg * writeShare(a)))
  return { seg, solid }
}

export const compositionBar = (a: Activation, width: number, total: number): string => {
  const { seg, solid } = segment(a, width, total)
  return '█'.repeat(solid) + '▒'.repeat(seg - solid) + '·'.repeat(Math.max(0, width - seg))
}

export const compositionSvg = (a: Activation, color: string, width: number, height: number, total: number): string => {
  const { seg, solid } = segment(a, width, total)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<defs><pattern id="h" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">`,
    `<rect width="2" height="4" fill="${color}"/></pattern></defs>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#898781" stroke-width="1" stroke-opacity="0.5"/>`,
    `<rect x="0" y="0" width="${solid}" height="${height}" fill="${color}"/>`,
    `<rect x="${solid}" y="0" width="${seg - solid}" height="${height}" fill="url(#h)"/>`,
    '</svg>',
  ].join('')
}
