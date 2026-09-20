import { Context } from '@deepseek-ai/cordis'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
  type AgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { afterEach } from 'vitest'

/** The smallest real harness these tests run against. */
export interface MinimalContext {
  /** The root context; disposing it unwinds every mounted service and agent. */
  readonly ctx: Context
  /** The production agent loop's test driver. */
  readonly harness: AgentLoopTestHarness
  /** Dispose the whole context. */
  dispose(): Promise<void>
}

/**
 * Boot the six prerequisite services, the token meter this plugin injects, and
 * the production agent loop.
 *
 * The caller decides the order of everything after that, which is the point:
 * a test that needs an agent live before the plugin loads must be able to
 * create it first.
 * @returns the booted context and its loop driver.
 */
export async function bootMinimalContext(): Promise<MinimalContext> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness, dispose: () => ctx.fiber.dispose() }
}

/**
 * Boot one minimal context for the current test and dispose it afterwards.
 *
 * A plugin that owns an agent's prompt scope must not outlive that agent, so
 * every test that loads it needs its own context and a guaranteed teardown.
 * @returns the boot function the test calls once.
 */
export function minimalContextFixture(): () => Promise<MinimalContext> {
  let booted: MinimalContext | undefined
  afterEach(async () => {
    await booted?.dispose()
    booted = undefined
  })
  return async () => (booted = await bootMinimalContext())
}
