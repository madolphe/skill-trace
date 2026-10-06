# skill-trace

A Claude Code **mod** that shows which skills and plugins have activated in your session, what triggered each one, and what it really costs in tokens.

Skills are cheap to list and expensive to load: once a skill's text is in the conversation, it is re-sent with every later request until the session is compacted or cleared. skill-trace makes that visible.

## What you get

- **A status line entry**: `🧩 3 activations · ≈31k injected · ≈1.3M reread`
- **A toast** each time something activates: `🧩 claude-api (Model) +≈29k`
- **A pane**, toggled with `/skill-trace`:
  - three totals: tokens injected, tokens reread, and real cost in token equivalents and dollars
  - one entry per activation with a colored trigger badge, the skill or plugin name, and a cost bar
  - the bar's track is the session's total real cost and is the same for every row. The colored segment is this activation's share of that total. The solid part is cache writes, the hatched part is cache reads.
  - press `t` to switch between chronological order and real-cost order
- **A table in the conversation**: `/skill-trace inline` prints the same data as a Markdown table in the transcript, so the mod is usable where panes and the status line are not drawn, such as claude.ai/code in a browser.
- **The same data for Claude**: `/skill-trace` also hands the table to the model as context, so you can ask Claude about it.

### What counts as an activation

| Source | How it is detected |
|---|---|
| Skill | Any skill load, whether you typed `/name`, the model called the Skill tool, or it was preloaded into a subagent |
| Plugin MCP tool | A call to an `mcp__plugin_<plugin>_…` tool. The size of its result counts as injected. |
| Hook | Context injected by a settings or plugin hook, such as a `SessionStart` hook. Hooks that inject nothing are ignored. |

### Trigger labels

| Label | Meaning |
|---|---|
| **Manual** | You typed `/skill-name` |
| **Model** | Claude called the Skill tool on its own |
| **Chained ← X** | Claude loaded it while skill X was already active in the same turn |
| **Subagent (type)** | It was loaded inside a subagent. These rows are excluded from the main totals. |
| **Hook (Event)** | A hook injected it. The name is guessed from what was injected, because the API does not say which hook ran. |

## How the cost is computed

Each request re-sends the whole conversation, but most of it is served from the prompt cache:

- **Injected** is the estimated size of the text the skill added: characters ÷ 3.5.
- **Reread** is injected × the number of requests since activation, as raw tokens. This is not the size of your context window, which only counts each token once.
- **Real cost** is computed per request:
  - the first request after activation, and any request that missed the cache, pays a **cache write** of injected × 2 (1-hour TTL);
  - every other request pays a **cache read** of injected × the model's read ratio: 0.05 on Opus 5.5, 0.025 on Fable/Mythos 5.1, 0.1 elsewhere.
  - the dollar amount is the cost in token equivalents × the model's input price.

The model and cache usage are read from each real request, so a model switch in the middle of a session is priced correctly.

## Install

```bash
/plugin marketplace add madolphe/skill-trace
/plugin install skill-trace@skill-trace
```

Then run `/skill-trace` in a session.

### On Claude Code on the web (claude.ai/code)

Cloud sessions do not load the mod at startup: project-level marketplaces in `.claude/settings.json` are skipped, and a `CLAUDE_CODE_PLUGIN_DIRS` variable set in the environment's settings reaches the shell but not the running Claude Code process. Load it with hot reloading instead, once per session:

1. In your cloud environment's settings, add this to the **setup script**:

   ```bash
   git clone --depth 1 https://github.com/madolphe/skill-trace /opt/skill-trace
   ```

2. At the start of a session, ask Claude:

   > Load the mod in /opt/skill-trace/plugins/skill-trace with hot reloading.

   Claude copies it into the session's mod folder. The hot-reload question appears only once Claude has loaded its `plugin-authoring` skill, which starts the watch on that folder. If no question appears, ask Claude to load the `plugin-authoring` skill first.
3. Answer **Enable for this session** when Claude Code asks *"Enable hot reloading for this session?"*. The mod loads at the end of that turn.
4. Run `/skill-trace inline`. The browser draws no pane or status line, so use `inline` to get the table in the conversation.

Activations that happened before the mod loaded are not counted.

## Commands

| Command | Effect |
|---|---|
| `/skill-trace` | Open or close the pane |
| `/skill-trace inline` | Print the table in the conversation instead of opening the pane, for surfaces that draw no pane (the claude.ai web client) |
| `/skill-trace nosvg` | Draw the bars with characters instead of SVG in the desktop app |
| `/skill-trace svg` | Switch back to SVG bars |

## Limits

- **Early-access API.** skill-trace is built on Claude Code's function hooks, which are early access and may change between releases. It was written and tested against **Claude Code 2.1.286**.
- **Activations before load are not seen.** Anything that activated before the mod loaded, such as a `SessionStart` hook in an already-running session, does not appear.
- **Token counts are estimates.** They are ±10–15%, because the mod API has no token-count call.
- **The cache TTL is assumed to be 1 hour.** That is what Claude Code uses, and the per-request usage does not report the TTL.
- **Cache-miss detection is a heuristic.** A request that wrote more than it read is treated as a miss.
- **Prices are hard-coded** as of September 2026 in `hooks/model.ts` (`PRICES`). An unknown model is priced at a 0.1 read ratio and its dollar total shows `$?`.

## Development

The plugin lives in `plugins/skill-trace`:

```
hooks/model.ts       pure logic: attribution, costs, formatting (unit-tested)
hooks/register.tsx   event hooks, state, status line, toast, pane
types/index.d.ts     $.state contract
hooks/*.test.ts(x)   tests
```

```bash
claude plugin validate plugins/skill-trace
claude plugin test plugins/skill-trace
claude --plugin-dir plugins/skill-trace
```

## License

MIT
