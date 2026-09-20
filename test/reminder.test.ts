/**
 * The tier reminder decision, tested as a pure function.
 *
 * The core is a function of the pressure figure, the capacity, whether the two
 * were confirmed to belong to the same route, the configured policy and the
 * folded reminder state — and of nothing else. Every test here states those
 * five inputs directly, so no assertion needs a session, a clock or a
 * projection to make its point.
 *
 * @module test/reminder
 */
import { describe, expect, it } from 'vitest'

import {
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
  decideTierReminder,
  escapeXml,
  resolveReminderPolicy,
  systemReminderFrame,
  tierReminderMessage,
  type TierFiringState,
} from '../lib/reminder.js'
import { isSampleAttributedTo } from '../lib/session-state.js'
import {
  ROUTE_A,
  ROUTE_B,
  SECOND_TIER_SECTION,
  TIER_SECTION,
  assistantMessage,
  foldContextSenseEvents as fold,
  pruneCompaction,
  reminderMessage,
  requestContextEvent,
  stepStart,
  summaryCompaction,
} from './session-events.js'

/** The default policy, resolved once: two tiers strictly below an assumed 80% threshold. */
const POLICY = resolveReminderPolicy({ tiers: [0.6, 0.75], compactionThresholdRatio: 0.8 })

/** A session that has compacted nothing and fired nothing. */
const FRESH: TierFiringState = { epoch: 0, firedEpochs: {} }

/** One decision input, with every field defaulted to a route-coherent, measured pairing. */
function input(overrides: Partial<Parameters<typeof decideTierReminder>[0]> = {}) {
  return {
    pressure: 100_000,
    capacity: 131_072,
    routeCoherent: true,
    policy: POLICY,
    state: FRESH,
    ...overrides,
  }
}

describe('tier eligibility', () => {
  it('makes no reminder without a route-coherent pairing of two real figures', () => {
    // Nothing has measured this session: there is no ratio to compare with a tier.
    expect(decideTierReminder(input({ pressure: undefined }))).toBeUndefined()
    // A route this session has left: the figure is real but unpaired.
    expect(decideTierReminder(input({ routeCoherent: false }))).toBeUndefined()
    // No recorded route has advertised a capacity, so there is no denominator.
    expect(decideTierReminder(input({ capacity: undefined }))).toBeUndefined()
    // 100000/131072 is 0.76, which crosses the configured notice tier several
    // times over — coherence, not arithmetic, is what withholds the reminder.
    expect(100_000 / 131_072).toBeGreaterThan(0.6)
  })

  it('makes no reminder from a pairing the fold cannot show belongs to one route', () => {
    // The gate the listener composes, as a pure property: a real measurement of
    // a route this session has left. The naive ratio crosses the notice tier
    // several times over, and coherence is what withholds the reminder.
    const switched = fold([
      requestContextEvent(0, ROUTE_A, 131_072),
      assistantMessage(1, ROUTE_A, { sample: 100_000 }),
      requestContextEvent(2, ROUTE_B, 131_072),
    ])

    expect(
      decideTierReminder(
        input({
          pressure: 100_000,
          capacity: 131_072,
          routeCoherent: isSampleAttributedTo(switched, switched.recordedRoute),
          state: switched,
        }),
      ),
    ).toBeUndefined()

    // And the same figures fire as soon as one settlement on the new route
    // makes the pairing showable.
    const settled = fold([
      requestContextEvent(0, ROUTE_A, 131_072),
      assistantMessage(1, ROUTE_A, { sample: 100_000 }),
      requestContextEvent(2, ROUTE_B, 131_072),
      assistantMessage(3, ROUTE_B, { sample: 100_000 }),
    ])
    expect(
      decideTierReminder(
        input({
          pressure: 100_000,
          capacity: 131_072,
          routeCoherent: isSampleAttributedTo(settled, settled.recordedRoute),
          state: settled,
        }),
      )?.tier,
    ).toBe(0)
  })

  it('reminds at the tier the ratio reaches, and at none below it', () => {
    // 0.57: below both configured tiers.
    expect(decideTierReminder(input({ pressure: 75_000 }))).toBeUndefined()

    const notice = decideTierReminder(input({ pressure: 80_000 }))
    expect(notice?.tier).toBe(0)
    // Pinned as a literal, as `session-state.test.ts` pins it: this name is the
    // durable key a fired tier is recorded under, so renaming it would silently
    // re-fire every tier in every session.
    expect(notice?.sectionName).toBe('context-sense:tier:0')
  })
})

describe('firing once per epoch', () => {
  it('owes nothing for a tier that already spoke in this epoch', () => {
    const noticeSpent: TierFiringState = { epoch: 0, firedEpochs: { [TIER_SECTION]: 0 } }

    // 0.69 reaches the notice tier only, and that tier has spoken.
    expect(decideTierReminder(input({ pressure: 90_000, state: noticeSpent }))).toBeUndefined()
    // With both tiers spent, a still-higher ratio owes nothing either: the
    // epoch, not the magnitude, is what a tier fires once in.
    expect(
      decideTierReminder(
        input({ pressure: 125_000, state: { epoch: 0, firedEpochs: { [TIER_SECTION]: 0, [SECOND_TIER_SECTION]: 0 } } }),
      ),
    ).toBeUndefined()
  })

  it('announces the lowest unspoken tier first, so a jump past a tier skips none', () => {
    // 0.95 reaches both tiers at once; the notice still goes first, and the
    // imminent tier follows on the next step rather than being lost.
    const first = decideTierReminder(input({ pressure: 125_000 }))
    expect(first?.tier).toBe(0)

    const second = decideTierReminder(input({ pressure: 125_000, state: { epoch: 0, firedEpochs: { [TIER_SECTION]: 0 } } }))
    expect(second?.tier).toBe(1)
    expect(second?.sectionName).toBe(SECOND_TIER_SECTION)
  })

  it('makes a tier eligible again in the epoch a summary compaction opened', () => {
    // One summary compaction in the own suffix, after both tiers had spoken in
    // epoch 0. Both firings belong to the closed epoch.
    const state = fold([stepStart(0, 1, 1), reminderMessage(1, TIER_SECTION, SECOND_TIER_SECTION), summaryCompaction(2, [1])])

    expect(state).toMatchObject({ epoch: 1, firedEpochs: { [TIER_SECTION]: 0, [SECOND_TIER_SECTION]: 0 } })
    expect(decideTierReminder(input({ pressure: 118_000, state }))?.tier).toBe(0)
  })

  it('does not re-arm a tier for a prune that opened no epoch', () => {
    // The state-machine rule the ticket fixes: a prune changes the surface it
    // priced but opens no epoch, so the notice stays spent and no reminder is
    // owed for it — whatever the prune did to the pressure figure.
    const pruned = fold([stepStart(0, 1, 1), reminderMessage(1, TIER_SECTION), pruneCompaction(2, [1])])

    expect(pruned.epoch).toBe(0)
    // 0.69 reaches the notice tier only, and the notice is still spent: the
    // prune bought this session no fresh warning.
    expect(decideTierReminder(input({ pressure: 90_000, state: pruned }))).toBeUndefined()
  })
})

describe('the reminder frame', () => {
  it('escapes every character that could close the frame it owns', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d')
    // An ampersand already starting an entity is escaped once, not twice.
    expect(escapeXml('&amp;')).toBe('&amp;amp;')
    expect(escapeXml('</system-reminder>')).not.toContain(SYSTEM_REMINDER_CLOSE)
  })

  it('wraps one body in exactly one frame', () => {
    const framed = systemReminderFrame('one line')

    expect(framed).toBe(`${SYSTEM_REMINDER_OPEN}\none line\n${SYSTEM_REMINDER_CLOSE}`)
  })

  it('states the tier, the paired figures and the assumed threshold, and nothing else', () => {
    const reminder = decideTierReminder(input({ pressure: 100_000 }))!

    expect(reminder.text.startsWith(`${SYSTEM_REMINDER_OPEN}\n`)).toBe(true)
    expect(reminder.text.endsWith(`\n${SYSTEM_REMINDER_CLOSE}`)).toBe(true)
    // Exactly one frame, open and close: a figure cannot close it early.
    expect(reminder.text.split(SYSTEM_REMINDER_OPEN)).toHaveLength(2)
    expect(reminder.text.split(SYSTEM_REMINDER_CLOSE)).toHaveLength(2)

    expect(reminder.text).toContain('60% tier')
    expect(reminder.text).toContain('tier 1 of 2')
    expect(reminder.text).toContain('100000 tokens')
    expect(reminder.text).toContain('131072-token context window')
    // The threshold is named as an assumption, never as a reading of the
    // mounted compaction policy.
    expect(reminder.text).toContain('80% (104857 tokens)')
    expect(reminder.text).toContain('4857 tokens of headroom')
    expect(reminder.text).toContain('assumed policy value')
    expect(reminder.text).toContain('committed history')
  })

  it('delivers the reminder as a plugin-attributed user message carrying the tier as its section', () => {
    const reminder = decideTierReminder(input({ pressure: 100_000 }))!
    const message = tierReminderMessage(reminder)

    expect(message.role).toBe('user')
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: 'context-sense',
      form: 'snapshot',
      sections: [{ name: TIER_SECTION, text: reminder.text }],
    })
    // The section text is the model-facing text, frame included.
    expect(message.content).toEqual([{ type: 'text', text: reminder.text }])
  })
})

describe('reminder policy validation', () => {
  it('keeps the tiers exactly as configured, and never clamps or reorders them', () => {
    const policy = resolveReminderPolicy({ tiers: [0.6, 0.75], compactionThresholdRatio: 0.8 })

    expect(policy.tiers).toEqual([0.6, 0.75])
    expect(policy.compactionThresholdRatio).toBe(0.8)
  })

  it('refuses a threshold outside the open unit interval', () => {
    for (const compactionThresholdRatio of [0, 1, -0.1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveReminderPolicy({ tiers: [0.6], compactionThresholdRatio })).toThrow(
        /compactionThresholdRatio/,
      )
    }
  })

  it('refuses a tier that is not a finite ratio strictly below the threshold', () => {
    for (const tier of [-0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveReminderPolicy({ tiers: [tier], compactionThresholdRatio: 0.8 })).toThrow(/tiers/)
    }
    // The bounds are open, and a tier equal to the assumed threshold is not below it.
    for (const tier of [0, 1, 0.8]) {
      expect(() => resolveReminderPolicy({ tiers: [tier], compactionThresholdRatio: 0.8 })).toThrow(/tiers/)
    }
  })

  it('refuses tiers that are not strictly ascending, rather than sorting them', () => {
    expect(() => resolveReminderPolicy({ tiers: [0.75, 0.6], compactionThresholdRatio: 0.8 })).toThrow(
      /ascending/,
    )
    expect(() => resolveReminderPolicy({ tiers: [0.6, 0.6], compactionThresholdRatio: 0.8 })).toThrow(
      /ascending/,
    )
  })
})
