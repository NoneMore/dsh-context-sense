# Context Sense — give the model awareness of its own context window

Status: ready-for-agent

Harness baseline: **`dsh-v0.1.5-rc.2`**. Every contract below was verified against that release. This
document is the implementation contract for the first version: it keeps only what changes the code or its
tests.

## Problem Statement

DeepSeek Harness already shows the *human* how full the context is; the *model* is told none of it. Inside a
session the model cannot tell whether it sits at 5% or 75% of its window, cannot see what is consuming the
budget, and gets no signal before the mounted compaction backend replaces older history with a checkpoint
summary. The harness derives pressure from every request and acts on it automatically, while the party whose
behaviour depends most on that measurement is the only one not informed.

## Solution

A plugin, `context-sense`, with three contributions: a standing system-prompt statement of the session's
context capacity; a parameterless `context_status` tool for on-demand pressure, ratio, remaining room and
composition; and advisory `<system-reminder>` messages when a configured pressure tier is reached or a single
tool result is oversized. The plugin is **append-only with respect to the conversation**: it never compacts,
prunes, rewrites, reorders or truncates existing history, never calls the compaction engine, and its only
conversation contributions are messages it authors itself (source `{ kind: 'plugin', plugin:
'context-sense' }`), its prompt section and its tool.

## 1. First-version behaviour

**System-prompt capacity statement.** One named prompt section, registered **per agent** through that agent's
scoped `inject` and held as a disposer tied to that agent: install for every agent the registry already holds,
and for each one announced later (`agent/created`). Installing only on session start would silently skip
agents already live when the plugin loads. The text states the route's capacity in tokens when one is known,
says plainly that capacity is not yet known otherwise, names the `context_status` tool, states the configured
reminder tiers, and states that a reminder describes committed history and that the threshold it names is an
assumed policy value. It sits at a fixed order after the harness identity and persona prefix and ahead of the
policy and tool sections. It is never marked `complete`.

It carries capacity **only, never live pressure**: a section carrying pressure would append a new system
message on every step (under `systemPromptUpdate: 'in-history'`) or rewrite the request prefix and invalidate
the provider cache. Capacity changes only when the route changes, so the statement is stable within a route
and the live figure travels only by tool call and reminder.

**`context_status` tool.** One parameterless tool (`parameters: {}`) under a name that does not collide with a
built-in. Its canonical value is the declared `output.schema` — capacity plus a capacity-known flag, the
pressure figure plus a pressure state of `known` / `unknown` / `stale`, remaining, ratio, composition, a
per-figure provenance label, and the two compaction facts — with a separate pure `output.render(args, value)`
producing the model-facing text. Provenance values are exactly `route-metadata` (capacity),
`provider-anchored` (pressure, present only when the projection carries a figure) and `heuristic`
(composition); there is deliberately no `heuristic-only` pressure value, and route coherence is a separate
fact, so a figure can be `provider-anchored` and `stale` at once. The render gives the ratio and remaining
tokens only when both figures are known **and** route-coherent; otherwise it says that pressure is not yet
available, not confirmed for the current route, or that capacity is unknown, and omits ratio and remaining
rather than computing them from composition or across routes. It labels composition as the harness's
approximate heuristic and reports the two compaction facts. It reads live session state through
`exec.agent.session`, so repeated calls within one turn are correct; an execution with no agent reports
unknown rather than failing. It writes nothing.

**Reminders.** Pressure tiers are evaluated on the `agent/pre-step` waterfall; the oversized-result rule on
the `tools/post-execute` waterfall, delivering through the decision's `additionalContexts?: UserMessage[]`.
Both produce the same artifact: a user-role message attributed to the plugin carrying the text in a
`<system-reminder>` frame the plugin owns, with every interpolated value XML-escaped (`&`, `<`, `>`) so
nothing can close the frame. The message declares the harness context form matching its shape — `form:
'snapshot'` with named `sections` for a reading, `form: 'notice'` with a `summary` bounded by
`boundContextSummary` for a one-liner — which is what renders it as an attributed transcript row visible to
the human as well as the model. Reminder text previews names and sizes only, never raw payloads.

**Config.** Independent enable/disable for the prompt statement, the tool and the reminders; reminder tier
ratios (defaults 0.60 notice, 0.75 imminent); the oversized-result share (default 0.10 of capacity); and an
assumed compaction threshold ratio (default 0.80) used only for headroom wording and tier validation.
Validation is strict and fails at plugin load: threshold in (0,1); tiers finite, strictly ascending, in (0,1)
and strictly below the threshold; oversized share in (0,1). Tiers are never clamped, dropped or reordered.
Config arrives in the loader row's config block against the declared `Config` schema.

**Plugin shape.** A standard Cordis plugin exporting `name`, `inject`, `Config`, `apply`, with `inject`
declaring `sessionProjections`, `systemPrompt`, `tools` and `tokenMeter` so a composition missing one fails at
load. Source is TypeScript compiled to an ESM `lib/` with declarations, SDK packages as peer dependencies,
plus a bundle patch declaring its own loader row (a local absolute path or file URL is a valid row name). It
works for every agent that inherits its registrations, including subagents. Unload removes its prompt section,
its tool, its listeners and its host-side session state.

## 2. Data the first version uses

No new token accounting: every figure is route metadata, provider-reported usage, or a price the harness's own
meter produced.

- **Capacity** — `contextWindow` of the newest route the harness recorded for the session
  (`session.requestContext()?.contextWindow`, or `contextPressure.contextWindow` from the same snapshot).
  Route metadata, not an estimate; unknown when no route advertised one; never defaulted.
- **Pressure** — `snapshot(session, ['contextPressure'])`, figure `projectedTokens ?? pressureTokens` (the
  same numerator the human meter uses). Never `ctx.tokenMeter.measure()`, never re-derived from the unit's
  internals; a composition without the `contextPressure` unit degrades to unknown. `pressureTokens` is the
  provider-reported prompt size of the newest request (uncached input plus cache reads and writes, output
  excluded); `projectedTokens` is that sample plus the heuristic re-pricing of surface gained or lost since.
  Both are emitted under one guard, so **there is no heuristic-only total**: when the projection carries
  neither field the session has no provider usage sample yet, and pressure is unknown — no ratio, no
  remaining, no tier decision, and no fallback to composition.
- **Composition** — `contextBreakdown` (`systemTokens`, `toolsTokens`, `messageTokens`): heuristic only, not
  expected to sum to pressure, never presented as a total.
- **Oversized result** — `ctx.tokenMeter.estimateMessage(...)` on a tool-result-shaped message built from the
  waterfall's raw result. This is the only public pricing seam (the meter's pure estimator is not reachable as
  a package subpath) and the sole reason `tokenMeter` is injected.
- **Compaction observed** — two separate facts with different cuts, never conflated: *occurred in this
  session* = a `compaction/summary` or `compaction/prune` event in the own suffix; *checkpoint currently
  model-visible* = at least one surviving node of the current surface is a `user/message` whose source
  satisfies `isCompactCheckpointSource`, over the whole surface including the inherited prefix.

## 3. Lifecycle constraints that shape the code

- **Fresh session.** The first request may have neither capacity nor a pressure sample; both are reported
  unknown and corrected automatically on a later request. The capacity statement may name the previous
  route's capacity for at most one request after a model switch, until the next `request/context` record
  catches up.
- **`agent/pre-step` pressure is lagging.** The projection folds committed events, and the step's claimed
  messages, assembled prompt and tool-schema changes are not committed when the waterfall runs, so the
  reading describes the surface as of the previous step.
- **Different metrics.** The projection figure and the compaction backend's `measure().totalTokens` are
  different computations; the plugin never claims to reproduce, predict or verify the compaction number.
- **`tools/post-execute` sees the pre-finalization result.** It runs before the definition's own
  `finalizeContent` and before the observe-only `tools/result` emit, so the oversized rule measures the raw
  dispatch result. The only seam that sees post-`finalizeContent` content cannot attach context.
- **Re-arm.** Only a summary compaction (`compaction/summary`) opens a new reminder epoch. `compaction/prune`
  does not re-arm, as a policy choice: a prune is a local, model-free replacement that frees at most one
  node's overage and is often a prelude to a summary compaction, so re-arming on it would produce the
  fire-reset-fire loop this project must avoid.
- **Durable, replayable state.** Reminder state lives in the plugin's own **host-only** session projection
  (`ctx.sessionProjections.register` with `wire` omitted and its key declaration-merged into
  `SessionProjectionStateMap`), whose `apply` is a pure fold over committed events, so a resume or replay
  reconstructs it identically. It is never process-local.
- **Fork cut.** A child's own reminder state must not inherit the parent's. The cut comes from
  `init(header, inheritedEventCount)`, is carried in the projection's own state, and is never inferred from a
  session id, `firstLiveSeq`, a `session/end-seed` marker or a host-side map.
- **Route coherence is conservative.** The projection carries no route per field — its three fields are
  last-wins records of different moments, not one atomic observation — so the gate is reconstructed from
  durable events: the newest `request/context` route against the newest `assistant/message` route that
  carries `usage`. **If the plugin cannot simply show that the current pressure and the capacity belong to
  the same route, it reports `stale` and makes no ratio or tier decision.** `stale` (a sample exists,
  unconfirmed for the recorded route) is reported differently from `unknown` (nothing measured). An
  unattributable sample — e.g. an `assistant/attempt` usage chunk that names no route — reads as stale rather
  than being assumed coherent. Capacity, composition and the oversized rule do not depend on the gate.
- **Pre-step order inside one listener.** (1) read the pressure snapshot before `next()`; (2) read the folded
  reminder state and compute the decision with the pure core; (3) `await next()`, so downstream listeners —
  compaction among them — run; (4) re-read the reminder state and compare the compaction epoch: if a
  downstream listener committed a `compaction/summary`, **drop the pending reminder**, record nothing as
  fired, and return the decision unchanged; (5) otherwise append the reminder message to `decision.messages`
  and return it. Injection must happen after `next()`, the only point at which the final decision exists.
  `{ prepend: true }` puts the listener first in the dispatch list, but its code after `await next()` runs
  after every later listener.
- **What step 4 does not cover.** A summary compaction later in the same step — context-overflow recovery
  dispatched from `agent/request-error` after `decision.messages` are already committed — cannot retract a
  durable reminder, and no design here tries to. The epoch bookkeeping stays honest: the reminder counts as
  fired in the epoch the later summary closes, and the new epoch starts un-fired.

## 4. Reminder state machine

- **Pure core.** A pure function of (pressure, capacity, whether the two were confirmed to belong to the same
  route, config, the folded reminder state) returning none or a reminder at tier N with its text. It never
  reads a projection, a clock or module-level mutable state; a route-incoherent pairing is an input whose only
  effect is "no reminder". Purity is the testing seam and keeps both observation points identical.
- **State, split by cut.** *Child-owned* — the compaction epoch, each tier's fired epoch, the step cursor and
  the step of the last pressure reminder — folds only the own suffix (`seq >= inheritedEventCount`).
  *Surface-history* — the recorded route, the newest attributed usage sample and checkpoint visibility —
  folds the whole log including the inherited prefix, because those facts are true of the surface this
  session sends.
- **Epoch** = number of `compaction/summary` events in the own suffix, starting at 0. `compaction/start` and
  `compaction/end` carry no surface effect and do not move it. A summary in the inherited prefix does not
  count: the child starts at 0.
- **Firing is reconstructed from the plugin's own durable messages.** A `user/message` whose source is
  `{ kind: 'plugin', plugin: 'context-sense' }` and whose `snapshot` section name is the tier's stable key
  records that tier as fired in the current epoch. The section name is therefore both the transcript's
  contribution label and the fold's key; the body text is free to change. Reminders in the inherited prefix
  are skipped by the sequence guard but stay visible in the transcript.
- **A tier fires at most once per epoch:** the ratio from projected pressure and route capacity reaches N, the
  pairing is route-coherent, and N has not fired in this epoch. Not once per crossing — with no readable
  pressure history the fold cannot distinguish "already above" from "crossed now". No hysteresis, no
  pressure-fall re-arm, no process-local state. No re-arm from `agent/session-start` (rc.2 only ever
  publishes `'startup'` or `'resume'`).
- **Step cursor.** `(turn, step)` from the latest `step/start` in the own suffix (`user/message` carries
  neither). The fold records the step of the last **pressure-tier** reminder only; an oversized-result
  reminder must never fill that field, since it is committed at the step after the result that produced it.
- **Oversized result.** A single raw result whose estimated tokens exceed the configured share of capacity
  produces a reminder delivered with that result, suppressed when `pressureReminderStep === currentStep`. The
  reverse never suppresses: a tier signal is once per epoch, and withholding it would lose it for the whole
  epoch. The cut applies here too — turn and step numbers restart at 1 in a child, so an inherited
  `step/start` could otherwise masquerade as the child's current step.
- **Scope.** State is per session and therefore per agent: a child does not read its parent's inherited prefix
  as its own state, and a parent never sees its child's events. A fork taken mid-turn inherits only the
  parent's completed-turn prefix.

## 5. Known limitations

Each is a real rc.2 limitation, not a deferred task. The first version keeps the simplest conservative
behaviour and validates these during implementation and testing rather than designing around them.

1. **Same-request exact capacity** in the system prompt is not available: prompt assembly is given no resolved
   route, so the statement is built from the newest recorded route and is unknown on a session's first
   request.
2. **Same-step exact pressure crossing** is not detectable: pre-step pressure is a lagging projection, so a
   crossing caused by the request the step is about to send is first visible at a later step, and a reminder
   quotes a figure slightly smaller than the request that carries it.
3. **The mounted compaction policy is unreadable** — threshold, retention, per-route `modelPolicies` and
   `auto` are backend-internal. The threshold value is an operator-supplied assumption, never a reading; tiers
   are advisory signals, never a gate.
4. **Pressure/capacity route coherence is not a Harness atomic guarantee.** The gate is a conservative
   reconstruction from durable events, so in a route-change window the model reading can say `stale` while the
   human meter still shows a number, and a crossing in that window produces no reminder. A `request/context`
   record caused only by a `systemPromptUpdate` change can also read as `stale` for one request. A delayed
   reminder is recoverable on the next step; a ratio across two routes would be fabricated.
5. **The final model-visible tool-result size cannot be obtained at the seam that can attach a message**, so
   the oversized rule reports the raw result and may over-warn for a tool that shrinks its own output.
6. **The reminder metric and the compaction metric are not guaranteed to be in sync**, so a crossing may not
   be visible in the same step's compaction decision.
7. **A forked child may restate a tier its parent already announced**, because child-owned state is rebuilt
   from its own suffix only. A repeated warning is preferred to a permanently silent fork.
8. **Suppression is limited to the pre-step waterfall** — a summary compaction committed later in the same
   step leaves an already-committed reminder in place.

## 6. Minimum tests

Assert observable behaviour only: given a pressure/composition state and a config, what reading the model
receives and whether a reminder is produced. Do not assert private state, helper call counts or intermediate
shapes.

- **Pure seams (unit).** The decision core, the reading render and the state fold are pure and carry the
  logic: tier eligibility, epoch re-arm, oversized suppression, validation, remaining-room arithmetic, route
  gating and provenance labelling. Replay a hand-written event list through `apply` — including the plugin's
  own reminder messages and `compaction/summary` / `compaction/prune` events — and assert the per-tier epoch
  state; call `init(header, inheritedEventCount)` with a non-zero cut and assert which facts came from the
  inherited prefix. Route coherence is a pure property too: same route (coherent, ratio allowed), a newer
  record with an older sample (stale, no ratio, no tier even when a naive ratio would cross), an
  unattributable sample (stale), and no sample at all (unknown).
- **Integration.** Exercise the plugin against a real booted agent loop using
  `@deepseek-ai/dsh-agent-loop-testkit@0.1.5-rc.2` (pinned exactly — its `latest` tag points at an old
  `0.0.1-rc.1`), with a deterministic scripted `LlmAdapter` registered through `ctx.llm.registerAdapter`, and
  the real `dsh-compaction-basic` mounted where the test is about compaction. Required cases:
  - fresh session capacity unknown → known;
  - pressure unknown → known (never a composition-derived total, and no tier reminder while unknown),
    including a route switch to a different capacity with no new sample → `stale`, no ratio, no tier, capacity
    still the new route's, then the ratio returns once usage is reported;
  - a tier fires once per epoch;
  - after a summary compaction the tier is eligible again, and the reminder is suppressed on a step where a
    summary compaction runs inside the pre-step waterfall;
  - `compaction/prune` without a summary does not re-arm (assert the state-machine rule, not that prune left
    pressure unchanged);
  - pre-step lag: a tier crossed only by a message claimed for the current step is reminded at the following
    pre-step;
  - oversized raw result, including a tool whose `finalizeContent` shrinks its content, pinning the
    pre-finalization basis;
  - resume: the folded state matches the durable log — no repeated reminder, no skipped tier;
  - fork isolation from a parent whose log holds a summary compaction and a fired tier: the child's epoch
    starts at 0, the inherited reminder stays visible on the child's surface, the child fires its own
    reminder, the child reports no compaction in this session while a checkpoint is model-visible, and the
    parent's state is untouched (built with a non-zero `inheritedEventCount`, not by asserting on session
    ids);
  - unload: the prompt section is absent from assembly, the tool is unregistered, the listeners no longer
    fire, and `sessionProjections.stateOf(session, '<plugin key>') === undefined` (the unit is host-only, so
    it never appeared in a client snapshot).
- **Registration smoke test.** Boot against a minimal context holding one agent and assert exactly one prompt
  section and one tool per agent scope, and two listeners plus one projection unit on the plugin's own
  context.
- **Not tested here:** the harness's own hook dispatch, prompt assembly, registration and injection — those
  contracts are the host's to test. The repo has no scaffold, test runner or build yet; choosing tooling is
  the first implementation ticket's job, not a design question.

## Out of Scope

- Automatic context action: compacting, pruning, truncating, rewriting or reordering history, and any
  interaction with the compaction engine beyond observing that a compaction occurred.
- Reading or changing the mounted compaction policy (threshold, retention, per-route overrides, `auto`).
- A `/context` slash command and any client/UI contribution — the human already has a context meter.
- Provider-accurate tokenization; establishing reminder state from pressure history (which would need a
  durable per-step pressure sample or a re-implementation of the token meter's fold).
- Cost, billing or quota reporting.

## Further Notes

- **Prior art.** `dsh-time-context` supplies the plugin's registration, read and delivery shape (host-only
  declaration-merged projection, pure fold over its own durable `user/message` sources, `{ prepend: true }`
  pre-step listener reading state with `stateOf`, delivery by appending to the returned decision's `messages`);
  the fail-loud threshold validation follows `dsh-repeat-tool-reminder`. For the fork cut, `dsh-schedule` is the
  prior art — `dsh-time-context` is **not**, because it has no cut and would fold a fork's inherited prefix as
  its own.
- **Version sensitivity.** Established against harness `dsh-v0.1.5-rc.2`. Treat changes to the projection
  registry, the token-meter projections and the `projectedTokens` presence rule, `session.requestContext()`
  and the `request/context` append condition, settlement event route labels, the `agent/pre-step`,
  `agent/request-error` and `tools/post-execute` waterfalls and their commit order, Cordis waterfall
  ordering, and the `compaction/*` event family as breaking.
