import { describe, expect, it } from 'vitest'

import { buildContextReading, renderContextReading } from '../lib/reading.js'

describe('context reading render', () => {
  it('reads every figure as unknown on a session that has measured nothing, and invents no number', () => {
    const text = renderContextReading(buildContextReading({}))

    expect(text).toContain('Capacity (route-metadata): unknown')
    expect(text).toContain('Pressure: unknown')
    expect(text).toContain('Composition (heuristic, approximate): unknown')
    // Nothing measured means nothing to attribute: an absent pressure figure
    // carries no provider-anchored label.
    expect(text).not.toContain('provider-anchored')
    // Route coherence is not established at this slice, so the ratio and the
    // remaining room are reported unavailable rather than derived.
    expect(text).toMatch(/ratio and remaining room: not available/i)
    // No figure is fabricated anywhere in the reading.
    expect(text).not.toMatch(/\d/)
  })

  it('presents each measured figure with the source it came from, and still computes no ratio', () => {
    const text = renderContextReading(
      buildContextReading({
        contextWindow: 131_072,
        pressure: { projectedTokens: 4_321, pressureTokens: 4_000 },
        composition: { systemTokens: 900, toolsTokens: 1_200, messageTokens: 2_400 },
      }),
    )

    expect(text).toContain('Capacity (route-metadata): 131072 tokens')
    expect(text).toContain('Pressure (provider-anchored): 4321 tokens')
    expect(text).toContain('system 900, tool definitions 1200, messages 2400')
    expect(text).toMatch(/ratio and remaining room: not available/i)
    // The ratio and the remaining room are omitted, not derived from the
    // figures that are present: 4321/131072 and 131072-4321 appear nowhere.
    expect(text).not.toContain('%')
    expect(text).not.toContain('126751')
  })

  it('names the figure it is missing, and route coherence only when both figures exist', () => {
    const measured = { contextWindow: 131_072, pressure: { projectedTokens: 4_321 } }
    const reason = (input: Parameters<typeof buildContextReading>[0]) =>
      renderContextReading(buildContextReading(input))
        .split('\n')
        .find((line) => line.startsWith('Pressure ratio')) ?? ''

    expect(reason(measured)).toMatch(
      /not available — this reading does not establish that the pressure figure and the capacity belong to the same route/,
    )
    // With a figure missing, that is the reason — the line must not claim a
    // route-coherence question about figures it just called unknown.
    expect(reason({ contextWindow: 131_072 })).toMatch(
      /not available — nothing has measured the pressure for this session yet, so neither is computed\.$/,
    )
    expect(reason({ pressure: { projectedTokens: 4_321 } })).toMatch(
      /not available — no recorded route has advertised a context window, so neither is computed\.$/,
    )
    expect(reason({})).toMatch(
      /not available — nothing has measured the pressure for this session yet and no recorded route has advertised a context window, so neither is computed\.$/,
    )
  })

  it('never presents the composition figures as pressure when nothing has measured pressure', () => {
    const text = renderContextReading(
      buildContextReading({
        contextWindow: 131_072,
        composition: { systemTokens: 900, toolsTokens: 1_200, messageTokens: 2_400 },
      }),
    )
    const pressure = text.split('\n').find((line) => line.startsWith('Pressure')) ?? ''

    expect(text).toContain('Pressure: unknown')
    // The composition is still reported — as composition, never as pressure —
    // and the pressure line carries no figure at all, so no sum of the
    // composition could be hiding in it.
    expect(text).toContain('system 900, tool definitions 1200, messages 2400')
    expect(pressure).not.toMatch(/\d/)
  })
})

describe('context reading labelling', () => {
  it('takes the pressure figure the human meter shows, and falls back to the raw sample', () => {
    expect(buildContextReading({ pressure: { projectedTokens: 4_321, pressureTokens: 4_000 } }).pressure).toEqual({
      state: 'known',
      tokens: 4_321,
      provenance: 'provider-anchored',
    })
    expect(buildContextReading({ pressure: { pressureTokens: 4_000 } }).pressure).toEqual({
      state: 'known',
      tokens: 4_000,
      provenance: 'provider-anchored',
    })
  })

  it('treats a zero-token provider sample as a real measurement', () => {
    expect(buildContextReading({ pressure: { projectedTokens: 0 } }).pressure).toEqual({
      state: 'known',
      tokens: 0,
      provenance: 'provider-anchored',
    })
  })

  it('reports pressure unknown, with no figure and no source, when the projection carries none', () => {
    for (const input of [{}, { pressure: {} }, { composition: { systemTokens: 7, toolsTokens: 8, messageTokens: 9 } }]) {
      const { pressure } = buildContextReading(input)

      expect(pressure.state).toBe('unknown')
      expect(Object.hasOwn(pressure, 'tokens')).toBe(false)
      expect(Object.hasOwn(pressure, 'provenance')).toBe(false)
    }
  })

  it('never defaults or estimates capacity: it is known only when a recorded route advertised one', () => {
    expect(buildContextReading({}).capacity).toEqual({ known: false, provenance: 'route-metadata' })
    expect(buildContextReading({ pressure: { pressureTokens: 4_000 } }).capacity).toEqual({
      known: false,
      provenance: 'route-metadata',
    })
    expect(buildContextReading({ contextWindow: 131_072 }).capacity).toEqual({
      known: true,
      contextWindow: 131_072,
      provenance: 'route-metadata',
    })
  })

  it('labels composition as the harness heuristic, and unknown without that unit', () => {
    expect(buildContextReading({ composition: { systemTokens: 900, toolsTokens: 1_200, messageTokens: 2_400 } }).composition).toEqual({
      known: true,
      systemTokens: 900,
      toolsTokens: 1_200,
      messageTokens: 2_400,
      provenance: 'heuristic',
    })

    const absent = buildContextReading({}).composition
    expect(absent).toEqual({ known: false, provenance: 'heuristic' })
    expect(Object.hasOwn(absent, 'systemTokens')).toBe(false)
  })

  it('offers no ratio, no remaining room and no composition-derived total in the canonical value', () => {
    const reading = buildContextReading({
      contextWindow: 131_072,
      pressure: { projectedTokens: 4_321 },
      composition: { systemTokens: 900, toolsTokens: 1_200, messageTokens: 2_400 },
    })

    expect(Object.keys(reading)).toEqual(['capacity', 'pressure', 'composition'])
    expect(JSON.stringify(reading)).not.toMatch(/ratio|remaining|total/i)
  })

  it('labels every figure with one of exactly three sources, across every reading it can produce', () => {
    const readings = [
      buildContextReading({}),
      buildContextReading({ contextWindow: 131_072 }),
      buildContextReading({ pressure: { projectedTokens: 4_321 } }),
      buildContextReading({
        contextWindow: 131_072,
        pressure: { projectedTokens: 4_321 },
        composition: { systemTokens: 900, toolsTokens: 1_200, messageTokens: 2_400 },
      }),
    ]
    const labels = readings.flatMap((reading) =>
      [reading.capacity.provenance, reading.pressure.provenance, reading.composition.provenance].filter(
        (label) => label !== undefined,
      ),
    )

    // A fourth label — a pressure source derived from composition, say — would
    // have to appear here to exist at all.
    expect([...new Set(labels)].sort()).toEqual(['heuristic', 'provider-anchored', 'route-metadata'])
  })
})
