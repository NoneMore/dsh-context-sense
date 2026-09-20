# 02: `context_reading` tool reporting the live reading

**What to build:** The model can ask, at any point in a session, what its context looks like right now, and gets
back a source-attributed reading: how much capacity the route has, what the harness projects the next request
will cost, how the surface divides between system prompt, tool definitions and messages, and — for each figure
— where that figure came from. Nothing is fabricated: an unmeasured pressure reads as unknown, and the reading
never substitutes composition for pressure.

Blocked by: 01 (needs the plugin skeleton, the config schema, the test harness and the loader row).

Status: ready-for-agent

- [x] One parameterless tool (`parameters: {}`) under a name that does not collide with a built-in.
- [x] The tool's canonical value is its declared `output.schema`: capacity plus a capacity-known flag, the
      pressure figure plus a pressure state of `known` / `unknown`, composition, and a per-figure provenance
      label.
- [x] Provenance values are exactly `route-metadata` (capacity), `provider-anchored` (pressure, present only
      when the projection carries a figure) and `heuristic` (composition). There is deliberately no
      `heuristic-only` pressure value.
- [x] Capacity is read as route metadata from the newest recorded route; unknown when no route advertised one;
      never defaulted and never estimated.
- [x] Pressure is `snapshot(session, ['contextPressure'])` with the figure `projectedTokens ?? pressureTokens` —
      the same numerator the human meter uses. The plugin never calls `ctx.tokenMeter.measure()` and never
      re-derives pressure from the unit's internals; a composition without the `contextPressure` unit degrades
      to unknown.
- [x] When the projection carries neither `projectedTokens` nor `pressureTokens` the session has no
      provider-reported usage sample yet, so pressure state is `unknown` — no ratio, no remaining, and no
      fallback to composition.
- [x] Composition is read from `contextBreakdown` (`systemTokens`, `toolsTokens`, `messageTokens`), labelled as
      the harness's approximate heuristic, not expected to sum to pressure, and never presented as a total.
- [x] The model-facing text comes from a separate pure `output.render(args, value)`. At this slice it reports
      that the ratio and remaining room are not yet available — route coherence is not established yet — and
      omits both rather than computing them from composition or across routes.
- [x] The reading is taken from live session state through `exec.agent.session`, so repeated calls within one
      turn are each correct; an execution with no agent reports unknown rather than failing.
- [x] The tool writes nothing: it appends no message, mutates no history, and its only conversation effect is
      its own result.
- [x] The tool has an independent enable/disable flag in `Config`, separate from the prompt statement's flag.
- [x] Unit tests cover the pure render and the provenance/state labelling; integration covers fresh-session
      pressure unknown → known and asserts that no composition-derived total is ever presented as pressure.
- [x] Registration smoke test: exactly one tool registered in each agent's scope.
- [x] Unload unregisters the tool.

## Comments

Implemented. Every acceptance box above is covered by a test that fails if the behaviour is removed
(`test/reading.test.ts`, `test/tool-registration.test.ts`, `test/reading-integration.test.ts`; 37 tests total,
`npm test` builds `lib/` first so the tests exercise the artifact a deployment loads). The two pure seams are
`buildContextReading` (the labelling rules) and `renderContextReading` (the model-facing text), both in
`src/reading.ts`; `src/reading-tool.ts` is the thin adapter that reads the live session and declares the
schema.

Decisions the ticket did not settle:

- **Composition carries its own `known` flag.** The ticket names a known flag only for capacity, but an
  agent-less execution — and a composition without the `contextBreakdown` unit — has no composition to
  report, and the alternative to a flag is either fabricating zeros or failing a valid call. The flag mirrors
  capacity's, and the render says "unknown" in exactly that case.
- **Capacity and composition use the ticket's own "known flag" spelling, and only pressure uses `state`.**
  The ticket fixes `state: known / unknown` for pressure (`stale` arrives with route coherence) and a
  "capacity-known flag" for capacity; composition follows capacity. One representation for all three is not
  available without contradicting the ticket, so the two spellings stand, and `renderContextReading` branches
  twice on them.
- **The tool is registered once, globally, not once per agent scope.** The reading is per-call
  (`exec.agent.session`), so a per-agent registration would multiply identical definitions for no gain; the
  registration smoke test asserts each agent scope resolves exactly one tool and that the global view holds
  one too.
- **`CONTEXT_READING_TOOL_NAME` moved from `src/statement.ts` to `src/reading-tool.ts`,** the module that owns
  the tool. `statement.ts` imports it, so the statement still names the registered tool from one source.
- **The statement no longer says what the tool reports, only that it exists.** It read "for a live reading of
  context pressure, remaining room and composition", which this slice cannot support: the reading reports
  pressure and composition and says the ratio and the remaining room are not available yet. The sentence now
  names the tool and its source attribution, which is true both now and once route coherence lands.
- **The reading's input types are the SDK's own `ContextPressureProjection` and `ContextBreakdownProjection`**
  (type-only, from `@deepseek-ai/dsh-token-meter/client` — the only subpath that re-exports them; there is no
  `./projection` subpath despite that module's own doc comment). This binds the reading to the projection
  contract that a version bump would have to change, and brings the `SessionProjectionMap` augmentation into
  the `tsconfig.build.json` program.
- **The fresh unknown → known progression is observed through the registry's dispatch seam**
  (`ctx.tools.execute`), on a session that has sent no request. A model-requested call cannot observe the
  fresh state: the model can only call a tool after a request, and that request's usage sample is already
  committed when the tool runs. The loop path is covered separately by scripting the adapter to request
  `context_reading` and asserting the reading the model reads back on the next request.
- **The booted-loop tests share one scripted provider fixture** (`test/scripted-provider.ts`, with the tool
  request behind an `askForReading` option). The two integration files previously carried near-copies of the
  same adapter, constants and helpers.

`Status:` is left at `ready-for-agent`: the five canonical triage labels have no value meaning "implemented,
awaiting review", and ticking the boxes is what records progress here.


