# 01: Installable plugin with the context-capacity statement

**What to build:** The repository stops being documentation-only and becomes a working DSH plugin. In a real
session the model sees a standing statement, in its own system prompt, of how much context its current route
accepts — or a plain statement that capacity is not yet known — along with the name of the tool it can call for
a live reading and the reminder tiers it should expect. The plugin is loadable by the harness from its own
declared loader row, so this first slice reaches all the way from a booted agent loop to model-visible text.

Blocked by: None (can start immediately).

Status: ready-for-agent

- [x] Tooling is chosen and committed: TypeScript compiled to an ESM `lib/` with declarations, DSH SDK packages
      as peer dependencies, a test runner that can host both pure unit tests and a booted agent loop, and
      scripts for build, typecheck and test. Established against harness `dsh-v0.1.5-rc.2`, with
      `@deepseek-ai/dsh-agent-loop-testkit@0.1.5-rc.2` pinned exactly (its `latest` tag points at an old
      `0.0.1-rc.1`).
- [x] The plugin is a standard Cordis plugin exporting `name`, `inject`, `Config` and `apply`, with `inject`
      declaring `sessionProjections`, `systemPrompt`, `tools` and `tokenMeter`, so a composition missing one
      fails at load rather than degrading silently.
- [x] A bundle patch declares the plugin's own loader row (a local absolute path or file URL is a valid row
      name); a smoke test boots a minimal composition by that row and gets the plugin applied.
- [x] One named prompt section per agent scope, registered through that agent's scoped `inject` and held as a
      disposer tied to that agent. Sections install for every agent the registry already holds at load, and for
      every agent announced later on `agent/created`; a subagent created after load therefore gets its own.
- [x] The section text states the route's capacity in tokens when one is known, says plainly that capacity is
      not yet known otherwise, names the `context_reading` tool, states the configured reminder tiers, and states
      that a reminder describes committed history and that the threshold it names is an assumed policy value.
- [x] Capacity comes from the newest route the harness has recorded for the session
      (`session.requestContext()?.contextWindow`, or `contextPressure.contextWindow` from the same snapshot):
      route metadata, never an estimate, unknown when no route advertised one, and never defaulted.
- [x] The section sits at a fixed order after the harness identity and persona prefix and ahead of the policy
      and tool sections, and is never marked `complete`.
- [x] The section carries capacity only, never live pressure and never a ratio — a section carrying pressure
      would append a new system message every step or rewrite the request prefix and invalidate the provider
      cache.
- [x] The statement has an independent enable/disable flag in the declared `Config` schema; when disabled, no
      section is registered.
- [x] Registration smoke test: booting against a minimal context holding one agent yields exactly one prompt
      section in that agent's scope.
- [x] Integration: a booted agent loop with a deterministic scripted `LlmAdapter` registered through
      `ctx.llm.registerAdapter` shows the capacity statement in the assembled prompt — reading "not yet known"
      on a first request with no recorded route, and the concrete capacity once a request has recorded one.
- [x] Unload removes the section: it is absent from prompt assembly afterwards.

## Comments

Implemented. Every acceptance box above is covered by a test that fails if the behaviour is removed
(`test/statement.test.ts`, `test/registration.test.ts`, `test/loader-row.test.ts`,
`test/integration.test.ts`; 15 tests, `npm test` builds `lib/` first so the tests exercise the artifact a
deployment loads).

Two decisions the ticket did not settle:

- **`inject` also names `agents`.** The ticket lists the four services the plugin contributes to; the
  registry of live agents is a fifth service this slice reads (`ctx.agents.list()`, plus the
  `agent/created` listener), and the harness convention is to declare every service read as `ctx.<name>`
  (see `dsh-goal-round-driver`). The four named services are all still declared.
- **The bundle patch's row name is this package's own name (`dsh-context-sense`), not a path or file
  URL.** A bundle patch is applied at the *profile's* `baseUrl` and the loader imports a row's `name`
  verbatim (`!!js` interpolation reaches a row's `config` and `disabled`, never its `name`), so a path
  relative to this checkout would not resolve once the package is a profile bundle. A local absolute path
  or file URL remains valid for a checkout that is not installed as a bundle. The smoke test reads the
  row from the committed `cordis.patch.yml`, boots a loader tree by it and asserts the plugin applied;
  changing that row name makes the test fail with `ERR_MODULE_NOT_FOUND`.

- **The tool is `context_reading`, not `context_status`.** Code review flagged that `context_status` drifted to a
  synonym `CONTEXT.md` explicitly avoids ("Context reading" — _avoid_: status, report, metrics). The spec and
  ticket 02 (`issues/02-context-reading-tool.md`) were corrected to match the glossary rather than the glossary
  being widened to match them.

`Status:` is left at `ready-for-agent`: the five canonical triage labels have no value meaning "implemented,
awaiting review", and ticking the boxes is what records progress here.
