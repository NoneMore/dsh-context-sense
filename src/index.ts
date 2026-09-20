/**
 * Context Sense: give the model awareness of its own context window.
 *
 * This plugin contributes a standing system-prompt statement, registered once
 * per agent, of how much room the current route allows — or a plain statement
 * that capacity is not yet known — the parameterless `context_reading` tool,
 * which reports a source-attributed reading of the live session on demand,
 * advisory reminders when committed history reaches a configured pressure tier
 * and when one tool result is oversized, and its own durable, replayable memory
 * of the session's model-visible surface.
 *
 * @module dsh-context-sense
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'

import { PLUGIN_NAME } from './identity.js'
import { installOversizedResultReminders } from './oversized-reminders.js'
import { createContextReadingTool } from './reading-tool.js'
import {
  DEFAULT_COMPACTION_THRESHOLD_RATIO,
  DEFAULT_OVERSIZED_RESULT_MODE,
  DEFAULT_OVERSIZED_RESULT_TOKENS,
  DEFAULT_REMINDER_TIERS,
  resolveOversizedResultPolicy,
  resolveReminderPolicy,
} from './reminder.js'
import { contextSenseProjection } from './session-state.js'
import { CAPACITY_SECTION_NAME, CAPACITY_STATEMENT_ORDER, renderCapacityStatement } from './statement.js'
import { installTierReminders } from './tier-reminders.js'

/**
 * The plugin's identity, used for attribution and as its name in diagnostics.
 * Every message the plugin authors carries it, which is also how the fold
 * recognizes its own reminders.
 */
export const name = PLUGIN_NAME

/**
 * The services this plugin requires a composition to mount.
 *
 * The capacity statement reads `agents` and `systemPrompt`; the
 * `context_reading` tool reads `tools` and this plugin's own memory in
 * `sessionProjections`, which is also where that memory is registered; and the
 * oversized-result rule reads `tokenMeter`, the one public pricing seam, on the
 * `tools/post-execute` waterfall. A composition missing any of them should leave
 * this plugin pending at load rather than degrade silently later.
 */
export const inject = ['agents', 'sessionProjections', 'systemPrompt', 'tools', 'tokenMeter']

/**
 * The oversized-result block's declared schema.
 *
 * The two numeric fields carry no default: a form's field is absent whenever its
 * form is not the one in force, which keeps "was it configured?" answerable and
 * makes a configuration naming the other form's field a load-time refusal rather
 * than a value silently ignored.
 */
const OversizedResultConfigSchema = z.object({
  /** Report one raw tool result that exceeds the trigger below. Independent of the tier flag. */
  enabled: z.boolean().default(true),
  /** The trigger's form: the fixed token threshold, or the result share. */
  mode: z.union([z.const('tokens'), z.const('share')]).default(DEFAULT_OVERSIZED_RESULT_MODE),
  /** The fixed token threshold, in estimated tokens. Only with `mode: 'tokens'`. */
  tokens: z.number(),
  /** The share of the route's capacity one raw tool result may occupy. Only with `mode: 'share'`. */
  share: z.number(),
})

/**
 * The block's whole-value default: the form in force — enabled, the fixed form,
 * its threshold — and nothing of the other form, because a default that also
 * named a share would make every configuration self-contradictory and the
 * mutual-exclusion check meaningless.
 *
 * Schemastery types every declared key of an object as present in its output, so
 * a default that deliberately omits one is asserted rather than described.
 */
const OVERSIZED_RESULT_DEFAULTS = {
  enabled: true,
  mode: DEFAULT_OVERSIZED_RESULT_MODE,
  tokens: DEFAULT_OVERSIZED_RESULT_TOKENS,
} as unknown as Schemastery.TypeT<typeof OversizedResultConfigSchema>

/** The declared config schema; the loader row's `config` block validates against it. */
export const Config = z.object({
  statement: z
    .object({
      /** Register the standing capacity statement in every agent's prompt. */
      enabled: z.boolean().default(true),
    })
    // Stated in full because an object default is the whole value, not a patch.
    .default({ enabled: true }),
  tool: z
    .object({
      /** Register the `context_reading` tool the model calls for a live reading. */
      enabled: z.boolean().default(true),
    })
    // Stated in full because an object default is the whole value, not a patch.
    .default({ enabled: true }),
  reminders: z
    .object({
      /** Deliver pressure-tier reminders. Independent of the statement, the tool and the oversized-result rule. */
      enabled: z.boolean().default(true),
      /** Reminder tier ratios, strictly ascending and strictly below the assumed threshold. */
      tiers: z.array(z.number()).default([...DEFAULT_REMINDER_TIERS]),
      /**
       * The compaction threshold this deployment assumes, as a fraction of the
       * context window. Used only for headroom wording and tier validation —
       * never read as the policy the mounted compaction backend enforces.
       */
      compactionThresholdRatio: z.number().default(DEFAULT_COMPACTION_THRESHOLD_RATIO),
      oversized: OversizedResultConfigSchema.default(OVERSIZED_RESULT_DEFAULTS),
    })
    // Stated in full because an object default is the whole value, not a patch.
    .default({
      enabled: true,
      tiers: [...DEFAULT_REMINDER_TIERS],
      compactionThresholdRatio: DEFAULT_COMPACTION_THRESHOLD_RATIO,
      oversized: OVERSIZED_RESULT_DEFAULTS,
    }),
})

/** Validated plugin config. */
export type ContextSenseConfig = Schemastery.TypeT<typeof Config>

/**
 * Apply the plugin.
 * @param ctx - the plugin's context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: ContextSenseConfig): void {
  // Validated before anything is registered. An unusable policy is a
  // deployment error: it fails the plugin at load, rather than being silently
  // clamped into a shape the operator did not ask for, and that holds whether
  // or not the reminders it configures are switched on.
  const policy = resolveReminderPolicy(config.reminders)
  const oversizedPolicy = resolveOversizedResultPolicy(config.reminders.oversized)

  // Registered first and unconditionally: the surface memory is the plugin's
  // own durable state, and the tool's reading and the tier decision are the
  // faces it has. Registration is an effect on this plugin's fiber, so
  // unloading the plugin removes the unit along with everything else it
  // contributed.
  ctx.sessionProjections.register(contextSenseProjection)

  // The statement names the tiers a reminder will actually arrive at. A
  // switched-off reminder subsystem must not tell the model to expect warnings
  // that will never come, so the tiers it advertises are the ones in force.
  const announcedTiers = config.reminders.enabled ? config.reminders.tiers : []

  // The statement, the tool and the two reminder rules are independently
  // switchable: a deployment may want the standing statement without a tool, or
  // the reading without being interrupted, or the oversized-result report
  // without the per-epoch tier signals.
  if (config.statement.enabled) installCapacityStatements(ctx, announcedTiers)
  if (config.tool.enabled) ctx.tools.register(createContextReadingTool(ctx.sessionProjections))
  if (config.reminders.enabled) installTierReminders(ctx, policy)
  if (config.reminders.oversized.enabled) installOversizedResultReminders(ctx, oversizedPolicy)
}

/**
 * Register the standing capacity statement in every agent's prompt scope.
 * @param ctx - the plugin's context.
 * @param reminderTiers - configured reminder tier ratios, named by the statement.
 */
function installCapacityStatements(ctx: Context, reminderTiers: readonly number[]): void {
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
            reminderTiers,
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
