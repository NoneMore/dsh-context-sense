# Context Sense

Status: agreed (grilling complete; implementation not started)

A DSH plugin that makes the model aware of its own context budget. DSH already shows *the user* how full the context is — a percentage and an expandable panel driven by the `contextPressure` projection — and never tells the model. This plugin closes exactly that gap, and nothing more.

## Shape

A real npm package in this repo, plain ESM JavaScript, **no build step**.

- `package.json`: `"type": "module"`, an ESM `main`/`exports` entry, `peerDependencies` on `@deepseek-ai/cordis ^4.0.2` and `@deepseek-ai/schemastery ^3.18.2`, and `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`.
- `cordis.patch.yml`: a single `- insert:` entry naming the package, so the row is composed globally rather than per session.
- The plugin publishes **no service**, so no `isolate` realm is needed.
- Mounted globally in the profile plane. It is **not** mounted in any agent preset.
- Install: it must land as a **real directory** under `profiles\web\node_modules\<pkg>`, which is what an ordinary package install through the profile produces. Bare `@deepseek-ai/*` imports then resolve by Node's normal parent walk up into `profiles\node_modules`, and the declared bundle patch applies the row globally.

### Why the obvious mount routes fail

Pointing a row straight at this repo — whether by absolute path, `file:` URL, or `link:` — **does not work**, and it fails for a reason that is not obvious:

- The loader has **no `@deepseek-ai/*` specifier mapping**. Bare specifiers go through Node's own resolver, which walks up from the importing module's **realpath**.
- A linked or junctioned package resolves through to the repo, so the repo directory becomes the resolution base — and from there no harness package is reachable. (`link:` is the same shape as a junction, so it fails identically.)
- The intended mechanism for an out-of-tree plugin is the shared `profiles\node_modules` closure, which only helps a package that actually lives under the profile.
- `dsh.moduleFallback` is unrelated: it is launcher-generated metadata for the packaged-executable build, not an author-facing resolution hook.

### Development loop

Iterating against a packed install means re-installing after every edit. To avoid that, give the repo its own reachable view of the harness packages by junctioning the shared closure:

```powershell
New-Item -ItemType Junction `
  -Path E:\Home\projects\dsh-context-sense\node_modules\@deepseek-ai `
  -Target E:\Home\.dsh\profiles\node_modules\@deepseek-ai
```

Both paths realpath into the same install, so imports from the repo resolve to the *same module instances* the harness is running — verified by comparing `import('@deepseek-ai/dsh-llm')` from the repo against an absolute-path import of the installed file (`===` identical exports, so no split identity). A row in the profile patch layer naming `file:///E:/Home/projects/dsh-context-sense/lib/index.js` is then live-reloaded and source edits need no reinstall. `node_modules/` is gitignored, so the junction stays local.

Scope: **top-level sessions only**. Every entry point returns early when `session.header.delegationDepth > 0` (or `session.header.origin === 'subagent'`), so subagent, workflow, and Ralph child agents get neither the prompt section nor either reminder. The registered tool remains visible in a subagent's tool list; if a subagent calls it, it answers normally.

## Configuration

| key | default | meaning |
|---|---|---|
| `warnRatio` | `0.8` | warning line = **compaction threshold** × this value |
| `rearmRatio` | `0.75` | usage must fall below **compaction threshold** × this to re-arm |
| `oversizeTokens` | `4096` | a single tool result above this estimated token count is reported |
| `compactionThresholdRatio` | none | fallback only, used when `ctx.compaction.config` cannot be read |
| `toolDetailMax` | `5` | how many largest nodes `detail: 'top'` may list |

All five are schemastery fields following house style. Unknown keys fail loudly.

## 1. Static facts in the system prompt

`ctx.systemPrompt.section({ name: 'context-sense', order: 950, text: provider })`.

The section is dynamic (`text` is a function of `assembleContext`), but it renders **only constants**: the context window and the compaction threshold, in absolute tokens first with the ratio in parentheses, plus one sentence of static guidance naming the tool. It carries no live number, and therefore does not change from step to step — the whole reason the design is shaped this way (see ADR-0001).

Window: `contextPressure` projection view `contextWindow`, falling back to `session.requestContext()?.contextWindow`.
Threshold: `Math.floor(window × ratio)` where `ratio` is read from `ctx.compaction.config.thresholdRatio`, honouring a `modelPolicies` override for the current `provider/model`; if that read yields nothing, `compactionThresholdRatio` from our own config; if neither exists, the threshold is **omitted from the text** rather than invented (see ADR-0002's sibling decision in the open items).

Before the session's first request the window is unknown, so the provider returns `''`. Empty sections are filtered out; once the window is known the text appears, costing exactly one appended prompt copy for the whole session.

Rendered text (English):

```
Context budget: this model's context window is {{window}} tokens. DSH compacts the conversation
automatically once context usage reaches {{threshold}} tokens ({{ratio}} of the window).
Call `context_status` to read current usage, window, threshold, and headroom. Call it before
starting work that will produce large output, and after any reminder that you are near the limit.
```

With the threshold unavailable, the second sentence is dropped.

## 2. The `context_status` tool

Registered with `ctx.tools.register(defineTool({...}))`. Arguments and output use DSH's own JSON-schema DSL (`ValueSchemaSpec`/`ParameterSchemaSpec`) — schemastery is only for `Config`.

Parameters: `detail?: 'summary' | 'breakdown' | 'top'`, default `'summary'`. The default must stay small: this tool is the model's *live* read, so it will be called repeatedly, and a chatty reply would make the model's own queries push the context it is asking about.

- `summary` — used, window, threshold, headroom, percentage.
- `breakdown` — adds `systemTokens` / `toolsTokens` / `messageTokens` from the `contextBreakdown` projection.
- `top` — adds up to `toolDetailMax` largest surface nodes from `measure(session).nodes`.

One `sessionProjections.snapshot(session, ['contextPressure'])` call supplies both `contextWindow` and `projectedTokens`. Usage is `projectedTokens` — the same quantity the Web GUI shows the user (ADR-0002).

## 3. Warning-line reminder

`ctx.on('agent/pre-step', handler, { prepend: true })`.

Usage is read at the **top** of the handler, before `await next()` — i.e. before `dsh-compaction-basic`'s body runs. The decision is made there; if it is "emit", the plugin-sourced `notice` is appended to `decision.messages` after `next()` resolves, and only when `decision.kind === 'enter'` (a rejected step would silently discard the message).

```js
createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'context-sense', form: 'notice', summary: boundContextSummary(summary) },
})
```

Rendered text:

```
[context-sense] Context usage is {{used}} of {{window}} tokens ({{pct}}%). Automatic compaction
starts at {{threshold}}. Start wrapping up: finish the current piece of work, write anything
important to files, and avoid starting large new work.
```

The reminder lands as a durable `user/message` at the start of the next step and stays in history until compaction shadows it — so it is stated once but remains visible.

### The decision function (pure, unit-tested)

```
evaluate({ usedTokens, contextWindow, thresholdTokens, state }) -> { state, emit }
```

- window or threshold unknown → `emit: null`, state unchanged
- `used >= thresholdTokens` → `emit: null`, state unchanged (compaction is about to handle it; a "you are running out" notice would contradict the checkpoint that follows)
- state `armed` and `used >= thresholdTokens × warnRatio` → `emit: 'warning'`, state becomes `warned`
- state `warned` and `used < thresholdTokens × rearmRatio` → state becomes `armed`, `emit: null`
- window or threshold changed since the last evaluation → state resets to `armed`

Per-agent state lives in a `WeakMap<Agent, State>`.

## 4. Oversized tool output

`ctx.on('tools/post-execute', handler)`.

`await next()` first — `dsh-spill-policy` is already mounted with `maxInlineBytes: 50000` and rewrites oversized results, so we must compose with it rather than fight it. The notice is then prepended to the downstream decision's `additionalContexts` (handling the `block` variant as `dsh-repeat-tool-reminder` does), which the loop appends as a user message right after that step's tool results.

Rendered text:

```
[context-sense] The tool result above is large: about {{tokens}} tokens. Avoid reading it again
in full — read it with offset/limit, or search it instead.
```

Size is an estimate over the result's text (the token meter's 4-chars-per-token heuristic is the house approximation) — no size field exists on any tool event.

**Skipped when** the result was already externalised by spill-policy, so we never tell the model a result is big when its body is no longer in context.

The classifier and the notifier are separate: `evaluate()` decides *whether* a result is oversized and returns a decision object; today the only action is "attach a notice". Interception is a later branch in the same place, not a rewrite.

## Data sources

| what | where |
|---|---|
| window | `sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure.contextWindow` |
| usage | same snapshot's `projectedTokens` |
| breakdown | `sessionProjections.snapshot(session, ['contextBreakdown'])` |
| largest nodes | `ctx.tokenMeter.measure(session).nodes` |
| compaction ratio | `ctx.compaction.config.thresholdRatio`, plus a `modelPolicies` override lookup |
| top-level test | `agent.session.header.delegationDepth` |

## Non-goals

Not triggering compaction; not blocking or truncating tool output; no Client/browser UI; no token meter of our own; no per-message token tracking; not active in subagent sessions.

## Verification

Pure decision logic — crossing, hysteresis, re-arm after compaction, window change, unknown threshold, `used >= compaction threshold` — is tested with `node --test` against the extracted function, with no Cordis context and no session. The four behaviours end to end are confirmed by hand in one real session: the section appears with the right numbers, the tool answers at each `detail` level, a warning fires exactly once on crossing and again only after usage falls back, and an oversized result draws one notice while a spilled result draws none.

## Open items

- **Unverified**: that a `file:`-URL row actually loads under the junction arrangement described above. The *resolution* half is verified (same module instances); the row load itself was not exercised, because doing so means editing the live profile patch layer of a running harness.
- **Unverified**: the exact package-manager command that yields a real directory rather than a symlink. The distinction is `file:` (hard-linked copy) versus `link:` (symlink) in pnpm terms, and only the former satisfies the constraint above. The reference third-party plugin's README prescribes `dsh plugin --profile web add <packed-dir>`, which is the shape to copy.
