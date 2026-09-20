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
The harness's projection of how many tokens this session's next request would cost: the newest provider-reported prompt size, plus the harness's own heuristic re-pricing of everything the model-visible surface gained or lost since that sample was taken. Only the delta is estimated. It is provider-anchored, so it does not exist at all until a provider has reported usage for the session — absence means unknown, never low.
_Avoid_: usage, token count, context usage, fill level, occupancy, heuristic estimate

**Context composition**:
An estimate of how the request divides among the system prompt, tool definitions and conversation messages. Computed on a basis of its own, so it is not expected to sum to context pressure and is never a substitute for it.
_Avoid_: breakdown, usage stats, distribution, total

**Pressure ratio**:
Context pressure as a fraction of context window capacity. The quantity reminder tiers are expressed in. It exists only when both figures do.
_Avoid_: percentage used, fullness

**Figure provenance**:
What kind of number a reported figure is, stated per figure rather than once for a whole reading. Capacity is route metadata; the pressure anchor is provider-reported usage; composition and the projection delta are the harness's heuristic. A figure is never described with a provenance it does not have.
_Avoid_: estimate flag, confidence, accuracy

**Lagging pressure projection**:
The property that pressure is derived from committed session events, so at the moment a step is being prepared it describes the surface as of the previous step. The step's own claimed messages, its assembled prompt and its tool-schema changes are not yet reflected. A pressure reading is a statement about committed history, never the exact occupancy of the request being assembled.
_Avoid_: live reading, current occupancy, real-time pressure

**Assumed compaction threshold**:
The compaction threshold ratio this plugin's own configuration declares, used to describe headroom and to validate tiers. An assumption about the deployment, never a reading of the mounted compaction policy.
_Avoid_: compaction limit, real threshold, compaction policy

### What the model receives

**Context reading**:
A source-attributed snapshot of capacity, pressure or composition, attached to the conversation at the moment it was taken. Visible to the model from the moment it is admitted until a later surface replacement shadows it.
_Avoid_: status, report, metrics, telemetry

**Context reminder**:
A context reading the model did not ask for, arriving because a pressure ratio reached a tier still eligible in the current reminder epoch, or because one tool result was oversized.
_Avoid_: warning, alert, notification, nudge

**Context query**:
A context reading the model requests deliberately, through a tool, at a moment of its own choosing.
_Avoid_: introspection, self-check

**Reminder tier**:
A configured pressure ratio at which a reminder is delivered, at most once per reminder epoch.
_Avoid_: threshold, level, band

**Reminder epoch**:
The count of summary compactions in a session's durable log, starting at zero. The unit in which a tier's firing is once-only: a tier that has fired in the current epoch stays fired for the rest of it, and only a summary compaction opens a new one. Reconstructed from the durable log, never from process memory.
_Avoid_: cycle, round, generation

**Tier re-arm**:
Making an already-fired reminder tier eligible to fire again, which happens exactly when a summary compaction opens a new reminder epoch.
_Avoid_: reset, clear, re-crossing

### Where history lives

**Durable session log**:
The session's append-only record of every event, and the source of truth a session is replayed from. Containing an event is not the same as the model being able to see it.
_Avoid_: transcript, history, session file

**Model-visible surface**:
The events that currently derive the model's message history. A surface replacement removes events from it while they remain in the durable session log.
_Avoid_: context, prompt, messages

**Compaction checkpoint**:
The summary message a compaction backend puts on the surface in place of an older span, recognized by its message source rather than by its text. It is the surface half of a summary compaction, whose durable `compaction/summary` record is what opens a new reminder epoch.
_Avoid_: summary, compacted summary, condensed history

**Compaction prune**:
A model-free surface replacement that swaps one node for a smaller version of itself, leaving no checkpoint behind and logging no `compaction/summary`. It reduces occupancy without rewriting the span a reminder tier was measured against, so it does not open a new reminder epoch.
_Avoid_: compaction, cleanup, truncation

**Summary compaction**:
A compaction that replaces a span of history with a checkpoint summary, and therefore both reduces occupancy and rewrites the basis a reminder tier was measured against. Its durable record is the `compaction/summary` event, which is the epoch marker.
_Avoid_: full compaction, real compaction

### Boundaries

**Automatic context action**:
Any change the plugin makes to the conversation on the model's behalf — compacting, pruning, or rewriting history. Explicitly outside this project's scope; see the spec.
_Avoid_: auto-compaction, cleanup, garbage collection

**Append-only contribution**:
The plugin's own boundary: it may append messages it authors and attributes to itself, and it never rewrites, reorders, truncates or removes anything already in the session.
_Avoid_: read-only, non-mutating, side-effect free
