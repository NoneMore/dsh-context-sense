import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'

import * as ContextSense from '../lib/index.js'
import { bootMinimalContext, type MinimalContext } from './minimal-context.js'
import { CAPACITY, MODEL, PROVIDER, ScriptedAdapter, systemPromptOf, takeTurn } from './scripted-provider.js'
import { pressureOf } from './token-projections.js'

describe('capacity statement in a booted agent loop', () => {
  let booted: MinimalContext | undefined

  afterEach(async () => {
    await booted?.dispose()
    booted = undefined
  })

  it('reads not yet known on the first request and the route capacity once one is recorded', async () => {
    booted = await bootMinimalContext()
    const { ctx, harness } = booted
    const adapter = new ScriptedAdapter(CAPACITY)
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(ContextSense)
    const agent = await harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })

    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')

    expect(adapter.requests).toHaveLength(2)
    const [first, second] = adapter.requests
    expect(systemPromptOf(first!)).toContain('not yet known')
    expect(systemPromptOf(second!)).toContain(String(CAPACITY))
    expect(systemPromptOf(second!)).not.toContain('not yet known')
  })

  it('holds the statement still while pressure moves, so the request prefix stays stable', async () => {
    booted = await bootMinimalContext()
    const { ctx, harness } = booted
    const adapter = new ScriptedAdapter(CAPACITY)
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(ContextSense)
    const agent = await harness.create(SessionId('agent-1'), { provider: PROVIDER, model: MODEL })

    // The first request records the route; from the second on, capacity is
    // known and each request reports a new provider usage sample.
    await takeTurn(agent, 'first')
    await takeTurn(agent, 'second')
    const pressureAtSecond = pressureOf(ctx, agent)
    await takeTurn(agent, 'third')
    const pressureAtThird = pressureOf(ctx, agent)

    const [, second, third] = adapter.requests
    expect(systemPromptOf(second!)).toEqual(systemPromptOf(third!))
    expect(systemPromptOf(third!)).toContain(String(CAPACITY))
    // The statement is stable because it carries capacity only: the pressure
    // it deliberately leaves out really did move between these two requests.
    expect(pressureAtSecond).toBeTypeOf('number')
    expect(pressureAtThird).toBeGreaterThan(pressureAtSecond!)
  })
})
