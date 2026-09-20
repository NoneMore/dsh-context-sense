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

The asymmetry is the whole problem: the harness measures context pressure continuously and acts on it
automatically, but the party whose behaviour most depends on that measurement is the only one not informed of
it.

## Solution

A DeepSeek Harness plugin, `context-sense`, that gives the model the context awareness the human already has.
It has three parts:

1. **Standing knowledge.** A stable system-prompt statement of the session's context window capacity, so the
   model knows the size of the space it is working in once the harness has resolved one for the session.
2. **On-demand reading.** A `context_status` tool the model can call at any moment to learn current context
   pressure (labelled as an estimate), the pressure ratio, remaining room, and how the request divides between the
   system prompt, tool definitions and conversation messages.
3. **Advisory pressure signals.** `<system-reminder>` messages injected into the conversation when the
   estimated pressure ratio crosses a configured tier, or when a single tool result is oversized — so the model
   can change course (tighten output, externalise notes, tell the user) with room to act.

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
6. As a model, I want the capacity statement to name the tool I can use for live figures, so that I know how to
   get more detail when I need it.

### Reading the live figure on demand

7. As a model, I want a tool that reports my current estimated context pressure, so that I can decide whether to
   keep working in-context or to externalise state.
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
13. As a model, I want that tool to tell me the basis of its figure and that the figure is an estimate, so that
    I do not treat it as exact accounting.
14. As a model, I want that tool to tell me whether a compaction has occurred in this session at all, and
    separately whether a compaction checkpoint is still part of what I can currently see, so that I can tell
    "this happened" apart from "this is what my history looks like now".
15. As a model, I want that tool to distinguish a figure anchored on real provider usage from one derived purely
    from the harness's heuristic estimate, so that I can calibrate my trust in it.

### Being warned before it is too late

16. As a model approaching a context tier, I want an unsolicited reminder stating my estimated pressure and
    ratio, so that I can change course without having to remember to ask.
17. As a model, I want reminders to be configured at a tier well below the compaction threshold the deployment
    is assumed to run, so that the warning is normally actionable rather than a notification that the decision
    has already been made for me.
18. As a model, I want a distinct, more urgent reminder at a second tier, so that "you are filling up" and
    "compaction is imminent" are different signals.
19. As a model, I want each tier to fire once per crossing rather than on every step, so that reminders do not
    themselves consume the budget they are warning about.
20. As a model, I want a tier to re-arm after a compaction has rewritten my history, so that a session that
    compacts and then refills is warned again.
21. As a model, I want a reminder to tell me concretely what I can do about it, so that the warning is
    actionable rather than merely alarming.
22. As a model whose single tool result was large, I want to be told immediately after that result, so that I
    can avoid repeating the same oversized call.
23. As a model, I want an oversized-result reminder to be suppressed when a pressure reminder is already being
    delivered for the same moment, so that I do not receive two overlapping warnings.

### The human's side

24. As a user, I want context reminders to appear in the transcript, so that I can see the same pressure picture
    my model sees and intervene.
25. As a user, I want to be able to configure the reminder tiers, so that I can tune when I want to be
    interrupted.
26. As a user, I want to be able to disable pressure reminders while keeping the tool, so that I can have
    on-demand readings without injected messages.
27. As a user, I want to be able to disable the system-prompt statement, so that I can keep my prompt minimal if
    I do not want it.
28. As a user, I want a configuration mistake to fail loudly at plugin load, so that I never silently run with
    reminders that can never fire.
29. As a user, I want the plugin to validate my tiers against the compaction threshold **I declare for it**, and
    to be told that this declaration is an assumption about the mounted backend rather than a reading of it, so
    that I do not mistake an advisory check for a guarantee about my deployment.
30. As a user, I want the plugin to never alter my conversation on its own initiative beyond appending its own
    attributed reminders, so that enabling it cannot destroy history.

### Operating conditions

31. As an operator, I want a capacity figure that is unavailable to be reported as unknown rather than
    defaulted to a guess, so that the model is never given a fabricated window size.
32. As an operator, I want the plugin to work for every agent that inherits its registrations, including
    subagents, so that delegated work also knows its budget.
33. As an operator, I want the plugin to unload cleanly, removing its prompt section, its tool, its listeners
    and its session state, so that disabling it leaves no residue.
34. As an operator, I want the plugin to be loadable from a local path without publishing to a registry, so that
    I can evaluate it before sharing it.
35. As an operator, I want a package that can also be enabled as a bundle from a profile, so that turning it on
    is one entry rather than hand-written loader rows.
36. As an operator running a provider whose capacity differs from the shipped model catalogue, I want the
    reading to use the capacity of the route the harness actually resolved for the session, so that I do not
    need to maintain a model table.
37. As a maintainer, I want the reminder decision logic to be testable without a booted harness, so that I can
    verify thresholds and re-arming cheaply.
38. As a maintainer, I want reminder state to be reconstructible from the durable session log, so that a resumed
    session neither repeats nor skips reminders.
39. As an operator, I want the capacity statement to reach agents that are already running when the plugin loads,
    so that enabling it in a live process does not silently skip the sessions already in flight.

## Implementation Decisions

### Harness baseline and the surfaces this plugin relies on

Verified against `dsh-v0.1.5-rc.2`:

| Surface | Package | Contract used here |
|---|---|---|
| Projection registry | `dsh-session-projection` | `ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply })` (a host-only unit when `wire` is omitted), `.stateOf(session, key)`, `.snapshot(session, keys)` |
| Pressure projection | `dsh-token-meter` | `contextPressure`: `pressureTokens?`, `projectedTokens?`, `contextWindow?` |
| Composition projection | `dsh-token-meter` | `contextBreakdown`: `systemTokens`, `toolsTokens`, `messageTokens` |
| Recorded route | `dsh-session` | `session.requestContext(): RequestContext \| undefined` (`provider`, `model`, `contextWindow?`, `systemPromptUpdate?`) |
| Session log / surface | `dsh-session` | `session.snapshotEvents()`, `session.surface`, `session.deriveMessages()`, and the `session/event` notification |
| Agent registry | `dsh-agent` | `ctx.agents.list()`, `agent/created` and `agent/disposed`, and per-agent scoped `inject` for scoped prompt/tool contributions |
| Prompt registry | `dsh-system-prompt` | `ctx.systemPrompt.section({ name, order, text })` |
| Tool registry | `dsh-tools` | `defineTool({ name, description, parameters, output: { schema, render }, ... })`, `ctx.tools.register(...)` |
| Pre-step seam | `dsh-agent` / `dsh-agent-loop` | `agent/pre-step` waterfall: `{ agent, messages, turn, step, signal }` → decision whose `messages` enter the step |
| Tool-result seam | `dsh-tools` | `tools/post-execute` waterfall returning `PostToolDecision` with `additionalContexts?: UserMessage[]` |
| Message vocabulary | `dsh-llm` | `createUserMessage`, `MessageSourceMap['plugin']` with `ContextFormed` (`'snapshot'` + `sections`, `'notice'` + `summary`), `boundContextSummary` |
| Compaction lifecycle | `dsh-compaction`, `dsh-compaction-basic` | log-only `compaction/start`, `compaction/summary`, `compaction/end`, `compaction/prune`; the replacement is one `user/message` whose source is recognized by `isCompactCheckpointSource` (exported from `@deepseek-ai/dsh-compaction/checkpoint`) |

The plugin is a standard Cordis plugin module exporting `name`, `inject`, `Config` and `apply(ctx, config)`
(the shape `dsh-time-context` and `dsh-repeat-tool-reminder` use — `export { Config, apply, inject, name }`).
It declares the services it needs (`sessionProjections`, `systemPrompt`, `tools`) through `inject` rather than
assuming them, so a composition missing one fails at load instead of misbehaving later.

Source is TypeScript compiled to an ESM `lib/` output with emitted declarations, matching the first-party
package layout, with the SDK packages declared as peer dependencies. The package additionally ships a bundle
patch declaring a loader row for itself, so a profile can enable it by listing the package in its bundle
composition instead of hand-writing a patch row. A local absolute path or file URL is a valid loader-row name,
so no registry publish is required to evaluate it.

### Where the numbers come from

- **Capacity** is `contextWindow` of the newest route the harness has recorded for the session —
  `session.requestContext()?.contextWindow`, which the agent loop writes as a `request/context` event when the
  prepared request's provider, model, capacity or prompt-update mode differs from the previous record.
  (`contextPressure.contextWindow` carries that same recorded value, so a reading can take capacity and pressure
  from one projection snapshot instead.) Capacity belongs to the route, not to the session: a session that
  switches model has a different capacity, and the recorded value is a record of the last resolved route, not a
  promise about the next one.
- **Pressure** is read from the `contextPressure` projection, preferring `projectedTokens` and falling back to
  `pressureTokens` (`projectedTokens ?? pressureTokens`). This is the same rule the human-facing conversation UI
  uses (`dsh-client-ui-conversation`), so model and human see the same figure. `pressureTokens` is the newest
  provider-reported prompt size; `projectedTokens` is that sample plus the heuristic re-pricing of the surface's
  signed movement since it, so the figure stays anchored to the provider while still reacting when a compaction
  shadows a span.
- **Composition** is read from the `contextBreakdown` projection. It is a heuristic estimate of what the request
  is *made of*, computed on a basis of its own; it is **not** the provider-anchored pressure figure and is not
  expected to sum to it. The plugin presents it as approximate composition, never as a total.
- **Pressure and compaction's own measurement are different metrics.** The compaction backend decides from
  `ctx.tokenMeter.measure()`, whose `totalTokens` is route-priced request-and-response pressure over the current
  surface. `contextPressure.projectedTokens` is provider-anchored with a heuristic delta, and is not
  interchangeable with it. The plugin reports the projection figure and never claims to reproduce, predict or
  verify the number the compaction backend used.
- **No new token accounting is introduced.** Every figure is an estimate under the meter's fixed
  characters-per-token heuristic (plus declared visual-token pricing for images on routes that declare it), and
  every model-facing figure is labelled as an approximation with its basis (`provider-anchored` when derived
  from a provider usage sample, `heuristic-only` otherwise).

### The system-prompt statement

- The capacity statement is registered as a single named prompt section whose text is recomputed at each
  assembly for one agent's scope. It is registered **per agent**, closing over that agent's session so it can read
  the session's recorded route synchronously at assembly time; a global section could not tell which session it
  was assembled for (`AssembleContext` carries only `{ scope, signal }`). Registration follows the harness's own
  file-reference plugin: install for every agent the registry already holds, and install for each agent announced
  afterwards (`agent/created`), each registration made through the agent's own scoped `inject` of the prompt and
  tool services and each held as a disposer tied to that agent. Installing only on session start would silently
  skip agents that were already live when the plugin loaded.
- Its text is a short paragraph: the capacity in tokens when known, that a tool exists for live figures, the
  configured reminder tiers, and the fact that the compaction threshold it names is an assumed policy value. It
  sits at a fixed order chosen to fall after the harness identity and the deployment persona prefix and ahead of
  the policy and tool sections, so the statement reads as standing self-knowledge rather than as tool guidance;
  the harness centrally allocates orders only to its own sections, so this plugin owns this one value.
- **The section contains capacity only — never live pressure.** This is a correctness requirement, not a caching
  preference, and it holds under both of the harness's prompt-reconciliation modes. The agent loop reconciles
  the rendered prompt against the surviving `system/message` nodes each attempt: when the prepared route
  declares `systemPromptUpdate: 'in-history'` and the text has changed, a fresh system message is **appended**;
  otherwise the head node is **replaced in place**. A section carrying live pressure would therefore either
  append a new system message on every step — consuming the very budget it reports — or rewrite the request
  prefix on every step and invalidate the provider's cache. Capacity changes only when the route changes, so
  the statement stays stable within a route and the live figure travels only by tool call and reminder.
- **A prompt that is one complete section drops the statement.** Registration is per agent scope, so a preset
  that supplies its own prompt normally coexists with this section; but the harness restores a single *complete*
  section as the sole prompt section after assembly (an SDK profile that replaces the persona wholesale does
  this). In such a deployment the capacity statement does not appear, while the tool and the reminders are
  unaffected.
- **Capacity guarantee (lowered deliberately).** The statement names a real capacity only once the harness has
  resolved one for the session. It therefore states that capacity is not yet known on a session's first request,
  and it may state the previous route's capacity for at most one request after a model switch — while the
  harness's next `request/context` record catches up. The section is rewritten by the loop's ordinary
  reconciliation once the recorded route changes, so the correction is automatic and costs no new mechanism.
  Stating the exact capacity of the route being assembled, on the first request and immediately after a switch,
  is an **upstream prerequisite**: rc.2's `AssembleContext` exposes no route, and `ctx.llm.resolveModelInfo()` /
  `prepareCall()` are asynchronous and require an explicit provider/model that prompt assembly is not given.

### The `context_status` tool

- One tool, parameterless (`parameters: {}`), that serves the context query — a context reading the model asks
  for deliberately, at a moment of its own choosing — registered under a name that does not collide with a
  built-in.
- Its canonical output is a structured JSON value declared as the tool's `output.schema` — capacity,
  capacity-known flag, pressure, remaining, ratio, composition, pressure basis, route/basis labelling, estimate
  flag, and the two compaction facts — and a separate pure `output.render(args, value)` projects that value into
  the model-facing text. Declaring the canonical value and rendering it separately is the harness's own
  convention, not an invention of this plugin.
- The model-facing text is compact and states: estimated pressure of capacity (or that capacity is unknown), the
  ratio as a percentage, remaining tokens, the three-way composition labelled approximate, the basis and its
  approximation, and the two compaction facts.
- The tool reads live session state at call time through `exec.agent.session` (the loop sets the calling agent on
  every tool execution), so it is correct on repeated calls within a single turn. An execution that carries no
  agent reports the reading as unknown rather than failing.
- The tool writes nothing: it does not append events, inject messages, or mutate projections.

### Where reminders are observed and how they are delivered

The plugin attaches to **two** harness observation points, feeding **one** shared decision core:

- **Pressure tier reminders** are evaluated on the `agent/pre-step` waterfall, the same seam the compaction
  backend's automatic trigger uses. The listener delegates with `next()` and then appends its message to the
  returned decision's `messages`, which is how the harness's own time-context injector delivers an
  unconditional per-step message. It is registered with `{ prepend: true }`, the ordering the same first-party
  plugin uses, so the evaluation runs before listeners registered later. Tier evaluation happens once per step,
  so a large tool output earlier in the same turn is reflected before the next request.
- **Oversized tool-result reminders** are evaluated on the `tools/post-execute` waterfall, where the dispatch
  result is in hand and its size can be measured directly. Delivery rides the decision's
  `additionalContexts?: UserMessage[]`, the same mechanism `dsh-repeat-tool-reminder` uses to attach a
  plugin-attributed message to that result.

Both delivery paths produce the same artifact: a **user-role message attributed to the plugin**, carrying the
reminder text inside a `<system-reminder>` frame that the plugin owns and escapes correctly. The message
declares the harness's context form that matches its shape — `form: 'snapshot'` with named `sections` for a
reading, `form: 'notice'` with a `summary` bounded by `boundContextSummary` for a one-line account — which is
what makes the reminder render as an attributed row in the transcript and therefore visible to the human as well
as the model. The harness has no shared reminder-framing helper; the plugin implements and owns its own.

The reminder text is bounded: it previews no raw payloads, only names and sizes, so a reminder about a large
tool output cannot itself be large.

### The reminder decision core

- The decision core is a **pure function** of (measured pressure and known capacity, the plugin's config, and the
  reminder state folded for this session) returning either "no reminder" or "a reminder at tier N with this
  text". Purity here is the testing seam; it also keeps both observation points behaviourally identical.
- **Reminder state lives in the plugin's own session projection**, registered through
  `ctx.sessionProjections.register(...)` as a host-only unit whose `apply` is a pure fold over committed session
  events. The fold records which tiers have fired and records every compaction replacement it observes. Because
  the state is a pure function of the durable session log, it is reconstructed identically after a resume, a
  replay or a fork instead of relying on process-local memory.
- Default tiers are **60% (notice)** and **75% (imminent)** of capacity, expressed as ratios of the capacity the
  session's route actually resolved to. They are chosen to sit below the shipped backend's default threshold
  ratio of 0.8, so that in a default deployment the notice normally arrives with room to act.
- Config carries an **assumed compaction threshold ratio** (default 0.8) whose only jobs are to let the reading
  say how much room remains before the assumed threshold, and to let load-time validation **reject any tier at
  or above it**. This value is explicitly *advisory*: rc.2 exposes no way to read the mounted compaction
  backend's policy — `resolveConfig`, `resolveTargetPolicy` and `resolveCompactSpec` belong to
  `dsh-compaction-basic` itself, the policy is per exact provider/model route via `modelPolicies`, and `auto`
  can disable automatic compaction entirely. The plugin therefore validates against the deployment's declaration
  and never claims to have read the real policy. Misconfiguration fails loudly at plugin load, never silently
  producing a reminder that can never fire; the harness's existing reminder plugin likewise rejects invalid
  threshold configuration at load rather than falling back.
- A tier fires **once per crossing**, and **re-arms on the compaction lifecycle the harness actually emits**:
  the fold observes `compaction/summary` and `compaction/prune` (the surface-replacement events that reduce
  history) and re-arms the tiers for that session, because the numerator and the retained span have both been
  rewritten. A tier is also re-armed by a fall below the tier by a small hysteresis margin, so a session
  hovering at a boundary is not warned repeatedly.
  The plugin does **not** re-arm from `agent/session-start`: although `SessionStartSource` includes `'compact'`
  as a value, `dsh-agent` documents `'clear'`/`'compact'` as reserved with no emitter, so a design keyed to them
  would be dead code.
- The oversized-result rule is separate and simpler: a single tool result whose estimated tokens exceed a
  configured share of capacity (default 10%) produces a reminder, delivered with that result. If a pressure tier
  reminder is being delivered for the same moment, the oversized-result reminder is suppressed so the model is
  not handed two overlapping warnings; the reverse does not suppress, because the result-specific reminder
  carries information the pressure reminder does not.
- Reminder state is per session and therefore per agent, so subagent sessions neither share nor suppress each
  other's reminders.

### Oversized tool results: what is measured, and what is not

- The `tools/post-execute` waterfall runs **before** the tool definition's own `finalizeContent` last-mile
  transform, which the registry then applies before the result is materialized and observed by `tools/result`.
  The plugin therefore measures the **raw, pre-finalization dispatch result** and says so in the reminder: it
  reports what the tool produced, not what the model will necessarily see. A tool whose `finalizeContent` shrinks
  its content (the shipped `dsh-tool-jobs` `job_output` truncates to a visible-output limit) may therefore
  trigger a reminder for a result the model receives in smaller form. The plugin accepts over-warning here and
  documents it rather than silently redefining the measurement.
- Measuring the **final model-visible** result and attaching a reminder to it is an **upstream prerequisite**:
  the only seam that observes post-`finalizeContent` content is the observe-only `tools/result` emit, which has
  no channel for attaching context, while `additionalContexts` exists only on the post-execute decision, which
  runs earlier. Until a seam exists that both sees the finalized content and can attach a message to that
  result, the plugin does not claim its oversized-result figures describe the final model-visible payload.
- The `context_status` reading is unaffected by this boundary: it prices the durable surface, whose tool-result
  nodes carry the content the model receives.

### What "compaction observed" means

The plugin reports two separate facts and never conflates them:

- **Compaction occurred in this session** — the durable session log contains a `compaction/summary` or
  `compaction/prune` event. Log-only events, so this is a statement about history that exists in the session, not
  about what the model can see.
- **A compaction checkpoint is currently model-visible** — at least one surviving surface node is a `user/message`
  whose source satisfies `isCompactCheckpointSource` (source `{kind: 'plugin', plugin: 'compact', compactionId}`).
  A later compaction can shadow an earlier checkpoint, so this fact can be true and then false again while the
  first fact stays true.

### Configuration surface

- Config exposes: independent enable/disable for the prompt statement, the tool and the reminders; the reminder
  tiers; the oversized-result share; the assumed compaction threshold ratio; and whether the capacity statement
  is included.
- Validation is strict and fails at plugin load: tiers must be finite, strictly ascending, and within (0, 1); the
  oversized share must be within (0, 1); and every tier must be strictly below the configured assumed compaction
  threshold ratio. The plugin never silently clamps, drops or reorders a user's tiers.
- Configuration is supplied through the loader row's config block, which the harness validates against the
  plugin's declared `Config` schema before the plugin starts.

### Failure behaviour

- If the session's route exposes no capacity, the plugin reports capacity as **unknown** rather than
  substituting a default — in the tool reading, in the prompt statement ("capacity not yet known"), and in the
  reminder logic, which treats unknown capacity as "no decision" rather than as low pressure.
- If a projection is unavailable or not yet computed for a session, the tool reports that state explicitly as
  "unknown" rather than reporting zero, and the reminder logic treats it as "no decision" rather than as low
  pressure.
- If the session's route changes mid-session, the recorded capacity, the tool and the prompt statement converge
  on the new route within one request; reminder state is preserved, so a tier does not re-fire merely because
  the denominator changed.
- A genuinely invalid configuration is the only failure that fails loudly at load; an absent or not-yet-resolved
  measurement is reported as unknown.

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
3. **Tier-before-compaction ordering** — the plugin's listener can be ordered ahead of listeners registered
   later, but nothing guarantees a reminder tier is delivered strictly before compaction acts: a deployment may
   configure a threshold below the tier, `auto` may be off, and both may fire in the same step. The tiers are
   advisory signals, not a gate.
4. **Final model-visible tool-result size** — no seam both observes post-`finalizeContent` content and can attach
   a message to that result. *(Upstream prerequisite, as above.)*
5. **Metric equality** — `contextPressure.projectedTokens` and `tokenMeter.measure().totalTokens` are different
   measurements, and no guarantee is made that a tier crossing is visible in the same step's compaction decision.

## Testing Decisions

- **A good test here asserts observable behaviour, never internals.** For this plugin that means: given a
  pressure and composition state and a config, what reading does the model receive, and is a reminder produced
  or not. Tests must not assert on private state, call counts of internal helpers, or the shape of intermediate
  objects.
- **Primary pure seam: the decision core, the reading projection, and the state fold.** All three are pure
  functions — (numbers, config, folded state) to a value, or (state, event) to state — carrying the interesting
  logic: tier crossing, re-arming, hysteresis, suppression, validation, remaining-room arithmetic and estimate
  labelling. The projection `apply` being pure is what makes the fold directly unit-testable over a hand-written
  event list, exactly as `dsh-time-context` does.
- **Required integration seam: real agent-loop tests, not just registration smoke tests.** The plugin must be
  exercised against a booted loop using `@deepseek-ai/dsh-agent-loop-testkit@0.1.5-rc.2`, the version-matched,
  publicly published package that supplies prerequisite mounting, production agent-loop drivers and inbox stubs
  for exactly this purpose. A deterministic model stream comes from a scripted `LlmAdapter` the tests register
  through the harness's public `ctx.llm.registerAdapter` seam; the tests do **not** depend on
  `@deepseek-ai/dsh-llm-mock-server`, which is published only at `0.0.1-rc.1` with restricted access. Mount the
  real `dsh-compaction-basic` where the test is about compaction.
- **Required integration coverage** — at minimum:
  - **Routing and capacity**: the prompt statement and the tool reading follow the route the loop resolved,
    including the not-yet-known state on the first request and convergence after a mid-session route change
    (a `model/selection` plus the next `request/context`).
  - **Compaction ordering and re-arm**: with a compaction backend mounted at a threshold that can be crossed in
    a test session, assert the reminder behaviour on the crossing step and assert that tiers re-arm from the
    real `compaction/*` lifecycle — and that the test does not depend on a `'compact'` `agent/session-start`
    source, which never fires.
  - **Tool finalization**: with a tool whose `finalizeContent` shrinks its content, assert what the
    oversized-result rule measured and what the reading reports, pinning the documented pre-finalization basis.
  - **Resume**: create a session, cross or compact, then resume, and assert the folded reminder state matches
    the durable session log — no repeated reminder, no skipped tier.
  - **Subagent**: a subagent session gets its own capacity statement, reading and reminder state, and one agent's
    reminders neither suppress nor trigger another's.
  - **Unload**: after disposing the plugin, the prompt section is absent from assembly, the tool is no longer
    registered, the listeners no longer fire, and the plugin's projection key is gone from
    `sessionProjections.snapshot(...)`.
- **Secondary seam: a registration/lifecycle smoke test** remains useful — booting the plugin against a minimal
  context and asserting exactly one prompt section, one tool, two listeners and one projection unit are
  registered. It catches a plugin that works but is never wired in; it is not a substitute for the integration
  coverage above.
- **Prior art to follow.** The human-facing context meter computes occupancy as `projectedTokens ??
  pressureTokens` from the pressure projection and returns nothing until both the numerator and the capacity are
  known, clamping the displayed ratio at 100%; that is exactly the shape of the reading projection here, and its
  conventions must be mirrored so model and human figures agree. The token metering package's estimator is
  likewise a pure module, and the harness's repeat-call reminder is the prior art for load-time fail-loud
  threshold validation and for attaching a plugin-sourced `additionalContexts` message at post-execute.
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
- **A `/context` slash command.** The human already has a context meter in the conversation UI showing the same
  pressure figure. A command would duplicate existing UI for no new capability; it would also be the only part of
  this plugin aimed at the human rather than the model.
- **Client/UI contributions** — a new meter, badge, panel or renderer. The existing meter already serves the
  human, and reminders reach the transcript through ordinary injected messages.
- **Provider-accurate tokenization.** No tokenizer ships in the harness, and adding one is a different effort
  with a different risk profile. This plugin reports the harness's own estimate, clearly labelled.
- **A transcript or session-log search tool.** The absence of one was noticed during research but is unrelated to
  context awareness.
- **Cost, billing or quota reporting.** The harness deliberately treats occupancy as a reference figure rather
  than a billing record, and no per-session budget or cost gate exists in the accounting path.

## Further Notes

- **Orientation numbers.** Route capacities vary by deployment — the shipped first-party adapters advertise
  different windows from each other and from a user's provider profile, which is precisely why capacity is read
  from the route rather than hard-coded in a table. Any capacity figure quoted in an earlier draft of this spec
  was an observation of one profile at charting time and is not part of the contract.
- **Estimated figures are the only figures available.** The harness prices model-visible messages with a fixed
  four-characters-per-token heuristic plus block and role overheads, and that heuristic systematically
  underprices CJK text and JSON schemas. Reminders and readings must therefore be phrased as approximations
  ("about 70% of the window"), and nothing in this plugin may present a figure as exact.
- **Version sensitivity.** These decisions were established against harness `dsh-v0.1.5-rc.2`. The surfaces
  relied on are the session-projection registry, the token-meter projections, `session.requestContext()`, the
  system-prompt section registry, the tool registry and its `output`/`render` contract, the `agent/pre-step` and
  `tools/post-execute` waterfalls, the plugin-scoped message source vocabulary, and the `compaction/*` event
  family with `isCompactCheckpointSource`. The project should record the harness version it develops against and
  treat changes to those surfaces as breaking.
- **Research assets** gathered while charting this effort, both written against an earlier harness tree and
  therefore superseded wherever they conflict with the rc.2 contracts above:
  - `.scratch/dsh-context-token-audit/report.md` — context window, token accounting, projections, truncation
    caps, compaction, prompt assembly and persistence.
  - `.scratch/dsh-extension-points/research-report.md` — the event/hook system, which hooks can mutate what, and
    the exact injection mechanisms with worked examples.
- **Next step.** Implementation tickets are the normal next workflow; the user-invoked `to-tickets` skill
  produces them. It must be invoked explicitly by the user.
