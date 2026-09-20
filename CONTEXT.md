# context-sense

A DeepSeek Harness plugin that gives the model awareness of its own context window: how much room it has, what is occupying that room, and when it is running out.

## Language

### The budget

**Context window capacity**:
The maximum number of tokens a routed model accepts in a single request. A property of the model, not of the session, and therefore stable for the life of a session.
_Avoid_: context size, context limit, max tokens, budget

**Context pressure**:
How many tokens this session's request would occupy right now. The numerator measured against context window capacity.
_Avoid_: usage, token count, context usage, fill level

**Context composition**:
How context pressure divides among what occupies the request — the system prompt, tool definitions, and conversation messages.
_Avoid_: breakdown, usage stats, distribution

**Pressure ratio**:
Context pressure as a fraction of context window capacity. The quantity thresholds are expressed in.
_Avoid_: percentage used, fullness

### What the model receives

**Context reading**:
A durable, source-attributed snapshot of capacity, pressure or composition, attached to the conversation at the moment it was taken and visible to the model in every later request.
_Avoid_: status, report, metrics, telemetry

**Context reminder**:
A context reading the model did not ask for, arriving because a pressure ratio threshold was crossed or because one tool output was oversized.
_Avoid_: warning, alert, notification, nudge

**Context query**:
A context reading the model requests deliberately, through a tool, at a moment of its own choosing.
_Avoid_: introspection, self-check

### Boundaries

**Automatic context action**:
Any change the plugin makes to the conversation on the model's behalf — compacting, pruning, or rewriting history. Explicitly outside this project's scope; see the spec.
_Avoid_: auto-compaction, cleanup, garbage collection
