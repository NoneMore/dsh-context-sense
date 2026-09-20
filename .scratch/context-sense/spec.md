# Context Sense — give the model awareness of its own context window

Status: ready-for-agent

Harness baseline: **`dsh-v0.1.5-rc.2`**. Every harness contract named in this spec was verified against that
release's shipped runtime tree (`@deepseek-ai/*` packages under the installed `dsh` package). Sections that
record a seam the harness does **not** expose are marked *upstream prerequisite* and are commitments this
project does not make.

## Problem Statement

DeepSeek Harness already shows the *human* how full the context is: a context meter renders a ring with
used/window and a percentage. The *model* is told none of it.

From inside a session the model cannot tell whether it sits at 5% or 75% of its context window. It cannot see
which of its own actions are consuming the budget. It receives no signal before the mounted compaction backend
crosses its automatic threshold and replaces older history with a checkpoint summary — the shipped backend's
default is 80% of the resolved route's capacity, and a deployment that mounts no compaction backend, or mounts
one with `auto: false`, never compacts automatically at all. The consequences are visible in behaviour: the
model keeps producing large tool outputs and long prose when it is close to the ceiling; it holds conclusions
in its context that it could have written to a file; it is surprised when the conversation it remembers becomes
a `<compacted-summary>`; and the user cannot ask "how much room do you have left?" because there is no way for
the model to find out.

The asymmetry is the whole problem: the harness derives context pressure from every request the model makes and
acts on it automatically, but the party whose behaviour most depends on that measurement is the only one not
informed of it.

## Solution

A DeepSeek Harness plugin, `context-sense`, that gives the model the context awareness the human already has.
It has three parts:

1. **Standing knowledge.** A stable system-prompt statement of the session's context window capacity, so the
   model knows the size of the space it is working in once the harness has resolved one for the session.
2. **On-demand reading.** A `context_status` tool the model can call at any moment to learn the session's
   projected context pressure, the pressure ratio, remaining room, and how the request divides between the
   system prompt, tool definitions and conversation messages — each figure labelled with what it actually is:
   route metadata for capacity, provider-reported usage for the pressure anchor, and the harness's heuristic for
   the composition and the projection delta.
3. **Advisory pressure signals.** `<system-reminder>` messages injected into the conversation when the
   session's projected pressure ratio reaches a configured tier that has not yet fired in the current reminder
   epoch, or when a single tool result is oversized — so the model can change course (tighten output, externalise
   notes, tell the user) with room to act. A ratio is only ever formed from a provider usage sample the plugin can
   confirm belongs to the currently recorded route, so a route change withholds the ratio rather than dividing
   across two routes. Pressure is read from the durable projection, so these are statements about committed
   history, not about the exact request the step is about to make.

The plugin is **non-destructive with respect to existing history and append-only with respect to the
conversation**. It observes and reports. It never compacts, prunes, rewrites, reorders or truncates anything
already in the session, never calls the compaction engine, and never changes compaction policy. Its only
contributions to the conversation are messages it authors itself: attributed reminders (with source
`{kind: 'plugin', plugin: 'context-sense'}`), its prompt section, and its tool.

## User Stories

### Knowing the size of the space

1. As a model, I want to be told my context window capacity in the system prompt, so that I can reason about
   how much room my outputs will need.
2. As a model, I want the capacity statement to carry a real capacity as soon as the harness has resolved one
   for this session, and to say plainly that capacity is not yet known before that, so that I am never given a
   fabricated window size and never left guessing whether a number is real.
3. As a model that has just been compacted, I want my capacity statement to be unaffected by the rewrite, so
   that a compaction never leaves me with a wrong sense of scale.
4. As a model working after a model switch, I want the capacity statement to converge on the new route's
   capacity within one request, so that I do not reason from a stale window size for long.
5. As a model, I want the capacity statement to be short, so that the knowledge of my budget does not itself
   consume a meaningful part of it.
6. As a model, I want the capacity statement to name the tool I can use for on-demand figures, so that I know
   how to get more detail when I need it.

### Reading the figure on demand

7. As a model, I want a tool that reports the session's projected context pressure, so that I can decide whether
   to keep working in-context or to externalise state.
8. As a model, I want that tool to report my remaining room, so that I can judge whether a planned tool call
   will fit.
9. As a model, I want that tool to report the pressure ratio as a percentage, so that I can compare my position
   against the assumed compaction threshold I have been told about.
10. As a model, I want that tool to break the request down into system prompt, tool definitions and conversation
    messages, so that I can identify what is actually consuming my budget.
11. As a model, I want that tool to require no arguments, so that checking my budget is cheap enough to do
    casually.
12. As a model, I want that tool to be usable repeatedly within a turn, so that I can re-check after a large
    tool result.
13. As a model, I want that tool to tell me whether pressure is known at all, and which ingredients of the
    reading are provider-reported rather than the harness's own heuristic, so that I do not treat an
    approximation as exact accounting.
14. As a model, I want that tool to tell me whether a compaction has happened in **this session's own history**,
    and separately whether a compaction checkpoint is part of what I can currently see — including one inherited
    from a parent session when I was forked — so that I can tell "this happened to me" apart from "this is what
    my history looks like now".
15. As a model, I want that tool to report pressure as unknown rather than substituting a heuristic total when
    no provider usage sample exists yet, so that I am never handed a fabricated occupancy figure.
16. As a model that has just been switched to a different route, I want the reading to say that its pressure
    figure has not yet been confirmed for the route I am now on, rather than dividing the previous route's
    pressure by the new route's capacity, so that I am never shown a ratio that mixes two routes.
17. As a model, I want that tool to tell me that a stale-but-real pressure sample exists separately from
    "nothing has been measured at all", so that I can decide to ask again later instead of concluding the
    harness has no usage for me.

### Being warned before it is too late

18. As a model approaching a context tier, I want an unsolicited reminder stating my projected pressure and
    ratio, so that I can change course without having to remember to ask.
19. As a model, I want reminders to be configured at a tier well below the compaction threshold the deployment
    is assumed to run, so that the warning is normally actionable rather than a notification that the decision
    has already been made for me.
20. As a model, I want a distinct, more urgent reminder at a second tier, so that "you are filling up" and
    "compaction is imminent" are different signals.
21. As a model, I want each tier to fire at most once until a summary compaction re-arms it, rather than on
    every step, so that reminders do not themselves consume the budget they are warning about.
22. As a model, I want a tier to re-arm once a summary compaction has rewritten my history, so that a session
    that compacts and then refills is warned again.
23. As a model, I want a reminder to tell me concretely what I can do about it, so that the warning is
    actionable rather than merely alarming.
24. As a model whose single tool result was large, I want to be told immediately after that result, so that I
    can avoid repeating the same oversized call.
25. As a model, I want an oversized-result reminder to be suppressed when a pressure reminder was already
    delivered in the same step, so that I do not receive two overlapping warnings.
26. As a model, I want a pressure reminder to say that its figure describes committed history rather than the
    exact request I am about to make, so that I do not over-trust a measurement that cannot yet include that
    request.
27. As a model, I want a pressure reminder to be withheld when a summary compaction commits inside the
    pre-step waterfall that was about to carry it, so that I am not warned about pressure that has just been
    relieved before the step's own requests were built.
28. As a model, I want a prune that only trimmed one tool result not to re-arm a tier that already fired, so
    that a session hovering near a tier boundary is not warned again and again.
29. As a model whose pressure figure is not yet confirmed for my current route, I want no tier reminder to be
    decided at all, so that I am never warned from a ratio that spans two routes.
30. As a forked subagent, I want my own reminder epoch and per-tier firing to start from my own history, so
    that a reminder my parent received does not silence the first warning I would otherwise get.
31. As a forked subagent, I want the pressure reminder my parent left in the history I inherited to stay
    visible to me without counting as my own firing, so that I can see what my parent knew without losing my
    own signal.

### The human's side

32. As a user, I want context reminders to appear in the transcript, so that I can see the same pressure picture
    my model sees and intervene.
33. As a user, I want to be able to configure the reminder tiers, so that I can tune when I want to be
    interrupted.
34. As a user, I want to be able to disable pressure reminders while keeping the tool, so that I can have
    on-demand readings without injected messages.
35. As a user, I want to be able to disable the system-prompt statement, so that I can keep my prompt minimal if
    I do not want it.
36. As a user, I want a configuration mistake to fail loudly at plugin load, so that I never silently run with
    reminders that can never fire.
37. As a user, I want the plugin to validate my tiers against the compaction threshold **I declare for it**, and
    to be told that this declaration is an assumption about the mounted backend rather than a reading of it, so
    that I do not mistake an advisory check for a guarantee about my deployment.
38. As a user, I want the plugin to never alter my conversation on its own initiative beyond appending its own
    attributed reminders, so that enabling it cannot destroy history.

### Operating conditions

39. As an operator, I want a capacity figure that is unavailable to be reported as unknown rather than
    defaulted to a guess, so that the model is never given a fabricated window size.
40. As an operator, I want a pressure figure that is unavailable to be reported as unknown rather than replaced
    by a composition total, so that "not yet measured" is never presented as "measured, and low".
41. As an operator, I want the plugin to work for every agent that inherits its registrations, including
    subagents, so that delegated work also knows its budget.
42. As an operator, I want the plugin to unload cleanly, removing its prompt section, its tool, its listeners
    and its host-side session state, so that disabling it leaves no residue.
43. As an operator, I want the plugin to be loadable from a local path without publishing to a registry, so that
    I can evaluate it before sharing it.
44. As an operator, I want a package that can also be enabled as a bundle from a profile, so that turning it on
    is one entry rather than hand-written loader rows.
45. As an operator running a provider whose capacity differs from the shipped model catalogue, I want the
    reading to use the capacity of the route the harness actually resolved for the session, so that I do not
    need to maintain a model table.
46. As an operator whose first request on a newly selected route fails before the provider reports usage, I want
    the reading to stop presenting a ratio rather than pairing the old route's pressure with the new route's
    capacity.
47. As a maintainer, I want the reminder decision logic to be testable without a booted harness, so that I can
    verify thresholds and epoch re-arming cheaply.
48. As a maintainer, I want reminder state to be reconstructible from the durable session log alone, so that a
    resumed or replayed session neither repeats nor skips reminders, and a forked session rebuilds its own
    reminder state from its own suffix.
49. As a maintainer, I want the fork cut to come from the projection registry's own `inheritedEventCount`
    rather than from a session id, a first-live-sequence guess or process-local memory, so that isolation
    survives a cold restore and a detached subagent read.
50. As an operator, I want the capacity statement to reach agents that are already running when the plugin
    loads, so that enabling it in a live process does not silently skip the sessions already in flight.

## Implementation Decisions

### Harness baseline and the surfaces this plugin relies on

Verified against `dsh-v0.1.5-rc.2`:

| Surface | Package | Contract used here |
|---|---|---|
| Projection registry | `dsh-session-projection` | `ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply })` (a host-only unit when `wire` is omitted; its key is declared by merging `SessionProjectionStateMap`, and it is absent from `snapshot()`), `.stateOf(session, key)`, `.snapshot(session, keys)`; `init(header, inheritedEventCount)` receives the exact fork-inherited cut, which a unit must not infer from `firstLiveSeq` or `session/end-seed` |
| Pressure projection | `dsh-token-meter` | `contextPressure`: `pressureTokens?`, `projectedTokens?`, `contextWindow?`; `projectedTokens` is emitted only when a provider usage sample exists, so `projectedTokens === undefined` means pressure is not yet knowable. The three fields are **deliberately not one atomic request observation** — each is a last-wins record of a different moment, so a model switch can pair a fresh capacity with the previous route's pressure until the next request reports usage. This is the harness's own documented trade, not a gap this plugin can close from the figure alone |
| Composition projection | `dsh-token-meter` | `contextBreakdown`: `systemTokens`, `toolsTokens`, `messageTokens` |
| Recorded route | `dsh-session` | `session.requestContext(): RequestContext \| undefined` (`provider`, `model`, `contextWindow?`, `systemPromptUpdate?`), and the `request/context` log event the loop appends when any of those four differs from the previous record — appended during request preparation, i.e. **before** that request's usage sample can exist |
| Settlement usage | `dsh-session` / `dsh-llm` | an `assistant/message` event carries optional `usage` plus a `source` naming the `provider`/`model` that produced it, so a sample can be attributed to a route; an `assistant/attempt` event carries a `stream` whose last usage chunk the token meter also samples, but it names **no** route |
| Session log / surface | `dsh-session` | `session.snapshotEvents()`, `session.surface`, `session.deriveMessages()`, and the `session/event` notification; `user/message` events carry no `turn`/`step`, while `step/start` and `step/end` do |
| Fork cut | `dsh-session` | `session.inheritedEventCount`, `session.ownEvents()`, `session.isOwnSeq(seq)`. A seeded session's surface, `deriveMessages()` and every projection fold still cover the **whole** log — including the inherited prefix — so a unit that must ignore inherited history has to ignore it explicitly |
| Agent registry | `dsh-agent` | `ctx.agents.list()`, `agent/created` and `agent/disposed`, and per-agent scoped `inject` for scoped prompt/tool contributions |
| Prompt registry | `dsh-system-prompt` | `ctx.systemPrompt.section({ name, order, text })` |
| Tool registry | `dsh-tools` | `defineTool({ name, description, parameters, output: { schema, render }, ... })`, `ctx.tools.register(...)` |
| Pre-step seam | `dsh-agent` / `dsh-agent-loop` | `agent/pre-step` waterfall: `{ agent, messages, turn, step, signal }` → decision whose `messages` are appended as `user/message` at the first attempt of the step. `messages` are the inbox messages **claimed** for this step; the loop commits them only after the waterfall returns |
| Tool-result seam | `dsh-tools` | `tools/post-execute` waterfall `(exec, result, next)` returning `PostToolDecision` with `additionalContexts?: UserMessage[]`; it runs **before** the definition's `finalizeContent` and materialization |
| Listener ordering | `cordis` | `ctx.on(name, listener, { prepend: true })` unshifts the listener in the dispatch list; `waterfall` runs listeners outermost-first, so a listener's code after `await next()` runs after every later listener and after the innermost default decision |
| Message vocabulary | `dsh-llm` | `createUserMessage`, `MessageSourceMap['plugin']` with `ContextFormed` (`'snapshot'` + `sections`, `'notice'` + `summary`), `boundContextSummary` |
| Compaction lifecycle | `dsh-compaction`, `dsh-compaction-basic` | log-only `compaction/start`, `compaction/summary`, `compaction/end`, `compaction/prune`; the replacement is one `user/message` whose source is recognized by `isCompactCheckpointSource` (exported from `@deepseek-ai/dsh-compaction/checkpoint`). The automatic `pressure` trigger runs the tool-result pruner **first** and may return without summarizing when pruning alone drops the measurement below the threshold |

The plugin is a standard Cordis plugin module exporting `name`, `inject`, `Config` and `apply(ctx, config)`
(the shape `dsh-time-context` and `dsh-repeat-tool-reminder` use — `export { Config, apply, inject, name }`).
It declares the services it needs (`sessionProjections`, `systemPrompt`, `tools`, `tokenMeter`) through `inject`
rather than assuming them, so a composition missing one fails at load instead of misbehaving later. `tokenMeter`
is required for exactly one thing — pricing a raw tool result for the oversized-result rule — and is never used to
compute the pressure figure, which comes from the projection.

Source is TypeScript compiled to an ESM `lib/` output with emitted declarations, matching the first-party
package layout, with the SDK packages declared as peer dependencies. The package additionally ships a bundle
patch declaring a loader row for itself, so a profile can enable it by listing the package in its bundle
composition instead of hand-writing a patch row. A local absolute path or file URL is a valid loader-row name,
so no registry publish is required to evaluate it.

### Where the numbers come from

The plugin reports three figures, each with its own provenance, and the reading names each one. Two of them are
not estimates at all: capacity is metadata about the route, and the pressure anchor is what the provider actually
reported. Composition is entirely the harness's estimate, and pressure is an estimate only in the part of it that
is a projected delta.

- **Capacity is route metadata, not an estimate.** It is `contextWindow` of the newest route the harness has
  recorded for the session — `session.requestContext()?.contextWindow`, which the agent loop writes as a
  `request/context` event when the prepared request's provider, model, capacity or prompt-update mode differs
  from the previous record. (`contextPressure.contextWindow` carries that same recorded value, so a reading can
  take capacity and pressure from one projection snapshot instead.) Capacity belongs to the route, not to the
  session: a session that switches model has a different capacity, and the recorded value is a record of the last
  resolved route, not a promise about the next one. When no route has advertised one, capacity is **unknown**, and
  the plugin never substitutes a default.
- **Pressure is provider-anchored, and is `unknown` until a provider says something.** It is read through the
  `contextPressure` unit's own `view` — `snapshot(session, ['contextPressure'])` — as
  `projectedTokens ?? pressureTokens`, the same numerator the human-facing conversation UI uses
  (`dsh-client-ui-conversation`'s occupancy helper). The plugin does not re-derive this from the unit's internal
  state and does not call `ctx.tokenMeter.measure()` at all, so it has no opinion about which backend produced the
  figure, and a composition where the `contextPressure` unit is absent degrades to "unknown" instead of failing.
  Taking the same numerator is not the same as taking the same answer: whether that figure may be *divided by the
  capacity in the same snapshot* is decided separately by the route-coherence gate below, because the two fields
  are not one atomic observation.
  - `pressureTokens` is the **provider-reported** prompt size of the newest request (uncached input plus cache
    reads and writes; response output excluded). It is not a heuristic.
  - `projectedTokens` is that provider sample plus the **heuristic** re-pricing of everything the surface gained
    or lost since the sample was taken. Only that delta is estimated; the figure stays anchored to the provider
    while still reacting the moment a compaction shadows a span, which `pressureTokens` alone cannot do.
  - Both fields are emitted from the same guard: `projectedTokens` exists only when `pressureTokens` and the
    sample's surface watermark both exist. So **there is no heuristic-only pressure total.** When the projection
    carries neither field, the session has not yet had a provider usage sample and the plugin reports pressure as
    **unknown** — no ratio, no remaining room, and no tier decision. It does not fall back to composition.
- **Composition is heuristic only, and is never a substitute for pressure.** It is read from the
  `contextBreakdown` projection: the meter's fixed-density estimate of what the request is *made of* (system
  prompt, tool schemas, everything else). It is not provider-anchored, is not expected to sum to pressure, and
  when pressure is unknown it is **not** presented as a total. The plugin presents it as approximate composition
  and labels it as the harness's heuristic.
- **Pressure and compaction's own measurement are different metrics.** The compaction backend decides from
  `ctx.tokenMeter.measure()`, whose `totalTokens` is route-priced request-and-response pressure over the current
  surface and whose `baseline` may be a provider usage sample *or* a purely heuristic anchor. That measurement is
  a different computation from `contextPressure.projectedTokens`, and the two are not interchangeable. The plugin
  reports the projection figure and never claims to reproduce, predict or verify the number the compaction
  backend used.
- **No new token accounting is introduced.** The plugin defines no pricing formula of its own. Every figure it
  reports is either route metadata (capacity), provider-reported usage (the pressure anchor), or a price the
  harness's own meter produced (the projection delta and composition via the projections, the oversized-result
  measurement via the meter service's `estimateMessage`, plus declared visual-token pricing for images on routes
  that declare it). Model-facing text marks which is which: capacity is stated as the route's window, pressure is
  stated as anchored on the provider's last reported usage, and composition and the projection delta are stated as
  approximate. The meter's pure estimator module is not reachable as a package subpath, so the service method is
  the only public pricing seam and the plugin uses it rather than reimplementing the estimator.

### Route coherence: what may be divided by what

The pressure ratio is one number over another, and rc.2 does not promise that the two came from the same route.
`ContextPressureProjection` says so in its own declaration: the fields are "deliberately NOT one atomic request
observation", each is a last-wins record of a different moment, and "switching models can therefore pair a fresh
capacity with the previous route's pressure until the next request reports usage". The plugin treats that as a
constraint to design around, not a display quirk to inherit, and the fact that the human conversation UI divides
the same two fields without a gate is **not** evidence that the model may do so.

- **The projection carries no route per field, so the gate is reconstructed from durable events.** The plugin's
  own projection fold (which already sees every committed event) records two route facts:
  - the **recorded route** — `provider`/`model` of the newest `request/context` event, which is where the
    capacity in the snapshot comes from. The loop appends that record during request preparation, *before* the
    request can produce usage, so a route change is durable before any sample for the new route exists.
  - the **newest attributed sample** — `source.provider`/`source.model` of the newest `assistant/message` event
    that carries `usage`, which is the only settlement event whose route is named.
- **Pressure and ratio are reported only when those two routes match.** If no sample can be attributed, or the
  newest attributed sample names a different route than the newest record, the reading reports pressure as
  **stale** — not as a ratio, not as remaining room, and with no tier decision — until an attributed sample on
  the recorded route arrives. The figure itself is still real and still provider-anchored; what is withheld is
  the division.
- **`stale` and `unknown` are different answers.** `unknown` means no provider has reported usage for this
  session at all; `stale` means a sample exists but has not been confirmed for the route the capacity belongs to.
  The tool says which one it is, so the model is never told "nothing measured" when the truth is "measured, on a
  route you have left".
- **The gate is deliberately conservative.** An unattributable sample reads as stale rather than as coherent,
  because an `assistant/attempt` event can carry a usage sample that the token meter's own `usageOf` will accept
  while naming **no** route at all (it carries only a `stream`). When the newest sample is one of those, the
  plugin cannot attribute it and will not assume it belongs to the recorded route.
- **Capacity, composition and the oversized-result rule are unaffected.** Capacity is route metadata and is
  reported whether or not the pairing is coherent; composition is heuristic composition of the current surface
  and is never divided by capacity; the oversized-result share is a fraction of capacity alone, which is the
  current route's, so it needs no sample. Only the pressure ratio, remaining room against the window and the
  tier decision depend on the gate.
- **The cost is stated rather than hidden.** In the window after a route change this reading can say `stale`
  while the human's meter still shows a number, and a tier crossing during that window produces no reminder.
  That is the accepted trade: a delayed reminder is recoverable on the next step, a ratio computed across two
  routes is a fabricated figure, and this project does not produce those.
- **What is still not guaranteed.** The gate proves route *identity* by reconstruction from durable log events,
  not by any harness-provided per-sample route field — rc.2 exposes none, and the token-meter README records the
  atomic-pair comparison as **rejected** upstream. So the claim is exactly: "the newest sample the plugin can
  attribute was produced on the currently recorded route". The plugin never claims the projection's three fields
  were ever observed as one atomic request observation, and it never claims `pressureTokens` is itself a sample
  of the request the current step is about to make. A `request/context` record also appears when only
  `systemPromptUpdate` changed on an unchanged route; that case can read as `stale` for one request, because the
  log does not say which of the four recorded fields changed. Both are recorded as non-guarantees below rather
  than papered over.

### The system-prompt statement

- The capacity statement is registered as a single named prompt section whose text is recomputed at each
  assembly for one agent's scope. It is registered **per agent**, closing over that agent's session, so the
  section's lifetime is tied to that agent's and no assembly has to introspect its own context to discover whose
  budget it is describing. (`AssembleContext` does carry an optional `agent` — `dsh-agent` declaration-merges it
  in, documented as "absent on diagnostics" — so a single global section *could* read the same fact; the plugin
  still prefers scoped per-agent registration, because it follows the harness's own file-reference plugin and
  because the disposer then naturally belongs to the agent.) Registration follows that plugin: install for every
  agent the registry already holds, and install for each agent announced afterwards (`agent/created`), each
  registration made through the agent's own scoped `inject` of the prompt and tool services and each held as a
  disposer tied to that agent. Installing only on session start would silently skip agents that were already live
  when the plugin loaded.
- Its text is a short paragraph: the capacity in tokens when known, that a tool exists for on-demand figures, the
  configured reminder tiers, that a reminder describes committed history rather than the exact request being
  assembled, and the fact that the compaction threshold it names is an assumed policy value. It sits at a fixed
  order chosen to fall after the harness identity and the deployment persona prefix and ahead of the policy and
  tool sections, so the statement reads as standing self-knowledge rather than as tool guidance; the harness
  centrally allocates orders only to its own sections, so this plugin owns this one value.
- **The section contains capacity only — never live pressure.** This is a correctness requirement, not a caching
  preference, and it holds under both of the harness's prompt-reconciliation modes. The agent loop reconciles
  the rendered prompt against the surviving `system/message` nodes each attempt: when the prepared route
  declares `systemPromptUpdate: 'in-history'` and the text has changed, a fresh system message is **appended**;
  otherwise the head node is **replaced in place**. A section carrying live pressure would therefore either
  append a new system message on every step — consuming the very budget it reports — or rewrite the request
  prefix on every step and invalidate the provider's cache. Capacity changes only when the route changes, so
  the statement stays stable within a route and the live figure travels only by tool call and reminder.
- **A prompt that is one complete section drops the statement.** Registration is per agent scope, so a preset
  that supplies its own prompt normally coexists with this section; but a section declared `complete` is restored
  as the sole prompt section after assembly (an SDK profile that replaces the persona wholesale does this). In
  such a deployment the capacity statement does not appear, while the tool and the reminders are unaffected. The
  plugin never marks its own section `complete`: it is a contribution, not a persona, and declaring it complete
  would both displace a deployment's persona and risk the assembly failure the registry raises when more than one
  effective complete section exists.
- **Capacity guarantee (lowered deliberately).** The statement names a real capacity only once the harness has
  resolved one for the session. It therefore states that capacity is not yet known on a session's first request,
  and it may state the previous route's capacity for at most one request after a model switch — while the
  harness's next `request/context` record catches up. The section is rewritten by the loop's ordinary
  reconciliation once the recorded route changes, so the correction is automatic and costs no new mechanism.
  Stating the exact capacity of the route being assembled, on the first request and immediately after a switch,
  is an **upstream prerequisite**: rc.2's `AssembleContext` exposes the agent but no resolved route, and the route
  for the request being assembled is resolved only later, when the loop runs `agent/request` and its
  `prepareCall()`, which are asynchronous and require an explicit provider/model that prompt assembly is not
  given.

### The `context_status` tool

- One tool, parameterless (`parameters: {}`), that serves the context query — a context reading the model asks
  for deliberately, at a moment of its own choosing — registered under a name that does not collide with a
  built-in.
- Its canonical output is a structured JSON value declared as the tool's `output.schema` — capacity, a
  capacity-known flag, pressure (or a pressure-known flag beside an absent figure), remaining, ratio,
  composition, a per-figure provenance label, a pressure-state field distinguishing `known` from `unknown` from
  `stale`, and the two compaction facts — and a separate pure `output.render(args, value)` projects that value
  into the model-facing text. Declaring the canonical value and rendering it separately is the harness's own
  convention, not an invention of this plugin.
- The provenance label is per figure, not one flag for the whole reading, and it has exactly the values the three
  provenances in "Where the numbers come from" allow: capacity is `route-metadata`, pressure is
  `provider-anchored` (present only when the projection actually carries a figure), and composition is
  `heuristic`. There is deliberately **no** `heuristic-only` pressure value, because the projection cannot produce
  one. Route coherence is a separate, separately reported fact — a pressure figure can be `provider-anchored` and
  `stale` at the same time, and the reading says both rather than downgrading the provenance.
- The model-facing text is compact and states: pressure of capacity, or that pressure is not yet available because
  no provider usage has been reported, or that a provider sample exists but has not been confirmed for the
  current route; or that capacity is unknown; the ratio as a percentage and the remaining tokens only when both
  figures are known **and** route-coherent; the three-way composition labelled as the harness's approximate
  heuristic; and the two compaction facts.
- When pressure is unknown **or stale** the tool omits the ratio and remaining room rather than computing them
  from composition or across routes, and says which fact is missing. The distinction matters to the model: stale
  means asking again later will probably help, unknown means it will not yet.
- The tool reads live session state at call time through `exec.agent.session` (the loop sets the calling agent on
  every tool execution), so it is correct on repeated calls within a single turn. An execution that carries no
  agent reports the reading as unknown rather than failing.
- The tool writes nothing: it does not append events, inject messages, or mutate projections.

### Where reminders are observed and how they are delivered

The plugin attaches to **two** harness observation points, feeding **one** shared decision core:

- **Oversized tool-result reminders** are evaluated on the `tools/post-execute` waterfall, where the dispatch
  result is in hand and its size can be measured directly. Delivery rides the decision's
  `additionalContexts?: UserMessage[]`, the same mechanism `dsh-repeat-tool-reminder` uses to attach a
  plugin-attributed message to that result. That plugin is also the prior art for the ordering: measure from
  `(exec, result)` **before** `await next()`, then merge the message into the downstream decision's
  `additionalContexts` and return it.
- **Pressure tier reminders** are evaluated on the `agent/pre-step` waterfall, the same seam the compaction
  backend's automatic trigger uses. This seam requires care about *when* each thing happens, so the plugin's
  ordering is stated explicitly below.

#### The `agent/pre-step` control flow, exactly

The loop claims the step's inbox messages, assembles the system prompt, and then dispatches the `agent/pre-step`
waterfall with `{ agent, messages, turn, step, signal }`, where `messages` are the messages **removed from the
inbox for this step**. Only after the waterfall resolves does the loop run the rest of the step: append
`step/start`, dispatch `agent/request` and resolve the prepared call, commit the projected system prompt as
`system/message`, commit `decision.messages` as `user/message` surface events (on the first attempt of the step),
and only then build and dispatch the request. Two consequences the plugin's design depends on:

- **The claimed messages of the current step are not yet on the surface when the waterfall runs.** Neither is the
  system prompt just assembled, nor any tool-schema change for this step. The `contextPressure` projection is
  driven eagerly from *committed* events, so at this moment it reflects the surface as of the previous step.
  Pressure read here is therefore a **lagging durable projection**, not this request's occupancy.
- **`{ prepend: true }` positions the listener first; it does not make the listener's code run before later
  listeners complete.** Cordis's `waterfall` composes the dispatch list outermost-first and passes the innermost
  default as the final `next`, so a listener that calls `await next()` first has, by the time it resumes, already
  run every later listener — including `dsh-compaction-basic`'s automatic compaction, which registers
  unprepended. Reading pressure *after* `await next()` would therefore observe a possibly post-compaction
  surface. `dsh-time-context` is the prior art for the `{ prepend: true }` + `await next()` *shape*, and it reads
  no pressure, so it does not run into this.

The listener's order inside one step is consequently:

1. **Read the pressure snapshot** — `snapshot(session, ['contextPressure'])` — *before* `next()`. This is the
   reading the decision is made from, and it deliberately observes the pre-compaction, pre-injection surface.
2. **Read the folded reminder state** — `stateOf(session, <plugin key>)` — and compute the decision with the pure
   core.
3. **`await next()`** to obtain the step's decision. Downstream listeners (compaction among them) run here.
4. **Re-read the reminder state** and compare the compaction epoch. If a downstream `agent/pre-step` listener
   committed a `compaction/summary` during step 3, **drop the pending pressure reminder** and return the decision
   unchanged: the pressure the reminder described has just been relieved, and delivering "compaction is imminent"
   in the same step as the compaction is noise. Nothing is recorded as fired, so the tier stays eligible in the
   new epoch; the next step re-evaluates against the post-compaction surface, and a session that is still above
   the tier after compaction is therefore warned one step later rather than never.
5. Otherwise, if the decision is not a rejection and a reminder was decided, **append the reminder message to
   `decision.messages`** and return the modified decision. Injection must happen after `next()` because that is
   the only point at which the final decision exists to be extended.

The suppression in step 4 has a **precise and narrow** scope, and it is worth stating what it is not:

- It is exactly: *a pending pressure reminder is dropped if a downstream `agent/pre-step` listener commits a
  `compaction/summary` before the pre-step waterfall returns.* Nothing broader is claimed.
- It does **not** cover a summary compaction that happens later in the same step through another path. The
  settled example is context-overflow recovery: the loop commits `decision.messages` — including the reminder —
  as `user/message` surface events, builds and dispatches the request, and only when the provider rejects it with
  a context-window failure does it dispatch `agent/request-error`, from which `dsh-compaction-basic` may run
  `compactIfNeeded(agent, 'context-overflow', signal)` and commit a `compaction/summary`. By then the reminder is
  durable. A committed `user/message` cannot be retracted, and the plugin performs no history rewriting, so this
  later same-step compaction does **not** retroactively remove the reminder, and nothing in the design tries to.
- The reason this is acceptable rather than a defect: the reminder the model receives is a true statement about
  the committed surface at the moment it was decided, and the overflow that followed is visible to the model in
  the same step's error and recovery. Suppressing it would require a seam that can un-commit a message, which
  rc.2 does not have and this plugin would not use.
- The epoch bookkeeping stays honest in that case: the reminder was committed, so the fold records it as fired in
  the epoch that the later `compaction/summary` closes, and the new epoch starts un-fired. A session that
  overflows and compacts therefore keeps both the reminder it was given and its eligibility in the next epoch.

The epoch comparison in step 4 is a local before/after comparison inside one listener invocation, not stored
state: what it can affect is whether a message is committed, which is itself durable. Nothing about it needs to
survive a resume.

Both delivery paths produce the same artifact: a **user-role message attributed to the plugin** (source
`{ kind: 'plugin', plugin: 'context-sense' }`, no custom source `kind`), carrying the reminder text inside a
`<system-reminder>` frame that the plugin owns. Every interpolated value — section name, tool name, sizes and
percentages, and any tool-supplied text — is escaped for XML text content (`&`, `<` and `>` replaced with their
entities) before it enters the frame, so nothing interpolated can close the frame or introduce markup. The
message declares the harness's context form that matches its shape — `form: 'snapshot'` with named `sections` for
a reading, `form: 'notice'` with a `summary` bounded by `boundContextSummary` for a one-line account — which is
what makes the reminder render as an attributed row in the transcript and therefore visible to the human as well
as the model. The harness has no shared reminder-framing helper; the plugin implements and owns its own.

The reminder text is bounded: it previews no raw payloads, only names and sizes, so a reminder about a large tool
output cannot itself be large.

### The reminder decision core

- The decision core is a **pure function** of (the pressure and capacity read from projections, whether those two
  were confirmed to belong to the same route, the plugin's config, and the reminder state folded for this session)
  returning either "no reminder" or "a reminder at tier N with this text". Purity here is the testing seam; it also
  keeps both observation points behaviourally identical. The core never reads a projection, a clock or a mutable
  module-level variable itself — every input is passed in. A route-incoherent pairing is an input like any other,
  and its only effect is "no reminder": the core never sees a ratio it would have to qualify.
- **Reminder state lives in the plugin's own session projection**, registered through
  `ctx.sessionProjections.register(...)` as a **host-only** unit (`wire` omitted, its key declared by merging
  `SessionProjectionStateMap`), whose `apply` is a pure fold over committed session events. Because the state is
  a pure function of the durable session log, it is reconstructed identically after a resume, a replay or a fork
  instead of relying on process-local memory.
- **The state is split into a child-owned part and a surface-history part, and the two have different cuts.**
  This is the one structural decision the fork case forces, so it is stated before the details:

  - **Child-owned reminder state** — the compaction epoch, each tier's fired epoch, the step cursor and
    `pressureReminderStep` — is folded **only** from the session's own suffix, `seq >= inheritedEventCount`.
    A fork's inherited prefix is its parent's history, not this session's, so none of it may arm, fire, suppress
    or re-arm anything here.
  - **Surface-history state** — the recorded route and the newest attributed usage sample that the route-coherence
    gate compares, and the checkpoint-visibility fact read off the current surface — covers the **whole** log,
    inherited prefix included. That is not an inconsistency: the inherited prefix really is part of the surface
    this session sends and really does contain a route record and checkpoint nodes the model can see, so those
    facts are true of this session as it stands.
  - The cut comes from `init(header, inheritedEventCount)`, the exact fork-inherited prefix length the projection
    registry supplies, and it is carried in the projection's own state (so a checkpoint restored from the cache
    still knows its cut). It is never inferred from `session.id`, from `firstLiveSeq`, from a `session/end-seed`
    marker or from any process-local map — the registry documents that the cut must not be inferred, and
    `dsh-schedule` is the in-tree prior art for both halves: it receives the cut in `init`, folds the same
    transition function after it, and states that a fork folds only `ownEvents()`. A session-scoped projection
    keyed by session id would also break the plugin's own replay guarantee, which is the whole reason the state is
    a fold rather than a variable.
- **Why the child-owned cut is the right call, not just the tidy one.** A forked child inherits its parent's
  reminder *messages* on the surface, because a seeded session derives messages from the whole log. Those
  messages are statements about the parent's route and the parent's pressure at the parent's moment, and the fold
  cannot tell them apart from its own except by sequence. Counting them would let a parent's single 60% reminder
  silence the child forever in epoch 0 — a long-running fork, which is the normal reason to fork, would never
  warn. The reverse error is mild and self-correcting: a child may restate a tier whose reminder is already
  visible in the history it inherited. The plugin prefers a repeated warning to a permanently silent child.
- **What the fold can and cannot see — and therefore what the state may contain.** `apply(state, event)` receives
  only the previous state and one committed event. It has no access to the projection registry, so it **cannot
  read `contextPressure`**, cannot compare a ratio against a tier, and cannot know that pressure ever fell below a
  tier. A design that stored "pressure fell below tier N, so re-arm it" would be un-replayable: nothing in the
  log records the fall, and reconstructing it would mean duplicating the token-meter's fold. The plugin therefore
  **does not store any pressure-derived state at all**, and the hysteresis/re-arm-on-fall design is dropped
  rather than approximated. Everything the state contains is derived from events the plugin or the harness
  durably recorded.
- **Reminder epochs.** The child-owned state is the session's own compaction epoch plus, per tier, the epoch in
  which that tier last fired. All of it is derived from durable events in the own suffix:

  - The **epoch** is the number of `compaction/summary` events observed in the session's **own suffix**
    (`seq >= inheritedEventCount`), starting at 0. A summary compaction is the one compaction event that replaces
    a span of this session's history with a checkpoint, so it is the one event that unconditionally re-arms every
    tier. It is the marker because the backend appends the summary record and the replacement `user/message`
    adjacently in one non-yielding commit (the contract calls that adjacency contractual), and a summarization
    that fails earlier records only `compaction/end` with an `error` and never emits a summary. A crash between
    those two appends is not excluded by rc.2, so the plugin treats a summary as a rewrite rather than proving it —
    the cost of being wrong is one extra epoch, not a wrong figure. `compaction/start` and `compaction/end` bracket
    the transaction and carry no surface effect, so they do not move the epoch. A summary that happened in the
    inherited prefix does **not** count: it is the parent's epoch, and the child starts at 0.
  - **A tier's firing is reconstructed from the plugin's own durable reminder messages** in the own suffix. When
    the fold sees a `user/message` whose source is `{ kind: 'plugin', plugin: 'context-sense' }` and whose content
    is a pressure tier reminder, it records that tier as fired in the *current* epoch. The tier's identity rides
    the message's own durable vocabulary — the `snapshot` section name, which the plugin owns — rather than being
    parsed out of human-facing prose. That name is therefore chosen to be both the contribution label the
    transcript shows a human and the stable key the fold matches on; the reminder body text is free to change
    without disturbing the fold. (`snapshot`'s "supersedes earlier snapshots" semantics is a transcript caption,
    not a surface removal: earlier reminder nodes stay in the durable log, which is what the fold reads.) A
    reminder in the inherited prefix is skipped by the same `seq >= inheritedEventCount` guard, so it stays
    visible in the transcript without counting as this session's firing.
  - This closes the loop without any cross-projection read: the loop commits the reminder the plugin decided on
    as an ordinary `user/message`, the fold observes it, and every later decision sees the tier as already fired
    in that epoch. Once per epoch is therefore a property of the durable log, not of a counter in memory.
  - The fold tracks the current step from the own suffix's `step/start`/`step/end` (which carry `turn`/`step`;
    `user/message` does not) and records the step of the last **pressure tier** reminder it observed — and only
    that kind. An oversized-result reminder must not be recorded in this field: it is committed at the step *after*
    the result that produced it, so recording it would make a later step believe a pressure reminder was already
    delivered and wrongly suppress that step's own oversized reminder. That single field is the only input the
    oversized-result suppression rule needs. The cut applies here too and is not cosmetic: turn and step numbers
    restart at 1 in a child session, so an inherited `step/start` can carry the same `(turn, step)` pair as the
    child's own current step and would otherwise make the child believe a pressure reminder was already delivered
    this step.

- **A tier fires at most once per epoch.** The core fires tier N when the ratio derived from the projected
  pressure and the route capacity reaches N's ratio, the pairing is route-coherent, and N has not fired in the
  current epoch. This replaces once-per-crossing: with no readable pressure history in the fold, "already above
  the tier" and "crossed the tier this step" are not distinguishable, so the plugin guarantees the weaker, honest
  property — **at most one reminder per tier per epoch**. A session that drifts above a tier, receives the
  reminder and stays above it receives exactly one reminder.
- **`compaction/prune` does not re-arm — as a state-machine policy, not as a claim that prune leaves the
  measurement alone.** A prune *is* a surface replacement: the shipped `dsh-compaction-tool-result-pruner`
  appends a `compaction/prune` record and then a replacement `tool/result` with `surfaceOp: { op: 'replace' }`
  shadowing one node, so it does change the surface that pressure and the tier ratio are derived from. What is
  true of it is narrower and is the actual reason for the rule: it is a **local, model-free** replacement with no
  checkpoint, so it frees at most one node's overage — not necessarily a meaningful fraction of the window — and
  it is frequently a *prelude* to a summary compaction rather than a substitute for one. The automatic `pressure`
  trigger runs the pruner first and only proceeds to summarization if the measurement is still above the
  threshold, and context-overflow recovery runs it before selecting a range. Re-arming on prune would therefore
  produce exactly the loop this project must avoid — a tier fires at 75%, a prune shaves the surface just enough
  to drop below the tier, the tier re-arms, and the next step fires it again. Prune is not a checkpoint source
  either (`isCompactCheckpointSource` matches only the `plugin: 'compact'` summary replacement).
  - So the rule is a deliberate product policy: **only a summary compaction opens a new reminder epoch**, because
    only a summary compaction replaces a span with a new checkpoint and can free a large fraction of the window.
    Prune's small, local reduction does not qualify, even though it does shrink the measurement basis. The plugin
    states this as a choice rather than dressing it up as a fact about prune's effect on pressure.
  - The accepted consequence, stated plainly: a pressure crossing that the backend resolves by pruning alone
    leaves the epoch unmoved, so a tier that already fired in that epoch stays fired even after the session
    refills. The plugin prefers one missed reminder per epoch to a repeat loop. This is recorded as a
    non-guarantee below.
- Default tiers are **60% (notice)** and **75% (imminent)** of capacity, expressed as ratios of the capacity the
  session's route actually resolved to. They are chosen to sit below the shipped backend's default threshold
  ratio of 0.8, so that in a default deployment the notice normally arrives with room to act.
- Config carries an **assumed compaction threshold ratio** (default 0.8, matching the shipped backend's default)
  whose only jobs are to let the reading say how much room remains before the assumed threshold, and to let
  load-time validation **reject any tier at or above it**. This value is explicitly *advisory*: rc.2 exposes no
  way to read the mounted compaction backend's policy — `resolveConfig`, `resolveTargetPolicy` and
  `resolveCompactSpec` belong to `dsh-compaction-basic` itself, the policy is per exact provider/model route via
  `modelPolicies`, and `auto` can disable automatic compaction entirely. The plugin therefore validates against
  the deployment's declaration and never claims to have read the real policy. Misconfiguration fails loudly at
  plugin load, never silently producing a reminder that can never fire; the harness's existing reminder plugin
  likewise rejects invalid threshold configuration at load rather than falling back.
- The plugin does **not** re-arm from `agent/session-start`: although `SessionStartSource` includes `'clear'` and
  `'compact'` as values, rc.2's agent loop only ever publishes this event with `'startup'` or `'resume'`, so a
  design keyed to the other two would be dead code.
- The oversized-result rule is separate and simpler: a single tool result whose estimated tokens exceed a
  configured share of capacity (default 10%) produces a reminder, delivered with that result. It is **suppressed**
  when the fold shows a pressure tier reminder was committed **in the same step** as that result. That comparison
  is decidable from durable state alone: the fold's step cursor is `(turn, step)` taken from the latest
  `step/start`, and the reminder it observed was committed after that same `step/start`, so
  `pressureReminderStep === currentStep` at post-execute time means a pressure reminder is already riding this
  step. No timing heuristic or process-local flag is involved. The reverse never suppresses: a pressure reminder is
  not withheld because an oversized-result reminder was delivered, because the tier signal is once-per-epoch and
  withholding it would lose it for the whole epoch.
- Reminder state is per session and therefore per agent, so subagent sessions neither share nor suppress each
  other's reminders. That holds in both directions between a parent and a fork: the child does not read the
  parent's inherited prefix as its own state (the cut above), and the parent never sees the child's events at all,
  because a child session has its own log. A fork taken mid-turn inherits nothing from the in-flight turn either —
  `dsh-subagent-fork-in-process` seeds from the parent's completed-turn prefix, so there is no unbalanced turn for
  the fold to trip on.

### Oversized tool results: what is measured, and what is not

- The `tools/post-execute` waterfall runs **before** the tool definition's own `finalizeContent` last-mile
  transform and before the observe-only `tools/result` emit. The registry does materialize a candidate result
  around that boundary, but the plugin's input is the waterfall's `result` argument, which is the **raw,
  pre-finalization dispatch result**; the plugin measures that and says so in the reminder. It reports what the
  tool produced, not what the model will necessarily see. A tool whose `finalizeContent` shrinks its content (the
  shipped `dsh-tool-jobs` `job_output` truncates to a visible-output limit) may therefore trigger a reminder for a
  result the model receives in smaller form. The plugin accepts over-warning here and documents it rather than
  silently redefining the measurement.
- The measurement itself uses `ctx.tokenMeter.estimateMessage(...)` on a tool-result-shaped message built from
  that raw result — the only public pricing seam, since the meter's pure estimator module is not exposed as a
  package subpath. This is the sole reason the plugin injects `tokenMeter`.
- Measuring the **final model-visible** result and attaching a reminder to it is an **upstream prerequisite**:
  the only seam that observes post-`finalizeContent` content is the observe-only `tools/result` emit, which has
  no channel for attaching context, while `additionalContexts` exists only on the post-execute decision, which
  runs earlier. Until a seam exists that both sees the finalized content and can attach a message to that
  result, the plugin does not claim its oversized-result figures describe the final model-visible payload.
- The `context_status` reading is unaffected by this boundary: it prices the durable surface, whose tool-result
  nodes carry the content the model receives.

### What "compaction observed" means

The plugin reports two separate facts and never conflates them. They also have **different cuts**, and that is the
point of keeping them separate:

- **Compaction occurred in this session** — a `compaction/summary` or `compaction/prune` event in the session's
  **own suffix** (`seq >= inheritedEventCount`). Both are log-only events, so this is a statement about history
  that exists in this session, not about what the model can see. "In this session" is meant literally: a
  compaction the parent performed before forking is the parent's, not the child's, and a child reports `false`
  for it even though it can see the parent's checkpoint.
- **A compaction checkpoint is currently model-visible** — at least one surviving node of the **current surface**
  is a `user/message` whose source satisfies `isCompactCheckpointSource` (source
  `{kind: 'plugin', plugin: 'compact', compactionId}`). This fact deliberately covers the **whole** surface,
  inherited prefix included, because the model really can see an inherited checkpoint: a seeded session's
  `deriveMessages()` renders the inherited nodes, so a child's first request carries its parent's summary. A later
  compaction can shadow an earlier checkpoint, so this fact can be true and then false again while the first fact
  stays true.

The distinction is exactly "did this happen to me?" versus "is this what my history looks like now?", and the two
questions are answered from different cuts and different event sets, so neither answer stands in for the other. A
forked child can therefore honestly report "no compaction has happened in this session, and a compaction
checkpoint is part of what I can see".

This reporting rule is also wider than the reminder epoch rule, and that difference is deliberate too. A prune is
a compaction that happened and the reading reports it; it is a local, model-free surface replacement rather than a
checkpoint-bearing span replacement, so the project does not let it open a new reminder epoch. "Did compaction
occur?" and "does this event open a new reminder epoch?" are answered by different rules on purpose; see the
reminder decision core for why prune is excluded, which is a policy choice rather than a claim that prune leaves
the measurement alone.

### Configuration surface

- Config exposes: independent enable/disable for the prompt statement, the tool and the reminders; the reminder
  tiers; the oversized-result share; and the assumed compaction threshold ratio.
- Validation is strict and fails at plugin load: the assumed threshold ratio must be within (0, 1); tiers must be
  finite, strictly ascending, and within (0, 1); the oversized share must be within (0, 1); and every tier must be
  strictly below the configured assumed compaction threshold ratio. The plugin never silently clamps, drops or
  reorders a user's tiers.
- Configuration is supplied through the loader row's config block, which the harness validates against the
  plugin's declared `Config` schema before the plugin starts.

### Failure behaviour

- If the session's route exposes no capacity, the plugin reports capacity as **unknown** rather than
  substituting a default — in the tool reading, in the prompt statement ("capacity not yet known"), and in the
  reminder logic, which treats unknown capacity as "no decision" rather than as low pressure.
- If a projection is unavailable, not yet computed, or carries no provider usage sample, the plugin reports that
  state explicitly as "unknown" rather than reporting zero or falling back to composition, and the reminder logic
  treats it as "no decision" rather than as low pressure. "Not yet measured" and "measured, and low" are never
  presented as the same thing.
- If a provider sample exists but is not confirmed for the recorded route, the plugin reports pressure as
  **stale** — the figure, its `provider-anchored` provenance and the capacity are still reported, but the ratio and
  the remaining room are withheld and the reminder logic treats it as "no decision". A stale reading is never
  silently turned into a number by dividing across routes, and it is reported differently from unknown so the
  model knows that asking again later is worthwhile.
- If the session's route changes mid-session, the recorded capacity, the tool and the prompt statement converge
  on the new route within one request, and the pressure ratio follows as soon as an attributed usage sample for
  the new route lands — which is normally the same request, since the loop records the route during request
  preparation and the sample arrives with that request's settlement. The window where it does not is the one
  covered above: a route change whose first request produces no usage. Reminder state is not reset by a route
  change, so a tier that already fired in the current epoch does not re-fire merely because the denominator
  changed — which also means a route change to a *smaller* window can put the ratio above a tier that has already
  fired in that epoch without producing a reminder. That is the same once-per-epoch trade recorded below.
- A genuinely invalid configuration is the only failure that fails loudly at load; an absent, not-yet-resolved or
  route-unconfirmed measurement is reported as unknown or stale, never as a figure.

### Non-destructive boundary

- The plugin performs **no automatic context action**: it never compacts, prunes, truncates, rewrites or reorders
  existing conversation history, and it never calls the compaction engine or reads policy from it. It appends
  only messages it authors, attributed to itself. This boundary is what keeps `context-sense` safe to enable: it
  can add awareness and append its own signals, but it can never remove history or change what compaction does.

### Non-guarantees and upstream prerequisites

These are recorded so that no later reader mistakes them for commitments. Each is a real rc.2 limitation, not a
deferred task:

1. **Same-request capacity in the system prompt** — prompt assembly is given no resolved route, so the statement
   is built from the newest recorded route and is unknown on a session's first request. *(Upstream prerequisite:
   expose the resolved route — provider, model and capacity — to prompt assembly.)*
2. **Reading the mounted compaction policy** — threshold ratio, retention, per-route `modelPolicies` and `auto`
   are backend-internal and unreadable through any public seam. The plugin's threshold value is an assumption
   supplied by the operator. *(Upstream prerequisite: publish the resolved compaction policy as a service.)*
3. **Same-step crossing detection — pre-step pressure is a lagging durable projection.** The `contextPressure`
   projection is driven from *committed* session events, and at `agent/pre-step` the step's claimed messages, its
   assembled system prompt and its tool-schema changes are not yet committed. The pressure the reminder is
   decided from therefore describes the surface as of the previous step, and a reminder **cannot** be guaranteed
   to detect a crossing caused by the request the current step is about to send. Concretely:
   - a crossing caused by a very large user message claimed for this step is first visible to the plugin at the
     *next* step's pre-step (or at the next turn's, if the turn ends first) — and if the turn ends without
     another step, the plugin sees it on the following turn rather than during this one;
   - the request the reminder is injected into is slightly larger than the figure the reminder quotes, because
     the reminder is itself part of it;
   - the pressure reading is stated to the model as a measurement of committed history, not as the exact
     occupancy of the request being assembled.
   Making the reminder exact for the current request would need a seam that runs after this step's messages and
   prompt are committed but before the request is dispatched, with access to the resolved route. rc.2 has no such
   seam. *(Upstream prerequisite: expose post-commit, pre-dispatch request occupancy — or a per-step pressure
   sample — to the pre-step waterfall.)*
4. **Tier-before-compaction ordering** — `{ prepend: true }` orders the plugin's listener first in the dispatch
   list, but nothing guarantees a reminder tier is delivered strictly *before* compaction acts: the plugin's
   pressure read happens before downstream listeners run, yet `dsh-compaction-basic` runs inside the same
   waterfall and can compact during the same step, in which case the plugin suppresses the reminder entirely (see
   the control flow above; this covers the step-boundary path only, not later same-step overflow recovery, which
   is item 10). A deployment may also configure a threshold below the tier or turn `auto` off. The tiers are
   advisory signals, never a gate.
5. **Once per epoch, not once per crossing** — because the fold cannot read pressure, the plugin guarantees only
   that a tier fires at most once per compaction epoch, not once per upward crossing. Two consequences are
   accepted deliberately:
   - a session that stays above a tier receives exactly one reminder for that epoch, even if it re-crosses after
     a dip;
   - a pressure crossing that the backend resolves by pruning alone does **not** open a new epoch, so a tier that
     already fired in that epoch stays fired for the rest of it.
   `compaction/prune` is deliberately excluded from re-arming as a **policy choice**, not because it leaves
   pressure alone: a prune is itself a local surface replacement, so it does shrink the basis the ratio was
   computed from. It is excluded because it is local and model-free, frees at most one node's overage rather than
   a meaningful fraction of the window, and is often a prelude to a summary compaction — so re-arming on it would
   let a session hovering at a boundary fire-reset-fire repeatedly, the failure mode this rule exists to prevent.
   Only a summary compaction, which replaces a span with a checkpoint, opens a new epoch. *(Upstream prerequisite,
   only if exact crossing semantics are ever wanted: a durable per-step pressure sample that a pure projection
   fold can observe without re-implementing the token meter.)*
6. **Final model-visible tool-result size** — `tools/post-execute` runs before the tool definition's own
   `finalizeContent`, and the only seam that observes post-`finalizeContent` content (`tools/result`) has no
   channel for attaching context. Oversized-result reminders therefore describe the raw dispatch result, and may
   over-warn for a tool that shrinks its own output. *(Upstream prerequisite: a seam that both observes the
   finalized result and can attach a message to it.)*
7. **Metric equality** — `contextPressure.projectedTokens` and `tokenMeter.measure().totalTokens` are different
   measurements, and no guarantee is made that a tier crossing is visible in the same step's compaction decision.
8. **No heuristic-only pressure fallback** — this is a refusal, not a limitation of effort. The plugin will not
   synthesize an occupancy total from `contextBreakdown` when `contextPressure` has no provider anchor, because
   composition is computed on a different basis and is not a substitute for a total. Pressure is either
   provider-anchored or reported as unknown.
9. **No atomic pressure/capacity pair, and no harness-provided route attribution.** rc.2's
   `ContextPressureProjection` is documented in its own declaration as *not* one atomic request observation —
   three last-wins fields, each recording a different moment — and the token-meter README records the atomic-pair
   comparison as **rejected** upstream. The projection therefore carries no field saying which route a usage
   sample belongs to. The plugin's route-coherence gate is a **conservative reconstruction** from durable events
   (the newest `request/context` route against the newest `assistant/message` route that carries usage), not a
   reading of a harness guarantee, and the claim it supports is only: "the newest sample the plugin can attribute
   was produced on the currently recorded route". Consequences accepted:
   - an `assistant/attempt` event can carry a usage sample the token meter accepts while naming no route, so when
     the newest sample is one of those the reading is `stale` rather than assumed coherent;
   - a `request/context` record also appears when only `systemPromptUpdate` changed on an unchanged route, which
     can read as `stale` for one request because the log does not say which of the four recorded fields changed;
   - the human-facing meter divides the same two fields with no such gate, so in the incoherence window the
     transcript and the model reading can disagree — the plugin does not treat the UI's displayed number as
     evidence of coherence.
   *(Upstream prerequisite: publish a per-sample route identity, or make the pressure/capacity pair atomic.)*
10. **Suppression is limited to the pre-step waterfall.** A pending pressure reminder is dropped only if a
    downstream `agent/pre-step` listener commits a `compaction/summary` before that waterfall returns. A summary
    compaction that happens later in the same step — the settled case is `agent/request-error` context-overflow
    recovery, which runs after the step's `decision.messages` are already committed as `user/message` — does
    **not** retroactively remove a reminder that has been committed, and no design here attempts to. A committed
    message cannot be un-committed without rewriting history, which is outside this plugin's boundary. *(Upstream
    prerequisite, if same-step retraction were ever wanted: a pluggable commit stage, or a compaction signal
    delivered before the step's messages are committed.)*
11. **A forked child may restate a tier its parent already announced.** Because child-owned reminder state is
    rebuilt from the own suffix only, a tier the parent fired before the fork is un-fired in the child, so the
    child can emit a reminder whose text is already visible in the history it inherited. That is the deliberate
    trade: a repeated warning is recoverable, whereas inheriting the parent's fired state would silence a
    long-running fork for an entire epoch.

## Testing Decisions

- **A good test here asserts observable behaviour, never internals.** For this plugin that means: given a
  pressure and composition state and a config, what reading does the model receive, and is a reminder produced
  or not. Tests must not assert on private state, call counts of internal helpers, or the shape of intermediate
  objects.
- **Primary pure seam: the decision core, the reading projection, and the state fold.** All three are pure
  functions — (numbers, config, folded state) to a value, or (state, event) to state — carrying the interesting
  logic: tier eligibility, epoch re-arming, oversized-result suppression, validation, remaining-room arithmetic,
  route-coherence gating and provenance labelling. The projection `apply` being pure is what makes the fold
  directly unit-testable over a hand-written event list, exactly as `dsh-time-context` does: replay a log
  containing the plugin's own reminder messages and `compaction/summary` / `compaction/prune` events, and assert
  the resulting per-tier epoch state. The fold's cut is part of that seam: `init(header, inheritedEventCount)` is
  called directly with a non-zero cut and the same event list, and the test asserts which facts came from the
  inherited prefix and which did not — child-owned state unaffected by inherited compactions and inherited
  reminders, surface-history facts (recorded route, attributed sample, visible checkpoint) still spanning the
  whole log.
- **Route coherence is a pure-function property too.** The gate is a function of two route facts, so the unit
  tests cover: sample and record on the same route (coherent, ratio allowed), sample on a previous route with a
  newer record (stale, no ratio, no tier decision), a sample that cannot be attributed (stale), and no sample at
  all (unknown). A tier must not fire in either the stale or the unknown case, including when the ratio computed
  naively would exceed the tier.
- **Required integration seam: real agent-loop tests, not just registration smoke tests.** The plugin must be
  exercised against a booted loop using `@deepseek-ai/dsh-agent-loop-testkit@0.1.5-rc.2`, the version-matched,
  publicly published package (its peer dependencies pin the same `0.1.5-rc.2` packages this project develops
  against) that supplies prerequisite mounting, production agent-loop drivers and inbox stubs for exactly this
  purpose. Its `latest` dist-tag still points at an old `0.0.1-rc.1`, so the exact version must be pinned rather
  than requested by range. A deterministic model stream comes from a scripted `LlmAdapter` the tests register
  through the harness's public `ctx.llm.registerAdapter` seam: the plugin's tests need a deterministic in-process
  stream, and the separately published mock-server package is an HTTP/SSE *fault* server for provider-recovery
  tests, not a scripting seam for assembled requests. Mount the real `dsh-compaction-basic` where the test is
  about compaction.
- **Required integration coverage** — at minimum:
  - **Pressure presence**: on a session where the adapter reports no usage at all, the tool reports pressure as
    unknown (never a composition-derived total) and no tier reminder fires; once usage is reported, the figure
    appears with its provider-anchored provenance.
  - **Routing and capacity**: the prompt statement and the tool reading follow the route the loop resolved,
    including the not-yet-known state on the first request and convergence after a mid-session route change
    (a `model/selection` plus the next `request/context`).
  - **Route switch without a new sample**: switch to a route with a *different* capacity and arrange for the new
    `request/context` to be recorded while the new route never reports usage. Assert that the tool reports the
    pressure figure as stale with no ratio and no remaining room (not the old sample divided by the new window),
    that capacity itself is still reported as the new route's, and that no tier reminder fires even when the naive
    ratio would cross a tier. Then let the adapter report usage on the new route and assert the ratio returns.
    Cover the adapter that never reports usage at all as the terminal case of the same test.
  - **Epoch re-arm**: with a compaction backend mounted at a threshold that can be crossed in a test session,
    assert that a tier fires once, that the reminder is suppressed on the step where a summary compaction
    actually runs **inside the pre-step waterfall**, that a tier is eligible again only after the real
    `compaction/summary` event, and that the test does not depend on a `'compact'` `agent/session-start` source,
    which never fires.
  - **Overflow recovery does not retract a reminder**: drive a step that both decides a pressure reminder and then
    fails its request with the provider's context-window error, so `agent/request-error` recovery commits a
    `compaction/summary` after the reminder is already durable. Assert the reminder is still in the session log
    and still on the surface — no retroactive removal, which is the documented non-guarantee — and that the tier is
    eligible again in the new epoch. Asserting the *absence* of the reminder here would be asserting the wrong
    contract.
  - **Prune does not re-arm**: emit or induce `compaction/prune` without a `compaction/summary` (the shipped
    pruner applied to an oversized tool result is the natural way), and assert the tier stays fired — in
    particular that a step which would have re-fired it does not. The test asserts the state-machine rule, not
    that prune left pressure unchanged: it does change it, and the test must not encode the opposite.
  - **Pre-step lag**: assert the documented limit rather than wishing it away — cross a tier *only* by a user
    message claimed for the current step, and assert the reminder arrives at the following pre-step rather than
    during the step that carried the message.
  - **Tool finalization**: with a tool whose `finalizeContent` shrinks its content, assert what the
    oversized-result rule measured and what the reading reports, pinning the documented pre-finalization basis.
  - **Resume**: create a session, cross or compact, then resume, and assert the folded reminder state matches
    the durable session log — no repeated reminder, no skipped tier.
  - **Fork isolation**: fork a parent whose log already contains a `compaction/summary` and a fired tier reminder
    (the natural setup is a parent that crosses a tier and then compacts), then run the child. Assert: the child's
    epoch starts at 0, the inherited reminder is still on the child's surface and still visible in
    `deriveMessages()`, the child fires its own tier reminder rather than being suppressed by the parent's, the
    child reports "no compaction has occurred in this session" while reporting that a checkpoint is model-visible,
    and the parent's own state is untouched. Assert this against a session built with a non-zero
    `inheritedEventCount` rather than by asserting on session ids or any host-side map.
  - **Subagent**: a subagent session gets its own capacity statement, reading and reminder state, and one agent's
    reminders neither suppress nor trigger another's.
  - **Unload**: after disposing the plugin, the prompt section is absent from assembly, the tool is no longer
    registered, the listeners no longer fire, and the plugin's host-side state is gone —
    `sessionProjections.stateOf(session, '<plugin key>') === undefined`. The check is `stateOf`, not
    `snapshot(...)`: this unit is registered host-only, so it never appeared in a client snapshot in the first
    place and asserting its absence there would pass before the plugin was ever loaded.
- **Secondary seam: a registration/lifecycle smoke test** remains useful — booting the plugin against a minimal
  context holding one agent, and asserting exactly one prompt section, one tool, two listeners and one projection
  unit are registered. The counting is per registration scope and that is part of what the test pins: the section
  and the tool are installed once per agent through that agent's scoped `inject`, while the two listeners and the
  projection unit are registered once on the plugin's own context. It catches a plugin that works but is never
  wired in; it is not a substitute for the integration coverage above.
- **Prior art to follow.** The human-facing context meter computes occupancy in its own occupancy helper as
  `projectedTokens ?? pressureTokens` from the pressure projection and returns nothing until both the numerator
  and the capacity are known, clamping the displayed ratio at 100%; the numerator and denominator the reading here
  uses are the same two fields, so the arithmetic must be mirrored rather than reinvented. Agreement is claimed
  for the arithmetic, **not** for the display: the human meter has no route-coherence gate, so in the window where
  rc.2 pairs a new capacity with an old route's pressure it will keep showing a number while the model reading
  says `stale`. That divergence is intentional and asserted by the route-switch test; the human UI showing a
  figure is not evidence that the model may treat the pair as coherent. `dsh-time-context` is the prior art for
  most of the plugin shape this project reuses: a host-only projection whose key is declaration-merged into
  `SessionProjectionStateMap`, a pure fold that recognizes its own durable `user/message` sources, a
  `{ prepend: true }` pre-step listener that reads the state with `stateOf`, and delivery by appending to the
  returned decision's `messages`. For the fork cut specifically, `dsh-schedule` is the prior art — it takes the
  exact `inheritedEventCount` in `init`, stores it in state, guards `apply` with `event.seq <
  state.inheritedEventCount`, and documents that a fork folds only `ownEvents()` so a child never inherits its
  parent's reminders. `dsh-time-context` is deliberately **not** the prior art here: its `init` takes no cut and
  its `apply` has no `seq` guard, so it folds a fork's inherited prefix as if it were the child's own history.
  The plugin copies that plugin's registration, read and delivery shape, and takes the cut from `dsh-schedule`.
  The token metering package's estimator is likewise a pure module, and the harness's
  repeat-call reminder is the prior art for load-time fail-loud threshold validation and for attaching a
  plugin-sourced `additionalContexts` message at post-execute.
- **Not tested at this seam:** the harness's own hook dispatch, prompt assembly, tool registration or message
  injection. The integration tests assert what the plugin contributes through those contracts; the contracts
  themselves are the host's to test.
- The repo currently has no package scaffold, test runner or build. Establishing them is part of the first
  implementation ticket rather than a design question: the layout, module boundaries and seams are all fixed
  above, and only tooling selection is left open there.

## Out of Scope

- **Automatic context action** — compacting, pruning, truncating, rewriting or reordering history; and any
  interaction with the compaction engine beyond observing that a compaction occurred. Explicitly excluded when
  this effort was scoped; the plugin is advisory by design.
- **Reading or changing the mounted compaction policy** — its threshold, retention, per-model overrides or
  `auto` setting. The plugin validates against an operator-supplied assumption and reports headroom relative to
  it.
- **A `/context` slash command.** The human already has a context meter in the conversation UI, built on the same
  two projection fields. A command would duplicate existing UI for no new capability; it would also be the only
  part of this plugin aimed at the human rather than the model. The UI is not a substitute for the model reading
  either, in the one place they genuinely differ: the UI has no route-coherence gate, so it can display a ratio
  across a route change while the model reading reports the pairing as stale.
- **Client/UI contributions** — a new meter, badge, panel or renderer. The existing meter already serves the
  human, and reminders reach the transcript through ordinary injected messages.
- **Provider-accurate tokenization.** No tokenizer ships in the harness, and adding one is a different effort
  with a different risk profile. This plugin reports the harness's own estimate for the parts that are estimates,
  and reports what the provider and the route actually said for the parts that are not, clearly labelled.
- **Establishing reminder state from pressure history.** Reconstructing a pressure crossing (rather than a
  once-per-epoch firing) would require either a durable per-step pressure sample in the session log or the plugin
  re-implementing the token meter's fold. Both are out of scope here; the exact-crossing semantics are recorded
  as an upstream prerequisite instead.
- **A transcript or session-log search tool.** The absence of one was noticed during research but is unrelated to
  context awareness.
- **Cost, billing or quota reporting.** The harness deliberately treats occupancy as a reference figure rather
  than a billing record, and no per-session budget or cost gate exists in the accounting path.

## Further Notes

- **Orientation numbers.** Route capacities vary by deployment — the shipped first-party adapters advertise
  different windows from each other and from a user's provider profile, which is precisely why capacity is read
  from the route rather than hard-coded in a table. Any capacity figure quoted in an earlier draft of this spec
  was an observation of one profile at charting time and is not part of the contract.
- **Figures are of three kinds, and only two of them are approximations.** Capacity is route metadata, not an
  estimate. The pressure anchor is what the provider reported for an actual request, not an estimate. What the
  harness estimates is the projection delta on top of that anchor, the composition, and the oversized-result
  measurement — all with a fixed four-characters-per-token heuristic plus block and role overheads, which
  systematically underprices CJK text and JSON schemas. Reminders and readings must therefore phrase the estimated
  parts as approximations ("about 70% of the window"), name capacity as the route's window, and never present an
  estimated figure as exact.
- **Version sensitivity.** These decisions were established against harness `dsh-v0.1.5-rc.2`. The surfaces
  relied on are the session-projection registry (including the host-only registration path, the `init` fork-cut
  argument and the `stateOf` read face), the token-meter projections and the presence rule for `projectedTokens`
  together with the documented non-atomicity of `contextPressure`'s three fields, the `snapshot` read face,
  `session.requestContext()`, the `request/context` record condition, the `assistant/message` settlement's
  `source` route labels and optional `usage` (and the absence of the same on `assistant/attempt`),
  `Session.inheritedEventCount` / `ownEvents()` / `isOwnSeq()` and the fork seed cut taken at the parent's last
  `turn/end`, the system-prompt section registry, the tool registry and its `output`/`render` contract, the
  `agent/pre-step`, `agent/request-error` and `tools/post-execute` waterfalls together with the loop's commit
  order around `pre-step` and the point at which `request-error` is dispatched, Cordis's `{ prepend: true }` and
  outermost-first `waterfall` ordering, the plugin-scoped message source vocabulary, the `step/start`/`step/end`
  event fields, and the `compaction/*` event family with `isCompactCheckpointSource`. The project should record
  the harness version it develops against and treat changes to those surfaces as breaking — in particular a
  change to `pre-step` commit ordering, to waterfall listener order, to the `request/context` append condition, or
  to any settlement event's route labels would invalidate the control-flow and route-coherence sections above.
  Two of those are the kind of change that would *simplify* this design rather than break it, and the spec says so
  deliberately: an atomic pressure/capacity pair, or a per-sample route identity, would let the route-coherence
  gate be replaced by a direct read (non-guarantee 9).
- **Research assets** gathered while charting this effort, both written against an earlier harness tree and
  therefore superseded wherever they conflict with the rc.2 contracts above:
  - `.scratch/dsh-context-token-audit/report.md` — context window, token accounting, projections, truncation
    caps, compaction, prompt assembly and persistence.
  - `.scratch/dsh-extension-points/research-report.md` — the event/hook system, which hooks can mutate what, and
    the exact injection mechanisms with worked examples.
- **Next step.** Implementation tickets are the normal next workflow; the user-invoked `to-tickets` skill
  produces them. It must be invoked explicitly by the user.
