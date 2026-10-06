import { expect, mock, test } from 'claude-code/testing'
import type { Activation } from '../types'

let saved: Activation[] = []

const engine = (on: any, $?: any) => {
  saved = []
  mock.clock(on, { now: 0 })
  on('state.set', (_$: any, e: any, next: any) => {
    if (e.plugin === 'skill-trace' && e.key === 'activations') saved = e.value
    return next(e)
  })
  on('command.run', () => ({ text: '' }))
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', async (_$: any, e: any) => {
    // the engine expands a skill inside the Skill tool's run
    if (e.tool === 'Skill' && $) await $.skill.prompt({ skill: e.skill, text: e.text ?? 'a' })
    return { result: 'ok', text: 'x'.repeat(70) }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
}

const list = async (_$: any): Promise<Activation[]> => saved

test('manual then chained', async ($, on) => {
  engine(on, $)
  await $.command.run({ command: 'brainstorming', args: '' } as any)
  await $.turn.start({ text: '/brainstorming', turnId: 't1' })
  await $.skill.prompt({ skill: 'superpowers:brainstorming', text: 'a'.repeat(350) })
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:writing-plans', text: 'a'.repeat(35) } as any)
  const l = await list($)
  expect(l.map(a => [a.name, a.trigger.kind, a.injected, a.plugin])).toEqual([
    ['superpowers:brainstorming', 'manual', 100, 'superpowers'],
    ['superpowers:writing-plans', 'chained', 10, 'superpowers'],
  ])
})

test('model in a fresh turn, subagent skill', async ($, on) => {
  engine(on, $)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Skill', skill: 'pdf' } as any)
  await $.tool.call({ tool: 'Skill', skill: 'xlsx', agentId: 'ag1' } as any)
  const l = await list($)
  expect(l[0].trigger).toEqual({ kind: 'model' })
  expect(l[1].trigger.kind).toBe('subagent')
  expect(l[1].loop).toBe('ag1')
})

test('mcp plugin tool, non-plugin ignored', async ($, on) => {
  engine(on, $)
  await $.tool.call({ tool: 'mcp__plugin_pdf-viewer_pdf__display_pdf' } as any)
  await $.tool.call({ tool: 'mcp__github__create_issue' } as any)
  const l = await list($)
  expect(l.length).toBe(1)
  expect(l[0]).toMatchObject({ name: 'pdf-viewer (display_pdf)', plugin: 'pdf-viewer', source: 'mcp', injected: 20 })
})

// session.append (hook-context, compaction): the test kit cannot answer its bottom
// (an answer without next is skipped, next has nothing beneath) — verified live (Task 5).
test('clear resets', async ($, on) => {
  engine(on, $)
  await $.skill.prompt({ skill: 'pdf', text: 'a' })
  expect((await list($)).length).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 's', resume: {} } as any)
  expect((await list($)).length).toBe(0)
})

test('C1: session.start registers /skill-trace', async ($, on) => {
  engine(on, $)
  const names: string[] = []
  on('command.register', (_$: any, e: any) => { names.push(e.name); return { name: e.name } })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  expect(names).toContain('skill-trace')
})

test('I1: manual skill expanded before turn.start, then chained', async ($, on) => {
  engine(on, $)
  await $.turn.start({ text: 'previous', turnId: 't0' })
  await $.command.run({ command: 'brainstorming', args: '' } as any)
  await $.skill.prompt({ skill: 'superpowers:brainstorming', text: 'a' })
  await $.turn.start({ text: '/brainstorming', turnId: 't1' })
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:writing-plans' } as any)
  const l = await list($)
  expect(l.map(a => a.trigger.kind)).toEqual(['manual', 'chained'])
})

test('I2+I3: subagent type by agentId, preloaded skill in its loop', async ($, on) => {
  engine(on, $)
  let n = 0
  on('agent.spawn', async (s: any, e: any) => {
    n += 1
    if (e.subagentType === 'Plan') await $.skill.prompt({ skill: 'preloaded', text: 'a' })
    return { model: 'm', agentId: `ag${n}` }
  })
  await $.agent.spawn({ tool_use_id: 'x1', prompt: 'p', description: 'd', subagentType: 'Explore' } as any)
  await $.agent.spawn({ tool_use_id: 'x2', prompt: 'p', description: 'd', subagentType: 'Plan' } as any)
  await $.tool.call({ tool: 'Skill', skill: 'pdf', agentId: 'ag1' } as any)
  const l = await list($)
  const pre = l.find(a => a.name === 'preloaded')!
  expect(pre.trigger).toEqual({ kind: 'subagent', agentType: 'Plan' })
  expect(pre.loop).toBe('ag2')
  expect(l.find(a => a.name === 'pdf')!.trigger).toEqual({ kind: 'subagent', agentType: 'Explore' })
})

test('I4: pending Skill keyed by short name and cleared after the call', async ($, on) => {
  engine(on, $)
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming', agentId: 'ag9' } as any)
  saved = []
  // the call is over: a later manual /brainstorming must be Manuel
  await $.command.run({ command: 'brainstorming', args: '' } as any)
  await $.skill.prompt({ skill: 'superpowers:brainstorming', text: 'a' })
  const l = await list($)
  expect(l.at(-1)!.trigger.kind).toBe('manual')
})

test('/skill-trace inline prints the table in the transcript without opening the pane', async ($, on) => {
  engine(on, $)
  let opened = 0
  on('ui.open', () => { opened += 1; return { isPlaced: true as const } })
  await $.skill.prompt({ skill: 'pdf', text: 'a'.repeat(350) })
  const r = await $.command.run({ command: 'skill-trace', args: 'inline' } as any)
  expect(r.text).toContain('| Time | Skill / plugin |')
  expect(r.text).toContain('pdf')
  expect(r.context).toEqual([r.text])
  expect(opened).toBe(0)
})
