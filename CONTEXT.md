# context-sense

A DeepSeek Harness plugin that gives the model awareness of its own context window: how much room the current route leaves, when it is running out, and what that state calls for. The model reads that awareness from advisory reminders by default, and from an opt-in preflight probe when a deployment enables one.

## Language

**Context window capacity**:
The maximum number of tokens a resolved route accepts in a single request. A property of the route, not the session, so a capacity statement is only as current as the newest route the harness has recorded.
_Avoid_: context size, context limit, max tokens, budget

**Resolved route**:
The provider and model pair the harness has resolved for a request, with the capacity that belongs to it.
_Avoid_: model, endpoint, target

**Context pressure**:
The harness's projection of what this session's next request would cost: the newest provider-reported prompt size plus the harness's heuristic re-pricing of everything the surface gained or lost since that sample. Only the delta is estimated, so it is provider-anchored and does not exist at all until a provider has reported usage — absence means unknown, never low.
_Avoid_: usage, token count, fill level, occupancy

**Context composition**:
The harness's estimate of how a request divides among system prompt, tool definitions and conversation messages. Not expected to sum to context pressure and never a substitute for it.
_Avoid_: breakdown, usage stats, total

**Pressure ratio**:
Context pressure as a fraction of context window capacity — the quantity reminder tiers are expressed in. It exists only when both figures do and both belong to the same route.
_Avoid_: percentage used, fullness

**Route-coherent pressure**:
A pressure figure and a capacity the plugin can show belong to the same resolved route. Reconstructed from durable events, because the harness does not supply it: the newest `request/context` record names the capacity's route, and only an `assistant/message` settlement names a usage sample's route. If coherence cannot be shown, the plugin reports stale and forms no ratio.
_Avoid_: atomic pair, current occupancy

**Stale pressure**:
A real, provider-anchored pressure figure not confirmed for the route the current capacity belongs to. Distinct from unknown: unknown means nothing was measured; stale means what was measured belongs to a route this session has left.
_Avoid_: unknown, unavailable, not measured

**Lagging pressure projection**:
The property that pressure derives from committed session events, so at pre-step time it describes the surface as of the previous step. A pressure reading is a statement about committed history, never the exact occupancy of the request being assembled.
_Avoid_: live reading, real-time pressure

**Assumed compaction threshold**:
The compaction threshold ratio this plugin's config declares, used for headroom wording and tier validation. An assumption about the deployment, never a reading of the mounted policy.
_Avoid_: compaction limit, real threshold

**Context reading**:
A snapshot of the current route's capacity and of what committed history is projected to cost, attached to the conversation at the moment it was taken. A figure the plugin cannot attribute to that route is marked unusable rather than replaced by another number.
_Avoid_: status, report, metrics

**Preflight reading**:
A context reading the model asks for before work that will load substantial context, to decide how broadly to retrieve.
_Avoid_: context check, budget check, usage report

**Context guidance**:
What a notice says about managing the context it just reported: an abstract principle about what the model loads next, never a per-tool recipe. The standing statement authorizes such guidance; the notice that observed the event carries it.
_Avoid_: advice, tips, instructions, playbook

**Context reminder**:
A context reading the model did not ask for, arriving because a pressure ratio reached a tier still eligible in the current reminder epoch, or because one tool result was oversized, and carrying the guidance its kind owes.
_Avoid_: warning, alert, notification

**Tool hint**:
Guidance carried by an oversized-result reminder that is specific to the kind of call that produced the result. Its wording belongs to the deployment rather than to the plugin, because only the deployment knows which tools its model actually over-fetches with.
_Avoid_: per-tool tip, remediation, suggestion

**Reminder tier**:
A configured pressure ratio at which a reminder is delivered, at most once per reminder epoch, and only from a route-coherent ratio.
_Avoid_: threshold, level, band

**Reminder epoch**:
The count of summary compactions in a session's own history, starting at zero. The unit in which a tier fires once-only; only a summary compaction opens a new one, and it is rebuilt from the durable log's own suffix, never from a parent's inherited history or process memory.
_Avoid_: cycle, round, generation

**Oversized-result trigger**:
The configured figure one raw tool result is reported above, in exactly one form at a time. An operator-configured assumption with its own flag, never a reading of how much room a result ought to take.
_Avoid_: result limit, size cap, budget

**Fixed token threshold**:
The oversized-result trigger stated as an absolute token count — the form in force unless another is named, because it needs no capacity and does not rescale when the route's window changes. A price the harness's meter estimates rather than counts, so it is an approximation stated in the same units as every other context figure.
_Avoid_: token limit, token budget, size limit

**Result share**:
The oversized-result trigger stated as a fraction of the route's capacity, eligible only while a capacity is known — a share of an unknown window has no denominator, and the plugin never fabricates one.
_Avoid_: result limit, size threshold, budget

**Oversized result**:
One raw tool result whose harness-priced size exceeds the oversized-result trigger in force. Priced where the result is dispatched — before the tool's own finalization — so the report may quote more than the model received.
_Avoid_: large output, big result

**Own suffix**:
The events of a session's durable log at or after its inherited cut — the history this session wrote. The projection registry supplies that cut as the fork-inherited prefix length passed to a unit's initialization; it must never be inferred from a session id, a first-live sequence or a log marker.
_Avoid_: own events, session-local log

**Inherited prefix**:
The slice of a parent's log that a forked child was seeded with. Genuinely part of the child's surface, but not history the child wrote, so it never arms, fires, re-arms or suppresses the child's own reminders.
_Avoid_: parent history, seed

**Model-visible surface**:
The events that currently derive the model's message history. A surface replacement removes events from it while they remain in the durable session log; for a forked session it includes the inherited prefix.
_Avoid_: context, prompt, messages

**Compaction checkpoint**:
The summary message a compaction backend puts on the surface in place of an older span, recognized by its message source. Can be visible without having happened in this session, because a forked child sees its parent's checkpoint.
_Avoid_: summary, condensed history

**Summary compaction**:
A compaction that replaces a span of history with a checkpoint. Its durable record is the `compaction/summary` event, which is the epoch marker and the only compaction event that opens a new reminder epoch.
_Avoid_: full compaction, real compaction

**Compaction prune**:
A local, model-free surface replacement that swaps one node for a smaller version of itself, leaving no checkpoint. It does change the surface pressure is measured from, but by policy it does not open a new reminder epoch.
_Avoid_: compaction, cleanup, truncation

**Append-only contribution**:
The plugin's own boundary: it may append messages it authors and attributes to itself, and never rewrites, reorders, truncates or removes anything already in the session.
_Avoid_: read-only, non-mutating
