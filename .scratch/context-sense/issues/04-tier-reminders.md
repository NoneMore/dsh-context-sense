# 04: Tier reminders on the pre-step waterfall

**What to build:** When a route-coherent pressure ratio reaches a configured tier, the model — and the human
reading the transcript — receives an unsolicited, plugin-attributed advisory inside a `<system-reminder>` frame,
telling it that committed history has reached that tier. Each tier speaks at most once per reminder epoch, so
the model is warned as it runs out of room without being nagged every step, and a summary compaction earns it a
fresh warning. Oversized configuration fails loudly at plugin load instead of being silently clamped.

Blocked by: 03 (tier eligibility is defined on the route-coherent ratio and the durable reminder state).

Status: ready-for-agent

- [ ] Config carries the reminder tier ratios (defaults 0.60 notice, 0.75 imminent) and an assumed compaction
      threshold ratio (default 0.80) used only for headroom wording and tier validation. Validation is strict
      and fails at plugin load: threshold in (0,1); tiers finite, strictly ascending, in (0,1) and strictly
      below the threshold. Tiers are never clamped, dropped or reordered, and config arrives in the loader row's
      config block against the declared `Config` schema.
- [ ] A pure decision core: a function of (pressure, capacity, whether the two were confirmed to belong to the
      same route, the config, the folded reminder state) returning none or a reminder at tier N with its text.
      It never reads a projection, a clock or module-level mutable state; a route-incoherent pairing is an input
      whose only effect is "no reminder". Purity is the testing seam and keeps both observation points
      identical.
- [ ] One `agent/pre-step` listener registered `{ prepend: true }`, ordered exactly: (1) read the pressure
      snapshot before `next()`; (2) read the folded reminder state and compute the decision with the pure core;
      (3) `await next()` so downstream listeners — compaction among them — run; (4) re-read the reminder state
      and compare the compaction epoch: if a downstream listener committed a `compaction/summary`, drop the
      pending reminder, record nothing as fired, and return the decision unchanged; (5) otherwise append the
      reminder message to `decision.messages` and return it.
- [ ] Injection happens after `next()`, the only point at which the final decision exists, and the listener
      leaves every other listener's contribution to the decision intact.
- [ ] A tier fires at most once per epoch: the ratio from projected pressure and route capacity reaches N, the
      pairing is route-coherent, and N has not fired in this epoch. Not once per crossing — with no readable
      pressure history the fold cannot distinguish "already above" from "crossed now". No hysteresis, no
      pressure-fall re-arm, no process-local state, and no re-arm from `agent/session-start`.
- [ ] The reminder is a user-role message attributed to the plugin, carrying its text in a `<system-reminder>`
      frame the plugin owns, with every interpolated value XML-escaped (`&`, `<`, `>`) so nothing can close the
      frame.
- [ ] The message declares the harness context form matching its shape — `form: 'snapshot'` with named
      `sections` — which is what renders it as an attributed transcript row visible to the human as well as the
      model. The tier's section name is the stable key the fold reads back.
- [ ] Reminder text previews names and sizes only, never raw payloads.
- [ ] No reminder while pressure is `unknown` or `stale`, or while capacity is unknown.
- [ ] Reminders have an independent enable/disable flag in `Config`, separate from the statement and tool flags.
- [ ] Tests: a tier fires once per epoch; after a summary compaction the tier is eligible again; a
      `compaction/prune` without a summary does not re-arm (asserting the state-machine rule, not that prune
      left pressure unchanged); a summary compaction committed by a downstream listener inside the same pre-step
      waterfall suppresses that step's reminder; pre-step lag — a tier crossed only by a message claimed for the
      current step is reminded at the following pre-step; no tier reminder while pressure is unknown; resume
      produces no repeated reminder and no skipped tier.
- [ ] Unload removes the listener: it no longer fires.
