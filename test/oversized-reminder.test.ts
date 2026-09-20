/**
 * The oversized-result reminder, tested as a pure function.
 *
 * The core is a function of the tool's name, the price the harness's own meter
 * put on one raw result, the route's capacity, the oversized-result trigger in
 * force and the folded step facts — and of nothing else. It never reads a
 * projection, a meter, a clock or module-level state, so either form's
 * eligibility, the one-directional suppression and the frame are testable
 * without a session.
 *
 * @module test/oversized-reminder
 */
import { CONTEXT_SUMMARY_MAX_CHARS } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'

import {
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
  decideOversizedResultReminder,
  oversizedResultReminderMessage,
  resolveOversizedResultPolicy,
  type OversizedResultReminderInput,
  type OversizedSuppressionState,
} from '../lib/reminder.js'
import {
  TIER_SECTION,
  foldContextSenseEvents as fold,
  humanMessage,
  reminderMessage,
  stepStart,
} from './session-events.js'

/** The fixed token threshold these tests decide against. */
const TOKENS = 1_000

/** The result share these tests decide against when they select the share form. */
const SHARE = 0.1

/** The fixed form in force: an absolute count, needing no capacity to apply. */
const FIXED = resolveOversizedResultPolicy({ mode: 'tokens', tokens: TOKENS })

/** The share form, reached only by naming it. */
const SHARED = resolveOversizedResultPolicy({ mode: 'share', share: SHARE })

/** The capacity a share is formed against, and the window a fixed-form report quotes. */
const CAPACITY = 10_000

/** The step the result belongs to, in a session that has taken one step. */
const CURRENT_STEP = { turn: 1, step: 2 } as const

/** The folded step facts of a session that has taken a step and fired no tier. */
const STEPPED: OversizedSuppressionState = { cursor: CURRENT_STEP, pressureReminder: null }

/** One decision input, with every field defaulted to an unspent, measured step. */
function input(overrides: Partial<OversizedResultReminderInput> = {}): OversizedResultReminderInput {
  return {
    toolName: 'bulk_result',
    // Four times the fixed threshold, and 40% of the capacity below.
    estimatedTokens: 4_000,
    capacity: CAPACITY,
    policy: FIXED,
    state: STEPPED,
    ...overrides,
  }
}

describe('oversized-result eligibility', () => {
  it('reminds, under the fixed form, when one raw result exceeds the configured token threshold', () => {
    const reminder = decideOversizedResultReminder(input())

    expect(reminder).toBeDefined()
    expect(reminder?.text).toContain('bulk_result')
  })

  it('holds the fixed form to its boundary: exactly the threshold is not over it', () => {
    expect(decideOversizedResultReminder(input({ estimatedTokens: TOKENS }))).toBeUndefined()
    expect(decideOversizedResultReminder(input({ estimatedTokens: TOKENS - 1 }))).toBeUndefined()
    expect(decideOversizedResultReminder(input({ estimatedTokens: TOKENS + 1 }))).toBeDefined()
  })

  it('applies the fixed form with no advertised capacity, and whatever the capacity is', () => {
    // The point of the form: an absolute count needs no denominator, so a fresh
    // or unadvertised route is not silently unprotected...
    expect(decideOversizedResultReminder(input({ capacity: undefined }))).toBeDefined()
    // ...and a window smaller than the threshold does not change the decision.
    expect(decideOversizedResultReminder(input({ capacity: 1 }))).toBeDefined()
  })

  it('reminds, under the share form, when one raw result exceeds the configured share', () => {
    const reminder = decideOversizedResultReminder(input({ policy: SHARED }))

    expect(reminder).toBeDefined()
    expect(reminder?.text).toContain('bulk_result')
  })

  it('holds the share form to its boundary: exactly the share is not over it', () => {
    expect(decideOversizedResultReminder(input({ policy: SHARED, estimatedTokens: 1_000 }))).toBeUndefined()
    expect(decideOversizedResultReminder(input({ policy: SHARED, estimatedTokens: 999 }))).toBeUndefined()
    expect(decideOversizedResultReminder(input({ policy: SHARED, estimatedTokens: 1_001 }))).toBeDefined()
  })

  it('keeps the share form’s meaning: with no advertised capacity there is no rule to apply', () => {
    // A share is a share OF a window: with no denominator there is no reminder
    // to fabricate from a single figure, however large the result is.
    expect(decideOversizedResultReminder(input({ policy: SHARED, capacity: undefined }))).toBeUndefined()
  })
})

describe('oversized-result suppression', () => {
  it('withholds the reminder in the step a pressure-tier reminder went out at', () => {
    expect(
      decideOversizedResultReminder(input({ state: { cursor: CURRENT_STEP, pressureReminder: CURRENT_STEP } })),
    ).toBeUndefined()
  })

  it('does not withhold it for a tier reminder that went out at another step', () => {
    // The reverse direction never suppresses: a tier signal is once per epoch,
    // and an oversized result in a later step is a different fact.
    expect(
      decideOversizedResultReminder(
        input({ state: { cursor: CURRENT_STEP, pressureReminder: { turn: 1, step: 1 } } }),
      ),
    ).toBeDefined()
  })

  it('does not read two absent positions as the same position', () => {
    // No own step has started and no tier has spoken: `null === null` must not
    // stand in for "the current step", or the very first result of a session
    // would be silently withheld.
    expect(decideOversizedResultReminder(input({ state: { cursor: null, pressureReminder: null } }))).toBeDefined()
  })

  it('never lets an inherited tier reminder and step start stand in for the child’s own step', () => {
    // Turn and step numbers restart at 1 in a child, so this inherited pair
    // reads as a reminder that went out at the child's own first step — which
    // would withhold the reminder the child owes for its first result.
    const log = [stepStart(0, 1, 1), reminderMessage(1, TIER_SECTION), humanMessage(2)]
    const inheritedLength = 2

    // The parent's own view of the same log: both facts are its own, and the
    // pair really does suppress there.
    const parent = fold(log)
    expect(parent.cursor).toEqual({ turn: 1, step: 1 })
    expect(parent.pressureReminder).toEqual({ turn: 1, step: 1 })
    expect(decideOversizedResultReminder(input({ state: parent }))).toBeUndefined()

    // The child's view, cut at the inherited prefix: neither fact is its own, so
    // nothing masquerades as its current step.
    const child = fold(log, inheritedLength)
    expect(child.cursor).toBeNull()
    expect(child.pressureReminder).toBeNull()
    expect(decideOversizedResultReminder(input({ state: child }))).toBeDefined()
  })
})

describe('the oversized-result reminder frame', () => {
  it('names the tool, the price and the threshold, and quotes the window it can', () => {
    const reminder = decideOversizedResultReminder(input())!

    expect(reminder.text.startsWith(`${SYSTEM_REMINDER_OPEN}\n`)).toBe(true)
    expect(reminder.text.endsWith(`\n${SYSTEM_REMINDER_CLOSE}`)).toBe(true)
    // Exactly one frame, open and close: a tool name cannot close it early.
    expect(reminder.text.split(SYSTEM_REMINDER_OPEN)).toHaveLength(2)
    expect(reminder.text.split(SYSTEM_REMINDER_CLOSE)).toHaveLength(2)

    expect(reminder.text).toContain('`bulk_result`')
    expect(reminder.text).toContain('4000 tokens')
    expect(reminder.text).toContain('1000-token threshold')
    // The price as a share of the advertised window, which the fixed form can
    // still state when a route has advertised one — as a trailing clause after
    // the threshold the result is over.
    expect(reminder.text).toContain('40%')
    expect(reminder.text).toContain('10000-token context window')
    expect(reminder.text.indexOf('1000-token threshold')).toBeLessThan(
      reminder.text.indexOf('10000-token context window'),
    )
    // The basis of the figure, stated so the model is not told the model-facing
    // content was measured when the pre-finalization result was.
    expect(reminder.text).toContain('raw dispatch result')
    expect(reminder.text).toContain('finalization')
  })

  it('drops the share-of-window clause and says plainly that capacity is not known', () => {
    const reminder = decideOversizedResultReminder(input({ capacity: undefined }))!

    expect(reminder.text).toContain('`bulk_result`')
    expect(reminder.text).toContain('4000 tokens')
    expect(reminder.text).toContain('1000-token threshold')
    // The clause the fixed form cannot state gives way to the plain statement,
    // ending the account of the figure before the unchanged basis sentence.
    expect(reminder.text).toContain("1000-token threshold; the current route's context capacity is not known.")
    expect(reminder.text).toContain("the current route's context capacity is not known")
    // A ratio against a window nobody advertised is never fabricated.
    expect(reminder.text).not.toContain('context window')
    expect(reminder.text).not.toContain('10000')
    // The same frame, and the same basis sentence, as the shape above.
    expect(reminder.text.startsWith(`${SYSTEM_REMINDER_OPEN}\n`)).toBe(true)
    expect(reminder.text).toContain('raw dispatch result')
  })

  it('keeps the share form’s body, which always has a window to quote', () => {
    const reminder = decideOversizedResultReminder(input({ policy: SHARED }))!

    expect(reminder.text).toContain('`bulk_result`')
    expect(reminder.text).toContain('4000 tokens')
    expect(reminder.text).toContain('40%')
    expect(reminder.text).toContain('10000-token context window')
    expect(reminder.text).toContain('10% share')
    expect(reminder.text).toContain('raw dispatch result')
  })

  it('escapes a tool name that would otherwise close the frame', () => {
    const reminder = decideOversizedResultReminder(input({ toolName: 'a<b>&c' }))!

    expect(reminder.text).toContain('a&lt;b&gt;&amp;c')
    expect(reminder.text).not.toContain('<b>')
    expect(reminder.text.split(SYSTEM_REMINDER_CLOSE)).toHaveLength(2)
  })

  it('delivers it as a plugin-attributed notice whose one-line summary is bounded', () => {
    const reminder = decideOversizedResultReminder(input())!
    const message = oversizedResultReminderMessage(reminder)

    expect(message.role).toBe('user')
    expect(message.source).toMatchObject({ kind: 'plugin', plugin: 'context-sense', form: 'notice' })
    // The bound is the harness's, not this plugin's: a notice row is collapsed
    // until expanded, so its summary has to fit one line.
    expect(reminder.summary.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    // The summary names the tool, the price and the threshold, so a collapsed
    // row still says what the report is about.
    expect(reminder.summary).toContain('bulk_result')
    expect(reminder.summary).toContain('4000')
    expect(reminder.summary).toContain('1000-token threshold')
    expect(message.content).toEqual([{ type: 'text', text: reminder.text }])

    // A tool name with no length of its own is what makes the bound bite: the
    // summary is the account the transcript row shows.
    const long = decideOversizedResultReminder(input({ toolName: 't'.repeat(300) }))!
    expect(long.summary.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    expect(long.summary.endsWith('…')).toBe(true)
  })

  it('names the window instead of the threshold in the share form’s summary', () => {
    const reminder = decideOversizedResultReminder(input({ policy: SHARED }))!

    expect(reminder.summary).toContain('bulk_result')
    expect(reminder.summary).toContain('4000')
    expect(reminder.summary).toContain('10000')
  })
})

describe('oversized-result policy validation', () => {
  it('defaults to the fixed form, and its own threshold, when the block names neither', () => {
    // 8,000 estimated tokens: an absolute count, so a deployment gets a usable
    // threshold without configuring anything.
    expect(resolveOversizedResultPolicy({})).toEqual({ mode: 'tokens', tokens: 8_000 })
    expect(resolveOversizedResultPolicy({ enabled: true })).toEqual({ mode: 'tokens', tokens: 8_000 })
  })

  it('keeps a configured threshold exactly as configured', () => {
    expect(resolveOversizedResultPolicy({ mode: 'tokens', tokens: 4_096 })).toEqual({ mode: 'tokens', tokens: 4_096 })
    // A threshold of one token is odd but usable, and is never replaced.
    expect(resolveOversizedResultPolicy({ mode: 'tokens', tokens: 1 })).toEqual({ mode: 'tokens', tokens: 1 })
  })

  it('reaches the share form’s own default only by selecting the form', () => {
    expect(resolveOversizedResultPolicy({ mode: 'share' })).toEqual({ mode: 'share', share: 0.1 })
  })

  it('keeps a configured share exactly as configured', () => {
    expect(resolveOversizedResultPolicy({ mode: 'share', share: 0.25 })).toEqual({ mode: 'share', share: 0.25 })
  })

  it('refuses the field the form in force does not name', () => {
    // The form in force is the fixed one by default, so a leftover share is a
    // configuration the operator must re-choose rather than one silently kept.
    expect(() => resolveOversizedResultPolicy({ share: 0.25 })).toThrow(/oversized\.share/)
    expect(() => resolveOversizedResultPolicy({ mode: 'tokens', tokens: 4_000, share: 0.25 })).toThrow(
      /oversized\.share/,
    )
    // ...and the fixed form's field is refused just as loudly when the share is
    // the form in force.
    expect(() => resolveOversizedResultPolicy({ mode: 'share', tokens: 4_000 })).toThrow(/oversized\.tokens/)
    expect(() => resolveOversizedResultPolicy({ mode: 'share', share: 0.25, tokens: 4_000 })).toThrow(
      /oversized\.tokens/,
    )
  })

  it('refuses a threshold that is not a positive integer', () => {
    for (const tokens of [0, -1, -8_000, 0.5, 4_000.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveOversizedResultPolicy({ mode: 'tokens', tokens })).toThrow(/oversized\.tokens/)
    }
  })

  it('refuses a share outside the open unit interval', () => {
    for (const share of [0, 1, -0.1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveOversizedResultPolicy({ mode: 'share', share })).toThrow(/oversized\.share/)
    }
  })
})
