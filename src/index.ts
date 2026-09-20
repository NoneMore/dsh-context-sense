/**
 * Context Sense: give the model awareness of its own context window.
 *
 * This first slice contributes one thing — a standing system-prompt statement,
 * registered once per agent, of how much room the current route allows, or a
 * plain statement that capacity is not yet known.
 *
 * @module dsh-context-sense
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'

import { CAPACITY_SECTION_NAME, CAPACITY_STATEMENT_ORDER, renderCapacityStatement } from './statement.js'

/** The plugin's identity, used for attribution and as its name in diagnostics. */
export const name = 'context-sense'

/**
 * The services this plugin requires a composition to mount.
 *
 * This slice contributes only the capacity statement, which reads `agents`
 * and `systemPrompt`. `tools`, `sessionProjections` and `tokenMeter` are named
 * because the spec fixes ONE load-time contract for the whole first version —
 * the `context_reading` tool, the reminder state and the oversized-result rule
 * are the later slices that read them — and a composition missing any of them
 * should leave this plugin pending at load rather than degrade silently later.
 */
export const inject = ['agents', 'sessionProjections', 'systemPrompt', 'tools', 'tokenMeter']

/** The declared config schema; the loader row's `config` block validates against it. */
export const Config = z.object({
  statement: z
    .object({
      /** Register the standing capacity statement in every agent's prompt. */
      enabled: z.boolean().default(true),
    })
    // Stated in full because an object default is the whole value, not a patch.
    .default({ enabled: true }),
  /** Reminder tier ratios, as fractions of the context window. */
  reminderTiers: z.array(z.number()).default([0.6, 0.75]),
})

/** Validated plugin config. */
export type ContextSenseConfig = Schemastery.TypeT<typeof Config>

/**
 * Apply the plugin.
 * @param ctx - the plugin's context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: ContextSenseConfig): void {
  if (!config.statement.enabled) return

  // One disposer per live agent. Holding them here is what lets the plugin
  // unload remove every section it registered; releasing an entry when its
  // agent is disposed is what keeps a long-lived plugin from pinning the
  // scoped world of every agent it has ever seen.
  const statements = new Map<Agent, () => void>()

  const install = (agent: Agent): void => {
    if (statements.has(agent)) return
    statements.set(
      agent,
      // Registered through the agent's OWN scoped context, so the section is
      // agent-local and unwinds with that agent.
      agent.ctx.systemPrompt.section({
        name: CAPACITY_SECTION_NAME,
        order: CAPACITY_STATEMENT_ORDER,
        // A provider, not a string: capacity moves when the route does, and
        // assembly is the only point that sees the newest recorded route.
        text: () =>
          renderCapacityStatement({
            contextWindow: agent.session.requestContext()?.contextWindow,
            reminderTiers: config.reminderTiers,
          }),
      }),
    )
  }

  const release = (agent: Agent): void => {
    statements.get(agent)?.()
    statements.delete(agent)
  }

  // Agents already live when the plugin loads would otherwise be skipped: a
  // session's own start has already happened by the time a plugin row is
  // activated, so waiting for `agent/created` alone silently misses them.
  for (const agent of ctx.agents.list()) install(agent)
  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => release(agent))

  ctx.effect(
    () => () => {
      for (const dispose of statements.values()) dispose()
      statements.clear()
    },
    'context-sense: capacity statements',
  )
}
