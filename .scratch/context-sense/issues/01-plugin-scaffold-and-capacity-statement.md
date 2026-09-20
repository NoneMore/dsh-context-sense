# 01: Installable plugin with the context-capacity statement

**What to build:** The repository stops being documentation-only and becomes a working DSH plugin. In a real
session the model sees a standing statement, in its own system prompt, of how much context its current route
accepts — or a plain statement that capacity is not yet known — along with the name of the tool it can call for
a live reading and the reminder tiers it should expect. The plugin is loadable by the harness from its own
declared loader row, so this first slice reaches all the way from a booted agent loop to model-visible text.

Blocked by: None (can start immediately).

Status: ready-for-agent

- [ ] Tooling is chosen and committed: TypeScript compiled to an ESM `lib/` with declarations, DSH SDK packages
      as peer dependencies, a test runner that can host both pure unit tests and a booted agent loop, and
      scripts for build, typecheck and test. Established against harness `dsh-v0.1.5-rc.2`, with
      `@deepseek-ai/dsh-agent-loop-testkit@0.1.5-rc.2` pinned exactly (its `latest` tag points at an old
      `0.0.1-rc.1`).
- [ ] The plugin is a standard Cordis plugin exporting `name`, `inject`, `Config` and `apply`, with `inject`
      declaring `sessionProjections`, `systemPrompt`, `tools` and `tokenMeter`, so a composition missing one
      fails at load rather than degrading silently.
- [ ] A bundle patch declares the plugin's own loader row (a local absolute path or file URL is a valid row
      name); a smoke test boots a minimal composition by that row and gets the plugin applied.
- [ ] One named prompt section per agent scope, registered through that agent's scoped `inject` and held as a
      disposer tied to that agent. Sections install for every agent the registry already holds at load, and for
      every agent announced later on `agent/created`; a subagent created after load therefore gets its own.
- [ ] The section text states the route's capacity in tokens when one is known, says plainly that capacity is
      not yet known otherwise, names the `context_status` tool, states the configured reminder tiers, and states
      that a reminder describes committed history and that the threshold it names is an assumed policy value.
- [ ] Capacity comes from the newest route the harness has recorded for the session
      (`session.requestContext()?.contextWindow`, or `contextPressure.contextWindow` from the same snapshot):
      route metadata, never an estimate, unknown when no route advertised one, and never defaulted.
- [ ] The section sits at a fixed order after the harness identity and persona prefix and ahead of the policy
      and tool sections, and is never marked `complete`.
- [ ] The section carries capacity only, never live pressure and never a ratio — a section carrying pressure
      would append a new system message every step or rewrite the request prefix and invalidate the provider
      cache.
- [ ] The statement has an independent enable/disable flag in the declared `Config` schema; when disabled, no
      section is registered.
- [ ] Registration smoke test: booting against a minimal context holding one agent yields exactly one prompt
      section in that agent's scope.
- [ ] Integration: a booted agent loop with a deterministic scripted `LlmAdapter` registered through
      `ctx.llm.registerAdapter` shows the capacity statement in the assembled prompt — reading "not yet known"
      on a first request with no recorded route, and the concrete capacity once a request has recorded one.
- [ ] Unload removes the section: it is absent from prompt assembly afterwards.
