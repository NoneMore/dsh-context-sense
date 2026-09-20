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
The harness's projection of how many tokens this session's next request would cost: the newest provider-reported prompt size, plus the harness's own heuristic re-pricing of everything the model-visible surface gained or lost since that sample was taken. Only the delta is estimated. It is provider-anchored, so it does not exist at all until a provider has reported usage for the session — absence means unknown, never low. It is a figure, not a ratio: it may only be divided by a capacity when the two are confirmed to belong to the same route.
_Avoid_: usage, token count, context usage, fill level, occupancy, heuristic estimate

**Context composition**:
An estimate of how the request divides among the system prompt, tool definitions and conversation messages. Computed on a basis of its own, so it is not expected to sum to context pressure and is never a substitute for it.
_Avoid_: breakdown, usage stats, distribution, total

**Pressure ratio**:
Context pressure as a fraction of context window capacity. The quantity reminder tiers are expressed in. It exists only when both figures do, **and** only when the pressure sample and the capacity are confirmed to belong to the same route.
_Avoid_: percentage used, fullness

**Route-coherent pressure**:
A pressure figure and a capacity that the plugin can show belong to the same resolved route, so dividing one by the other means something. Reconstructed from durable events, because the harness does not supply it: the newest `request/context` record names the capacity's route, and only an `assistant/message` settlement names the route a usage sample came from. The harness's own pressure projection is a set of last-wins fields from different moments and explicitly not one atomic request observation, so a route change can pair a new capacity with the previous route's pressure until a sample for the new route is attributed.
_Avoid_: atomic pair, consistent reading, current occupancy

**Stale pressure**:
A real, provider-anchored pressure figure that has not been confirmed for the route the current capacity belongs to. Reported as its own state, distinct from unknown: unknown means nothing has been measured, stale means what was measured belongs to a route this session has left. Neither produces a ratio or a tier decision; only stale is expected to resolve without new information.
_Avoid_: unknown, unavailable, not measured

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
A configured pressure ratio at which a reminder is delivered, at most once per reminder epoch, and only from a route-coherent pressure ratio.
_Avoid_: threshold, level, band

**Reminder epoch**:
The count of summary compactions in a session's **own** history, starting at zero. The unit in which a tier's firing is once-only: a tier that has fired in the current epoch stays fired for the rest of it, and only a summary compaction opens a new one. Reconstructed from the durable log's own suffix, never from process memory — and never from a parent session's inherited history.
_Avoid_: cycle, round, generation

**Tier re-arm**:
Making an already-fired reminder tier eligible to fire again, which happens exactly when a summary compaction opens a new reminder epoch. A prune never re-arms, as a deliberate policy choice rather than because a prune leaves pressure unchanged — a prune is itself a local surface replacement, but it is too small and too often a prelude to a summary compaction to be worth a fire-reset-fire loop.
_Avoid_: reset, clear, re-crossing

**Pending reminder suppression**:
Dropping a pressure reminder that was decided but not yet committed. It happens only when a downstream pre-step listener commits a summary compaction before the pre-step waterfall returns, because that is the one moment the reminder is still held by the plugin rather than by the log. A summary compaction later in the same step — context-overflow recovery after the request is rejected — cannot suppress anything: the reminder is already a committed message, and this plugin never rewrites history.
_Avoid_: cancellation, withdrawal, retraction

### History ownership

**Own suffix**:
The events of a session's durable log at or after its inherited cut — the history this session wrote itself. The projection registry supplies that cut exactly, as the fork-inherited prefix length handed to a projection unit's initialization; a unit must not infer it from a session id, a first-live sequence or a log marker.
_Avoid_: own events, new history, session-local log

**Inherited prefix**:
The slice of a parent session's log that a forked child was seeded with. It is genuinely part of the child's surface — the child's requests carry it and its `deriveMessages()` renders it — but it is not history the child wrote, so it never arms, fires, re-arms or suppresses the child's own reminders.
_Avoid_: parent history, seed, context

**Child-owned reminder state**:
The part of a session's reminder state that only its own suffix may build: the reminder epoch, each tier's fired epoch, the step cursor and the step of its last pressure reminder. Rebuilding it from the whole log is the bug this distinction exists to prevent — a fork would inherit its parent's fired tiers and stay silent, and inherited turn/step numbers can collide with the child's own.
_Avoid_: session state, reminder state (unqualified)

### Where history lives

**Durable session log**:
The session's append-only record of every event, and the source of truth a session is replayed from. Containing an event is not the same as the model being able to see it, and a forked session's log also contains its parent's inherited prefix — which is neither this session's doing nor, for that reason, this session's reminder history.
_Avoid_: transcript, history, session file

**Model-visible surface**:
The events that currently derive the model's message history. A surface replacement removes events from it while they remain in the durable session log. For a forked session the surface includes the inherited prefix, because the model really does send and see it.
_Avoid_: context, prompt, messages

**Compaction checkpoint**:
The summary message a compaction backend puts on the surface in place of an older span, recognized by its message source rather than by its text. It is the surface half of a summary compaction, whose durable `compaction/summary` record is what opens a new reminder epoch. A checkpoint can be visible without having happened in this session: a forked child can see its parent's checkpoint while its own compaction history is empty.
_Avoid_: summary, compacted summary, condensed history

**Compaction prune**:
A local, model-free surface replacement that swaps one node for a smaller version of itself, leaving no checkpoint behind and never logging a `compaction/summary`. It does change the surface pressure is measured from, but it is small and often a prelude to a summary compaction, so by policy it does not open a new reminder epoch.
_Avoid_: compaction, cleanup, truncation

**Summary compaction**:
A compaction that replaces a span of history with a checkpoint summary, reducing occupancy and replacing the basis a reminder tier was measured against. Its durable record is the `compaction/summary` event, which is the epoch marker, and it is the only compaction event that opens a new reminder epoch.
_Avoid_: full compaction, real compaction

**Compaction observed in this session**:
Whether this session's own history contains a compaction event. A compaction the parent ran before forking is not this session's, however visible its checkpoint is — the two facts are reported separately and never conflated.
_Avoid_: compaction happened, history was compacted

### Boundaries

**Automatic context action**:
Any change the plugin makes to the conversation on the model's behalf — compacting, pruning, or rewriting history. Explicitly outside this project's scope; see the spec.
_Avoid_: auto-compaction, cleanup, garbage collection

**Append-only contribution**:
The plugin's own boundary: it may append messages it authors and attributes to itself, and it never rewrites, reorders, truncates or removes anything already in the session.
_Avoid_: read-only, non-mutating, side-effect free
