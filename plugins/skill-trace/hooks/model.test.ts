import { describe, expect, test } from 'claude-code/testing'
import type { Activation } from '../types'
import {
  activeInTurn, applyCompaction, applyStep, classifyTrigger, cumulative,
  estimateTokens, formatTokens, guessHookName, matchesCommand, parseMcpTool,
  formatDollars, isCacheMiss, modelPricing,
  compositionBar, compositionSvg, writeShare, costBar, shareLabel, triggerColor, pluginOf, pruneEmptyHooks, sortRows, withRealCost, statusText, tableMarkdown, totals, triggerLabel,
} from './model'

const act = (over: Partial<Activation>): Activation => ({
  id: 1, at: 0, name: 'x', source: 'skill', trigger: { kind: 'model' },
  loop: 'main', injected: 100, steps: 0, isCompacted: false, effective: 0, written: 0, dollars: 0, isPriced: true, ...over,
})

describe('tokens', () => {
  test('estimate', async () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a'.repeat(35))).toBe(10)
    expect(estimateTokens('a'.repeat(36))).toBe(11)
  })
  test('format', async () => {
    expect(formatTokens(850)).toBe('850')
    expect(formatTokens(1900)).toBe('1.9k')
    expect(formatTokens(9960)).toBe('10k')
    expect(formatTokens(212_400)).toBe('212k')
    expect(formatTokens(1_240_000)).toBe('1.2M')
  })
})

describe('names', () => {
  test('mcp plugin', async () => {
    expect(parseMcpTool('mcp__plugin_pdf-viewer_pdf__display_pdf'))
      .toEqual({ plugin: 'pdf-viewer', server: 'pdf', tool: 'display_pdf' })
    expect(parseMcpTool('mcp__github__create_issue')).toBeUndefined()
    expect(parseMcpTool('Bash')).toBeUndefined()
  })
  test('plugin of skill', async () => {
    expect(pluginOf('superpowers:brainstorming')).toBe('superpowers')
    expect(pluginOf('plugin-authoring')).toBeUndefined()
  })
  test('matchesCommand', async () => {
    expect(matchesCommand('superpowers:brainstorming', 'superpowers:brainstorming')).toBe(true)
    expect(matchesCommand('superpowers:brainstorming', 'brainstorming')).toBe(true)
    expect(matchesCommand('superpowers:brainstorming', 'model')).toBe(false)
    expect(matchesCommand('superpowers:brainstorming', undefined)).toBe(false)
  })
  test('guessHookName', async () => {
    expect(guessHookName("full content of your 'superpowers:using-superpowers' skill", 'SessionStart'))
      .toBe('superpowers:using-superpowers')
    expect(guessHookName('---\nname: my-skill\n---', 'SessionStart')).toBe('my-skill')
    expect(guessHookName('Remember to run the linter after each edit please', 'PostToolUse'))
      .toBe('"Remember to run the linter after each…"')
    expect(guessHookName('  short\n note ', 'Stop')).toBe('"short note"')
    expect(guessHookName('', 'Stop')).toBe('Hook (Stop)')
  })
})

describe('trigger', () => {
  test('manual', async () => {
    expect(classifyTrigger({ skill: 'superpowers:brainstorming', manualCommand: 'brainstorming' }))
      .toEqual({ kind: 'manual' })
  })
  test('a built-in command does not make it manual', async () => {
    expect(classifyTrigger({ skill: 'review', manualCommand: 'model' })).toEqual({ kind: 'model' })
  })
  test('subagent', async () => {
    expect(classifyTrigger({ skill: 'x', pendingAgentId: 'a1', agentType: 'Explore' }))
      .toEqual({ kind: 'subagent', agentType: 'Explore' })
    expect(classifyTrigger({ skill: 'x', pendingAgentId: 'a1' }))
      .toEqual({ kind: 'subagent', agentType: 'subagent' })
  })
  test('chained', async () => {
    expect(classifyTrigger({ skill: 'b', activeInTurn: 'a' })).toEqual({ kind: 'chained', from: 'a' })
  })
  test('labels', async () => {
    expect(triggerLabel({ kind: 'manual' })).toBe('Manual')
    expect(triggerLabel({ kind: 'model' })).toBe('Model')
    expect(triggerLabel({ kind: 'chained', from: 'superpowers:using-superpowers' })).toBe('Chained ← using-superpowers')
    expect(triggerLabel({ kind: 'subagent', agentType: 'Explore' })).toBe('Subagent (Explore)')
    expect(triggerLabel({ kind: 'hook', event: 'SessionStart' })).toBe('Hook (SessionStart)')
  })
})

describe('cumulative', () => {
  test('steps per loop, compaction stops counting', async () => {
    let list = [act({ id: 1 }), act({ id: 2, loop: 'agent-1' })]
    list = applyStep(list, 'main')
    list = applyStep(list, 'main')
    expect(list.map(a => a.steps)).toEqual([2, 0])
    list = applyCompaction(list, 'agent-1')
    list = applyStep(list, 'agent-1')
    expect(list[1].steps).toBe(0)
    expect(list[1].isCompacted).toBe(true)
    expect(list[0].isCompacted).toBe(false)
    expect(cumulative(list[0])).toBe(200)
  })
  test('activeInTurn', async () => {
    const list = [act({ id: 1, name: 'a', turnId: 't1' }), act({ id: 2, name: 'b', turnId: 't2' })]
    expect(activeInTurn(list, 'main', 't2')).toBe('b')
    expect(activeInTurn(list, 'main', 't3')).toBeUndefined()
    expect(activeInTurn(list, 'agent-1', 't2')).toBeUndefined()
  })
  test('sort and totals (main loop only)', async () => {
    const list = [
      act({ id: 1, injected: 100, steps: 1, effective: 200, dollars: 0.0008 }),
      act({ id: 2, injected: 50, steps: 10, effective: 145, dollars: 0.00058 }),
      act({ id: 3, injected: 999, steps: 9, loop: 'agent-1', effective: 2400 }),
    ]
    expect(sortRows(list, 'time').map(a => a.id)).toEqual([1, 2, 3])
    expect(sortRows(list, 'cumulative').map(a => a.id)).toEqual([3, 1, 2])
    expect(totals(list)).toMatchObject({ count: 2, injected: 150, cumulative: 600, effective: 345, isPriced: true })
    expect(Math.abs(totals(list).dollars - 0.00138) < 1e-12).toBe(true)
    expect(statusText(list)).toBe('🧩 2 activations · ≈150 injected · ≈600 reread')
    expect(statusText([])).toBe('🧩 0 activation')
  })
})

describe('table', () => {
  test('markdown table with total, empty case', async () => {
    const list = [
      act({ id: 1, name: 'superpowers:brainstorming', trigger: { kind: 'manual' }, injected: 3100, steps: 12, effective: 7905, dollars: 0.0316 }),
      act({ id: 2, name: 'pdf', loop: 'ag1', trigger: { kind: 'subagent', agentType: 'Explore' }, injected: 600, steps: 3, isCompacted: true, effective: 1260 }),
    ]
    const md = tableMarkdown(list, 'time')
    const lines = md.split('\n')
    expect(lines[0]).toBe('| Time | Skill / plugin | Trigger | Injected | Requests | Reread | Real cost |')
    expect(lines[2]).toContain('| superpowers:brainstorming | Manual | ≈3.1k | 12 | ≈37k | ≈7.9k |')
    expect(lines[3]).toContain('| _pdf_ | _Subagent (Explore)_ | ≈600 | 3 compacted | ≈1.8k | ≈1.3k |')
    expect(lines.at(-1)).toBe('| | **Total (main session)** | | **≈3.1k** | | **≈37k** | **≈7.9k ($0.03)** |')
    expect(tableMarkdown([], 'time')).toBe('_No activations yet._')
  })
  test('pipes in names are escaped', async () => {
    expect(tableMarkdown([act({ name: 'a|b' })], 'time')).toContain('a\\|b')
  })
})

describe('empty hooks', () => {
  test('prune drops hook rows that injected nothing', async () => {
    const list = [
      act({ id: 1, source: 'hook', injected: 0 }),
      act({ id: 2, source: 'hook', injected: 5 }),
      act({ id: 3, source: 'mcp', injected: 0 }),
    ]
    expect(pruneEmptyHooks(list).map(a => a.id)).toEqual([2, 3])
  })
})

describe('real cost', () => {
  test('pricing per model, unknown falls back', async () => {
    expect(modelPricing('claude-opus-5-5')).toEqual({ inputPerM: 4, readRatio: 0.05 })
    expect(modelPricing('claude-opus-5-5[1m]')).toEqual({ inputPerM: 4, readRatio: 0.05 })
    expect(modelPricing('claude-opus-5')).toEqual({ inputPerM: 5, readRatio: 0.1 })
    expect(modelPricing('claude-fable-5-1')).toEqual({ inputPerM: 10, readRatio: 0.025 })
    expect(modelPricing('claude-sonnet-5-5')).toEqual({ inputPerM: 2, readRatio: 0.1 })
    expect(modelPricing('claude-haiku-4-5-20251001')).toEqual({ inputPerM: 1, readRatio: 0.1 })
    expect(modelPricing('gpt-x')).toEqual({ inputPerM: undefined, readRatio: 0.1 })
  })
  test('cache miss = more written than read', async () => {
    expect(isCacheMiss({ cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } as any)).toBe(false)
    expect(isCacheMiss({ cache_read_input_tokens: 0, cache_creation_input_tokens: 9000 } as any)).toBe(true)
    expect(isCacheMiss(null)).toBe(false)
  })
  test('first step writes (2x), then reads at the model ratio', async () => {
    const opus = { model: 'claude-opus-5-5', isMiss: false }
    let list = [act({ injected: 1000 })]
    list = applyStep(list, 'main', opus)
    expect(list[0].effective).toBe(2000)
    list = applyStep(list, 'main', opus)
    expect(list[0].effective).toBe(2050)
    expect(Math.abs(list[0].dollars - 0.0082) < 1e-12).toBe(true)
    expect(list[0].isPriced).toBe(true)
  })
  test('a cache miss charges a rewrite; model switch changes the ratio', async () => {
    let list = [act({ injected: 1000, steps: 1, effective: 2000 })]
    list = applyStep(list, 'main', { model: 'claude-opus-5-5', isMiss: true })
    expect(list[0].effective).toBe(4000)
    list = applyStep(list, 'main', { model: 'claude-fable-5-1', isMiss: false })
    expect(list[0].effective).toBe(4025)
  })
  test('unknown model: priced false, dollars untouched', async () => {
    let list = [act({ injected: 1000 })]
    list = applyStep(list, 'main', { model: 'mystery', isMiss: false })
    expect(list[0].effective).toBe(2000)
    expect(list[0].dollars).toBe(0)
    expect(list[0].isPriced).toBe(false)
  })
  test('dollars format', async () => {
    expect(formatDollars(0.031)).toBe('$0.03')
    expect(formatDollars(0.004)).toBe('<$0.01')
    expect(formatDollars(12.5)).toBe('$12.50')
  })
  test('total shows $? when a row is unpriced', async () => {
    const md = tableMarkdown([act({ steps: 1, effective: 200, isPriced: false })], 'time')
    expect(md.split('\n').at(-1)).toContain('($?)')
  })
})

describe('migration', () => {
  test('old rows without real cost get an unpriced estimate', async () => {
    const old = { ...act({ injected: 1000, steps: 3 }) } as any
    delete old.effective; delete old.dollars; delete old.isPriced
    const [m] = withRealCost([old, act({ effective: 5 })])
    expect(m.effective).toBe(2200)
    expect(m.written).toBe(2000)
    expect(m.isPriced).toBe(false)
    const mid = { ...act({ injected: 1000, steps: 3, effective: 2100 }) } as any
    delete mid.written
    expect(withRealCost([mid])[0].written).toBe(2000)
    expect(withRealCost([act({ effective: 5 })])[0].effective).toBe(5)
  })
})

describe('rendering', () => {
  test('cost bar scales to the largest row', async () => {
    expect(costBar(50, 100, 10)).toBe('█████░░░░░')
    expect(costBar(100, 100, 10)).toBe('██████████')
    expect(costBar(0, 100, 10)).toBe('░░░░░░░░░░')
    expect(costBar(1, 100, 10)).toBe('█░░░░░░░░░')
    expect(costBar(5, 0, 4)).toBe('░░░░')
    expect(costBar(5, 10, 0)).toBe('')
    expect(shareLabel(91, 100, 0)).toBe(' 91% of total cost')
  })
  test('share of the session total, with an explicit percent', async () => {
    expect(shareLabel(91, 100, 10)).toBe('█████████░ 91% of total cost')
    expect(shareLabel(7, 100, 10)).toBe('█░░░░░░░░░ 7% of total cost')
    expect(shareLabel(0.3, 100, 10)).toBe('█░░░░░░░░░ <1% of total cost')
    expect(shareLabel(0, 100, 10)).toBe('░░░░░░░░░░ 0% of total cost')
    expect(shareLabel(5, 0, 4)).toBe('░░░░ 0% of total cost')
  })
  test('writes are tracked apart from reads', async () => {
    const opus = { model: 'claude-opus-5-5', isMiss: false }
    let list = [act({ injected: 1000 })]
    list = applyStep(list, 'main', opus)
    list = applyStep(list, 'main', opus)
    list = applyStep(list, 'main', { ...opus, isMiss: true })
    expect(list[0].written).toBe(4000)
    expect(list[0].effective).toBe(4050)
  })
  test('write share', async () => {
    expect(writeShare(act({ written: 3000, effective: 4000 }))).toBe(0.75)
    expect(writeShare(act({ written: 0, effective: 0 }))).toBe(0)
  })
  test('char bar: same track for every row, segment = share of total, split write/read', async () => {
    // 4000 of 8000 → half the 8-cell track; 75 % of that segment is writes
    expect(compositionBar(act({ written: 3000, effective: 4000 }), 8, 8000)).toBe('███▒····')
    expect(compositionBar(act({ written: 3000, effective: 4000 }), 8, 4000)).toBe('██████▒▒')
    expect(compositionBar(act({ written: 0, effective: 0 }), 8, 8000)).toBe('········')
    // a tiny nonzero share keeps one visible cell
    expect(compositionBar(act({ written: 1, effective: 10 }), 8, 100000)).toBe('▒·······')
    expect(compositionBar(act({ written: 3000, effective: 4000 }), 8, 8000).length).toBe(8)
    expect(compositionBar(act({ written: 3000, effective: 4000 }), 0, 8000)).toBe('')
  })
  test('svg bar: fixed track, segment = share of total, solid writes then hatched reads', async () => {
    const svg = compositionSvg(act({ written: 3000, effective: 4000 }), '#1baf7a', 120, 10, 8000)
    expect(svg).toContain('width="120"')
    expect(svg).toContain('<rect x="0.5" y="0.5" width="119" height="9" fill="none"')
    expect(svg).toContain('<rect x="0" y="0" width="45" height="10" fill="#1baf7a"')
    expect(svg).toContain('<rect x="45" y="0" width="15" height="10" fill="url(#h)"')
  })
  test('one color per trigger kind', async () => {
    const kinds = ['manual', 'model', 'chained', 'subagent', 'hook'] as const
    const colors = kinds.map(k => triggerColor(k))
    expect(new Set(colors).size).toBe(5)
    colors.forEach(c => expect(c).toMatch(/^#[0-9a-f]{6}$/))
  })
})
