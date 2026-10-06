import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activation, SortMode, Trigger } from '../types'
import {
  activeInTurn, applyCompaction, applyStep, classifyTrigger, estimateTokens,
  compositionBar, compositionSvg, writeShare, shareLabel, cumulative, formatDollars, formatTokens, clockTime, guessHookName, sortRows, totals, triggerColor, isCacheMiss, parseMcpTool, pluginOf, pruneEmptyHooks, withRealCost, shortName, statusText, tableMarkdown, triggerLabel,
} from './model'

export const PANE = 'skill-trace'
const SPAWNING = 'spawning' // loop of a skill preloaded while its subagent is being spawned
const activations = atom({ plugin: 'skill-trace', key: 'activations' } as const, [] as Activation[])
const sort = atom({ plugin: 'skill-trace', key: 'sort' } as const, 'time' as SortMode)

// Transient markers: a hot reload drops them, the list in $.state stays.
const live = {
  manualCommand: undefined as string | undefined,
  manualIds: [] as number[], // manual activations recorded before their turn.start
  turnId: undefined as string | undefined,
  spawning: undefined as string | undefined, // subagent type being spawned
  agentTypes: new Map<string, string>(), // agentId -> subagent type
  pendingSkills: new Map<string, string | undefined>(), // short skill name -> agentId
  useSvg: true, // `/skill-trace nosvg` falls back to character bars on desktop
}

const agentType = (agentId: string) => live.agentTypes.get(agentId) ?? 'subagent'

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.map(b => (b && typeof b === 'object' && 'text' in b && typeof b.text === 'string' ? b.text : '')).join('\n')
    : ''

// Observer only: every failure is swallowed so the chain never breaks.
async function add($: EngineInterface, a: Omit<Activation, 'id' | 'at' | 'steps' | 'isCompacted' | 'effective' | 'written' | 'dollars' | 'isPriced'>): Promise<number | undefined> {
  try {
    const at = await $.clock.now()
    let next: Activation[] = []
    let id = 0
    await update($, activations, list => {
      id = (list.at(-1)?.id ?? 0) + 1
      next = [...list, { ...a, id, at, steps: 0, isCompacted: false, effective: 0, written: 0, dollars: 0, isPriced: true }]
      return next
    })
    $.ui.status(statusText(next))
    if (a.loop === 'main') $.ui.toast(`🧩 ${a.name} (${triggerLabel(a.trigger)}) +≈${formatTokens(a.injected)}`)
    return id
  } catch {
    return undefined
  }
}

async function refresh($: EngineInterface, change: (list: Activation[]) => Activation[]) {
  try {
    let next: Activation[] = []
    await update($, activations, list => (next = change(list)))
    $.ui.status(statusText(next))
  } catch {}
}

async function onSkill($: EngineInterface, skill: string, text: string) {
  try {
    const key = shortName(skill)
    const hasPending = live.pendingSkills.has(key)
    const pendingAgentId = live.pendingSkills.get(key)
    const isPreload = !hasPending && live.spawning !== undefined
    const loop = isPreload ? SPAWNING : (pendingAgentId ?? 'main')
    const trigger: Trigger = isPreload
      ? { kind: 'subagent', agentType: live.spawning! }
      : classifyTrigger({
          skill,
          manualCommand: hasPending ? undefined : live.manualCommand,
          pendingAgentId,
          agentType: pendingAgentId ? agentType(pendingAgentId) : undefined,
          activeInTurn: activeInTurn(await read($, activations), loop, live.turnId),
        })
    const id = await add($, { name: skill, plugin: pluginOf(skill), source: 'skill', trigger, loop, turnId: live.turnId, injected: estimateTokens(text) })
    if (trigger.kind === 'manual' && id !== undefined) live.manualIds.push(id)
  } catch {}
}

export const register: Register = on => {
  on('command.run', ($, e, next) => {
    live.manualCommand = e.command
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    live.turnId = e.turnId
    if (live.manualIds.length > 0) {
      // A typed /skill is expanded before its turn starts: it belongs to this turn.
      const ids = live.manualIds
      live.manualIds = []
      await refresh($, list => list.map(a => (ids.includes(a.id) ? { ...a, turnId: e.turnId } : a)))
    }
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (!('agentId' in e) || !e.agentId) live.manualCommand = undefined
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    live.spawning = e.subagentType
    try {
      const r = await next(e)
      const agentId = r.agentId
      if (agentId) {
        live.agentTypes.set(agentId, e.subagentType)
        await refresh($, list => list.map(a => (a.loop === SPAWNING ? { ...a, loop: agentId } : a)))
      }
      return r
    } finally {
      live.spawning = undefined
    }
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Skill') {
      const skill = (e as { skill?: unknown }).skill
      if (typeof skill !== 'string') return next(e)
      const key = shortName(skill)
      live.pendingSkills.set(key, e.agentId)
      try {
        return await next(e)
      } finally {
        live.pendingSkills.delete(key)
      }
    }
    const mcp = parseMcpTool(e.tool)
    if (!mcp) return next(e)
    const r = await next(e)
    await add($, {
      name: `${mcp.plugin} (${mcp.tool})`,
      plugin: mcp.plugin,
      source: 'mcp',
      trigger: e.agentId ? { kind: 'subagent', agentType: agentType(e.agentId) } : { kind: 'model' },
      loop: e.agentId ?? 'main',
      turnId: live.turnId,
      injected: estimateTokens(r.deny ?? r.text ?? ''),
    })
    return r
  })

  on('skill.prompt', async ($, e, next) => {
    await onSkill($, e.skill, e.text)
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const loop = e.agentId ?? 'main'
    if (e.door === 'compaction') {
      await refresh($, list => applyCompaction(list, loop))
    } else if (e.door === 'hook-context' && e.origin.kind === 'hook') {
      const event = e.origin.event
      const text = textOf(e.message.content)
      if (estimateTokens(text) === 0) return next(e) // a hook that injected nothing costs nothing
      const name = guessHookName(text, event)
      await add($, { name, plugin: pluginOf(name), source: 'hook', trigger: { kind: 'hook', event }, loop, turnId: live.turnId, injected: estimateTokens(text) })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const step = { model: r.usage?.model ?? e.model, isMiss: isCacheMiss(r.usage) }
    await refresh($, list => applyStep(list, e.agentId ?? 'main', step))
    return r
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await refresh($, () => [])
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await refresh($, list => withRealCost(pruneEmptyHooks(list)))
    try {
      await $.command.register({ name: 'skill-trace', description: 'Show or hide the skills and plugins activated in this session and their token cost', argumentHint: '[inline | nosvg | svg]' })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'skill-trace' }, async ($, e) => {
    if (e.args.trim() === 'nosvg' || e.args.trim() === 'svg') {
      live.useSvg = e.args.trim() === 'svg'
      return { text: `Desktop bars: ${live.useSvg ? 'SVG' : 'text'}.` }
    }
    const table = tableMarkdown(await read($, activations), await read($, sort))
    // Surfaces that draw no pane (the web client): the table goes in the transcript.
    if (e.args.trim() === 'inline') return { text: table, context: [table] }
    // The engine's record of open panes survives a hot reload; a module flag would not.
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'skill-trace pane closed.', context: [table] }
    }
    await $.ui.open({ id: PANE, title: 'Skills & plugins' })
    return { text: 'skill-trace pane opened.', context: [table] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
   try {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Svg = live.useSvg && e.surface === 'desktop' && 'Svg' in elements ? elements.Svg : undefined
    const bar = (a: Activation, cells: number) => {
      const color = triggerColor(a.trigger.kind)
      return Svg
        ? <Svg source={compositionSvg(a, color, cells * 10, 10, t.effective)} alt={compositionBar(a, cells, t.effective)} width={cells * 10} height={10} />
        : <Text color={color}>{compositionBar(a, cells, t.effective)}</Text>
    }
    const pct = (x: number) => `${Math.round(x * 100)}%`
    const mode = await read($, sort)
    const list = await read($, activations)
    const rows = sortRows(list, mode)
    const t = totals(list)
    const cols = e.props.bodyColumns ?? 80
    const isNarrow = cols < 70
    const barCells = Math.max(8, Math.min(16, cols - 24))
    const costText = `≈${formatTokens(Math.round(t.effective))} ${t.isPriced ? formatDollars(t.dollars) : '$?'}`
    const tile = (key: string, label: string, value: string) => (
      <Box key={key} borderStyle="round" borderDimColor flexDirection="column" paddingX={1} flexGrow={1}>
        <Text dimColor>{label}</Text>
        <Text bold>{value}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column" gap={1}>
        {isNarrow
          ? <Box key="kpi-line"><Text bold wrap="wrap">Injected ≈{formatTokens(t.injected)} · Reread ≈{formatTokens(t.cumulative)} · Cost {costText}</Text></Box>
          : <Box flexDirection="row" gap={1}>
              {tile('kpi-injected', 'Injected', `≈${formatTokens(t.injected)}`)}
              {tile('kpi-reread', 'Reread', `≈${formatTokens(t.cumulative)}`)}
              {tile('kpi-cost', 'Real cost', costText)}
            </Box>}
        <Box>
          <Button key="sort" hotkey="t" label={`Sort: ${mode === 'time' ? 'time' : 'real cost'}`}
            onPress={() => update($, sort, m => (m === 'time' ? 'cumulative' : 'time'))} />
        </Box>
        {rows.length === 0 && <Text dimColor>No activations yet.</Text>}
        {rows.map(a => {
          const isSub = a.loop !== 'main'
          const hasCost = (a.effective ?? 0) > 0
          const steps = a.isCompacted ? `${a.steps} req. (compacted)` : `${a.steps} req.`
          const split = hasCost ? ` (writes ${pct(writeShare(a))} / reads ${pct(1 - writeShare(a))})` : ''
          return (
            <Box key={`row-${a.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={triggerColor(a.trigger.kind)} bold>{triggerLabel(a.trigger)}</Text>
                <Text bold={!isSub} dimColor={isSub} wrap="truncate-end">{a.name}</Text>
              </Box>
              <Box key={`bar-${a.id}`} flexDirection="row" gap={1}>
                {!isSub && hasCost && bar(a, barCells)}
                <Text dimColor>
                  {isSub ? 'subagent, not in total' : hasCost ? shareLabel(a.effective ?? 0, t.effective, 0).trim() : 'no request yet'}
                </Text>
              </Box>
              <Box key={`detail-${a.id}`}>
                <Text dimColor wrap="wrap">
                  {clockTime(a.at)} · ≈{formatTokens(a.injected)} injected · {steps} · reread ≈{formatTokens(cumulative(a))} · cost ≈{formatTokens(Math.round(a.effective ?? 0))}{split}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
   } catch (err) {
    const { Text } = $.ui.resolve(e)
    return <Text color="#e34948">skill-trace: render failed — {String(err)}</Text>
   }
  })
}
