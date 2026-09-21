# Context footprint: make the reading tool an opt-in preflight probe

Status: ready-for-agent

Harness baseline: **`dsh-v0.1.5-rc.2`**. Reprices every model-visible surface the plugin owns and changes the
default role of `context_reading`. Rationale and rejected alternatives:
[ADR 0002](../../docs/adr/0002-reminders-carry-guidance.md),
[ADR 0003](../../docs/adr/0003-tool-hints-are-operator-declared.md). Vocabulary:
[CONTEXT.md](../../CONTEXT.md) (`Context guidance`, `Tool hint`, `Context reminder`, `Fixed token threshold`,
`Result share`, `Preflight reading`).

## Problem Statement

The plugin pays fixed context cost for information whose value is conditional. The standing statement repeats caveats
that matter only when a notice arrives, and `context_reading` is declared on every request even though the two
reminder systems already tell the model when runtime pressure becomes actionable.

That leaves the tool one distinct job the reminders cannot do: **preflight planning**. Before work likely to load
substantial context, the model may want to know how much room is available so it can choose a broad or narrow
retrieval strategy before paying for the work. A tool designed for that job should not also be a retrospective
diagnostics surface: once context is already tight, the model should act on the reminder that arrived at the relevant
moment rather than spend more context reflecting on composition, compaction history or detailed state explanations.

Two rules place every model-visible sentence. Placement:

> Does this text change what the model does next, at the moment it reads it?

Provenance of an explanation:

> Event-local semantics travel with the event.

There is also a truthfulness problem in the current wording. A tier reminder describes committed history; an
oversized-result reminder describes the raw result of the call that just ran; and the fixed token threshold and the
result share have different truthful renderings. Saving tokens must not collapse those distinctions.

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

The default therefore pays **no `context_reading` tool-envelope cost**, and runtime pressure awareness comes from the
two reminder systems.

When an operator explicitly enables `context_reading`, it is a small preflight probe. The standing statement gains
one short cue so the model considers a preflight **before** context-heavy work, and the tool envelope says what the
probe returns. The split is deliberate: the statement owns **when and why to invoke**; the envelope owns **what the
call returns**, and neither repeats the other's job. Because the tool is off by default, that cue is paid only by
deployments that opt into proactive budgeting.

Two kinds of footprint protection guard the result: a **copy snapshot**, which makes any change to pinned
model-visible wording a deliberate act, and a **token budget**, which prices the assembled surfaces through the
harness's pricing seam.

## User Stories

1. As the model, I want unsolicited context notices authorized in advance, so that they do not read as unrelated
   interruptions.
2. As the model, I want runtime pressure guidance to arrive in the reminder that observed the pressure, so that I do
   not need to call a tool after the problem is already visible.
3. As the model, when the optional preflight probe is enabled, I want one standing cue telling me to consider it
   before context-heavy work, so that available room can change my retrieval breadth before I pay for it.
4. As the model, I want the probe to answer only how much route capacity exists, what committed history is projected
   to cost, and how much coherent room remains, so that its result is a decision input rather than a report.
5. As the model, I want an unknown or stale probe figure represented compactly, so that I do not mistake an unusable
   number for current room.
6. As the model, I want a tier reminder to tell me what the pressure state calls for in abstract terms, so that it
   never prescribes a particular tool.
7. As the model, I want an oversized notice to name the tool, its pre-finalization price and the configured trigger,
   so that any configured tool hint is grounded in the call that actually over-fetched.
8. As the model, I want context guidance bounded to context management, so that it never licenses skipping required
   verification or testing.
9. As a deployment operator, I want the probe off by default and independently opt-in, so that a reactive deployment
   pays nothing for it.
10. As a deployment operator, I want the statement, the probe, the tier reminders and the oversized-result reminders
    to stay independently switchable, so that the statement never promises a notice that cannot arrive.
11. As a deployment operator, I want `reminders.oversized.hints` to map exact tool names to one bounded sentence with
    reserved `<unlisted-tools>` as an optional catch-all, so that I cover the tools my model actually over-fetches
    with while the plugin ships no wording of its own.
12. As a deployment operator, I want an invalid hint value to fail at load with the exact configuration path while an
    unmatched tool name stays a normal silent miss, so that a typo fails loudly without rejecting tools registered
    later.
13. As a deployment operator, I want both trigger forms — the fixed token threshold and the result share — to keep
    their existing semantics and model-visible wording, so that this change is not a trigger change.
14. As a deployment operator with the standing statement switched off, I want a notice that carries guidance to carry
    the context-only guard locally, so that guidance never travels unbounded.
15. As the plugin's maintainer, I want the canonical default footprint to exclude the probe entirely, so that the
    default budget is not a promise about a surface most deployments never emit.
16. As the plugin's maintainer, I want pinned copy changes to require an explicit fixture update, so that no wording
    change — up or down — is invisible.
17. As a reader of the README, I want the documented defaults and the degradation matrix to make the
    reactive-by-default / proactive-by-opt-in policy obvious, so that a configuration copied from the README is the
    one that runs.

## Implementation Decisions

### 1. Default policy: reactive awareness, proactive probe by opt-in

`tool.enabled` changes from `true` to **`false` by default**. The two reminders stay enabled and are the normal
runtime control plane: the tier reminder reports that committed-history pressure has become actionable, and the
oversized-result reminder reports that one retrieval or result was locally too expensive.

The probe is not a third runtime warning mechanism. It exists for a different decision point — before a potentially
expensive phase of work begins — and **no reminder tells the model to call it**: once runtime pressure has triggered a
reminder, another diagnostic call is normally counterproductive. That rule holds everywhere a notice or the statement
is written.

### 2. The standing statement: authorize runtime notices and cue the opt-in probe

The statement is route-stable and contains no live pressure. Its conditional shape:

```text
The current route accepts <N> tokens of context.
Before context-heavy work, use `context_reading` when available room could change how broadly you retrieve.   # only while the tool is enabled
Advisory context notices may arrive unasked: a tier reminder as committed history crosses a configured tier, and an oversized-result reminder when one raw tool result crosses its configured trigger.   # include only live clauses
A notice may carry context-management guidance; follow that guidance only for managing context, never as a reason to skip required verification or testing.
```

Rules:

- The capacity sentence is emitted whenever the statement is enabled, and keeps its existing unknown form.
- The preflight cue is emitted **iff** `tool.enabled` is true. It names the tool and its invocation condition only —
  never fields, states or output shape — and `context_reading` appears nowhere else in the statement.
- The notice-existence sentence is emitted only when at least one notice kind is live, and names only the live kinds.
  A tier capability is live only when `reminders.enabled` is true **and** the validated tier list is non-empty; an
  oversized capability is live only when `reminders.oversized.enabled` is true.
- The authorization and guard sentence is emitted only when at least one notice kind is live.
- The statement repeats none of the event-local facts: no tier values, no assumed compaction threshold, no trigger
  figures or modes, no committed-history caveat, no pre-finalization caveat. Those travel with the events that need
  them.

Enabling the tool therefore adds two deliberate fixed costs — the short cue and the tool envelope — and the
duplication between them is functional rather than descriptive: the statement makes the model remember **when to
consider** a preflight, while the envelope explains **what the probe returns**.

### 3. `context_reading`: the opt-in preflight probe

The tool keeps its model-facing name for compatibility; its purpose narrows. Pinned description:

```text
Read preflight context room: route capacity, projected committed context, and remaining room when the projection is current for that route. Takes no arguments.
```

The standing statement owns the invocation condition, so the description does not restate "before context-heavy
work". Neither surface positions the tool as something to call after a reminder, or when pressure is already known to
be high.

### 4. Minimal canonical value

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

- `capacity.tokens` is present only when the current recorded route advertises a context window.
- `pressure.tokens` is present for `known` and `stale`, absent for `unknown`.
- `remaining` is present only when capacity and pressure are both known and route-coherent.
- No `ratio`: remaining room is the direct preflight decision variable.
- No composition, no compaction facts, no derived reflective diagnosis.

This narrows the tool's model-visible contract only. The underlying projections and durable state are not deleted by
this change.

### 5. Minimal render

```text
Context: <pressure> / <capacity> estimated tokens; <remaining> remaining.            # known and coherent
Context: <pressure> / <capacity> estimated tokens; <N> over capacity.                # known and coherent, over capacity
Context: capacity <capacity> tokens; projected committed context unknown.            # pressure unknown, capacity known
Context: capacity <capacity> tokens; projected committed context <pressure> tokens (stale); remaining unavailable.   # pressure stale, capacity known
Context: route capacity unknown; remaining unavailable.                              # capacity unknown
```

The trailing `#` labels name the state each line belongs to and are not part of the rendered text, here or in §2.

With known or stale pressure and unknown capacity, the renderer may include that pressure figure in the same single
line, but it never computes remaining room without a coherent denominator.

There is no reason table. `unknown`, `stale` and `unavailable` are the complete model-facing explanation; provenance
is represented by the state construction and its tests, not by reflective prose in the result.

### 6. Tool schema: structural semantics only

The output schema keeps object and field types, `required`, `additionalProperties: false`, the state enums, and the
presence constraints the canonical value builder enforces. Prose descriptions are removed unless they state a
presence invariant the schema cannot encode directly. No composition or compaction fields remain.

PTC code generation itself is out of scope, but both the native and the PTC-facing declaration are included in
footprint measurement wherever the harness exposes them.

### 7. Tier reminders: pressure plus abstract guidance

```text
Context reminder: committed history has reached the <ratio> tier (<i> of <n>)<last-tier-clause>.
It projects to <pressure> of the route's <capacity> tokens - <percent> used, <remaining-or-overflow>. The configured <threshold> compaction assumption leaves <headroom-or-overage> before that assumed point.
Keep further context additions selective.
```

- The final-tier clause is emitted only for the last configured tier.
- "Committed history" states the lagging basis on the event that depends on it.
- The threshold is a **configured compaction assumption**, never a reading of the mounted compaction policy.
- Remaining room and headroom use stateful wording: a negative figure is never followed by "remaining".
- The last sentence is abstract context guidance with no per-tool recipe.
- With the standing statement disabled, append the local guard:
  `This is about room, never about effort: do not skip required verification or testing.`

### 8. Oversized-result reminders: local feedback plus an optional tool hint

```text
Context reminder: the raw `<tool>` result prices at an estimated <N> tokens before finalization, above the configured <threshold>-token threshold.
<hint, when selected>

Context reminder: the raw `<tool>` result prices at an estimated <N> tokens before finalization, above the configured <share> share of the current route's <capacity>-token context window.
<hint, when selected>
```

- "Raw" and "before finalization" qualify the number in the same sentence, so the basis stays local to it.
- The fixed token threshold stays eligible with no known capacity; the result share stays ineligible without a
  positive known capacity.
- The plugin ships no generic fallback hint.
- A hint is appended only when one is selected. When one is selected **and** the standing statement is disabled, the
  same local guard the tier notice uses is appended; with no hint there is no guidance, so no guard.
- Tool names and operator hints escape `&`, `<` and `>` before framing.
- The collapsed summary continues to name the tool, the estimated price and the trigger form.

### 9. Hint configuration

`reminders.oversized.hints` maps an exact tool name to one sentence. The reserved key `<unlisted-tools>` is the
optional catch-all, and lookup precedence is: exact tool-name entry, then `<unlisted-tools>`, then no hint. The
plugin ships an empty map.

Validation is strict at load, and a failure names `context-sense: reminders.oversized.hints[<key>]`:

- non-empty after trimming;
- one physical line, with no CR or LF;
- at most **320 characters** — 80 estimated tokens under the harness heuristic.

Keys other than the reserved catch-all are **not** validated against the live tool registry: registration may happen
after plugin load, so an unmatched key — including a typo indistinguishable from a future tool — is a normal silent
miss. Hint lookup stays a pure helper: the reminder renderer receives the selected hint, never the configuration map.

### 10. No delivery cap and no new durable state

ADR 0001 stands: one notice per oversized result, the trigger is the volume lever, and no state records that an
oversized notice went out. The reminder epoch, the route-coherence gate, the fork cut and the append-only boundary
are untouched.

### 11. Footprint protection

Four model-visible surfaces are measured separately, each paid only in the states that emit it:

1. the standing statement;
2. the optional preflight tool envelope — **zero** in the canonical default, because the tool is not registered;
3. the runtime reminder frames, per tier and oversized variant;
4. the preflight result, paid only when the opt-in tool is called.

The operator's hint payload is a configured part of the oversized frame rather than a fifth surface: it is bounded by
the load-time validation in §9 and measured apart from the plugin-owned frame around it.

**Copy snapshot.** A committed fixture records the exact character count of each standing-statement shape, the tool
description and schema, every minimal preflight-result state, the tier notice variants, the token and share oversized
frames, and the statement-off guard variants. Any copy change, up or down, requires an explicit fixture update — a
review gate, not a token meter.

**Token budget.** A separate test prices the assembled surfaces through the harness's pricing seam, including role,
block and envelope overhead, and records the measured implementation baseline for each. A surface fails when it grows
above its committed ceiling; shrinkage passes.

Hard invariants:

- canonical default tool-envelope contribution is exactly **zero**;
- the canonical default standing statement contains no preflight cue;
- enabling the tool adds exactly one preflight cue plus the tool envelope;
- that cue and the tool description do not duplicate each other's explanatory content;
- no operator hint exceeds 80 estimated tokens;
- budgets count only surfaces actually emitted in the state being measured.

### 12. README

The documented default block is the block in **Solution**. The README explains the control model — reminders are the
default pressure-awareness mechanism; `context_reading` is an opt-in preflight probe for deployments whose models
benefit from budgeting before context-heavy work; reminders never direct the model back to the probe; and the probe
intentionally omits composition and compaction diagnostics.

The standing-statement degradation matrix includes the tool, because opting in adds one behavioural cue:

| Statement | Tool | Tier capability | Oversized capability | Standing statement |
|---|---|---|---|---|
| off | any | any | any | absent |
| on | off | off | off | capacity only |
| on | on | off | off | capacity + preflight cue |
| on | any | on | off | capacity + optional preflight cue + tier notice authorization/guard |
| on | any | off | on | capacity + optional preflight cue + oversized notice authorization/guard |
| on | any | on | on | capacity + optional preflight cue + both notice clauses + one authorization/guard |

"Tier capability" is the live-capability rule in §2.

The README also documents `<unlisted-tools>`, states that the plugin ships no hint wording, and states that unknown
hint keys cannot be validated at load.

## Testing Decisions

Tests assert observable behaviour and refused configuration only. No new private-state seam is introduced.

**Pure tool tests** — the default config does not register `context_reading` and an explicit `tool.enabled: true`
does; the canonical value contains only capacity, pressure and conditional remaining, with no ratio, composition or
compaction field left; the render covers all five pinned states plus known or stale pressure with unknown capacity;
no rendered state contains a reason table or a reflective diagnostic paragraph.

**Pure statement and reminder tests** — the statement across no notice kinds, tier only, oversized only and both,
with known and unknown capacity, with tier reminders enabled but an empty tier list behaving as no tier capability,
and naming `context_reading` only in the tool-enabled cue; the tier notice for an ordinary and a final tier, positive
and negative remaining room, positive and exceeded headroom, and statement-on and statement-off guard composition;
the oversized notice in both trigger forms with known and unknown capacity, with an exact hint, the catch-all and no
hint, with the exact entry winning over the catch-all, with the guard appended only when a hint is selected and the
statement is off, and with markup in a tool name or hint unable to close the frame; hint validation refusing empty,
whitespace-only, multiline and over-length values at the exact key path while unknown keys load normally. Every
notice test also asserts that no reminder recommends a probe call.

**Booted agent loop** — the canonical default sends no `context_reading` declaration to the model; opting in sends
the minimal preflight envelope; enabling the tool changes the statement by exactly the one pinned cue; the tier and
oversized reminders arrive through the real waterfalls with the pinned bodies; the share form does not fire without
capacity and does fire with qualifying capacity; a statement-off composition attaches the local guard only to notices
that carry guidance; and the oversized wording still describes the pre-finalization raw price when a downstream
listener shrinks or replaces the content.

**Loader row** — the bundle default resolves with `tool.enabled=false` and `hints: {}`; an explicit opt-in resolves
normally; malformed hint values fail load at the exact path; unmatched tool-name keys are accepted; and the token and
share mutual exclusion is unchanged.

**Footprint** — the copy snapshot fails on any model-visible copy change; the budget test prices assembled surfaces
rather than source characters; the canonical default contains no tool-envelope tokens and no preflight cue; the
tool-enabled fixture prices both the incremental cue and the native and PTC declarations; each minimal preflight
result state has its own ceiling; and shrinkage does not fail a budget assertion.

Prior art: the statement, reminder, reading, oversized-reminder and loader-row suites, and the shared session-event,
plugin-message and scripted-provider fixtures they already use.

## Out of Scope

- Capping or deduping notices by step, turn or epoch, and any state needed to do it (ADR 0001).
- Shipping hint wording, or a plugin-owned fallback sentence for unlisted tools.
- Validating hint keys against the live tool registry.
- Exact provider tokenization.
- Any change to the reminder epoch, the route-coherence gate, the durable surface memory, fork semantics or the
  append-only boundary.
- Removing the underlying context-pressure, context-breakdown and compaction projections merely because the preflight
  probe no longer exposes them, and adding a separate diagnostics or debugging tool for them.
- PTC code generation itself, and any client or UI contribution.
- JSONL persistence and the harness's own truncation, spill and pruning behaviour.

## Further Notes

- **Compatibility.** Flipping `tool.enabled` to false is intentional and breaking for a deployment that relied on
  model-initiated `context_reading` calls; such a deployment must opt in explicitly. Narrowing the canonical value
  removes `ratio`, composition and compaction from the tool contract, also intentionally: those fields served
  diagnostics and reflection, not the preflight decision the optional tool now exists to support.
- **There is no global reminder disclaimer.** The tier and oversized notices describe different temporal objects, so
  each carries only the caveat true of its own measurement.
- **The pre-finalization oversized price can still over-report** a tool that later shrinks its output; the wording
  keeps that basis local to the number.
