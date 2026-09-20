/**
 * The plugin's durable surface memory, tested as a pure fold.
 *
 * Every assertion replays a hand-written event list through the projection's
 * `apply` from `init(header, inheritedEventCount)`. Nothing here boots a
 * session, so the tests state the fold's contract directly: which events move
 * which fact, and which of those facts belong to the fork cut rather than to
 * the whole log.
 *
 * @module test/session-state
 */
import { describe, expect, it } from 'vitest'

import { buildContextReading } from '../lib/reading.js'
import {
  contextSenseStateSchema,
  hasVisibleCheckpoint,
  isSampleAttributedTo,
  pressureTierSectionName,
} from '../lib/session-state.js'
import {
  ROUTE_A,
  ROUTE_B,
  SECOND_TIER_SECTION,
  TIER_SECTION,
  assistantAttempt,
  assistantMessage,
  compactionBracket,
  foldContextSenseEvents as fold,
  humanMessage,
  noticeReminder,
  pruneCompaction,
  reminderMessage,
  replacementMessage,
  requestContextEvent,
  stepStart,
  summaryCompaction,
} from './session-events.js'

describe('reminder epoch', () => {
  it('starts at zero and is opened only by a summary compaction', () => {
    const events = [
      stepStart(0, 1, 1),
      humanMessage(1),
      compactionBracket('compaction/start', 2),
      compactionBracket('compaction/end', 3),
    ]

    // `compaction/start` and `compaction/end` hold and release the lock; they
    // have no surface effect and open no epoch.
    expect(fold(events).epoch).toBe(0)
    expect(fold([]).epoch).toBe(0)
  })

  it('counts each summary compaction in the session’s own suffix', () => {
    const log = [
      summaryCompaction(0, [1]),
      summaryCompaction(1, [2]),
      // A prune does not re-arm: it leaves no checkpoint and is often a prelude
      // to a summary compaction, so counting it would re-fire the same tier.
      pruneCompaction(2, [3]),
      summaryCompaction(3, [4]),
    ]

    expect(fold(log).epoch).toBe(3)
  })

  it('does not count a summary carried in the inherited prefix', () => {
    const inherited = [humanMessage(0), summaryCompaction(1, [0])]
    const own = [stepStart(2, 1, 1)]

    const child = fold([...inherited, ...own], inherited.length)

    // The child starts its own history at zero: the parent's compaction is
    // surface history, not an epoch the child ever opened.
    expect(child.epoch).toBe(0)
    expect(child.inheritedEventCount).toBe(2)
  })

  it('records the epoch each tier fired in, and re-arms it in the next epoch', () => {
    const log = [
      reminderMessage(0, TIER_SECTION),
      stepStart(1, 1, 1),
      summaryCompaction(2, [0]),
      reminderMessage(3, SECOND_TIER_SECTION),
    ]

    const state = fold(log)

    expect(state.epoch).toBe(1)
    // The first tier fired in epoch 0; the second in epoch 1. The recorded
    // epoch is what makes "at most once per epoch" a fold, not a memory.
    expect(state.firedEpochs).toEqual({ [TIER_SECTION]: 0, [SECOND_TIER_SECTION]: 1 })
  })

  it('skips a reminder in the inherited prefix but keeps it on the surface', () => {
    const inherited = [reminderMessage(0, TIER_SECTION), summaryCompaction(1, [0])]
    const child = fold([...inherited, humanMessage(2)], inherited.length)

    // Not the child's history: the tier is un-fired for the child, which will
    // restate it rather than stay silent forever.
    expect(child.firedEpochs).toEqual({})
    expect(child.epoch).toBe(0)
  })
})

describe('step cursor', () => {
  it('takes (turn, step) from the latest step start in the own suffix', () => {
    expect(fold([stepStart(0, 1, 1), stepStart(1, 2, 3)]).cursor).toEqual({ turn: 2, step: 3 })
    expect(fold([]).cursor).toBeNull()
  })

  it('ignores an inherited step start, whose numbering restarts in the child', () => {
    const inherited = [stepStart(0, 7, 4)]

    expect(fold(inherited, inherited.length).cursor).toBeNull()
  })

  it('records the step of a pressure-tier reminder, and never that of an oversized result', () => {
    const tiered = fold([stepStart(0, 1, 1), reminderMessage(1, TIER_SECTION)])
    expect(tiered.pressureReminder).toEqual({ turn: 1, step: 1 })

    // The oversized-result reminder is delivered with the result that produced
    // it and committed at the following step, so its own position must not
    // stand in for "the step a pressure reminder went out at".
    const oversized = fold([stepStart(0, 1, 2), noticeReminder(1)])
    expect(oversized.pressureReminder).toBeNull()
  })
})

describe('surface history', () => {
  it('records the newest route anywhere in the log, inherited prefix included', () => {
    const inherited = [requestContextEvent(0, ROUTE_A, 131_072)]
    const own = [requestContextEvent(1, ROUTE_B, 8_192), humanMessage(2)]

    // Surface history describes the surface this session sends, so it folds
    // the inherited prefix too.
    expect(fold([...inherited, ...own], inherited.length).recordedRoute).toEqual(ROUTE_B)
    expect(fold(inherited, inherited.length).recordedRoute).toEqual(ROUTE_A)
  })

  it('attributes a usage sample only when the settlement names a route', () => {
    const attributed = fold([assistantMessage(0, ROUTE_A, { sample: 4_000 })])
    expect(attributed.newestSample).toEqual({ kind: 'attributed', ...ROUTE_A })

    // An attempt commits no surface message and names no route, yet its usage
    // sample is what the harness's pressure figure is anchored to.
    const unattributable = fold([assistantMessage(0, ROUTE_A, { sample: 4_000 }), assistantAttempt(1, 9_000)])
    expect(unattributable.newestSample).toEqual({ kind: 'unattributed' })

    const nothing = fold([humanMessage(0)])
    expect(nothing.newestSample).toEqual({ kind: 'none' })
  })

  it('attributes an inherited sample too: surface history folds the whole log', () => {
    const inherited = [assistantMessage(0, ROUTE_A, { sample: 4_000 })]

    // The sample a parent's settlement reported is the sample this session's
    // pressure figure is anchored to, so the cut must not hide it.
    expect(fold(inherited, inherited.length).newestSample).toEqual({ kind: 'attributed', ...ROUTE_A })
  })

  it('reads a sample that rides only the embedded stream as a sample', () => {
    expect(fold([assistantMessage(0, ROUTE_A, { sample: 4_000, usageInStream: true })]).newestSample).toEqual({
      kind: 'attributed',
      ...ROUTE_A,
    })
  })

  it('tracks checkpoint visibility over the whole surface, including replacements', () => {
    // A checkpoint the parent landed: visible on the child's inherited surface.
    const inherited = [humanMessage(0), summaryCompaction(1, [0]), replacementMessage(2, [0])]
    // A checkpoint this session landed, then shadowed by a later replacement.
    const own = [humanMessage(3), summaryCompaction(4, [3]), replacementMessage(5, [3]), replacementMessage(6, [5], { checkpoint: false })]

    const child = fold([...inherited, ...own], inherited.length)

    expect(child.visibleCheckpoints).toEqual([2])
  })

  it('reports a compaction in this session separately from a visible checkpoint', () => {
    const inherited = [humanMessage(0), summaryCompaction(1, [0]), replacementMessage(2, [0])]
    const own = [humanMessage(3)]

    const child = fold([...inherited, ...own], inherited.length)

    // The child sends its parent's checkpoint but has compacted nothing itself;
    // conflating the two would tell the model it lost history it never had.
    expect(child.compactedInSession).toBe(false)
    expect(child.visibleCheckpoints).toEqual([2])

    // Either compaction event is this session's own history, whether or not a
    // checkpoint survives it.
    const summarized = fold([humanMessage(0), summaryCompaction(1, [0]), replacementMessage(2, [0])])
    expect(summarized.compactedInSession).toBe(true)
    expect(summarized.epoch).toBe(1)

    const pruned = fold([humanMessage(0), pruneCompaction(1, [0]), replacementMessage(2, [0], { checkpoint: false })])
    expect(pruned.compactedInSession).toBe(true)
    expect(pruned.epoch).toBe(0)
  })
})

describe('route coherence', () => {
  it('holds only when the newest sample is attributed to the capacity’s route', () => {
    const coherent = fold([requestContextEvent(0, ROUTE_A, 131_072), assistantMessage(1, ROUTE_A, { sample: 100_000 })])

    expect(isSampleAttributedTo(coherent, ROUTE_A)).toBe(true)
  })

  it('fails for a newer record whose route the newest sample does not share', () => {
    const switched = fold([
      requestContextEvent(0, ROUTE_A, 131_072),
      assistantMessage(1, ROUTE_A, { sample: 100_000 }),
      // The route moved and nothing has been measured on the new one yet.
      requestContextEvent(2, ROUTE_B, 8_192),
    ])

    expect(switched.recordedRoute).toEqual(ROUTE_B)
    // The capacity now belongs to ROUTE_B while the newest sample is a real
    // measurement of ROUTE_A: the pair the model would be shown is incoherent,
    // which is exactly what asking about the capacity's own route reports.
    expect(isSampleAttributedTo(switched, ROUTE_B)).toBe(false)
    expect(isSampleAttributedTo(switched, ROUTE_A)).toBe(true)
  })

  it('fails for an unattributable sample, for no sample at all, and for no route at all', () => {
    const unattributable = fold([requestContextEvent(0, ROUTE_A, 131_072), assistantAttempt(1, 4_000)])
    expect(isSampleAttributedTo(unattributable, ROUTE_A)).toBe(false)

    const unmeasured = fold([requestContextEvent(0, ROUTE_A, 131_072)])
    expect(isSampleAttributedTo(unmeasured, ROUTE_A)).toBe(false)

    // No recorded route means no capacity to pair the sample with.
    expect(isSampleAttributedTo(unmeasured, undefined)).toBe(false)
  })

  it('reads an unattributable sample as stale rather than as coherent', () => {
    // The whole seam, as the tool composes it: a real provider sample whose
    // event names no route reaches the model as `stale`, and no ratio is formed
    // from it even though both figures exist.
    const state = fold([requestContextEvent(0, ROUTE_A, 131_072), assistantAttempt(1, 100_000)])
    const reading = buildContextReading({
      contextWindow: 131_072,
      pressure: { pressureTokens: 100_000 },
      routeCoherent: isSampleAttributedTo(state, state.recordedRoute),
      compaction: { occurredInSession: state.compactedInSession, checkpointVisible: hasVisibleCheckpoint(state) },
    })

    expect(reading.pressure).toEqual({ state: 'stale', tokens: 100_000, provenance: 'provider-anchored' })
    expect(reading.ratio).toBeUndefined()
    // A naive pairing would read 0.76 and cross the configured notice tier.
    expect(100_000 / 131_072).toBeGreaterThan(0.6)
  })
})

describe('state schema', () => {
  it('validates the state the fold produces, so a persisted checkpoint can seed it again', () => {
    const state = fold([
      stepStart(0, 1, 1),
      reminderMessage(1, TIER_SECTION),
      requestContextEvent(2, ROUTE_A, 131_072),
      assistantMessage(3, ROUTE_A, { sample: 4_000 }),
      summaryCompaction(4, [1]),
      replacementMessage(5, [1]),
    ])

    const parsed = contextSenseStateSchema.parse(JSON.parse(JSON.stringify(state)))

    expect(parsed).toEqual(state)
  })

  it('rejects a state shape it did not produce', () => {
    expect(() => contextSenseStateSchema.parse({ inheritedEventCount: -1 })).toThrow()
  })
})

describe('tier section names', () => {
  it('names a tier by its position, so the key survives a ratio change', () => {
    // Pinned as literals: this name is the durable key a fired tier is recorded
    // under, so renaming it would silently re-fire every tier in every session.
    expect(pressureTierSectionName(0)).toBe('context-sense:tier:0')
    expect(pressureTierSectionName(1)).toBe('context-sense:tier:1')
    expect(TIER_SECTION).toBe('context-sense:tier:0')
    expect(SECOND_TIER_SECTION).toBe('context-sense:tier:1')
  })
})
