import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'

/**
 * The harness's own pressure figure, read the way the human context meter reads
 * it. Tests compare the plugin's reading against this, so the expected value
 * comes from the harness rather than from the code under test.
 * @param ctx - the context holding the projection registry.
 * @param agent - the agent whose session to read.
 * @returns the projected prompt size, or `undefined` before any usage sample.
 */
export function pressureOf(ctx: Context, agent: Agent): number | undefined {
  const projections = ctx.get('sessionProjections') as SessionProjectionRegistry
  const { contextPressure } = projections.snapshot(agent.session, ['contextPressure']).values
  return contextPressure?.projectedTokens ?? contextPressure?.pressureTokens
}
