# 05: Oversized-result reminders on the post-execute waterfall

**What to build:** When a single tool result is large enough to consume a configured share of the route's
capacity, the model hears about it while the result is still attached to its own step — a one-line advisory in
the same plugin-owned `<system-reminder>` frame, naming what was large and how large, so the model can decide
what to do about it before the next request. The rule is deliberately conservative about what it can prove: it
reports the raw dispatch result, and it never fights the tier reminder.

Blocked by: 04 (needs the shared reminder artifact, the step cursor and its suppression field).

Status: ready-for-agent

- [ ] Config carries the oversized-result share of capacity (default 0.10), validated strictly in (0,1) and
      failing at plugin load like the tier ratios.
- [ ] On the `tools/post-execute` waterfall, the raw result is priced with `ctx.tokenMeter.estimateMessage(...)`
      on a tool-result-shaped message built from the waterfall's raw result. This is the only public pricing
      seam, and the sole reason `tokenMeter` is injected; the plugin never re-derives pricing from the meter's
      internals or its own heuristic.
- [ ] A single raw result whose estimated tokens exceed the configured share of capacity produces a reminder
      delivered with that result through the decision's `additionalContexts?: UserMessage[]`.
- [ ] The reminder uses the same artifact as the tier reminder — user-role, plugin-attributed, plugin-owned
      `<system-reminder>` frame, every interpolated value XML-escaped — but declares `form: 'notice'` with a
      `summary` bounded by `boundContextSummary` for a one-liner.
- [ ] Suppression is one-directional: the oversized reminder is suppressed when
      `pressureReminderStep === currentStep`. The reverse never suppresses — a tier signal is once per epoch,
      and withholding it would lose it for the whole epoch.
- [ ] The fork cut applies here too: turn and step numbers restart at 1 in a child, so an inherited
      `step/start` must never masquerade as the child's current step.
- [ ] Reminder text previews names and sizes only, never raw payloads.
- [ ] The oversized reminder has its own enable/disable flag in `Config`, independent of the tier reminder flag.
- [ ] Tests: an oversized raw result triggers; a tool whose `finalizeContent` shrinks its content still triggers
      on the raw pre-finalization basis (the rule may over-warn, and the implementation does not attempt to see
      post-finalization content — the only seam that sees it cannot attach context); no reminder for a result
      under the share; suppression when a pressure-tier reminder was delivered in the current step; the child
      case, where an inherited `step/start` is not treated as the current step.
- [ ] Unload removes the listener: it no longer fires.
