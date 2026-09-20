# Context footprint: spend the plugin's tokens where they change behaviour

Status: review-ready

Harness baseline: **`dsh-v0.1.5-rc.2`**. This change reprices every model-visible surface the plugin owns and
changes the default role of `context_reading`.
Rationale and rejected alternatives: [ADR 0002](../../docs/adr/0002-reminders-carry-guidance.md) and
[ADR 0003](../../docs/adr/0003-tool-hints-are-operator-declared.md). Vocabulary: [CONTEXT.md](../../CONTEXT.md)
(`Context guidance`, `Tool hint`, `Context reminder`).

## Problem Statement

The plugin currently pays fixed context cost for information whose value is mostly conditional. The standing
statement repeats caveats that matter only when a notice arrives, while the `context_reading` tool is declared on
every request even though the two reminder systems already tell the model when runtime pressure becomes actionable.

That leaves the tool with one distinct job the reminders cannot do: **preflight planning**. Before work that is likely
to load substantial context, a model may want to know how much room is available so it can choose a broad or narrow
retrieval strategy before paying for the work.

A tool designed for that job should not also be a retrospective diagnostics surface. If context is already tight,
the model should react to the reminder that arrived at the relevant moment, not spend more context calling a tool to
reflect on compaction history, composition or detailed state explanations.

There is also a scope problem in the current wording. A tier reminder describes committed history; an
oversized-result reminder describes the raw result of the call that just ran. A fixed-token oversized trigger and a
route-share trigger have different truthful renderings. Saving tokens must not collapse those distinctions.

## Design Principle

Every model-visible sentence is placed by one question:

> Does this text change what the model does next, at the moment it reads it?

Three control surfaces follow from that principle:

1. **Optional preflight probe** — before context-heavy work, answer how much room is available.
2. **Local runtime feedback** — after one oversized result, identify that call and optionally carry tool-shaped
   guidance.
3. **Global runtime feedback** — when committed history crosses a pressure tier, tell the model to keep subsequent
   context additions selective.

And one placement rule follows:

> Event-local semantics travel with the event.

The standing statement authorizes unsolicited runtime feedback and, when the optional preflight probe is enabled,
carries one short invocation cue telling the model **when to think of using it**. It does not duplicate the tool's
output contract, repeat event-local caveats or teach the model to perform retrospective context analysis.

## Solution

The canonical deployment defaults to:

```yaml
statement:
  enabled: true
tool:
  enabled: false
reminders:
  enabled: true
  oversized:
    enabled: true
    hints: {}
```

The default therefore pays **no `context_reading` tool-envelope cost**. Runtime pressure awareness comes from the
two reminder systems.

When an operator explicitly enables `context_reading`, the tool is a small preflight probe. The standing statement
adds one short behavioural cue so the model remembers to consider a preflight **before** context-heavy work; the tool
description then says what the probe reports. Its canonical value and rendered output contain only the figures needed
for that decision.

This split is intentional: the standing statement owns **when/why to invoke**; the tool envelope owns **what the call
returns**. The two surfaces must not duplicate the same explanatory detail. Because the tool is off by default, the
extra standing cue is paid only by deployments that explicitly opt into proactive budgeting.

The implementation separates two kinds of footprint protection:

1. A **copy snapshot** makes changes to pinned model-visible wording deliberate.
2. A **token budget** prices the actual assembled surfaces through the harness pricing seam.

## User Stories

1. As the model, I want unsolicited context notices authorized in advance, so that they do not read as unrelated
   interruptions.
2. As the model, I want runtime pressure guidance to arrive in the reminder that observed the pressure, so that I do
   not need to call another tool after the problem is already visible.
3. As the model, when an optional preflight probe is enabled, I want one standing cue to remind me to consider it
   before context-heavy work when available room could change my retrieval breadth.
4. As the model, I want the preflight probe to answer only how much route capacity exists, what committed history is
   projected to cost, and how much coherent room remains.
5. As the model, I want an unknown or stale preflight figure represented compactly, so that I do not mistake an
   unusable number for current room.
6. As the model, I do not want the preflight probe to spend output on composition, compaction history, checkpoint
   state or reflective explanations that do not change my initial retrieval decision.
7. As the model, I want a tier reminder to tell me what the pressure state calls for, in abstract terms, without
   prescribing a particular tool.
8. As the model, I want an oversized notice to name the tool, its pre-finalization price and the configured trigger,
   so that any configured tool hint is grounded in the call that actually over-fetched.
9. As the model, I want context guidance bounded to context management, so that it never licenses skipping required
   verification or testing.
10. As a deployment operator, I want the preflight tool off by default and independently opt-in.
11. As a deployment operator, I want statement, preflight tool, tier reminders and oversized-result reminders to
    remain independently switchable.
12. As a deployment operator, I want `reminders.oversized.hints` to map exact tool names to one bounded sentence,
    with reserved `<unlisted-tools>` as an optional catch-all.
13. As a deployment operator, I want the plugin to ship no tool-hint wording of its own.
14. As a deployment operator, I want invalid hint values to fail at load with the exact configuration path, while
    an unmatched tool name remains a normal silent miss because tools may register after plugin load.
15. As a deployment operator, I want both oversized trigger forms — fixed tokens and route share — to keep their
    existing semantics and model-visible wording.
16. As a deployment operator with the standing statement switched off, I want any notice that carries guidance to
    carry the context-only guard locally.
17. As the plugin's maintainer, I want the default fixed footprint to exclude the preflight tool completely.
18. As the plugin's maintainer, I want pinned copy changes to require an explicit fixture update and measured token
    budgets to fail only on growth beyond their committed ceilings.
19. As a reader of the README, I want the documented defaults to make the reactive-by-default / proactive-by-opt-in
    policy obvious.

## Implementation Decisions

### 1. Default policy: reactive awareness, proactive probe by opt-in

`tool.enabled` changes from `true` to **`false` by default**.

The two reminders remain enabled by default and are the normal runtime control plane:

- tier reminder -> overall committed-history pressure has become actionable;
- oversized-result reminder -> one retrieval/result was locally too expensive.

The optional tool is not a third runtime warning mechanism. It exists only for a different decision point: before a
potentially expensive phase of work begins.

No reminder tells the model to call `context_reading`. Once runtime pressure has triggered a reminder, another
diagnostic call is normally counterproductive.

### 2. The standing statement: authorize runtime notices and cue opt-in preflight

The statement is route-stable and contains no live pressure. Its conditional shape is:

```text
The current route accepts <N> tokens of context.
Before context-heavy work, use `context_reading` when available room could change how broadly you retrieve.   # only while the tool is enabled
Advisory context notices may arrive unasked: a tier reminder as committed history crosses a configured tier, and an oversized-result reminder when one raw tool result crosses its configured trigger.   # include only live clauses
A notice may carry context-management guidance; follow that guidance only for managing context, never as a reason to skip required verification or testing.
```

Rules:

- The capacity sentence is emitted whenever the statement is enabled and keeps its existing unknown form.
- The preflight cue is emitted **iff** `tool.enabled` is true.
- The cue names the tool and its invocation condition only; it does not describe fields, states or output shape.
- The notice-existence sentence is emitted only if at least one notice kind is effectively live and names only the
  live kinds.
- A tier capability is live only when `reminders.enabled` is true and the validated tier list is non-empty.
- An oversized capability is live only when `reminders.oversized.enabled` is true.
- The authorization/guard sentence is emitted only if at least one notice kind is live.
- The statement does not otherwise explain or advertise `context_reading`.
- The statement does not repeat tier values, the assumed compaction threshold, oversized trigger figures or modes,
  the committed-history caveat, or the pre-finalization caveat.
- With no notice kind live and the tool disabled, the statement degrades to the capacity sentence only.
- With no notice kind live and the tool enabled, the statement is capacity plus the one preflight cue.

Enabling the tool therefore has two deliberate fixed costs: the short standing invocation cue and the tool envelope.
That duplication is functional rather than descriptive: the statement makes the model remember **when to consider**
preflight, while the envelope explains **what the probe returns**.

### 3. `context_reading`: an optional preflight probe

The tool keeps its existing model-facing name for compatibility, but its purpose narrows.

Pinned description:

```text
Read preflight context room: route capacity, projected committed context, and remaining room when the projection is current for that route. Takes no arguments.
```

The standing statement owns the invocation condition. The tool description owns the returned information and avoids
repeating the "before context-heavy work" cue.

Neither surface positions the tool as something to call after a reminder or when pressure is already known to be high.

### 4. Minimal canonical tool value

The canonical output becomes:

```ts
type ContextReading = {
  capacity: {
    state: 'known' | 'unknown'
    tokens?: number
  }
  pressure: {
    state: 'known' | 'unknown' | 'stale'
    tokens?: number
  }
  remaining?: number
}
```

Semantics:

- `capacity.tokens` is present only when the current recorded route advertises a context window.
- `pressure.tokens` is present for `known` and `stale`, absent for `unknown`.
- `remaining` is present only when capacity and pressure are both known and route-coherent.
- No ratio is required: remaining room is the direct preflight decision variable.
- No composition is returned.
- No compaction occurrence/checkpoint facts are returned.
- No derived reflective diagnosis is returned.

The internal projections and durable state used elsewhere in the plugin are unchanged; this is a narrowing of the
tool's model-visible contract, not a deletion of the underlying measurements.

### 5. Minimal tool render

Known and coherent:

```text
Context: <pressure> / <capacity> estimated tokens; <remaining> remaining.
```

Known and coherent but over capacity:

```text
Context: <pressure> / <capacity> estimated tokens; <N> over capacity.
```

Unknown pressure with known capacity:

```text
Context: capacity <capacity> tokens; projected committed context unknown.
```

Stale pressure with known capacity:

```text
Context: capacity <capacity> tokens; projected committed context <pressure> tokens (stale); remaining unavailable.
```

Unknown capacity:

```text
Context: route capacity unknown; remaining unavailable.
```

If pressure is also known/stale while capacity is unknown, the renderer may include that pressure figure in the same
single line, but it never computes remaining room without a coherent denominator.

There is no reason table. `unknown`, `stale` and `unavailable` are the complete model-facing explanation.
Detailed provenance remains represented by the state construction and tests, not by reflective prose in the result.

### 6. Tool schema: structural semantics only

The output schema keeps:

- object/field types;
- `required`;
- `additionalProperties: false`;
- state enums;
- presence constraints enforced by the canonical value builder.

Descriptions are removed unless needed to state a presence invariant that the schema cannot encode directly.

The schema contains no composition or compaction fields. PTC code generation itself remains out of scope, but native
and PTC-facing declarations are both included in footprint measurement where the harness exposes them.

### 7. Tier reminders: runtime global pressure + abstract guidance

Pinned shape:

```text
Context reminder: committed history has reached the <ratio> tier (<i> of <n>)<last-tier-clause>.
It projects to <pressure> of the route's <capacity> tokens - <percent> used, <remaining-or-overflow>. The configured <threshold> compaction assumption leaves <headroom-or-overage> before that assumed point.
Keep further context additions selective.
```

Rules:

- The final-tier clause is emitted only for the last configured tier.
- "Committed history" makes the lagging basis explicit on the event that depends on it.
- The threshold is a **configured compaction assumption**, never a reading of mounted compaction policy.
- Remaining room and headroom use stateful wording; a negative number is never followed by "remaining".
- The final sentence is abstract context guidance, with no per-tool recipe.
- If the standing statement is disabled, append:
  `This is about room, never about effort: do not skip required verification or testing.`
- The tier notice never suggests calling `context_reading`.

### 8. Oversized reminders: runtime local feedback + optional tool hint

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

- "raw" and "before finalization" qualify the number in the same sentence.
- The fixed-token form remains eligible without known capacity.
- The share form remains ineligible without positive known capacity.
- The plugin ships no generic fallback hint.
- If a hint is selected and the standing statement is disabled, append the same context-only guard used by the tier
  notice. If no hint is selected, no guard is appended.
- Tool names and operator hints escape `&`, `<` and `>` before framing.
- The notice never suggests calling `context_reading`.

The collapsed summary continues to name the tool, estimated price and trigger form.

### 9. Hint configuration

`reminders.oversized.hints` is a map of exact tool name to one sentence. The reserved key
`<unlisted-tools>` is the optional catch-all.

Lookup precedence:

1. exact tool-name entry;
2. `<unlisted-tools>`;
3. no hint.

The plugin ships an empty map.

Validation is strict at load for values:

- non-empty after trimming;
- one physical line (no CR or LF);
- at most **320 characters** (80 estimated tokens under the harness heuristic).

A failure names `context-sense: reminders.oversized.hints[<key>]`.

Keys other than the reserved catch-all are not validated against the live tool registry. Tool registration may happen
after plugin load, so an unmatched key — including a typo indistinguishable from a future tool — is a normal silent
miss.

Hint lookup remains a pure helper; the reminder renderer receives the selected hint, not the configuration map.

### 10. No delivery cap and no new durable state

ADR 0001 stands: one notice per oversized result, the trigger is the volume lever, and no state records that an
oversized notice went out. Reminder epoch, route-coherence gate, fork cut and append-only boundary are untouched.

### 11. Footprint protection

There are four separately measured model-visible budgets:

1. **Standing statement** — fixed by default.
2. **Optional preflight tool envelope** — zero cost in the canonical default because the tool is not registered.
3. **Runtime reminder frames** — tier and oversized variants, paid only when triggered.
4. **Preflight result** — paid only when the opt-in tool is actually called.

Operator hint payload is measured separately from the plugin-owned oversized frame and bounded by configuration.

**Copy snapshot.** A committed fixture records a stable fingerprint or exact character count for:

- each standing-statement shape;
- the optional tool description and schema;
- every minimal preflight-result state;
- tier notice variants;
- oversized token/share frames;
- statement-off guard variants.

Any copy change, up or down, requires an explicit fixture update. This is a review gate, not a token meter.

**Token budget.** A separate test prices actual assembled surfaces through the harness's pricing seam, including
role/block/envelope overhead.

The committed budget fixture records the measured implementation baseline for each surface. Tests fail when a surface
grows above that ceiling; shrinkage succeeds.

Hard invariants:

- canonical default tool-envelope contribution is exactly **zero**;
- canonical default standing statement contains no preflight cue;
- enabling the tool adds exactly one short preflight cue to the standing statement plus the optional tool envelope;
- the cue and tool description do not duplicate each other's explanatory content;
- operator hints cannot exceed 80 estimated tokens;
- reminder and preflight-result budgets exclude surfaces that are not actually emitted in that state.

The previous combined `standing statement + tool envelope <= 360` figure is retained only as historical comparison;
it is no longer the default-budget contract because the tool is off by default.

### 12. README

The documented default block shows:

```yaml
statement:
  enabled: true
tool:
  enabled: false
reminders:
  enabled: true
  oversized:
    enabled: true
    hints: {}
```

README explains the control model:

- reminders are the default runtime pressure-awareness mechanism;
- `context_reading` is an opt-in preflight probe for deployments where models benefit from budgeting before
  context-heavy work;
- reminders do not direct the model back to the probe;
- the probe intentionally omits composition and compaction diagnostics.

The standing-statement degradation matrix includes the tool because explicit opt-in adds one behavioural cue:

| Statement | Tool | Tier capability | Oversized capability | Standing statement |
|---|---|---|---|---|
| off | any | any | any | absent |
| on | off | off | off | capacity only |
| on | on | off | off | capacity + preflight cue |
| on | any | on | off | capacity + optional preflight cue + tier notice authorization/guard |
| on | any | off | on | capacity + optional preflight cue + oversized notice authorization/guard |
| on | any | on | on | capacity + optional preflight cue + both notice clauses + one authorization/guard |

Tier capability is off when the validated tier list is empty even if `reminders.enabled` is true.

README also documents `<unlisted-tools>`, states that the plugin ships no hint wording, and states that unknown hint
keys cannot be validated at load.

## Testing Decisions

Tests assert observable behaviour and refused configuration only. No new private-state seam is introduced.

### Pure tool tests

- default config does not register `context_reading`;
- explicit `tool.enabled: true` registers it;
- enabling the tool adds exactly the one pinned preflight cue to the standing statement;
- disabling the tool removes that cue;
- the standing cue states the invocation condition;
- the tool description states the returned figures without repeating the invocation condition;
- canonical value contains only capacity, pressure and conditional remaining;
- no ratio, composition or compaction fields remain;
- render covers:
  - known coherent room;
  - over-capacity room;
  - unknown pressure;
  - stale pressure;
  - unknown capacity;
  - known/stale pressure with unknown capacity without fabricated remaining;
- no rendered state contains a reason table or reflective diagnostic paragraph.

### Pure statement/reminder tests

- standing statement:
  - no notice kinds / tier only / oversized only / both;
  - tier flag on with empty tiers behaves as no tier capability;
  - known and unknown capacity;
  - names `context_reading` only in the tool-enabled preflight cue;
- tier notice:
  - ordinary and final tier;
  - positive and negative remaining room;
  - positive and exceeded assumed-threshold headroom;
  - statement-on and statement-off guard composition;
  - never recommends a probe call;
- oversized notice:
  - fixed-token mode with known and unknown capacity;
  - share mode with known capacity;
  - exact hint, catch-all and no hint;
  - exact match wins over catch-all;
  - statement-off + hint appends guard;
  - statement-off + no hint does not append an irrelevant guard;
  - markup in tool name/hint cannot close the reminder frame;
  - never recommends a probe call;
- hint validation:
  - empty/whitespace-only, multiline and over-320-character values fail with the exact key path;
  - unknown keys load normally.

### Booted agent loop

- canonical default sends no `context_reading` declaration to the model;
- opt-in tool registration sends the minimal preflight envelope;
- enabling the tool changes the system-prompt statement only by adding the pinned preflight cue;
- tier and oversized reminders arrive through the real waterfalls with pinned bodies;
- share mode does not fire without capacity and does fire with qualifying capacity;
- statement-off composition attaches local guards only to notices that carry guidance;
- oversized wording continues to describe the pre-finalization raw price when downstream finalization shrinks or
  replaces content.

### Loader row

- bundle default resolves with `tool.enabled=false` and `hints: {}`;
- explicit tool opt-in resolves normally;
- malformed hint values fail load with exact path;
- unmatched tool-name keys are accepted;
- token/share mutual exclusion remains unchanged.

### Footprint

- exact-copy snapshot fails on any model-visible copy change;
- budget test prices assembled surfaces, not source characters;
- canonical default contains no tool-envelope tokens and no preflight cue;
- the tool-enabled fixture prices both the incremental standing cue and the optional native/PTC tool declaration;
- each minimal preflight result state has its own measured ceiling;
- shrinkage does not fail a budget assertion.

## Compatibility

Changing the default of `tool.enabled` from true to false is intentional. Deployments that rely on model-initiated
`context_reading` calls must opt in explicitly.

Narrowing the canonical tool value removes ratio, composition and compaction fields from the tool contract. This is
also intentional: those fields served diagnostics and reflection, not the preflight decision the optional tool now
exists to support.

The underlying context-pressure, context-breakdown and compaction projections/state are not removed by this change;
other plugin behaviour may continue to use them.

## Out of Scope

- Capping or deduping notices by step, turn or epoch, and any state needed to do it (ADR 0001).
- Shipping hint wording or a plugin-owned fallback sentence for unlisted tools.
- Validating hint keys against the live tool registry.
- Exact provider tokenization.
- Any change to reminder epoch, route-coherence gate, durable surface memory, fork semantics or append-only boundary.
- Removing the underlying composition or compaction projections merely because the preflight tool no longer exposes
  them.
- Adding a separate diagnostics/debugging tool for composition or compaction history.
- PTC code generation itself, and any client or UI contribution.
- JSONL persistence and the harness's own truncation, spill and pruning behaviour.

## Further Notes

- **Reminders own runtime pressure awareness; the optional tool exists only for preflight planning.**
- **Preflight intent and tool contract are split deliberately.** When enabled, the standing statement pays for one
  short "when to use it" cue; the tool envelope pays for "what it returns". Neither repeats the other's job.
- **The default deployment is reactive, not introspective.** A model that never needs preflight budgeting pays no
  tool-envelope cost.
- **There is no global reminder disclaimer.** Tier and oversized notices describe different temporal objects, so
  each carries only the caveat true of its own measurement.
- **An empty tier list means no tier capability.**
- **Share mode remains first-class.**
- **A typo in a hint key is not detectable at load** without also rejecting valid tools registered later.
- The pre-finalization oversized price can still over-report a tool that later shrinks its output; the wording keeps
  that basis local to the number.
