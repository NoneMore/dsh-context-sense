# 03: Replayable surface memory and the route-coherence gate

**What to build:** The plugin gains a durable, replayable memory of the session's model-visible surface — which
route the recorded capacity belongs to, the newest attributed usage sample, the compaction history of this
session, and whether a compaction checkpoint is currently on the surface — and the reading only claims a
pressure ratio and remaining room when it can show that the pressure figure and the capacity belong to the same
route. When it cannot show that, the model is told the figure is stale (or unknown, when nothing was measured)
instead of being handed a number stitched across two routes. The reading also becomes able to distinguish "a
compaction happened in this session" from "a checkpoint is on my surface".

Blocked by: 02 (the reading and its render are what this state becomes visible through).

Status: ready-for-agent

- [ ] Reminder state lives in the plugin's own **host-only** session projection, registered with `wire` omitted
      and its key declaration-merged into `SessionProjectionStateMap`. Its `apply` is a pure fold over committed
      events, so a resume or replay reconstructs it identically; it is never process-local and never appears in
      a client snapshot.
- [ ] The fork cut comes from `init(header, inheritedEventCount)`, is carried in the projection's own state, and
      is never inferred from a session id, `firstLiveSeq`, a `session/end-seed` marker or a host-side map.
- [ ] State is split by that cut. Child-owned facts — the compaction epoch, each tier's fired epoch, the step
      cursor and the step of the last pressure-tier reminder — fold only the own suffix
      (`seq >= inheritedEventCount`). Surface-history facts — the recorded route, the newest attributed usage
      sample, checkpoint visibility — fold the whole log including the inherited prefix, because they are true
      of the surface this session sends.
- [ ] Epoch is the number of `compaction/summary` events in the own suffix, starting at 0. `compaction/start` and
      `compaction/end` carry no surface effect and do not move it. A summary in the inherited prefix does not
      count: the child starts at 0.
- [ ] Tier firing is reconstructed from the plugin's own durable messages: a `user/message` whose source is
      `{ kind: 'plugin', plugin: 'context-sense' }` and whose `snapshot` section name is the tier's stable key
      records that tier as fired in the current epoch. The section name is therefore both the transcript's
      contribution label and the fold's key; the body text stays free to change. Reminders in the inherited
      prefix are skipped by the sequence guard but stay visible in the transcript.
- [ ] The step cursor is `(turn, step)` from the latest `step/start` in the own suffix. The fold records the
      step of the last **pressure-tier** reminder only; an oversized-result reminder must never fill that field,
      since it is committed at the step after the result that produced it.
- [ ] Route coherence is reconstructed conservatively from durable events: the newest `request/context` route
      against the newest `assistant/message` route that carries `usage`. If the plugin cannot simply show that
      the current pressure and the capacity belong to the same route, the reading is `stale` and no ratio or
      tier decision follows. An unattributable sample — e.g. an `assistant/attempt` usage chunk that names no
      route — reads as `stale` rather than being assumed coherent. `stale` (a sample exists, unconfirmed for the
      recorded route) is reported differently from `unknown` (nothing measured).
- [ ] The reading carries the two compaction facts, never conflated: *occurred in this session* is a
      `compaction/summary` or `compaction/prune` event in the own suffix; *checkpoint currently model-visible*
      is at least one surviving node of the current surface being a `user/message` whose source satisfies
      `isCompactCheckpointSource`, over the whole surface including the inherited prefix.
- [ ] The render gives the ratio and remaining tokens only when both figures are known **and** route-coherent.
      Otherwise it says that pressure is not yet available, that it is not confirmed for the current route, or
      that capacity is unknown, and omits ratio and remaining rather than computing them from composition or
      across routes.
- [ ] Capacity and composition do not depend on the gate.
- [ ] Pure tests: replay a hand-written event list through `apply` — including the plugin's own reminder
      messages and `compaction/summary` / `compaction/prune` events — and assert the per-tier epoch state; call
      `init(header, inheritedEventCount)` with a non-zero cut and assert which facts came from the inherited
      prefix; assert route coherence as a pure property — same route (coherent, ratio allowed), a newer record
      with an older sample (stale, no ratio, no tier even when a naive ratio would cross), an unattributable
      sample (stale), and no sample at all (unknown).
- [ ] Integration: fresh session capacity unknown → known; pressure unknown → known, with no tier-eligible
      reading while unknown; a route switch to a different capacity with no new sample → `stale`, no ratio, no
      tier, capacity still the new route's, and the ratio returns once usage is reported; resume reconstructs
      the same state from the durable log.
- [ ] Integration, fork isolation: a child of a parent whose log holds a summary compaction and a fired tier —
      the child's epoch starts at 0, the inherited reminder stays visible on the child's surface, the child
      reports no compaction in this session while a checkpoint is model-visible, and the parent's state is
      untouched. Built with a non-zero `inheritedEventCount`, not by asserting on session ids.
- [ ] Unload removes the unit: `sessionProjections.stateOf(session, '<plugin key>') === undefined`.
