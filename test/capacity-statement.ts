import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeOf } from '@deepseek-ai/dsh-scope'

import { CAPACITY_SECTION_NAME } from '../lib/statement.js'

/**
 * Assemble the prompt one agent's requests would send.
 *
 * The agent's own scope is the only place its contributions are visible, so
 * every observation of the statement goes through it.
 * @param ctx - the context holding the prompt registry.
 * @param agent - the agent whose scope to assemble.
 * @returns the assembly the agent's next request would render from.
 */
export async function assembleFor(ctx: Context, agent: Agent) {
  return ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx) })
}

/**
 * The capacity statement's own sections in one agent's assembly — the count
 * that has to be exactly one per agent scope.
 * @param ctx - the context holding the prompt registry.
 * @param agent - the agent whose scope to assemble.
 * @returns the matching sections, in assembly order.
 */
export async function capacitySections(ctx: Context, agent: Agent) {
  const assembly = await assembleFor(ctx, agent)
  return assembly.sections.filter((section) => section.name === CAPACITY_SECTION_NAME)
}
