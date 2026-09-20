import { describe, expect, it } from 'vitest'

import { buildContextReading, renderContextReading, type ContextReading, type ContextReadingInput } from '../lib/reading.js'

/** A reading built from the supplied facts, coherent and uncompacted unless stated otherwise. */
function read(input: Partial<ContextReadingInput> = {}): ContextReading {
  return buildContextReading({
    routeCoherent: true,
    compaction: { occurredInSession: false, checkpointVisible: false },
    ...input,
  })
}

/** The reading's pressure line, which must never carry a composition-derived figure. */
function pressureLine(reading: string): string {
  return reading.split('\n').find((line) => line.startsWith('Pressure')) ?? ''
}

/** The reading's room line, which states the ratio or why there is none. */
function roomLine(reading: string): string {
  return reading.split('\n').find((line) => line.startsWith('Ratio and remaining room')) ?? ''
}

/** The reading's compaction line, which states the two compaction facts. */
function compactionLine(reading: string): string {
  return reading.split('\n').find((line) => line.startsWith('Compaction in this session')) ?? ''
}

describe('context reading render', () => {
  it('reads every figure as unknown on a session that has measured nothing, and invents no number', () => {
    const text = renderContextReading(read())

    expect(text).toContain('Capacity (route-metadata): unknown')
    expect(text).toContain('Pressure: unknown')
    expect(text).toContain('Composition (heuristic, approximate): unknown')
    // Nothing measured means nothing to attribute: an absent pressure figure
    // carries no provider-anchored label.
    expect(text).not.toContain('provider-anchored')
    expect(roomLine(text)).toMatch(/not available/i)
    // No figure is fabricated anywhere in the reading: with nothing measured,
    // no line of it may carry a digit at all.
    expect(text).not.toMatch(/\d/)
    expect(pressureLine(text)).not.toMatch(/\d/)
    expect(roomLine(text)).not.toMatch(/\d/)
  })

  it('presents each measured figure with its source and, when the route is confirmed, the ratio too', () => {
    const text = renderContextReading(
      read({
        contextWindow: 100_000,
        pressure: { projectedTokens: 25_000, pressureTokens: 24_000 },
        composition: { systemTokens: 900, toolsTokens: 1_200, messageTokens: 2_400 },
      }),
    )

    expect(text).toContain('Capacity (route-metadata): 100000 tokens')
    expect(text).toContain('Pressure (provider-anchored): 25000 tokens')
    expect(text).toContain('system 900, tool definitions 1200, messages 2400')
    expect(roomLine(text)).toBe("Ratio and remaining room: 25% of the route's context window — 75000 tokens remaining.")
  })

  it('states the ratio and the remaining room from the figures it was given, and nothing else', () => {
    const reading = read({ contextWindow: 131_072, pressure: { projectedTokens: 4_321 } })

    // 4321/131072 and 131072-4321, worked out independently of the code under test.
    expect(reading.ratio).toBeCloseTo(0.03296661376953125, 12)
    expect(reading.remaining).toBe(126_751)
  })

  it('reports how far over the route a projected request would run', () => {
    const text = renderContextReading(read({ contextWindow: 10_000, pressure: { projectedTokens: 12_500 } }))

    expect(roomLine(text)).toContain("over the route's context window by 2500 tokens")
  })

  it('names the figure it is missing, and never forms a ratio without both', () => {
    const measured = { contextWindow: 131_072, pressure: { projectedTokens: 4_321 } }
    const reason = (input: Partial<ContextReadingInput>) => roomLine(renderContextReading(read(input)))

    expect(reason({ ...measured, routeCoherent: false })).toMatch(
      /not available — the newest pressure sample is not confirmed for the route the recorded capacity belongs to, so neither is computed\.$/,
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
      read({
        contextWindow: 131_072,
        composition: { systemTokens: 900, toolsTokens: 1_200, messageTokens: 2_400 },
      }),
    )

    expect(text).toContain('Pressure: unknown')
    // The composition is still reported — as composition, never as pressure —
    // and the pressure line carries no figure at all, so no sum of the
    // composition could be hiding in it.
    expect(text).toContain('system 900, tool definitions 1200, messages 2400')
    expect(pressureLine(text)).not.toMatch(/\d/)
  })

  it('states the two compaction facts separately, in both directions', () => {
    const childSendingItsParentCheckpoint = renderContextReading(
      read({ compaction: { occurredInSession: false, checkpointVisible: true } }),
    )
    expect(compactionLine(childSendingItsParentCheckpoint)).toBe(
      "Compaction in this session: none — no compaction event appears in this session's own history. " +
        'Compaction checkpoint on the surface: yes — a compaction summary is part of the model-visible surface.',
    )

    const compactedButPrunedAway = renderContextReading(
      read({ compaction: { occurredInSession: true, checkpointVisible: false } }),
    )
    expect(compactionLine(compactedButPrunedAway)).toBe(
      "Compaction in this session: a summary or prune compaction has replaced part of this session's own history. " +
        'Compaction checkpoint on the surface: none — no compaction summary is on the model-visible surface.',
    )
  })
})

describe('context reading labelling', () => {
  it('takes the pressure figure the human meter shows, and falls back to the raw sample', () => {
    expect(read({ pressure: { projectedTokens: 4_321, pressureTokens: 4_000 } }).pressure).toEqual({
      state: 'known',
      tokens: 4_321,
      provenance: 'provider-anchored',
    })
    expect(read({ pressure: { pressureTokens: 4_000 } }).pressure).toEqual({
      state: 'known',
      tokens: 4_000,
      provenance: 'provider-anchored',
    })
  })

  it('treats a zero-token provider sample as a real measurement', () => {
    expect(read({ pressure: { projectedTokens: 0 } }).pressure).toEqual({
      state: 'known',
      tokens: 0,
      provenance: 'provider-anchored',
    })
  })

  it('reports pressure unknown, with no figure and no source, when the projection carries none', () => {
    for (const input of [{}, { pressure: {} }, { composition: { systemTokens: 7, toolsTokens: 8, messageTokens: 9 } }]) {
      const { pressure } = read(input)

      expect(pressure.state).toBe('unknown')
      expect(Object.hasOwn(pressure, 'tokens')).toBe(false)
      expect(Object.hasOwn(pressure, 'provenance')).toBe(false)
    }
  })

  it('keeps a real figure and its source when the route cannot be confirmed, and forms no ratio', () => {
    // A route switch with no sample yet: the measurement is real, but it is not
    // the capacity's route. It is provider-anchored and stale at once — and no
    // ratio may be formed from the pair.
    const stale = read({ contextWindow: 8_192, pressure: { pressureTokens: 50_000 }, routeCoherent: false })

    expect(stale.pressure).toEqual({ state: 'stale', tokens: 50_000, provenance: 'provider-anchored' })
    expect(stale.capacity).toEqual({ known: true, contextWindow: 8_192, provenance: 'route-metadata' })
    // A naive ratio here would read 6.1 and cross every configured tier; the
    // gate, not the magnitude, is what withholds it.
    expect(50_000 / 8_192).toBeGreaterThan(0.6)
    expect(stale.ratio).toBeUndefined()
    expect(stale.remaining).toBeUndefined()
    expect(renderContextReading(stale)).toContain('Pressure (provider-anchored, stale): 50000 tokens')
  })

  it('never defaults or estimates capacity: it is known only when a recorded route advertised one', () => {
    expect(read().capacity).toEqual({ known: false, provenance: 'route-metadata' })
    expect(read({ pressure: { pressureTokens: 4_000 } }).capacity).toEqual({
      known: false,
      provenance: 'route-metadata',
    })
    expect(read({ contextWindow: 131_072 }).capacity).toEqual({
      known: true,
      contextWindow: 131_072,
      provenance: 'route-metadata',
    })
  })

  it('labels composition as the harness heuristic, and unknown without that unit', () => {
    expect(read({ composition: { systemTokens: 900, toolsTokens: 1_200, messageTokens: 2_400 } }).composition).toEqual({
      known: true,
      systemTokens: 900,
      toolsTokens: 1_200,
      messageTokens: 2_400,
      provenance: 'heuristic',
    })

    const absent = read().composition
    expect(absent).toEqual({ known: false, provenance: 'heuristic' })
    expect(Object.hasOwn(absent, 'systemTokens')).toBe(false)
  })

  it('carries no ratio and no composition-derived total when the route is not confirmed', () => {
    const reading = read({
      contextWindow: 131_072,
      pressure: { projectedTokens: 4_321 },
      composition: { systemTokens: 900, toolsTokens: 1_200, messageTokens: 2_400 },
      routeCoherent: false,
    })

    expect(reading.ratio).toBeUndefined()
    expect(reading.remaining).toBeUndefined()
    expect(JSON.stringify(reading)).not.toMatch(/"ratio"|"remaining"/)
    // The composition figures are still present, and still labelled as the
    // approximation they are — the gate withholds only the ratio.
    expect(reading.composition).toEqual({
      known: true,
      systemTokens: 900,
      toolsTokens: 1_200,
      messageTokens: 2_400,
      provenance: 'heuristic',
    })
  })

  it('labels every figure with one of exactly three sources, across every reading it can produce', () => {
    const readings = [
      read(),
      read({ contextWindow: 131_072 }),
      read({ pressure: { projectedTokens: 4_321 } }),
      read({ pressure: { projectedTokens: 4_321 }, routeCoherent: false }),
      read({
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
