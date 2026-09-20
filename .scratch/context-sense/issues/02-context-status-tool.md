# 02: `context_status` tool reporting the live reading

**What to build:** The model can ask, at any point in a session, what its context looks like right now, and gets
back a source-attributed reading: how much capacity the route has, what the harness projects the next request
will cost, how the surface divides between system prompt, tool definitions and messages, and — for each figure
— where that figure came from. Nothing is fabricated: an unmeasured pressure reads as unknown, and the reading
never substitutes composition for pressure.

Blocked by: 01 (needs the plugin skeleton, the config schema, the test harness and the loader row).

Status: ready-for-agent

- [ ] One parameterless tool (`parameters: {}`) under a name that does not collide with a built-in.
- [ ] The tool's canonical value is its declared `output.schema`: capacity plus a capacity-known flag, the
      pressure figure plus a pressure state of `known` / `unknown`, composition, and a per-figure provenance
      label.
- [ ] Provenance values are exactly `route-metadata` (capacity), `provider-anchored` (pressure, present only
      when the projection carries a figure) and `heuristic` (composition). There is deliberately no
      `heuristic-only` pressure value.
- [ ] Capacity is read as route metadata from the newest recorded route; unknown when no route advertised one;
      never defaulted and never estimated.
- [ ] Pressure is `snapshot(session, ['contextPressure'])` with the figure `projectedTokens ?? pressureTokens` —
      the same numerator the human meter uses. The plugin never calls `ctx.tokenMeter.measure()` and never
      re-derives pressure from the unit's internals; a composition without the `contextPressure` unit degrades
      to unknown.
- [ ] When the projection carries neither `projectedTokens` nor `pressureTokens` the session has no
      provider-reported usage sample yet, so pressure state is `unknown` — no ratio, no remaining, and no
      fallback to composition.
- [ ] Composition is read from `contextBreakdown` (`systemTokens`, `toolsTokens`, `messageTokens`), labelled as
      the harness's approximate heuristic, not expected to sum to pressure, and never presented as a total.
- [ ] The model-facing text comes from a separate pure `output.render(args, value)`. At this slice it reports
      that the ratio and remaining room are not yet available — route coherence is not established yet — and
      omits both rather than computing them from composition or across routes.
- [ ] The reading is taken from live session state through `exec.agent.session`, so repeated calls within one
      turn are each correct; an execution with no agent reports unknown rather than failing.
- [ ] The tool writes nothing: it appends no message, mutates no history, and its only conversation effect is
      its own result.
- [ ] The tool has an independent enable/disable flag in `Config`, separate from the prompt statement's flag.
- [ ] Unit tests cover the pure render and the provenance/state labelling; integration covers fresh-session
      pressure unknown → known and asserts that no composition-derived total is ever presented as pressure.
- [ ] Registration smoke test: exactly one tool registered in each agent's scope.
- [ ] Unload unregisters the tool.
