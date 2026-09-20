# 04: Tier reminders on the pre-step waterfall

**What to build:** When a route-coherent pressure ratio reaches a configured tier, the model — and the human
reading the transcript — receives an unsolicited, plugin-attributed advisory inside a `<system-reminder>` frame,
telling it that committed history has reached that tier. Each tier speaks at most once per reminder epoch, so
the model is warned as it runs out of room without being nagged every step, and a summary compaction earns it a
fresh warning. Oversized configuration fails loudly at plugin load instead of being silently clamped.

Blocked by: 03 (tier eligibility is defined on the route-coherent ratio and the durable reminder state).

Status: ready-for-agent

- [x] Config carries the reminder tier ratios (defaults 0.60 notice, 0.75 imminent) and an assumed compaction
      threshold ratio (default 0.80) used only for headroom wording and tier validation. Validation is strict
      and fails at plugin load: threshold in (0,1); tiers finite, strictly ascending, in (0,1) and strictly
      below the threshold. Tiers are never clamped, dropped or reordered, and config arrives in the loader row's
      config block against the declared `Config` schema.
- [x] A pure decision core: a function of (pressure, capacity, whether the two were confirmed to belong to the
      same route, the config, the folded reminder state) returning none or a reminder at tier N with its text.
      It never reads a projection, a clock or module-level mutable state; a route-incoherent pairing is an input
      whose only effect is "no reminder". Purity is the testing seam and keeps both observation points
      identical.
- [x] One `agent/pre-step` listener registered `{ prepend: true }`, ordered exactly: (1) read the pressure
      snapshot before `next()`; (2) read the folded reminder state and compute the decision with the pure core;
      (3) `await next()` so downstream listeners — compaction among them — run; (4) re-read the reminder state
      and compare the compaction epoch: if a downstream listener committed a `compaction/summary`, drop the
      pending reminder, record nothing as fired, and return the decision unchanged; (5) otherwise append the
      reminder message to `decision.messages` and return it.
- [x] Injection happens after `next()`, the only point at which the final decision exists, and the listener
      leaves every other listener's contribution to the decision intact.
- [x] A tier fires at most once per epoch: the ratio from projected pressure and route capacity reaches N, the
      pairing is route-coherent, and N has not fired in this epoch. Not once per crossing — with no readable
      pressure history the fold cannot distinguish "already above" from "crossed now". No hysteresis, no
      pressure-fall re-arm, no process-local state, and no re-arm from `agent/session-start`.
- [x] The reminder is a user-role message attributed to the plugin, carrying its text in a `<system-reminder>`
      frame the plugin owns, with every interpolated value XML-escaped (`&`, `<`, `>`) so nothing can close the
      frame.
- [x] The message declares the harness context form matching its shape — `form: 'snapshot'` with named
      `sections` — which is what renders it as an attributed transcript row visible to the human as well as the
      model. The tier's section name is the stable key the fold reads back.
- [x] Reminder text previews names and sizes only, never raw payloads.
- [x] No reminder while pressure is `unknown` or `stale`, or while capacity is unknown.
- [x] Reminders have an independent enable/disable flag in `Config`, separate from the statement and tool flags.
- [x] Tests: a tier fires once per epoch; after a summary compaction the tier is eligible again; a
      `compaction/prune` without a summary does not re-arm (asserting the state-machine rule, not that prune
      left pressure unchanged); a summary compaction committed by a downstream listener inside the same pre-step
      waterfall suppresses that step's reminder; pre-step lag — a tier crossed only by a message claimed for the
      current step is reminded at the following pre-step; no tier reminder while pressure is unknown; resume
      produces no repeated reminder and no skipped tier.
- [x] Unload removes the listener: it no longer fires.

## Comments

Implemented. Three new modules and three changed ones:

- `src/reminder.ts` — the plugin-owned `<system-reminder>` frame, `escapeXml` and `REMINDER_DISCLAIMER`,
  `ReminderPolicy` and its strict `resolveReminderPolicy` validation, the pure `decideTierReminder`, the body
  renderer, and `tierReminderMessage`. Nothing here reads a projection, a clock or module-level state.
- `src/tier-reminders.ts` — the single `agent/pre-step` listener, registered `{ prepend: true }`, in the exact
  five-step order the ticket fixes.
- `src/index.ts` — `Config` gained a `reminders` block (`enabled`, `tiers`, `compactionThresholdRatio`), and
  `apply` resolves the policy **before** registering anything, so an unusable configuration fails the plugin at
  load whether or not the reminders are switched on.
- `src/statement.ts` — `reminderSentence` shares `REMINDER_DISCLAIMER` with the reminder body, and states
  plainly that no reminder will arrive when no tier is in force.
- `src/reading.ts` — `projectedPressureTokens` is now the one statement of the `projectedTokens ??
  pressureTokens` rule, used by both the reading and the tier decision.
- `src/session-state.ts` — `isPressureRouteCoherent` is now the one statement of the route-coherence gate, used
  by both the reading tool and the tier listener, so the two observation points cannot drift.

Coverage: `test/reminder.test.ts` (15) covers the pure core, the frame and its escaping, the message shape, the
composed route-coherence gate, and validation; `test/reminder-listener.test.ts` (13) covers the loop — no
reminder while unmeasured, no reminder with no advertised capacity, delivery to transcript and model, once per
epoch in ascending order, pre-step lag, re-arm after a real `dsh-compaction-basic` summary, no re-arm for a
prune, in-waterfall suppression, ordering against another listener, resume, unload, the reminders flag, and
fail-loud load. 95 tests total.

Decisions the ticket did not settle:

- **A pressure that jumps past several tiers announces the lowest unspoken one first.** The ticket's own test
  list demands "no skipped tier" on resume, and this is the only reading under which that phrase can bite: with
  highest-first, a lower tier the pressure had already passed is lost for the whole epoch, and the assertion
  becomes vacuous. The state machine is therefore monotone per epoch — tier 0, then tier 1, then a summary
  compaction re-arms tier 0 — and `test/reminder.test.ts` pins it directly. The known cost is that when a
  compaction drops the pending reminder on several consecutive steps (step 4), the tier announced so far is the
  least urgent one; that cost is identical under highest-first, because a dropped candidate is dropped either
  way, and lowest-first at least converges on announcing every tier the moment the drops stop.
- **`resolveReminderPolicy` takes the policy fields and the core never sees `enabled`.** Whether to register the
  listener at all is a load-time decision; making it a decision-core input would let a disabled subsystem still
  return a reminder, which is a trap the type now prevents.
- **The config keeps its settings grouped under `reminders`** (`enabled`, `tiers`, `compactionThresholdRatio`)
  rather than leaving `reminderTiers` at the top level beside a new top-level flag. The ticket's own config
  paragraph groups each contribution's flag with that contribution, slice 05 adds the oversized-result share to
  the same block, and the loader row in `cordis.patch.yml` now exercises the whole block against the declared
  schema. This does rename the top-level key; it was called out in review as a departure from the declared
  schema, and it is deliberate.
- **An empty tier list is valid.** The ticket's rules constrain each tier, not the count, so an empty list is
  accepted rather than inventing a rule the ticket did not state; the statement then says plainly that no
  reminder will arrive. `reminders.enabled: false` reaches the same wording, because a statement that promised
  reminders the flag had switched off would be telling the model something false.
- **The listener reads the state through `stateOf` before `next()` and again after it,** rather than
  snapshotting the registry: `stateOf` is driven on append, so a `compaction/summary` a downstream listener
  commits inside the waterfall is visible to the post-`next()` epoch comparison. A rejected decision and an
  aborted `signal` both return the decision untouched.
- **The reminder quotes the assumed threshold and its token value**, alongside the pressure, the capacity, the
  ratio, the remaining room and the headroom. Every interpolated value goes through `escapeXml`, which is
  asserted directly as well as through the single-frame property of the rendered text.
- **`test/reminder-listener.test.ts` mounts the real `dsh-compaction-basic`** (`@deepseek-ai/dsh-compaction-basic`
  is a new devDependency, pinned exactly at `0.1.5-rc.2` like every other harness dependency). Three of the
  backend's constraints shape the fixtures: `compactRegion` refuses outside an open turn, so the between-turns
  re-arm case goes through `compactNow` ("the way `/compact` does"); it refuses to rewrite the system-prompt
  node; and it refuses a summary that is not smaller than what it replaces, so the in-waterfall case commits a
  range that excludes node 0 over a step's worth of real text. A listener registered *ahead* of the plugin
  drives that case, because `{ prepend: true }` is what makes it downstream.
- **Both new behavioural tests were mutation-checked.** Removing `{ prepend: true }` fails the contribution-order
  test, and removing the epoch comparison fails the suppression test; without those checks both tests passed
  against the unfixed code, because the compacted surface's pressure falls below the tier on its own.
- **Resume is asserted through `ctx.sessionProjections.restore`,** the registry's cold-read replay recipe, and
  then through the decision the reconstructed memory produces (the notice is not repeated, and the tier that
  never spoke is not skipped). **This is a partial against the ticket's wording and is called out as such:** no
  live resumed session is constructed here. A persistence-backed `ctx.agents.resume` needs a
  `SessionPersistence` backend this repo does not mount, and `ctx.agents.create` refuses a seed that is not
  exactly its `inheritedEventCount`, so a resume-shaped session (whole stored log as own history, cut at zero)
  is not constructible. This is the same cut slice 03 documented.
- **The prune fixture writes the durable shape by hand** — a log-only `compaction/prune` plus a replacement of
  one non-system surface node — and asserts the epoch state, exactly as the ticket asks. The summary cases use
  the real backend; the prune case is about the state-machine rule, not the pruner's policy.

Review (fixed point `b17088d`, two axes, both addressed):

- *Standards* — renamed the tier local `threshold` → `tierRatio` and dropped "warning" for a context reminder,
  both of which CONTEXT.md lists under "Reminder tier → Avoid"; hoisted the duplicated disclaimer sentence into
  `REMINDER_DISCLAIMER`; extracted `projectedPressureTokens` and `isPressureRouteCoherent` so the two
  observation points share one rule each; replaced the two hard-coded tier section literals with
  `pressureTierSectionName`; dropped the unused `fromSeq` parameters and the unread `enabled` field from the
  policy input; removed the derivable duplicates from the body facts; renamed the vague `before`/`after`
  locals; fixed local-import order in `src/reminder.ts` and the import grouping in `test/reminder.test.ts`.
- *Spec* — the missing statement wording for a disabled reminders flag is fixed and asserted; the config
  grouping, the lowest-first rule and the resume partial are recorded above with their reasoning rather than
  left implicit; the devDependency was re-pinned from `^0.1.5-rc.2` to the exact `0.1.5-rc.2`; and a
  listener-level case now covers the "while capacity is unknown" half of the ticket's no-reminder bullet. The
  `stale` half stays at the pure core and the composed fold test, because a route switch's sample arrives
  inside the same request that moves the route — the stale window is not observable from any pre-step (spec §5,
  limitation 4).

`Status:` is left at `ready-for-agent`: the five canonical triage labels have no value meaning "implemented,
awaiting review", and ticking the boxes is what records progress here.
