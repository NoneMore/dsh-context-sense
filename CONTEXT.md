# context-sense

A DeepSeek Harness plugin that gives the model awareness of its own context window: how much room it has, what is occupying that room, and when it is running out.

## Language

### The budget

**Context window capacity**:
The maximum number of tokens a resolved route accepts in a single request. A property of the route, not of the session: a session that changes route has a different capacity, so any capacity statement is only as current as the newest route the harness has recorded for that session.
_Avoid_: context size, context limit, max tokens, budget

**Resolved route**:
The provider and model pair the harness has resolved for a request, together with the capacity and adapter metadata that belong to it.
_Avoid_: model, endpoint, target

**Context pressure**:
How many tokens this session's next request would occupy, as the harness's own measurement estimates it.
_Avoid_: usage, token count, context usage, fill level

**Context composition**:
An estimate of how the request divides among the system prompt, tool definitions and conversation messages. Computed on a basis of its own, so it is not expected to sum to context pressure.
_Avoid_: breakdown, usage stats, distribution

**Pressure ratio**:
Context pressure as a fraction of context window capacity. The quantity reminder tiers are expressed in.
_Avoid_: percentage used, fullness

**Assumed compaction threshold**:
The compaction threshold ratio this plugin's own configuration declares, used to describe headroom and to validate tiers. An assumption about the deployment, never a reading of the mounted compaction policy.
_Avoid_: compaction limit, real threshold, compaction policy

### What the model receives

**Context reading**:
A source-attributed snapshot of capacity, pressure or composition, attached to the conversation at the moment it was taken. Visible to the model from the moment it is admitted until a later surface replacement shadows it.
_Avoid_: status, report, metrics, telemetry

**Context reminder**:
A context reading the model did not ask for, arriving because a pressure ratio tier was crossed or because one tool result was oversized.
_Avoid_: warning, alert, notification, nudge

**Context query**:
A context reading the model requests deliberately, through a tool, at a moment of its own choosing.
_Avoid_: introspection, self-check

**Reminder tier**:
A configured pressure ratio at which a reminder is delivered.
_Avoid_: threshold, level, band

**Tier re-arm**:
Making an already-fired reminder tier eligible to fire again, after compaction has rewritten the history it was measured against or after pressure has fallen well below the tier.
_Avoid_: reset, clear

### Where history lives

**Durable session log**:
The session's append-only record of every event, and the source of truth a session is replayed from. Containing an event is not the same as the model being able to see it.
_Avoid_: transcript, history, session file

**Model-visible surface**:
The events that currently derive the model's message history. A surface replacement removes events from it while they remain in the durable session log.
_Avoid_: context, prompt, messages

**Compaction checkpoint**:
The summary message a compaction backend puts on the surface in place of an older span, recognized by its message source rather than by its text.
_Avoid_: summary, compacted summary, condensed history

### Boundaries

**Automatic context action**:
Any change the plugin makes to the conversation on the model's behalf — compacting, pruning, or rewriting history. Explicitly outside this project's scope; see the spec.
_Avoid_: auto-compaction, cleanup, garbage collection

**Append-only contribution**:
The plugin's own boundary: it may append messages it authors and attributes to itself, and it never rewrites, reorders, truncates or removes anything already in the session.
_Avoid_: read-only, non-mutating, side-effect free
