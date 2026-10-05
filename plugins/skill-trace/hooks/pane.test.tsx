import { expect, mock, test } from 'claude-code/testing'

const PANE = { component: 'Pane', requestId: 'skill-trace', props: { title: 'Skills & plugins', isFocused: false, bodyColumns: 116, placement: 'dock', scroll: { top: 0, height: 30 } }, viewport: { columns: 120, rows: 30 } } as const

test('pane shows rows and toggles sort', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { model: 'claude-opus-5-5', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 1 } }
  })
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', async (_$: any, e: any) => {
    await $.skill.prompt({ skill: e.skill, text: 'a'.repeat(350) })
    return { result: 'ok', text: '' }
  })
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' } as any)
  for await (const _ of ($ as any).turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) { /* drain */ }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'skill-trace', surface, ...PANE } as any)
    expect(await ui.find({ text: /brainstorming/ })).toBeDefined()
    expect(await ui.find({ text: /Model/ })).toBeDefined()
    expect((await ui.find({ key: 'kpi-injected' }))?.text).toMatch(/≈100/)
    expect((await ui.find({ key: 'kpi-reread' }))?.text).toMatch(/≈100/)
    expect((await ui.find({ key: 'kpi-cost' }))?.text).toMatch(/≈200/)
    expect((await ui.find({ key: 'bar-1' }))?.text).toMatch(/100% of total cost/)
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    else expect(await ui.find({ type: 'Text', text: /[█▒·]{16}/ })).toBeDefined()
    expect((await ui.find({ key: 'sort' }))?.text).toMatch(/time/)
    await ui.press({ key: 'sort' })
    expect((await ui.find({ key: 'sort' }))?.text).toMatch(/real cost/)
    await ui.press({ key: 'sort' })
    await ui.unmount()
  }
})

test('narrow pane stacks everything: one KPI line, bar and details on their own lines', async ($, on) => {
  mock.clock(on, { now: 0 })
  on('skill.prompt', (_$: any, e: any) => ({ text: e.text }))
  on('tool.call', async (_$: any, e: any) => {
    await $.skill.prompt({ skill: e.skill, text: 'a'.repeat(350) })
    return { result: 'ok', text: '' }
  })
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:brainstorming' } as any)
  const NARROW = { ...PANE, props: { ...PANE.props, bodyColumns: 40 }, viewport: { columns: 44, rows: 30 } }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'skill-trace', surface, ...NARROW } as any)
    expect((await ui.find({ key: 'kpi-line' }))?.text).toMatch(/Injected ≈100/)
    expect(await ui.find({ key: 'kpi-injected' })).toBeUndefined()
    expect(await ui.find({ key: 'detail-1' })).toBeDefined()
    await ui.unmount()
  }
})
