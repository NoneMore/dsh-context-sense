import { describe, expect, it } from 'vitest'

import { renderCapacityStatement } from '../lib/statement.js'

const TIERS = [0.6, 0.75]

describe('capacity statement text', () => {
  it('says capacity is not yet known when no route has advertised one', () => {
    const text = renderCapacityStatement({ reminderTiers: TIERS })

    expect(text).toContain('not yet known')
  })

  it('states the recorded route capacity in tokens', () => {
    const text = renderCapacityStatement({ contextWindow: 131072, reminderTiers: TIERS })

    expect(text).toContain('131072')
    expect(text).not.toContain('not yet known')
  })

  it('names the context_reading tool for a live reading', () => {
    const text = renderCapacityStatement({ contextWindow: 131072, reminderTiers: TIERS })

    expect(text).toContain('context_reading')
  })

  it('states the configured reminder tiers, with or without a known capacity', () => {
    const known = renderCapacityStatement({ contextWindow: 131072, reminderTiers: TIERS })
    const unknown = renderCapacityStatement({ reminderTiers: TIERS })

    for (const text of [known, unknown]) {
      expect(text).toContain('60%')
      expect(text).toContain('75%')
    }
  })

  it('states that a reminder describes committed history at an assumed compaction threshold', () => {
    const text = renderCapacityStatement({ contextWindow: 131072, reminderTiers: TIERS })

    expect(text).toContain('committed history')
    // The rendered wording the ticket fixes; the concept it names is the
    // glossary's "assumed compaction threshold".
    expect(text).toContain('assumed policy value')
  })

  it('says plainly that no reminder will arrive when no tier is configured', () => {
    // An empty tier list is a valid configuration — the rules constrain each
    // tier, not the count — so the statement must still read as a sentence
    // rather than as a list of nothing.
    const text = renderCapacityStatement({ contextWindow: 131072, reminderTiers: [] })

    expect(text).toContain('No advisory context reminder tiers are configured')
    expect(text).not.toContain('arrive at  of')
  })
})
