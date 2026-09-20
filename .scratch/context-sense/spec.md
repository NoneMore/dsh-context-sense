# Context Sense — give the model awareness of its own context window

Status: ready-for-agent

## Problem Statement

DeepSeek Harness already shows the *human* how full the context is: a context meter renders a ring with used/window, a percentage, and a popover splitting occupancy into system, tools and messages. The *model* is told none of it.

From inside a session the model cannot tell whether it sits at 5% or 75% of its context window. It cannot see which of its own actions are consuming the budget. It receives no signal before auto-compaction fires at 80% of capacity and silently replaces its history with a checkpoint summary. The consequences are visible in behaviour: the model keeps producing large tool outputs and long prose when it is close to the ceiling; it holds conclusions in its context that it could have written to a file; it is surprised when the conversation it remembers becomes a `<compacted-summary>`; and the user cannot ask "how much room do you have left?" because there is no way for the model to find out.

The asymmetry is the whole problem: the harness measures context pressure continuously and acts on it automatically, but the party whose behaviour most depends on that measurement is the only one not informed of it.

## Solution

A DeepSeek Harness plugin, `context-sense`, that gives the model the context awareness the human already has. It has three parts:

1. **Standing knowledge.** A stable system-prompt statement of the session's context window capacity, so the model always knows the size of the space it is working in.
2. **On-demand reading.** A `context_status` tool the model can call at any moment to learn current pressure, the pressure ratio, remaining room, and how pressure divides between the system prompt, tool definitions and conversation messages.
3. **Advisory pressure signals.** `<system-reminder>` messages injected into the conversation when the pressure ratio crosses a configured tier, or when a single tool result is oversized — so the model can change course (tighten output, externalise notes, tell the user) *before* compaction takes the decision out of its hands.

The plugin is strictly read-only with respect to the conversation. It observes and reports; it never compacts, prunes, rewrites or truncates anything.

## User Stories

### Knowing the size of the space

1. As a model in a fresh session, I want to be told my context window capacity in the system prompt, so that I can reason about how much room my outputs will need.
2. As a model, I want the capacity statement to be present from the very first request, so that I never plan work under an unknown ceiling.
3. As a model that has just been compacted, I want my capacity statement to remain accurate, so that a compaction never leaves me with a wrong sense of scale.
4. As a model working after a model switch, I want the capacity statement to reflect the newly routed model, so that I do not reason from a stale window size.
5. As a model, I want the capacity statement to be short, so that the knowledge of my budget does not itself consume a meaningful part of it.
6. As a model, I want the capacity statement to name the tool I can use for live figures, so that I know how to get more detail when I need it.

### Reading the live figure on demand

7. As a model, I want a tool that reports my current context pressure, so that I can decide whether to keep working in-context or to externalise state.
8. As a model, I want that tool to report my remaining room, so that I can judge whether a planned tool call will fit.
9. As a model, I want that tool to report the pressure ratio as a percentage, so that I can compare my position against the compaction threshold I have been told about.
10. As a model, I want that tool to break pressure down into system prompt, tool definitions and conversation messages, so that I can identify what is actually consuming my budget.
11. As a model, I want that tool to require no arguments, so that checking my budget is cheap enough to do casually.
12. As a model, I want that tool to be usable repeatedly within a turn, so that I can re-check after a large tool result.
13. As a model, I want that tool to tell me the basis of its figure and that the figure is an estimate, so that I do not treat it as exact accounting.
14. As a model, I want that tool to tell me whether a compaction has already occurred in this session, so that I know how much of my earlier history is now a summary.
15. As a model, I want that tool to distinguish a figure anchored on real provider usage from one derived purely from the harness's heuristic estimate, so that I can calibrate my trust in it.

### Being warned before it is too late

16. As a model approaching a context tier, I want an unsolicited reminder stating my pressure and ratio, so that I can change course without having to remember to ask.
17. As a model, I want reminders to arrive at a tier well below the compaction threshold, so that the warning is actionable rather than a notification that the decision has already been made for me.
18. As a model, I want a distinct, more urgent reminder at a second tier, so that "you are filling up" and "compaction is imminent" are different signals.
19. As a model, I want each tier to fire once per crossing rather than on every step, so that reminders do not themselves consume the budget they are warning about.
20. As a model, I want a tier to re-arm when pressure genuinely drops, so that a session that compacts and then refills is warned again.
21. As a model, I want a reminder to tell me concretely what I can do about it, so that the warning is actionable rather than merely alarming.
22. As a model whose single tool result just consumed a large share of capacity, I want to be told immediately after that result, so that I can avoid repeating the same oversized call.
23. As a model, I want an oversized-result reminder to be suppressed when a pressure reminder is already being delivered for the same moment, so that I do not receive two overlapping warnings.

### The human's side

24. As a user, I want context reminders to appear in the transcript, so that I can see the same pressure picture my model sees and intervene.
25. As a user, I want to be able to configure the reminder tiers, so that I can tune when I want to be interrupted.
26. As a user, I want to be able to disable pressure reminders while keeping the tool, so that I can have on-demand readings without injected messages.
27. As a user, I want to be able to disable the system-prompt statement, so that I can keep my prompt minimal if I do not want it.
28. As a user, I want a configuration mistake to fail loudly at plugin load, so that I never silently run with reminders that can never fire.
29. As a user, I want the plugin to tell me if I configure a tier that the mounted compaction policy would pre-empt, so that I do not ship a warning that is dead code.
30. As a user, I want the plugin to never alter my conversation on its own initiative, so that enabling it cannot destroy history.

### Operating conditions

31. As an operator, I want a capacity figure that is unavailable to fail loudly rather than default to a guess, so that the model is never given a fabricated window size.
32. As an operator, I want the plugin to work for subagent sessions as well as the top-level session, so that delegated work also knows its budget.
33. As an operator, I want the plugin to unload cleanly, removing its prompt section, its tool and its listeners, so that disabling it leaves no residue.
34. As an operator, I want the plugin to be loadable from a local path without publishing to a registry, so that I can evaluate it before sharing it.
35. As an operator, I want a package that can also be enabled as a bundle from a profile, so that turning it on is one entry rather than hand-written loader rows.
36. As an operator running a provider whose capacity differs from the shipped model catalogue, I want the reading to use the route's own capacity, so that I do not need to maintain a model table.
37. As a maintainer, I want the reminder decision logic to be testable without a booted harness, so that I can verify thresholds and re-arming cheaply.

## Implementation Decisions

### Plugin contract and packaging

- The plugin is a standard harness plugin module exporting `name`, `inject`, `Config` and `apply(ctx, config)`; it declares the services it needs (token metering, session projections, the system-prompt registry and the tool registry) through `inject` rather than assuming them.
- Source is TypeScript compiled to an ESM `lib/` output with emitted declarations, matching the first-party package layout, with the SDK packages declared as peer dependencies. This is the minimum needed to satisfy "locally usable, but publishable in structure".
- The package additionally ships a bundle patch declaring a loader row for itself, so a profile can enable it by listing the package in its bundle composition instead of hand-writing a patch row. A local absolute path or file URL is a valid loader-row name, so no registry publish is required to evaluate it.

### Where the numbers come from

- **Capacity** is the routed model's own context window, taken from the LLM route's resolved model information. The harness treats capacity as a property of the provider/model route, not of the session, so the plugin never maintains a model→capacity table of its own.
- **Pressure** and **composition** are read from the existing session projections that the token metering service already maintains: a pressure projection carrying current pressure, projected pressure and the route's context window; and a composition projection carrying system, tools and messages token counts.
- The reading prefers the *projected* pressure figure over the *anchor* pressure figure, because the anchor is the last provider-reported prompt size and the projection reprices the surface delta since then. This matches the calculation the human-facing context meter already performs, so model and human see the same number.
- No new token accounting is introduced. The existing meter's underlying estimator is a fixed characters-per-token heuristic and there is no provider-accurate tokenizer anywhere in the harness, so **every figure the model receives is an estimate and must be labelled as one**. The plugin presents figures with an explicit approximation marker and a stated basis (provider-anchored vs heuristic-only).

### The system-prompt statement

- The capacity statement is registered as a single named system-prompt section at an order that places it adjacent to harness identity and ahead of all policy and tool sections. Its text is a short paragraph: the capacity in tokens, the fact that a tool exists for live figures, and the pressure tiers at which reminders will arrive.
- **The section contains capacity only — never live pressure.** This is a correctness requirement, not a caching preference, and it holds under either of the harness's system-prompt update modes. Under an in-history update, a prompt whose text changes across steps is *appended as a new system message* rather than edited in place, so live pressure would append a fresh system message on every step — consuming the very budget it reports. Under an in-place update, the change would instead invalidate the prompt cache on every step. Capacity is stable for the life of a session, so the section is written once and the live figure travels only by tool call and reminder.
- When the route changes (a model switch or a resumed session on a different route), the section text is recomputed from the new route's capacity, and the harness's own in-history update mechanism carries the correction.

### The `context_status` tool

- One tool, parameterless, registered under a name that does not collide with a built-in. Its canonical output is a structured JSON value — capacity, pressure, remaining, ratio, composition, basis, estimate flag, compaction-observed flag — and a separate pure render function projects that value into the model-facing text.
- The model-facing text is compact and states: current pressure of capacity, the ratio as a percentage, remaining tokens, the three-way composition, the basis and its approximation, and whether a compaction has already occurred in this session.
- The tool reads the live session state at call time, so it is correct on repeated calls within a single turn.
- The tool writes nothing: it does not append events, inject messages, or mutate projections.

### Where reminders are observed and how they are delivered

The plugin attaches to **two** harness observation points, feeding **one** shared decision core:

- **Pressure tier reminders** are evaluated on the harness's pre-step hook — the same seam the compaction engine itself uses, which means the reminder is delivered into the same request batch that compaction would otherwise act on. The tier evaluation happens per step, so a large tool output earlier in the same turn is reflected before the next request.
- **Oversized tool-result reminders** are evaluated on the post-execute hook, where the actual tool result is in hand and its size can be measured directly rather than re-derived from the surface. Delivered as an additional context attached to that tool result, this is the same mechanism the harness's own repeat-call reminder uses.

Both delivery paths produce the same artifact: a **user-role message attributed to the plugin**, carrying the reminder text inside a `<system-reminder>` frame that the plugin owns and escapes correctly. The message declares a snapshot-style context form with named sections, matching the harness's own time-context injector — which is what makes the reminder render as an attributed, collapsible row in the transcript and therefore visible to the human as well as the model. The harness has no shared reminder-framing helper, so the plugin implements and owns its own.

The reminder text is bounded: it previews no raw payloads, only names and sizes, so a reminder about a large tool output cannot itself be large.

### The reminder decision core

- The decision core is a **pure function** of (current pressure and capacity, the plugin's config, and the reminder history for this session) returning either "no reminder" or "a reminder at tier N with this text". Purity here is the testing seam; it also keeps both observation points behaviourally identical.
- Default tiers are **60% (notice)** and **75% (imminent)** of capacity. These sit deliberately below the deployment's compaction threshold: with the default automatic compaction policy firing at **80%** of capacity and retaining about 16%, a warning tier at or above 80% would be unreachable, because compaction would have already replaced the history before the warning could be delivered.
- Config therefore carries a **compaction threshold ratio** (defaulting to the policy's default of 80%) whose only jobs are to let the reading say how much room remains before compaction, and to let load-time validation **reject any tier at or above it**. Misconfiguration fails loudly at plugin load, never silently producing a reminder that can never fire. This follows the harness's existing reminder plugin, which likewise rejects invalid threshold configuration at load rather than falling back.
- A tier fires **once per crossing**. Tiers re-arm when the session's agent reports a session start with a compaction source — compaction announces itself explicitly, so re-arming does not need to be inferred from a pressure drop — and are also re-armed by a fall below the tier by a small hysteresis margin, so a session that compacts and refills is warned again while one hovering at a boundary is not warned repeatedly.
- The oversized-result rule is separate and simpler: a single tool result whose estimated tokens exceed a configured share of capacity (default 10%) produces a reminder, delivered with that result. If a pressure tier reminder is being delivered for the same moment, the oversized-result reminder is suppressed so the model is not handed two overlapping warnings; the reverse does not suppress, because the result-specific reminder carries information the pressure reminder does not.
- Reminder history is per-session and per-agent, so subagent sessions neither share nor suppress each other's reminders.

### Configuration surface

- Config exposes: enable/disable for the whole plugin's three parts independently (prompt statement, tool, reminders); the reminder tiers; the oversized-result share; the compaction threshold ratio; and a switch for whether the capacity statement is included.
- Validation is strict and fails at plugin load: tiers must be finite, strictly ascending, and within (0, 1); the oversized share must be within (0, 1); and every tier must be strictly below the configured compaction threshold ratio. The plugin never silently clamps, drops or reorders a user's tiers.
- Configuration is supplied through the loader row's config block, which the harness validates against the plugin's declared schema before the plugin starts.

### Failure behaviour

- If the routed model exposes no context capacity, the plugin **fails loudly** rather than substituting a default. The compaction engine already treats a missing capacity as a configuration error for exactly this reason; inventing a window size would silently give the model wrong scale information.
- If a projection is unavailable or not yet computed for a session, the tool reports that state explicitly as "unknown" rather than reporting zero, and the reminder logic treats it as "no decision" rather than as low pressure.
- If the session's route changes mid-session, capacity is re-resolved; the tool and the prompt section reflect the new route, and reminder history is preserved so a tier does not re-fire merely because the denominator changed.

### Scope boundary

- The plugin performs **no automatic context action**: it never compacts, prunes, truncates, rewrites or reorders the conversation, and it never calls the compaction engine. Its output is information for the model and the human; the decision to act remains theirs. This boundary is what keeps the context-sense plugin safe to enable: it can only ever add awareness, never remove history.

## Testing Decisions

- **A good test here asserts observable behaviour, never internals.** For this plugin that means: given a pressure/composition state and a config, what reading does the model receive, and is a reminder produced or not. Tests must not assert on private state, call counts of internal helpers, or the shape of intermediate objects.
- **Primary seam: the pure decision core and the pure reading projection.** Both are functions from (numbers, config, small history record) to a value. They carry all the interesting logic — tier crossing, re-arming, suppression, validation, remaining-room arithmetic, estimate labelling — and they need no booted harness, no clock and no I/O. This is the highest useful seam and the only one the logic requires.
- **Secondary seam: a registration/lifecycle smoke test.** Booting the plugin against a minimal harness context and asserting that it registers exactly one prompt section, one tool and its two listeners, and that unloading removes them. This catches the failure mode that a pure-function test cannot: a plugin that works but is never wired in, or that leaks a registration.
- **Prior art to follow.** The human-facing context meter computes occupancy as a pure function of the pressure projection; that is exactly the shape of the reading projection here, and its conventions (prefer projected over anchor pressure, clamp the ratio at 100%, treat an absent figure as unknown rather than zero) should be mirrored so model and human figures agree. The token metering package's estimator is likewise a pure module, and the harness's repeat-call reminder is the prior art for load-time fail-loud threshold validation.
- **Not tested at this seam:** the harness's own hook dispatch, prompt assembly, tool registration or message injection. Those are the harness's contracts; testing them here would test the host, not the plugin.
- The repo currently has no package scaffold, test runner or build. Establishing them is part of the first implementation ticket rather than a design question, since the layout is fixed by the decisions above.

## Out of Scope

- **Automatic context action** — compacting, pruning, truncating, rewriting or reordering history; and any interaction with the compaction engine beyond observing that a compaction occurred. Explicitly excluded when this effort was scoped; the plugin is advisory by design.
- **A `/context` slash command.** The human already has a context meter in the conversation UI showing the same figures with the same composition split. A command would duplicate existing UI for no new capability; it would also be the only part of this plugin aimed at the human rather than the model.
- **Client/UI contributions** — a new meter, badge, panel or renderer. The existing meter already serves the human, and reminders reach the transcript through ordinary injected messages.
- **Provider-accurate tokenization.** No tokenizer ships in the harness, and adding one is a different effort with a different risk profile. This plugin reports the harness's own estimate, clearly labelled.
- **A transcript or session-log search tool.** The absence of one was noticed during research but is unrelated to context awareness.
- **Cost, billing or quota reporting.** The harness deliberately treats occupancy as a reference figure rather than a billing record, and no per-session budget or cost gate exists in the accounting path.
- **Changing compaction policy** — its threshold, retention, model or auto/manual setting. The plugin reads the expected threshold ratio from config purely to validate its own tiers and to report headroom.

## Further Notes

- **Orientation numbers.** In the session this spec was written from, the route is a pi-ai provider profile serving `deepseek-flash` with a capacity of 384,000 tokens and a 192,000 output cap, giving an automatic compaction threshold of 307,200 tokens and a retained tail of 61,440. The shipped first-party defaults differ (DeepSeek official advertises 1,000,000; the generic pi-ai adapter defaults to 262,144), which is precisely why capacity must be read from the route rather than hard-coded.
- **Estimated figures are the only figures available.** The harness prices model-visible messages with a fixed four-characters-per-token heuristic and block/role overheads. Reminders and readings must therefore be phrased as approximations ("~268,800 of 384,000, about 70%"), and nothing in this plugin should present a figure as exact.
- **Version sensitivity.** These decisions were established against harness `0.1.5-rc.1`. The surfaces relied on are the token metering service, the session projections, the system-prompt section registry, the tool registry, the pre-step and post-execute hooks, and user-message construction with a plugin source. The project should record the harness version it is developed against and treat changes to those surfaces as breaking.
- **Research assets** gathered for this spec, both written during charting and available in the repo:
  - `.scratch/dsh-context-token-audit/report.md` — context window, token accounting, projections, truncation caps, compaction, prompt assembly and persistence, with verbatim signatures.
  - `.scratch/dsh-extension-points/research-report.md` — the event/hook system, which hooks can mutate what, and the exact injection mechanisms with worked examples.
- **Next step.** Implementation tickets are the normal next workflow; the user-invoked `to-tickets` skill produces them. It must be invoked explicitly by the user.
