import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

import * as ContextSense from '../lib/index.js'
import { CAPACITY_SECTION_NAME } from '../lib/statement.js'
import { assembleFor, capacitySections } from './capacity-statement.js'
import { minimalContextFixture } from './minimal-context.js'

describe('capacity statement registration', () => {
  const boot = minimalContextFixture()

  it('registers exactly one section in the scope of the agent the registry already holds', async () => {
    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))

    await ctx.plugin(ContextSense)

    expect(await capacitySections(ctx, agent)).toHaveLength(1)
  })

  it('registers the section per agent, not globally', async () => {
    const { ctx, harness } = await boot()
    await harness.create(SessionId('agent-1'))
    await ctx.plugin(ContextSense)

    const unscoped = await ctx.systemPrompt.assemble()
    const global = unscoped.sections.filter((section) => section.name === CAPACITY_SECTION_NAME)

    expect(global).toHaveLength(0)
  })

  it('registers a section for an agent announced after the plugin loaded', async () => {
    const { ctx, harness } = await boot()
    const first = await harness.create(SessionId('agent-1'))
    await ctx.plugin(ContextSense)

    const second = await harness.create(SessionId('agent-2'))

    expect(await capacitySections(ctx, first)).toHaveLength(1)
    expect(await capacitySections(ctx, second)).toHaveLength(1)
  })

  it('gives a child agent created after load its own section', async () => {
    const { ctx, harness } = await boot()
    const parent = await harness.create(SessionId('parent'))
    await ctx.plugin(ContextSense)

    const child = await ctx.agents.create({ sessionId: SessionId('child'), parentAgent: parent })

    expect(await capacitySections(ctx, parent)).toHaveLength(1)
    expect(await capacitySections(ctx, child.agent)).toHaveLength(1)
  })

  it('survives an installed agent being disposed, and still serves new agents', async () => {
    const { ctx, harness } = await boot()
    const parent = await harness.create(SessionId('parent'))
    await ctx.plugin(ContextSense)
    const child = await ctx.agents.create({ sessionId: SessionId('child'), parentAgent: parent })

    await child.dispose()

    expect(await capacitySections(ctx, parent)).toHaveLength(1)
    const later = await harness.create(SessionId('later'))
    expect(await capacitySections(ctx, later)).toHaveLength(1)
  })

  it('places the section after the identity and persona prefix and ahead of the policy and tool sections', async () => {
    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))
    await ctx.plugin(ContextSense)

    // Probes at the harness's OWN allocated boundary positions, registered in
    // the same agent scope, so this reads the effective position in the
    // assembled prompt rather than the constant in isolation.
    for (const [probe, position] of [
      ['probe:persona-prefix', 'DEPLOYMENT_PERSONA_PREFIX'],
      ['probe:policy', 'PLAN_POLICY'],
      ['probe:tool', 'TOOL_BASH'],
    ] as const) {
      agent.ctx.systemPrompt.section({
        name: probe,
        order: ctx.systemPrompt.getSectionOrder(position),
        text: probe,
      })
    }

    const names = (await assembleFor(ctx, agent)).sections.map((section) => section.name)

    expect(names.indexOf('probe:persona-prefix')).toBeLessThan(names.indexOf(CAPACITY_SECTION_NAME))
    expect(names.indexOf(CAPACITY_SECTION_NAME)).toBeLessThan(names.indexOf('probe:policy'))
    expect(names.indexOf(CAPACITY_SECTION_NAME)).toBeLessThan(names.indexOf('probe:tool'))
  })

  it('never replaces the prompt: the harness sections survive alongside it', async () => {
    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))
    await ctx.plugin(ContextSense)

    const assembly = await assembleFor(ctx, agent)

    expect(assembly.sections.length).toBeGreaterThan(1)
  })

  it('registers no section at all when the statement is disabled', async () => {
    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))

    await ctx.plugin(ContextSense, { statement: { enabled: false } })

    expect(await capacitySections(ctx, agent)).toHaveLength(0)
  })

  it('removes the section from prompt assembly when the plugin unloads', async () => {
    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))
    const fiber = ctx.plugin(ContextSense)
    await fiber
    expect(await capacitySections(ctx, agent)).toHaveLength(1)

    await fiber.dispose()

    expect(await capacitySections(ctx, agent)).toHaveLength(0)
    // Unloading this plugin must not disturb the rest of the composition.
    expect((await assembleFor(ctx, agent)).sections.length).toBeGreaterThan(0)
  })
})
