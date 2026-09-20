# Context footprint: spend the plugin's tokens where they change behaviour

Status: ready-for-agent

Harness baseline: **`dsh-v0.1.5-rc.2`**. Changes behaviour and defaults of every model-visible surface the plugin
owns. Rationale and rejected alternatives: [ADR 0002](../../docs/adr/0002-reminders-carry-guidance.md) and
[ADR 0003](../../docs/adr/0003-tool-hints-are-operator-declared.md). Vocabulary: [CONTEXT.md](../../CONTEXT.md)
(`Context guidance`, `Tool hint`, `Context reminder`).

## Problem Statement

The plugin's own overhead was never designed, only accumulated, and it is paid on surfaces the model re-reads on
every request. Two failures follow. The standing statement spent 46 of its 104 tokens restating a caveat and never
told the model what to do with a warning it deliberately provokes; the tool's envelope description spent 233 tokens
per request enumerating rules the tool's own rendered output already states, in place, at the moment each rule
matters. And the cost was invisible: nothing failed when a surface grew, so every copy edit could quietly raise the
price of a plugin whose whole purpose is to reduce pressure.

## Solution

Every model-visible surface is repriced against one question — does this text change what the model does next, at
the moment it reads it? The standing statement grows to authorize the notices and to carry the caveat once, the
tool envelope shrinks to what the model needs in order to call the tool, the two notices shrink to what is timely
in their own step, and the tool's rendered reading explains its own non-obvious states instead of the envelope
pre-explaining every state on every request. A committed baseline then makes any future growth fail a test.

**Pinned footprint** (estimated tokens, the meter's four-characters-per-token heuristic plus role/block overhead):

| Surface | Current | This spec |
|---|---|---|
| Standing statement | 108 | **257** |
| Tool envelope (name, description, parameters) | 252 | **95** |
| **Fixed cost per request** | **360** | **352** |
| Tier notice | 154 | **74** |
| Oversized notice (no hint configured / with one) | 101 | **38 / 59** |
| Tool reading, stale / first request / all known | 170 / 167 / 132 | **156 / 153 / 132** |

The fixed cost is near flat while the statement gains a purpose, an authorization and a guard; the injected
notices fall by 40–60%.

## User Stories

1. As the model, I want to be told what a pressure state calls for, so that a reminder I cannot act on is not the
   most expensive surface per unit of value.
2. As the model, I want that guidance abstract, so that it never licenses skipping verification or testing.
3. As the model, I want the standing statement to authorize unasked notices, so that an injected message does not
   read as an interruption or an injection.
4. As the model, I want each notice to carry only what is timely in its own step, so that the configured tiers and
   thresholds are not restated where they change nothing.
5. As the model, I want the tool description to say what the tool reports, so that I can decide to call it without
   the envelope re-explaining every state it might return.
6. As the model, I want the tool's rendered reading to explain `unknown` and `stale` in the line that reports them,
   so that the meaning arrives when it is needed rather than on every request in advance.
7. As the model, I want an oversized notice to name the tool, its price and the configured threshold, so that I can
   choose a narrower follow-up call in that step.
8. As the model, I want a tool hint specific to the kind of call that produced the result, so that the advice fits
   the tool I actually over-fetched with.
9. As the model, I want to be told when a notice's price is a pre-finalization estimate, so that I never read it as
   a count of what I received.
10. As a deployment operator, I want to declare a hint per tool name under `oversized.hints`, so that I cover the
    tools my model actually over-fetches with instead of relying on one generic sentence.
11. As a deployment operator, I want a reserved `<unlisted-tools>` entry as an optional catch-all, so that full
    coverage is my choice rather than the plugin's assumption.
12. As a deployment operator, I want the plugin to ship no hint wording of its own, so that the words are mine.
13. As a deployment operator, I want the four switches to stay independent and the statement to match them, so
    that switching a subsystem off never leaves the model promised a notice that cannot arrive.
14. As a deployment operator with the statement switched off, I want the guard and the pre-finalization caveat to
    ride the notices instead, so that guidance never arrives without the sentence that bounds it.
15. As a deployment operator, I want an empty or whitespace-only hint refused at load, and a tool name I have not
    listed to be silently unmatched rather than an error, so that a typo fails loudly while an unknown tool
    degrades.
16. As the plugin's maintainer, I want a committed footprint baseline covering every surface, so that any growth
    fails a test and names the surface that grew.
17. As the plugin's maintainer, I want that baseline to fail on shrinkage too, so that it stays a true record.
18. As a reader of the README, I want the documented default block to show the hint key, so that a configuration
    copied from the README is the one that runs.

## Implementation Decisions

**The standing statement (package B: the statement authorizes, each notice instructs).** Seven parts, in order,
emitted conditionally. Pinned copy, each part a single sentence:

```
The current route accepts <N> tokens of context.
`context_reading` reports a live, source-attributed reading of that room on demand: capacity, the harness's projection of what the next request costs, the ratio between them, and the approximate split between system prompt, tool definitions and messages.
Two advisory notices may arrive unasked: a tier reminder when committed history reaches <tiers> of the window, and an oversized-result notice when one raw tool result prices above <threshold> estimated tokens.   # one clause per live subsystem
An advisory notice may carry its own guidance; follow it when it does.
Such a notice is about room, never about effort: it is no reason to skip verification or testing.
A reminder describes committed history rather than the request being assembled, and the threshold it names is an assumed policy value, not a reading of the mounted compaction policy.
An oversized-result figure prices the raw dispatch result before the tool's own finalization, so it may exceed what the model actually received.
```

- `capacity` and the tool sentence are always emitted. The capacity sentence keeps its unknown form.
- The notice-existence sentence names **only** the kinds that can arrive: the tier clause only while
  `reminders.enabled`, the oversized clause only while `reminders.oversized.enabled`. This generalizes the existing
  `announcedTiers` rule, which already refuses to promise a tier reminder that cannot come.
- With **no** notice kind live, the whole notice group — existence, authorization, guard, disclaimer, basis — is
  omitted and the statement degrades to capacity plus the tool sentence.
- With the statement switched off, the **guard** rides each tier notice and the **basis** rides each oversized
  notice, so neither a guidance sentence nor a pre-finalization price ever travels unbounded. The plugin already
  knows both flags at load.
- The authorization sentence says *may* carry, not *does*: with no hint configured an oversized notice carries its
  reading alone, and the statement must stay true in that configuration.
- The statement keeps its route-stable rendering: capacity and the configured figures only, never live pressure.

**The tool envelope.** The description is replaced by pinned copy (300 characters, ~90 tokens priced):

```
Read this session's context window: the route's capacity, the projected cost of the next request, and how the surface divides between system prompt, tool definitions and conversation messages. Every figure states its source; an unmeasured figure reads as unknown, never estimated. Takes no arguments.
```

The output schema keeps every structural constraint — `required`, `additionalProperties`, `enum`, `const`, types —
and drops the prose descriptions that duplicate this description and the render, because under PTC mode those
descriptions are the model's only declaration and prose there costs far more than the same words in the statement.

**The rendering dedup.** The reading's reason table is rephrased as pointers to the lines above it
(`the pressure figure above is not known yet`, `the pressure figure above is not confirmed for this route`,
`the capacity above is not known yet`), so the `Ratio and remaining room` line stops restating a cause the previous
two lines have already given in full. Every state keeps its own explanation in its own line; nothing becomes
inferable-only.

**The tier notice.** The existing measurement body plus one abstract line, no imperative:

```
Context reminder: committed history has reached the <ratio> tier (<i> of <n>) - the last configured tier.   # the trailing clause only on the last tier
It projects to <pressure> of the route's <capacity> tokens - <percent> used, <remaining> remaining. The assumed <threshold> compaction threshold leaves <headroom> tokens of headroom.
Committed history cannot be reduced from here.
```

The third sentence states a fact the model cannot act around (it cannot shrink committed history and cannot trigger
compaction); the emphatic description carries the urgency. The guard sentence is appended only when the statement
is switched off.

**The oversized notice.** The reading body, then one tool hint when the configuration supplies one:

```
Context reminder: the `<tool>` result prices at an estimated <N> tokens, above the configured <threshold>-token threshold.
<hint for that exact tool name, else the `<unlisted-tools>` entry, else nothing>
```

The basis sentence is appended only when the statement is switched off.

**Hint configuration.** `reminders.oversized.hints` is a map of exact tool name to one sentence, with the reserved
key `<unlisted-tools>` as the optional catch-all — the harness's own reserved-rest marker, so a real tool name
cannot collide with it. Validation is strict and at load: an empty or whitespace-only hint is a deployment error
naming `context-sense: reminders.oversized.hints[<key>]`; tool names are **not** validated, because registrations
follow plugin load and a deployment may add tools at runtime, so an unmatched name is a normal state and not an
error. An unmatched tool with no catch-all yields a notice with no hint. The plugin's own bundle row ships no hint
entries: the words belong to the deployment.

**No delivery cap, and no new durable state.** ADR 0001 stands: one notice per oversized result, the threshold is
the volume lever, and no state records that a notice went out. The reminder epoch, the route-coherence gate, the
fork cut and the append-only boundary are untouched.

**The footprint baseline.** A committed fixture records, for the canonical default configuration (the bundle's own
row, capacity 384000, the default tiers and threshold), the rendered character count of each surface: the statement,
the tool envelope, both notice bodies, the guard-and-basis variants that the statement-off composition produces,
and the five reading states. The test fails on **any** deviation up or down, and its failure message gives the
surface, the direction and both figures. Updating the baseline is a deliberate act in the same change as the growth.

**README.** The documented default block gains the `hints` key and its reserved catch-all; the reading-semantics
section gains the flag-degradation matrix (which parts of the statement are emitted for which switch combination)
and states that the plugin ships no hint wording.

## Testing Decisions

Tests assert observable behaviour only — what text reaches the model, and what a configuration is refused for.
Nothing asserts private state or call counts. The three existing seams are used; **no new seam is introduced**.

- **Pure renderers** (`lib/` exports called directly, as in the statement, reminder and reading suites): the
  statement's every conditional shape across the four switch combinations; the tier notice with and without the
  last-tier clause and with the guard appended; the oversized notice with an exact-match hint, with the catch-all,
  and with neither; the reading's five states and the rephrased reason table; the tool description and the
  description-free output schema.
- **The booted agent loop** (the existing scripted-provider harness): a tier reminder and an oversized reminder
  reaching the model through the real waterfalls with the pinned bodies; the statement-off composition attaching
  the guard and the basis to their notices; the tool envelope as the model actually receives it.
- **The bundle's default row** (the existing loader-row suite): resolving with no hints declared, and a
  whitespace-only hint failing load with the naming message.
- **The footprint baseline** (new file, existing pure-renderer seam): the canonical configuration's surfaces
  measured against the fixture, failing on growth and on shrinkage.

Prior art: the statement, reminder, reading, oversized-reminder and loader-row suites, and the shared
session-event, plugin-message and scripted-provider fixtures they use.

## Out of Scope

- Capping or deduping notices by step, turn or epoch, and any state that would be needed to do it (ADR 0001).
- Shipping hint wording, and any plugin-owned fallback sentence for unlisted tools.
- Validating hint keys against the live tool registry.
- Exact tokenization: every figure stays the meter's heuristic price.
- Any change to the reminder epoch, the route-coherence gate, the durable surface memory, the tool's canonical
  value, the compaction facts, or the append-only boundary.
- PTC mode's code generation itself, and any client or UI contribution.
- The JSONL persistence format and the harness's own truncation, spill and pruning behaviour.

## Further Notes

- **The pinned copy is the baseline.** Wording may still be revised; a revision is a deliberate act that updates
  the footprint baseline in the same change, which is exactly what the baseline is for. The pinned strings are the
  measured ones, not placeholders.
- **One phrasing resolved to stay true**: the authorization sentence says *may* carry guidance, because with no
  hint configured an oversized notice carries its reading alone. A sentence promising guidance would be false in
  the shipped default.
- **Facts the numbers rest on**, all verified read-only in the packaged harness: the envelope carries only
  `name`, `description` and `parameters`, so the output schema costs nothing in native function calling and costs
  prose-only in PTC mode; `read` caps at 51,200 bytes (≈12,800 estimated tokens) and `pwsh`/`bash` at 64,000 bytes
  per stream (≈16,000), which is why the default 8,000-token threshold fires often enough that the notice body is
  worth shortening; the model cannot trigger compaction, since `compactNow` is reachable only from the
  user-invoked `/compact` command.
- Carried-over limitations: the pre-finalization price can over-report a tool that shrinks its output, and the
  plugin's reminder bodies still quote the harness's heuristic figures rather than counts.
