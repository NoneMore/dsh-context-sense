# Fixed token threshold: make the oversized-result trigger absolute by default

Status: ready-for-agent

Harness baseline: **`dsh-v0.1.5-rc.2`**. Supersedes the oversized-result trigger contract in the first-version
spec and the defaults issue `05` records; nothing else about the plugin changes.

## Problem Statement

The oversized-result threshold is a fraction of the route's context window, which is wrong in two ways an
operator cannot configure away: it rescales with a window they do not control (a configured tenth is 38,400
tokens on a 384,000-token route and 100,000 on a 1,000,000-token one), and it has no denominator until a route
advertises a window — so the rule is silent exactly in the fresh or unadvertised session where a tool result's
cost is least visible.

## Solution

The oversized-result trigger takes one of two forms, and the **fixed token threshold** — an absolute token
count — is the form in force unless the operator names the other. It needs only the price the harness meter
already produces, so it holds in a session whose capacity is unknown and means the same thing on every route.
The **result share** stays available, chosen explicitly. Exactly one form is in force: a configuration naming
the other is refused at plugin load rather than silently ignored. The forms differ in the trigger and in how
much the reminder can say, and in nothing else — same price, same notice attached to the result that produced
it, same yielding to a pressure-tier reminder in that step, no new durable state. Rationale and rejected
alternatives: [ADR 0001](../../docs/adr/0001-fixed-token-threshold-as-default.md).

## User Stories

1. As a deployment operator, I want a usable threshold out of the box, so that I get useful reports without
   configuring anything.
2. As a deployment operator, I want that default to be an absolute token count, so that its meaning does not
   change when the session moves to a route with a different window.
3. As a deployment operator, I want the rule to work while capacity is unknown, so that a fresh session is not
   silently unprotected.
4. As a deployment operator, I want to set an absolute threshold of my own, so that I can tune it to what my
   tools actually return.
5. As a deployment operator, I want a share-of-window threshold still available, so that a route-relative rule
   remains an option.
6. As a deployment operator whose configuration names a share, I want load to refuse it now that the share is
   no longer the default form, so that I choose deliberately instead of running with a rule that is not in
   force.
7. As a deployment operator, I want the forms mutually exclusive and checked, and an unusable value to fail
   load rather than be clamped, so that a typo cannot silently change what the model is told.
8. As a deployment operator, I want my threshold validated even with the rule switched off, and an independent
   switch for the rule itself, so that a broken configuration surfaces and the tiers can stay without the
   per-result notices.
9. As the model, I want to be told when one tool result is large, attached to the very result that produced it,
   so that I can choose a narrower follow-up call in that step.
10. As the model, I want the threshold quoted in tokens and the price marked an estimate of the raw result, so
    that it is comparable with the other figures I am given and never read as a count of what I received.
11. As the model, I want the share-of-window clause dropped when capacity is unknown, so that I am never shown
    a ratio computed against a window nobody advertised.
12. As the model, I want a report that names the tool and the sizes only, and gives way to a pressure-tier
    reminder that already spoke in this step, so that the payload is not put back into my context and I am not
    told the same thing twice.
13. As the model, I want each oversized result reported in its turn, so that a later large result is not
    silenced by an earlier smaller one.
14. As the human reading the transcript, I want each report as a plugin-attributed row with a one-line account,
    so that I can see why the model was told something and still scan a long session.
15. As the plugin's maintainer, I want both forms decided by one pure rule and no new durable state, so that
    the figures quoted and the decision to remind cannot drift, and replay, resume and fork isolation keep
    their proofs.
16. As a forked child or a delegated subagent session, I want suppression decided on my own steps and my own
    tool calls reported, so that an inherited step start is never mistaken for mine.
17. As a reader of the README, I want the documented defaults to show the form actually in force, so that a
    configuration copied from the README is the one that runs.

## Implementation Decisions

**One trigger, two forms, exactly one in force.** The validated policy becomes a choice rather than one ratio:

```
{ mode: 'tokens', tokens: <positive integer> }   // the fixed token threshold, in force by default
{ mode: 'share',  share:  <ratio in (0, 1)> }    // the result share, chosen explicitly
```

**Configuration.** The oversized block keeps its place and gains a form selector; the two numeric fields carry
**no schema default**, so "was it configured?" stays answerable.

```yaml
oversized:
  enabled: true
  mode: tokens   # 'tokens' (default) or 'share'
  tokens: 8000   # omitted means the plugin default of 8000; only with mode: 'tokens'
  share: 0.10    # omitted means the plugin default of 0.10; only with mode: 'share'
```

- The block's whole-value default names only the form in force (enabled, the fixed form, its threshold): a
  default that also named a share would make every configuration self-contradictory and the check below
  meaningless.
- **Mutual exclusion is enforced at load**: the field the form in force does not name must be absent, or load
  fails naming `context-sense: reminders.oversized.<field>`. A configuration written for the previous default
  form fails loudly, once, with the fix in the message.
- **Validation stays strict and runs at load, before anything is registered, whether or not the rule is on**:
  `tokens` a positive integer (fraction, zero, negative, `NaN` or infinity is a deployment error); `share` a
  finite ratio strictly inside `(0, 1)`. Nothing is clamped, dropped or replaced.

**The decision core stays pure** — a function of the tool's name, the meter's price on the raw result, the
capacity if one was advertised, the validated policy and the folded step facts, and of nothing else. It reads no
projection, no clock and no module-level state, so the reminder the model receives and the decision to send it
come from the same facts.

- Fixed form: eligible when the price **exceeds** the threshold (exactly the threshold is not over it); **no
  capacity required**.
- Share form: unchanged — no advertised capacity means no eligible result, and exactly the share is not over it.
- Suppression unchanged and one-directional: an oversized report gives way when a pressure-tier reminder's step
  is the current step; a tier reminder is never withheld for one.
- A call with no owning agent, or a session with no plugin state, reports nothing.

**No new durable state.** The fold keeps exactly its two step facts (the current `(turn, step)` cursor and the
step a pressure-tier reminder went out at). Nothing records that an oversized report went out, so a second
oversized result in the same step is reported in its turn. Replay, resume and the fork cut are untouched.

**The artifact is unchanged and shared.** Both forms produce one user-role message attributed to this plugin,
carrying its text in the plugin-owned `<system-reminder>` frame with every interpolated value escaped,
declaring the `notice` context form with a harness-bounded summary, delivered through the post-execute
decision's additional contexts and attached to the result that produced it. The listener keeps its outermost
position, so a listener that rebuilds the decision cannot drop the report.

**Body and summary.** Fixed form, capacity known: tool name, estimated price, configured threshold, and a
trailing clause giving the price as a share of the advertised window. Fixed form, capacity unknown: the same
sentence without that clause, ending by stating plainly that the route's capacity is not known. Share form:
unchanged. Both forms keep the existing basis sentence — the figure prices the raw dispatch result before the
tool's own finalization, so a tool that shrinks its output may be reported larger than what the model received.
The bounded summary names the tool, the estimated price and the threshold (fixed form) or the window (share
form).

**Defaults.** The fixed threshold defaults to **8,000 estimated tokens** — roughly 32,000 bytes of ordinary text
under the meter's four-characters-per-token heuristic, deliberately below the harness's own default 50,000-byte
inline budget so that this plugin is the soft signal and the harness the hard one. The share's default stays
0.10, reached only by selecting the share form.

**Untouched:** the capacity statement (still does not announce the rule), the reading tool, the tier rule, the
reminder epoch, the route-coherence gate, and the injected services — the meter stays the only pricing seam and
no composition gains a requirement. The README's summary line, its documented default block, and the bundle
patch row's comment are updated to the form actually in force.

## Testing Decisions

Tests assert observable behaviour only: given a priced result, a capacity (or none), a configuration and the
folded step facts, does a reminder reach the model and what does its text say. Nothing asserts private state or
call counts, as in the existing suites. The seams already exist; no new one is introduced.

- **Pure decision core** — both forms' eligibility and their boundary, the fixed form with no capacity, the
  share form refusing without one, one-directional suppression.
- **Pure policy resolver** — each form kept exactly as configured; the non-mode field refused; `tokens` refused
  when non-positive, fractional, `NaN` or infinite; `share` kept inside `(0, 1)`; failure with the rule off.
- **Pure body renderer** — frame, escaping, both fixed-form shapes, the share-form body, the bounded summary.
- **Booted agent loop** (the existing scripted-provider harness) — the default form reporting with no advertised
  capacity, the share form still requiring one, the boundary, suppression by a tier reminder in the same step, a
  child whose inherited step start is not its own, the independent switch, unload.
- **The bundle's default row** — resolving to the fixed form with the default threshold, so the README's
  configuration is exercised against the declared schema.

Prior art: the oversized-result pure and listener suites, the loader-row suite, and the shared session-event and
plugin-message fixtures they already use.

## Out of Scope

- A threshold per tool, per route or per result kind; one configured trigger covers every oversized result.
- Capping reports per step, and any state that would be needed to do it.
- A running total of what results have cost, as opposed to one result at a time.
- Exact tokenization: the figure stays the meter's heuristic price, so it underprices CJK text and JSON schemas.
- Any change to the harness's truncation, spill or pruning behaviour, or any attempt to read the mounted spill
  policy as a reading rather than an assumption.
- Changes to the tiers, the epoch, the route-coherence gate, the reading tool, the capacity statement or the
  plugin's append-only boundary, and any client or UI contribution.

## Further Notes

- This spec supersedes the oversized-result parts of the first-version spec and of issue `05`; those files stay
  as the record of what was built, and where they disagree this document is the contract.
- The default's rationale rests on a fact verified read-only in the packaged harness: the global spill policy's
  default inline budget is 50,000 bytes and it hooks the same post-execute waterfall. That is why the default
  sits below it — never a reading the plugin claims at runtime, since the mounted budget is unreadable and the
  threshold stays an operator's assumption, like the assumed compaction threshold.
- Carried-over limitations: the raw pre-finalization price can over-report a tool that shrinks its output, and
  because the fixed form needs no capacity, a report can arrive in a session whose capacity is unknown — the
  point of the form, but also the case where a report may be the model's only size figure.
