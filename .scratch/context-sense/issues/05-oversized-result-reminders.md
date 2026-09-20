# 05: Oversized-result reminders on the post-execute waterfall

**What to build:** When a single tool result is large enough to consume a configured share of the route's
capacity, the model hears about it while the result is still attached to its own step — a one-line advisory in
the same plugin-owned `<system-reminder>` frame, naming what was large and how large, so the model can decide
what to do about it before the next request. The rule is deliberately conservative about what it can prove: it
reports the raw dispatch result, and it never fights the tier reminder.

Blocked by: 04 (needs the shared reminder artifact, the step cursor and its suppression field).

Status: ready-for-agent

- [x] Config carries the oversized-result share of capacity (default 0.10), validated strictly in (0,1) and
      failing at plugin load like the tier ratios.
- [x] On the `tools/post-execute` waterfall, the raw result is priced with `ctx.tokenMeter.estimateMessage(...)`
      on a tool-result-shaped message built from the waterfall's raw result. This is the only public pricing
      seam, and the sole reason `tokenMeter` is injected; the plugin never re-derives pricing from the meter's
      internals or its own heuristic.
- [x] A single raw result whose estimated tokens exceed the configured share of capacity produces a reminder
      delivered with that result through the decision's `additionalContexts?: UserMessage[]`.
- [x] The reminder uses the same artifact as the tier reminder — user-role, plugin-attributed, plugin-owned
      `<system-reminder>` frame, every interpolated value XML-escaped — but declares `form: 'notice'` with a
      `summary` bounded by `boundContextSummary` for a one-liner.
- [x] Suppression is one-directional: the oversized reminder is suppressed when
      `pressureReminderStep === currentStep`. The reverse never suppresses — a tier signal is once per epoch,
      and withholding it would lose it for the whole epoch.
- [x] The fork cut applies here too: turn and step numbers restart at 1 in a child, so an inherited
      `step/start` must never masquerade as the child's current step.
- [x] Reminder text previews names and sizes only, never raw payloads.
- [x] The oversized reminder has its own enable/disable flag in `Config`, independent of the tier reminder flag.
- [x] Tests: an oversized raw result triggers; a tool whose `finalizeContent` shrinks its content still triggers
      on the raw pre-finalization basis (the rule may over-warn, and the implementation does not attempt to see
      post-finalization content — the only seam that sees it cannot attach context); no reminder for a result
      under the share; suppression when a pressure-tier reminder was delivered in the current step; the child
      case, where an inherited `step/start` is not treated as the current step.
- [x] Unload removes the listener: it no longer fires.

## Comments

Implemented. One new source module, one new listener module, and three changed ones:

- `src/reminder.ts` — the oversized rule beside the tier rule and the frame they share: `DEFAULT_OVERSIZED_RESULT_SHARE`,
  `OversizedResultPolicy` and its strict `resolveOversizedResultPolicy`, the pure `decideOversizedResultReminder`,
  the body renderer, `oversizedResultReminderMessage`, and one private `reminderMessage` both reminders are now
  built through, so "the same artifact as the tier reminder" is one piece of code rather than two that agree by luck.
- `src/oversized-reminders.ts` — the single `tools/post-execute` listener. It prices the raw result, decides
  before `next()` and folds its context into the decision after it.
- `src/index.ts` — `Config` gained `reminders.oversized` (`enabled`, `share`), and `apply` resolves **both**
  policies before registering anything, so an unusable share fails the plugin at load whether or not the rule
  is switched on.
- `src/session-state.ts` — `sameStepCursor` is now exported and shared by the fold and the new rule; the
  middle-man `sameCursor` is gone.
- `test/plugin-messages.ts` — one reader for "this plugin's own messages", used by both listener suites.

Coverage: `test/oversized-reminder.test.ts` (12) covers the threshold and its boundary, the missing capacity,
the one-directional suppression, the child cut, the frame and its escaping, the message shape and the bounded
summary, and validation; `test/oversized-reminder-listener.test.ts` (11) covers the loop — delivery to the
transcript and to the model, a result under the share, the pre-finalization basis, suppression in the step a
tier reminder went out at with an identically sized result delivered one step later, the two independent flags,
a decision rebuilt by another listener, a blocked call, and unload. 118 tests total.

Decisions the ticket did not settle:

- **The config groups the share under `reminders.oversized`** (`enabled`, `share`), which is the placement
  slice 04's own note recorded for this slice.
- **The tier policy still carries nothing it does not read.** Slice 04's review removed an unread field from a
  decision core's input, so the share gets its own `OversizedResultPolicy` and its own resolver rather than
  being folded into `ReminderPolicy` — which would have put a field into `TierReminderInput` that the tier core
  never touches. The resolver takes the config **block**, like `resolveReminderPolicy`, so the diagnostic path
  it names is a block it was actually given.
- **"The same step" is one rule with one home.** `sameStepCursor` is exported from `session-state.ts` and used
  by the fold's cursor and by the suppression test alike, and two absent positions are deliberately *not* the
  same position: a literal `===` would read `null === null` as "the current step" for a session's very first
  result, or for a child that has not started a step of its own. That reading is required by the fork-cut
  bullet, and it is pinned by both a pure test and the live one.
- **The listener is registered `{ prepend: true }`.** Unlike the tier listener it reads nothing a downstream
  listener can change — the price comes from the raw result — but it *delivers* into the decision, and being
  the outermost handler is what makes its fold the last word: a listener that rebuilds the decision from the
  accept shape alone can otherwise drop the context. Mutation-checked: dropping `{ prepend: true }` fails both
  the decision-rewrite test and the blocked-call test.
- **A blocked call is still enriched.** A `block` decision is as much a decision to attach context to as an
  accept one (both variants carry `additionalContexts`, which is the field the ticket names), and the notice's
  claim stays true — a raw result really was oversized, and the reminder never says the model received it.
  `dsh-repeat-tool-reminder`, the spec's cited prior art, makes the same choice for the same field. Pinned by a
  test asserting the block stands and the tool's own content never reached the model.
- **A failed result is priced like a successful one.** The ticket's subject is "a single raw result"; the rule
  is about the result's size, not its outcome, and narrowing it to successes would mean the model is told
  nothing when a failing tool floods the step.
- **The statement does not announce the oversized rule.** The spec review called the sentence I first added
  scope creep with a false-promise cost, and it is right: the spec's statement paragraph enumerates capacity,
  the tool, the configured *tiers* and the disclaimer, while the rule's delivery is conditional (suppressed in
  the step a tier reminder went out at) and impossible with no recorded capacity. What is kept is the reword it
  forced, which is required for truth: `no reminder will interrupt a step` → `no tier reminder will interrupt a
  step`, because a notice can now interrupt one. The notice explains itself when it fires.
- **The `finalizeContent` case is a characterization, not a mutation-checkable rule.** No seam that can attach a
  message sees post-finalization content, so no plausible alternative implementation could pass by mistake; what
  the test pins is the observable consequence (the model receives the shrunken text while the reminder quotes
  the raw price). The *suppression* rule is the mutation-checked one: neutralising it fails three tests.
- **Spec §6's "two listeners plus one projection unit" smoke line is covered behaviourally, not by counting.**
  The plugin now registers exactly those two listeners — tier on `agent/pre-step`, oversized on
  `tools/post-execute` — and each is asserted to fire and to stop firing after unload. Asserting the count
  itself would mean reading the event bus's own hook table, i.e. testing private state, which the repo's `tdd`
  guidance forbids; slices 03 and 04 made the same choice for the section and tool counts.

Review (fixed point `5d90843`, two axes, both addressed):

- *Standards* — no hard violations. Addressed: the third copy of the fold driver became
  `foldContextSenseEvents` in `test/session-events.ts`; the message readers both listener suites had duplicated
  became `test/plugin-messages.ts`; both reminder messages are built by one `reminderMessage`; the `sameCursor`
  middle man is gone; the share resolver takes the config block; the unexported-but-exported
  `OVERSIZED_RESULT_BASIS` is module-private again (and `OversizedSuppressionState` is now used by a fixture,
  like its tier sibling); glossary-avoided prose ("over-warn", "warned about") is reworded; the stale
  `@param input` is fixed. Not chased, with reason: merging the two listener suites' boot fixtures, which mount
  different things (a compaction backend vs. registered tools) and register different scripted calls.
- *Spec* — the statement creep, the §6 listener-count line and the untested block enrichment are all recorded
  above with what was done about each. `exec.callId`/`name`/`agent` and the priced message shape were
  independently checked against the loop's own `appendToolResult`.

`Status:` is left at `ready-for-agent`: the five canonical triage labels have no value meaning "implemented,
awaiting review", and ticking the boxes is what records progress here.
