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

- [x] Reminder state lives in the plugin's own **host-only** session projection, registered with `wire` omitted
      and its key declaration-merged into `SessionProjectionStateMap`. Its `apply` is a pure fold over committed
      events, so a resume or replay reconstructs it identically; it is never process-local and never appears in
      a client snapshot.
- [x] The fork cut comes from `init(header, inheritedEventCount)`, is carried in the projection's own state, and
      is never inferred from a session id, `firstLiveSeq`, a `session/end-seed` marker or a host-side map.
- [x] State is split by that cut. Child-owned facts — the compaction epoch, each tier's fired epoch, the step
      cursor and the step of the last pressure-tier reminder — fold only the own suffix
      (`seq >= inheritedEventCount`). Surface-history facts — the recorded route, the newest attributed usage
      sample, checkpoint visibility — fold the whole log including the inherited prefix, because they are true
      of the surface this session sends.
- [x] Epoch is the number of `compaction/summary` events in the own suffix, starting at 0. `compaction/start` and
      `compaction/end` carry no surface effect and do not move it. A summary in the inherited prefix does not
      count: the child starts at 0.
- [x] Tier firing is reconstructed from the plugin's own durable messages: a `user/message` whose source is
      `{ kind: 'plugin', plugin: 'context-sense' }` and whose `snapshot` section name is the tier's stable key
      records that tier as fired in the current epoch. The section name is therefore both the transcript's
      contribution label and the fold's key; the body text stays free to change. Reminders in the inherited
      prefix are skipped by the sequence guard but stay visible in the transcript.
- [x] The step cursor is `(turn, step)` from the latest `step/start` in the own suffix. The fold records the
      step of the last **pressure-tier** reminder only; an oversized-result reminder must never fill that field,
      since it is committed at the step after the result that produced it.
- [x] Route coherence is reconstructed conservatively from durable events: the newest `request/context` route
      against the newest `assistant/message` route that carries `usage`. If the plugin cannot simply show that
      the current pressure and the capacity belong to the same route, the reading is `stale` and no ratio or
      tier decision follows. An unattributable sample — e.g. an `assistant/attempt` usage chunk that names no
      route — reads as `stale` rather than being assumed coherent. `stale` (a sample exists, unconfirmed for the
      recorded route) is reported differently from `unknown` (nothing measured).
- [x] The reading carries the two compaction facts, never conflated: *occurred in this session* is a
      `compaction/summary` or `compaction/prune` event in the own suffix; *checkpoint currently model-visible*
      is at least one surviving node of the current surface being a `user/message` whose source satisfies
      `isCompactCheckpointSource`, over the whole surface including the inherited prefix.
- [x] The render gives the ratio and remaining tokens only when both figures are known **and** route-coherent.
      Otherwise it says that pressure is not yet available, that it is not confirmed for the current route, or
      that capacity is unknown, and omits ratio and remaining rather than computing them from composition or
      across routes.
- [x] Capacity and composition do not depend on the gate.
- [x] Pure tests: replay a hand-written event list through `apply` — including the plugin's own reminder
      messages and `compaction/summary` / `compaction/prune` events — and assert the per-tier epoch state; call
      `init(header, inheritedEventCount)` with a non-zero cut and assert which facts came from the inherited
      prefix; assert route coherence as a pure property — same route (coherent, ratio allowed), a newer record
      with an older sample (stale, no ratio, no tier even when a naive ratio would cross), an unattributable
      sample (stale), and no sample at all (unknown).
- [x] Integration: fresh session capacity unknown → known; pressure unknown → known, with no tier-eligible
      reading while unknown; a route switch to a different capacity with no new sample → `stale`, no ratio, no
      tier, capacity still the new route's, and the ratio returns once usage is reported; resume reconstructs
      the same state from the durable log.
- [x] Integration, fork isolation: a child of a parent whose log holds a summary compaction and a fired tier —
      the child's epoch starts at 0, the inherited reminder stays visible on the child's surface, the child
      reports no compaction in this session while a checkpoint is model-visible, and the parent's state is
      untouched. Built with a non-zero `inheritedEventCount`, not by asserting on session ids.
- [x] Unload removes the unit: `sessionProjections.stateOf(session, '<plugin key>') === undefined`.

## Comments

Implemented. The memory is `src/session-state.ts` — the state type, its zod schema, `init(header,
inheritedEventCount)`, the pure `apply` fold, `isSampleAttributedTo`, and `contextSenseProjection`, registered
unconditionally in `apply` with `wire` omitted and the key declaration-merged into
`SessionProjectionStateMap`. The reading grew the gate: `src/reading.ts` labels a real figure `stale` when the
route cannot be shown, carries `ratio`/`remaining` only for a `known` figure with a known capacity, and reports
the two compaction facts separately; `src/reading-tool.ts` reads the memory through
`sessionProjections.stateOf` and declares the widened value.

Coverage: `test/session-state.test.ts` (21 tests) replays hand-written logs through `init`/`apply`, including a
non-zero cut, and asserts which facts came from the inherited prefix; `test/reading.test.ts` (15) covers the
labelling, the ratio, the three ways no ratio can be formed and the render of both compaction facts;
`test/reading-integration.test.ts` covers fresh unknown → known, an unmeasured reading carrying no ratio, and a
real route switch; `test/surface-memory.test.ts` covers replay through the registry's cold-read `restore` and a
real fork; `test/registration.test.ts` covers the host-only unit and its removal on unload. 66 tests total,
`npm test` builds `lib/` first.

Decisions the ticket did not settle:

- **The gate asks whether the newest sample is attributed to the capacity's own route**, so the pairing it
  clears is the one the model is actually shown. `isSampleAttributedTo(state, route)` takes the route the
  reported capacity came from — the session's newest `request/context` record — rather than re-deriving it from
  the fold's own last-wins copy of the same event, which would leave the two reads free to disagree for a
  reader that runs before the registry's drive. The sample's own existence is decided by the token meter's own
  rule (`assistant/message.usage`, else the last usage chunk in the embedded stream, for `assistant/message` and
  `assistant/attempt` alike). Mirroring the meter matters: if the fold disagreed about which event produced the
  figure, it would attribute a route to a sample the meter took from somewhere else, and an
  `assistant/attempt` usage chunk would silently read coherent. No route at all means no pair, so the gate
  fails.
- **`compaction/summary` sets "this session compacted" as well as moving the epoch.** They are one event and one
  fact; only the epoch is what a tier's re-arming depends on. `compaction/prune` sets the fact without opening an
  epoch, which is the ticket's own policy.
- **Checkpoint survivorship uses the replacement event's `sourceEventSeqs`, not the declared `shadowedRange`.**
  The durable record states that `shadowedRange` is a surface-*position* span whose `start` can be greater than
  its `end`, while a replacement's cited source seqs are the authoritative removed set. The bookkeeping runs for
  every surface event, not only `user/message`: whatever replaced a span removed the nodes it cited.
- **The fold keys tiers by section name for every `snapshot`-form message this plugin authored**, rather than
  against the configured tier list, so the fold stays independent of `Config`. `pressureTierSectionName(index)`
  is the naming rule — position, never ratio, so re-tuning a tier cannot re-fire it in an epoch it already fired
  in. A tier reminder sets `pressureReminder` from the fold's step cursor; an oversized-result reminder carries
  the `notice` form and no sections, so it can never fill that field.
- **"No tier decision" is expressed as "the reading carries no ratio."** Slice 04's decision core reads
  `reading.ratio`, which is absent while the pressure is unknown or stale; there is no separate tier predicate in
  this slice. The pure and integration tests pin the gate rather than the magnitude: the stale case's naive
  `tokens / capacity` crosses the configured notice tier several times over, and 4321/131072 crosses nothing —
  in both directions it is coherence, not arithmetic, that decides.
- **The fork fixture writes the compaction's durable shape by hand** — `compaction/start`, `compaction/summary`,
  a replacement `user/message` built with the real `compactCheckpointSource`, `compaction/end` — instead of
  mounting `dsh-compaction-basic`. Tickets 04 and 05 mount the real backend where the reminder machinery itself
  is under test; here the durable shape is what the fold reads.
- **Resume is covered through `ctx.sessionProjections.restore`**, the registry's own cold-read replay recipe
  (stored log + supplied fork cut + the same unit schema), asserted equal to the live state; and the fork case
  does go through a genuinely seeded session, built by `ctx.agents.create({ seed, inheritedEventCount })`, which
  is the same `sessions.prepare` construction a resume performs. A persistence-backed `ctx.agents.resume` needs a
  `SessionPersistence` backend — a host contract this repo does not mount and the spec keeps out of these tests —
  so what is asserted here is that the plugin's fold, not the storage plumbing, reconstructs the same memory.
- **`PLUGIN_NAME` moved to `src/identity.ts`.** The fold, the reminder attribution and the tier key prefix all
  need the plugin's name, and importing it from the entry point would close an import cycle through a
  not-yet-initialized binding. `src/index.ts` re-exports it as `name`.
- **Two new dependencies.** `@deepseek-ai/dsh-compaction` supplies `isCompactCheckpointSource`, the harness's own
  checkpoint predicate the ticket names; `zod` supplies the projection `stateSchema`, the validator the registry
  itself takes (the same one `dsh-schedule`'s projection uses). Both are peer + dev dependencies.

`Status:` is left at `ready-for-agent`: the five canonical triage labels have no value meaning "implemented,
awaiting review", and ticking the boxes is what records progress here.
