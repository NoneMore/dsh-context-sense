/**
 * The oversized-result reminder, tested as a pure function.
 *
 * The core is a function of the tool's name, the price the harness's own meter
 * put on one raw result, the route's capacity, the configured share and the
 * folded step facts — and of nothing else. It never reads a projection, a
 * meter, a clock or module-level state, so the threshold rule, the
 * one-directional suppression and the frame are testable without a session.
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

/** The share one result may occupy in these tests: a tenth of the route's capacity. */
const SHARE = 0.1

/** The policy those tests decide against. */
const POLICY = resolveOversizedResultPolicy({ share: SHARE })

/** The capacity the figures below are formed from. */
const CAPACITY = 10_000

/** The step the result belongs to, in a session that has taken one step. */
const CURRENT_STEP = { turn: 1, step: 2 } as const

/** The folded step facts of a session that has taken a step and fired no tier. */
const STEPPED: OversizedSuppressionState = { cursor: CURRENT_STEP, pressureReminder: null }

/** One decision input, with every field defaulted to an unspent, measured step. */
function input(overrides: Partial<OversizedResultReminderInput> = {}): OversizedResultReminderInput {
  return {
    toolName: 'bulk_result',
    // 0.4 of the capacity: four times the share in force.
    estimatedTokens: 4_000,
    capacity: CAPACITY,
    policy: POLICY,
    state: STEPPED,
    ...overrides,
  }
}

describe('oversized-result eligibility', () => {
  it('reminds when one raw result exceeds the configured share of capacity', () => {
    const reminder = decideOversizedResultReminder(input())

    expect(reminder).toBeDefined()
    expect(reminder?.text).toContain('bulk_result')
  })

  it('stays quiet for a result that does not exceed the share, boundary included', () => {
    // Exactly the share is not more than the share: 0.1 of a 10000-token window
    // is 1000 tokens, and the rule reports only what exceeds it.
    expect(decideOversizedResultReminder(input({ estimatedTokens: 1_000 }))).toBeUndefined()
    expect(decideOversizedResultReminder(input({ estimatedTokens: 999 }))).toBeUndefined()
    expect(decideOversizedResultReminder(input({ estimatedTokens: 1_001 }))).toBeDefined()
  })

  it('stays quiet while no recorded route has advertised a capacity', () => {
    // The share is a share OF a window: with no denominator there is no rule to
    // apply, however large the result is.
    expect(decideOversizedResultReminder(input({ capacity: undefined }))).toBeUndefined()
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
  it('names the tool and the sizes, and never a payload', () => {
    const reminder = decideOversizedResultReminder(input())!

    expect(reminder.text.startsWith(`${SYSTEM_REMINDER_OPEN}\n`)).toBe(true)
    expect(reminder.text.endsWith(`\n${SYSTEM_REMINDER_CLOSE}`)).toBe(true)
    // Exactly one frame, open and close: a tool name cannot close it early.
    expect(reminder.text.split(SYSTEM_REMINDER_OPEN)).toHaveLength(2)
    expect(reminder.text.split(SYSTEM_REMINDER_CLOSE)).toHaveLength(2)

    expect(reminder.text).toContain('`bulk_result`')
    expect(reminder.text).toContain('4000 tokens')
    expect(reminder.text).toContain('40%')
    expect(reminder.text).toContain('10000-token context window')
    expect(reminder.text).toContain('10% share')
    // The basis of the figure, stated so the model is not told the model-facing
    // content was measured when the pre-finalization result was.
    expect(reminder.text).toContain('raw dispatch result')
    expect(reminder.text).toContain('finalization')
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
    expect(message.content).toEqual([{ type: 'text', text: reminder.text }])

    // A tool name with no length of its own is what makes the bound bite: the
    // summary is the account the transcript row shows.
    const long = decideOversizedResultReminder(input({ toolName: 't'.repeat(300) }))!
    expect(long.summary.length).toBeLessThanOrEqual(CONTEXT_SUMMARY_MAX_CHARS)
    expect(long.summary.endsWith('…')).toBe(true)
  })
})

describe('oversized-result policy validation', () => {
  it('keeps the configured share exactly as configured', () => {
    expect(resolveOversizedResultPolicy({ share: 0.25 })).toEqual({ share: 0.25 })
  })

  it('refuses a share outside the open unit interval', () => {
    for (const share of [0, 1, -0.1, 1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveOversizedResultPolicy({ share })).toThrow(/oversized\.share/)
    }
  })
})
