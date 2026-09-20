# 01: Fixed token threshold as the default oversized-result trigger

**What to build:** Mount the plugin and the oversized-result rule works with an absolute token threshold — 8,000
estimated tokens unless the operator says otherwise — including in a session whose route advertises no context
window, where today the rule is silent. The notice quotes the threshold in tokens and drops the share-of-window
clause when capacity is unknown. An operator who wants the window fraction back selects the share form
explicitly, and a configuration that names the field the form in force does not use is refused at plugin load
with a diagnostic naming it. Nothing else about the plugin changes.

Contract: [the spec](../spec.md) and [ADR 0001](../../../docs/adr/0001-fixed-token-threshold-as-default.md).

Blocked by: None (can start immediately).

Status: ready-for-agent

- [x] The validated policy is one of two mutually exclusive forms — a fixed token threshold (a positive integer,
      defaulting to 8,000 when omitted) or a result share (a ratio in `(0, 1)`, defaulting to 0.10 when the share
      form is selected) — and configuring the field the form in force does not name fails plugin load with a
      diagnostic naming `context-sense: reminders.oversized.<field>`, whether or not the rule is enabled. The
      config block's whole-value default names only the form in force.
- [x] An unusable value fails the plugin at load and is never clamped, dropped or replaced: `tokens` must be a
      positive integer, `share` a finite ratio strictly inside `(0, 1)`.
- [x] The fixed form reports one raw result whose estimated price strictly exceeds the threshold, and requires no
      advertised capacity; the share form keeps its meaning (a known capacity is required, and exactly the share
      is not over it). Both price the raw dispatch result through the harness meter, before finalization.
- [x] The notice's body names the tool, the estimated price and the configured threshold, appends the price as a
      share of the advertised window when capacity is known, and otherwise ends by stating plainly that the
      current route's context capacity is not known. The bounded summary names the tool, the price and the
      threshold. The frame, the escaping, the `notice` context form and the basis sentence are unchanged, and no
      report quotes the result's content.
- [x] Nothing about delivery or state changes: the report is attached to the result that produced it, a
      pressure-tier reminder in the same step still suppresses it, each oversized result in a step is reported in
      its turn, and no durable state is added — replay, resume and the fork cut are untouched.
- [x] The capacity statement still does not announce the rule, and the reading tool, the pressure tiers, the
      reminder epoch and the route-coherence gate behave exactly as before.
- [x] The README's summary line and its documented default configuration block, and the bundle patch row's
      comment, state the form actually in force; the declared row still boots unchanged.
- [x] Tests, at the existing seams and no new ones: the pure suite covers both forms' eligibility and boundary,
      each form with no advertised capacity, and the new validation including the failure with the rule switched
      off; the render covers both fixed-form shapes and the bounded summary; the booted-loop suite covers the
      default form reporting with no advertised capacity, the share form still requiring one, suppression and
      unload. Prior art is the existing oversized-result pure and listener suites.
