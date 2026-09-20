# Context footprint: spend the plugin's tokens where they change behaviour

Status: review-ready

Harness baseline: **`dsh-v0.1.5-rc.2`**. This change reprices every model-visible surface the plugin owns.
Rationale and rejected alternatives: [ADR 0002](../../docs/adr/0002-reminders-carry-guidance.md) and
[ADR 0003](../../docs/adr/0003-tool-hints-are-operator-declared.md). Vocabulary: [CONTEXT.md](../../CONTEXT.md)
(`Context guidance`, `Tool hint`, `Context reminder`).

## Problem Statement

The plugin's own overhead was never designed, only accumulated, and it is paid on surfaces the model re-reads on
every request. Two failures follow. The standing statement spends fixed tokens on caveats that matter only when a
notice actually arrives, while the tool envelope pre-explains states the tool's rendered output can explain at the
moment they occur. And the cost is invisible: nothing fails when a surface grows, so a copy edit can quietly raise
the price of a plugin whose purpose is to reduce pressure.

There is a second design failure hidden inside that duplication: facts with different scopes have been phrased as if
they were one contract. A tier reminder describes committed history; an oversized-result reminder describes the raw
result of the call that just ran. A tool can be switched off independently of the standing statement. The oversized
trigger can be a fixed token threshold or a share of the route. Any footprint rewrite must preserve those distinctions
instead of saving tokens by making a broader sentence false.

## Design Principle

Every model-visible sentence is placed by one question:

> Does this text change what the model does next, at the moment it reads it?

That produces one additional rule:

> Event-local semantics travel with the event.

The standing statement pays only for stable capability discovery and authorization. A tier notice owns the semantics
of a tier reading. An oversized-result notice owns the semantics of a raw-result price. The on-demand reading owns
the explanation of `unknown` and `stale`. The tool envelope says enough to decide whether to call the tool, not
enough to pre-render every state it might return.

## Solution

The standing statement becomes a small, route-stable declaration of the capabilities that are actually live. The
tool envelope shrinks to call-discovery information while retaining semantically irreducible schema descriptions.
Tier reminders gain one abstract, actionable context-management sentence. Oversized reminders may gain one
deployment-owned tool hint, selected by exact tool name or an optional catch-all. Kind-specific provenance and
caveats stay on the notice whose figure they qualify.

The implementation also separates two different kinds of footprint protection:

1. A **copy snapshot** makes any change to pinned model-visible wording deliberate.
2. A **token budget** prices the assembled model-visible surfaces through the harness's own pricing seam and fails
   only when a surface exceeds its budget.

The canonical default must not exceed the current fixed cost of **360 estimated tokens per request** for the standing
statement plus tool envelope. Notice frames and readings must not grow beyond their current corresponding surfaces
unless the same change deliberately raises the relevant budget. Operator-provided hint text is excluded from the
plugin-owned notice-frame budget and is bounded separately.

## User Stories

1. As the model, I want to know which context-sense capabilities are actually available, so that the standing
   statement never promises a tool or notice that cannot arrive.
2. As the model, I want unasked notices authorized in advance, so that they do not read as unrelated interruptions.
3. As the model, I want context guidance bounded to context management, so that it never licenses skipping required
   verification or testing.
4. As the model, I want each notice to carry the provenance and caveat that qualify its own figures, so that I never
   have to remember an event-specific disclaimer from a previous request.
5. As the model, I want a tier reminder to tell me what the pressure state calls for, in abstract terms, without
   prescribing a particular tool.
6. As the model, I want an oversized notice to name the tool, its pre-finalization price and the configured trigger,
   so that any configured tool hint is grounded in the call that actually over-fetched.
7. As the model, I want a tool hint specific to the kind of call that produced the result, so that the advice fits
   the tool I actually used.
8. As the model, I want the on-demand reading to explain `unknown` and `stale` where those states are rendered,
   rather than paying to pre-explain them on every request.
9. As the model, I want `context_reading` discoverable when it is enabled, including its compaction facts, and not
   mentioned when it is disabled.
10. As a deployment operator, I want the four switches to remain independent: statement, reading tool, tier
    reminders and oversized-result reminders.
11. As a deployment operator, I want `reminders.oversized.hints` to map exact tool names to one bounded sentence,
    with reserved `<unlisted-tools>` as an optional catch-all.
12. As a deployment operator, I want the plugin to ship no tool-hint wording of its own.
13. As a deployment operator, I want invalid hint values to fail at load with the exact configuration path, while
    an unmatched tool name remains a normal silent miss because tools may register after plugin load.
14. As a deployment operator, I want both oversized trigger forms — fixed tokens and route share — to keep their
    existing semantics and model-visible wording.
15. As a deployment operator with the standing statement switched off, I want any notice that carries guidance to
    carry the context-only guard locally.
16. As the plugin's maintainer, I want pinned copy changes to require an explicit fixture update, whether the copy
    grows or shrinks.
17. As the plugin's maintainer, I want the actual assembled token budget to fail on growth beyond a committed ceiling,
    while a shrink remains a budget success.
18. As a reader of the README, I want the documented default block and degradation matrix to match the configuration
    that actually runs.

## Implementation Decisions

### 1. Resolve effective capabilities once

Raw config flags are not model-facing truth. `apply` resolves the effective capabilities once and passes that
resolved shape to registration and rendering.

Conceptually:

```ts
interface EffectiveCapabilities {
  readonly toolEnabled: boolean
  readonly tierPolicy?: ReminderPolicy
  readonly oversizedPolicy?: OversizedResultPolicy
}
```

A tier capability is live only when `reminders.enabled` is true **and** the validated tier list is non-empty.
An oversized capability is live only when `reminders.oversized.enabled` is true. The tool capability is live only
when `tool.enabled` is true.

The statement and the listeners consume the same resolved truth. No renderer independently reconstructs whether a
subsystem is live from raw flags.

### 2. The standing statement: stable capability discovery and authorization only

The statement is route-stable and contains no live pressure. Its parts are conditional:

```text
The current route accepts <N> tokens of context.
`context_reading` reports route capacity, projected next-request cost, route-coherent room, approximate surface composition and compaction facts on demand.   # only while the tool is enabled
Advisory context notices may arrive unasked: a tier reminder as committed history crosses a configured tier, and an oversized-result reminder when one raw tool result crosses its configured trigger.   # include only the live clauses
A notice may carry context-management guidance; follow that guidance only for managing context, never as a reason to skip required verification or testing.
```

Rules:

- The capacity sentence is emitted whenever the statement is enabled and keeps its existing unknown form.
- The tool sentence is emitted **iff** the tool is enabled.
- The notice-existence sentence is emitted only if at least one notice kind is live and names only the live kinds.
- The authorization/guard sentence is emitted only if at least one notice kind is live.
- The standing statement does **not** repeat tier values, the assumed compaction threshold, the oversized threshold,
  the oversized trigger mode, the committed-history caveat or the pre-finalization caveat. Those facts matter only
  when their event occurs and belong on that event.
- With no tool and no notice kind live, the statement degrades to the capacity sentence only.

This is the only place where unasked notices are authorized globally. It is deliberately mode-neutral: changing an
oversized trigger between `tokens` and `share` does not change the standing statement.

### 3. The tool envelope

The model-facing description becomes compact call-discovery copy:

```text
Read this session's context window: route capacity, projected next-request cost, their ratio and remaining room when route-coherent, approximate system/tool/message composition, and compaction facts. Figures state their source; unmeasured pressure is unknown and cross-route pressure is stale. Takes no arguments.
```

The output schema keeps every structural constraint — `required`, `additionalProperties`, `enum`, `const`,
types — and keeps descriptions only where structure cannot communicate the semantic distinction. In particular:

- the meanings of pressure states `unknown` and `stale`;
- provenance labels whose meaning is not implied by their literal value;
- the distinction between "compaction occurred in this session" and "checkpoint visible on this surface".

Descriptions that merely restate a field name or type are removed. This applies to the canonical schema used by
native function calling and PTC; PTC code generation itself remains out of scope.

### 4. The reading render owns state explanations

The reading keeps its five lines: capacity, pressure, ratio/remaining room, composition and compaction.

The reason table is rephrased as pointers to facts already rendered above it:

- unknown pressure -> `the pressure figure above is not known yet`
- stale pressure -> `the pressure figure above is not confirmed for this route`
- unknown capacity -> `the capacity above is not known yet`

The ratio line never restates the full cause from the preceding lines. Every state still explains itself locally;
nothing becomes inferable-only.

Negative remaining room keeps the existing explicit "over the route's context window by ..." form.

### 5. Tier reminders: measurement + abstract guidance

Pinned shape:

```text
Context reminder: committed history has reached the <ratio> tier (<i> of <n>)<last-tier-clause>.
It projects to <pressure> of the route's <capacity> tokens - <percent> used, <remaining-or-overflow>. The configured <threshold> compaction assumption leaves <headroom-or-overage> before that assumed point.
Keep further context additions selective.
```

Rules:

- The final-tier clause is emitted only for the last configured tier.
- "Committed history" makes the lagging basis explicit on the event that depends on it.
- The threshold is called a **configured compaction assumption**, never the mounted policy.
- Remaining room and headroom are stateful phrases, never negative values followed by "remaining":
  - `<N> remaining` when non-negative;
  - `<N> over the route's context window` or `<N> beyond that assumed point` when negative.
- The final sentence is context guidance: abstract and actionable, with no per-tool recipe.
- If the standing statement is disabled, append the guard:
  `This is about room, never about effort: do not skip required verification or testing.`

No tier notice repeats the whole tier list.

### 6. Oversized reminders: event-local basis + optional tool hint

The two trigger modes keep distinct truthful renderings.

Fixed-token form:

```text
Context reminder: the raw `<tool>` result prices at an estimated <N> tokens before finalization, above the configured <threshold>-token threshold.
<hint, when selected>
```

Share form:

```text
Context reminder: the raw `<tool>` result prices at an estimated <N> tokens before finalization, above the configured <share> share of the current route's <capacity>-token context window.
<hint, when selected>
```

Rules:

- "raw" and "before finalization" qualify the number in the same sentence, so a model never reads it as a count of
  the finalized result it received.
- The fixed-token form remains eligible without a known route capacity.
- The share form remains ineligible without a positive known capacity; no denominator is fabricated.
- The plugin-owned frame contains no generic fallback guidance.
- If a hint is selected and the standing statement is disabled, append the same context-only guard used by the tier
  notice. If no hint is selected, no guard is needed because the notice carries no guidance.
- Tool names and operator hint text are treated as text inside the plugin-owned frame; `&`, `<` and `>` are
  escaped before framing.

The collapsed notice summary keeps naming the tool, estimated price and trigger form.

### 7. Hint configuration

`reminders.oversized.hints` is a map of exact tool name to one sentence. The reserved key
`<unlisted-tools>` is the optional catch-all.

Lookup precedence is deterministic:

1. exact tool-name entry;
2. `<unlisted-tools>`;
3. no hint.

The plugin ships an empty map.

Validation is strict at load for values:

- not empty or whitespace-only;
- one physical line (no CR or LF);
- at most **320 characters**, which is 80 estimated tokens under the harness's four-characters-per-token heuristic.

A failure names `context-sense: reminders.oversized.hints[<key>]`.

Keys other than the reserved catch-all are **not** validated against the live tool registry. Tool registration follows
plugin load and deployments may add tools dynamically, so an unmatched key — including a typo the plugin cannot
distinguish from a future tool — is a normal silent miss. The documentation must not promise typo detection.

Hint lookup is a pure helper returning either the selected text and its source (`exact` or `catch-all`) or
`undefined`. The reminder renderer receives the selected hint, not the whole configuration map.

### 8. No delivery cap and no new durable state

ADR 0001 stands: one notice per oversized result, the trigger is the volume lever, and no state records that an
oversized notice went out. The reminder epoch, route-coherence gate, fork cut and append-only boundary are untouched.

### 9. Footprint protection: copy snapshot and token budget are different tests

**Copy snapshot.** A committed fixture records the exact rendered character count (or equivalent stable fingerprint)
of every pinned plugin-owned model-visible surface:

- each conditional standing-statement shape;
- tool description and the retained semantic schema descriptions;
- tier notice variants;
- oversized token/share notice frames, without operator hint payload;
- statement-off guard variants;
- the five reading states.

Any copy change, up or down, fails until the fixture is deliberately updated in the same change. This is a review
gate, not a claim about token cost.

**Token budget.** A separate test prices the model-visible surface through the same harness pricing seam used in
production, including the role/block/envelope overhead that actually reaches the model. It covers native function
calling and the PTC-facing declaration where the harness exposes both forms.

Budgets:

- canonical default fixed cost (standing statement + tool envelope): **<= 360 estimated tokens per request**;
- each plugin-owned tier notice frame: no larger than the corresponding pre-change tier surface unless its budget is
  deliberately raised;
- each plugin-owned oversized notice frame, excluding operator hint text: no larger than its corresponding
  pre-change surface unless deliberately raised;
- each reading state: no larger than its corresponding pre-change state unless deliberately raised;
- one configured hint: at most 80 estimated tokens by the configuration bound above.

Budget tests fail only on crossing the committed ceiling. Shrinkage is success; the separate copy snapshot still
requires the wording change to be acknowledged.

### 10. README

The documented default block gains `hints: {}` and documents `<unlisted-tools>` as the reserved optional
catch-all. The reading-semantics section gains the effective-capability degradation matrix:

| Statement | Tool | Tier capability | Oversized capability | Standing statement |
|---|---|---|---|---|
| off | any | any | any | absent |
| on | off | off | off | capacity only |
| on | on | off | off | capacity + tool |
| on | any | on | off | capacity + live tool clause, if any + tier notice authorization/guard |
| on | any | off | on | capacity + live tool clause, if any + oversized notice authorization/guard |
| on | any | on | on | capacity + live tool clause, if any + both notice clauses + one authorization/guard |

For this matrix, tier capability is off when the validated tier list is empty even if `reminders.enabled` is true.

README also states that the plugin ships no tool-hint wording and cannot validate hint keys against tools that may
register later.

## Testing Decisions

Tests assert observable behaviour only — what text reaches the model and what configuration is refused for. No new
private-state seam is introduced.

### Pure renderers and policy helpers

- standing statement:
  - tool on/off;
  - no notice kinds / tier only / oversized only / both;
  - tier flag on with an empty tier list behaves as no tier capability;
  - known and unknown capacity;
- tier notice:
  - ordinary and last tier;
  - positive and negative remaining room;
  - positive and exceeded assumed-threshold headroom;
  - statement-on and statement-off guard composition;
- oversized notice:
  - fixed-token trigger with known and unknown capacity;
  - share trigger with known capacity;
  - exact hint, catch-all hint and no hint;
  - exact match wins over catch-all;
  - statement-off + hint appends the guard;
  - statement-off + no hint does not append an irrelevant guard;
  - tool name and hint markup cannot close the reminder frame;
- hint validation:
  - empty/whitespace-only, multiline and over-320-character values fail with the key path;
  - unknown keys load normally;
- reading:
  - all five reading states and the deduplicated reason pointers;
- tool declaration:
  - compact description;
  - structural schema constraints remain;
  - semantic descriptions for pressure/provenance/compaction remain.

### Booted agent loop

Using the existing scripted-provider harness:

- the model receives no `context_reading` promise when the tool is disabled;
- the model receives the compact tool envelope when the tool is enabled;
- tier and oversized reminders arrive through their real waterfalls with pinned bodies;
- the share trigger does not fire without capacity and does fire with a qualifying capacity;
- statement-off composition attaches local guards only to notices that carry guidance;
- an oversized reminder still describes the pre-finalization raw price when downstream finalization shrinks or
  replaces content.

### Loader row

- the bundle default resolves with an empty hint map;
- malformed hint values fail load with the exact path;
- unmatched tool-name keys are accepted;
- token/share mutual exclusion remains unchanged.

### Footprint

- exact-copy snapshot fails on any model-visible copy change;
- token-budget test prices assembled surfaces, not source characters;
- the canonical fixed cost stays at or below 360 estimated tokens;
- native and PTC-facing tool declarations are both priced when available;
- shrinking a surface does not fail its budget assertion.

Prior art remains the statement, reminder, reading, oversized-reminder and loader-row suites, and the shared
session-event, plugin-message and scripted-provider fixtures they use.

## Out of Scope

- Capping or deduping notices by step, turn or epoch, and any state needed to do it (ADR 0001).
- Shipping hint wording or a plugin-owned fallback sentence for unlisted tools.
- Validating hint keys against the live tool registry.
- Exact provider tokenization: figures remain the harness meter's heuristic prices.
- Any change to the reminder epoch, route-coherence gate, durable surface memory, tool's canonical value, compaction
  facts or append-only boundary.
- Removing compaction facts from `context_reading`.
- PTC code generation itself, and any client or UI contribution.
- The JSONL persistence format and the harness's own truncation, spill and pruning behaviour.

## Further Notes

- **The pinned copy is a contract, not the budget meter.** Wording revisions update the copy snapshot deliberately;
  token budgets are measured separately from assembled model-visible surfaces.
- **There is no global reminder disclaimer.** Tier and oversized notices describe different temporal objects, so
  each carries only the provenance/caveat that is true of its own measurement.
- **The tool switch is authoritative.** A standing statement that names `context_reading` while
  `tool.enabled=false` is a bug.
- **An empty tier list means no tier capability.** Enabling the listener while configuring no eligible tier must not
  authorize a notice that cannot occur.
- **Share mode remains first-class.** Any implementation or test plan that only renders a fixed token threshold is
  incomplete.
- **A typo in a hint key is not detectable at load.** Rejecting unknown keys would also reject valid tools that
  register later, so the contract promises strict value validation and silent key misses instead.
- **Facts the numbers rest on:** the harness token meter uses the same four-characters-per-token heuristic for the
  plugin's context figures; `read` caps at 51,200 bytes (about 12,800 estimated tokens) and `pwsh`/`bash` at
  64,000 bytes per stream (about 16,000), so the default 8,000-token trigger is frequent enough that notice-frame
  cost matters; the model cannot trigger compaction, since `compactNow` is reachable only from the user-invoked
  `/compact` command.
- The pre-finalization oversized price can still over-report a tool that later shrinks its output. The revised
  wording makes that basis local to the number rather than hiding it in standing copy.
