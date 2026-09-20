/**
 * The standing capacity statement: the text the model reads in its own system
 * prompt about how much room its route allows.
 *
 * It carries capacity only. Live pressure never appears here, because a
 * section whose text moves every step either appends a new system message per
 * step or rewrites the request prefix and invalidates the provider cache.
 * Capacity changes only when the route does.
 *
 * @module dsh-context-sense/statement
 */
import { formatPercent } from './reading.js'
import { CONTEXT_READING_TOOL_NAME } from './reading-tool.js'
import { REMINDER_DISCLAIMER } from './reminder.js'

/** The facts the statement states, resolved at each prompt assembly. */
export interface CapacityStatementInput {
  /**
   * `contextWindow` of the newest route this session has recorded, or
   * `undefined` when no recorded route advertised one. Route metadata, never
   * an estimate.
   */
  readonly contextWindow?: number | undefined
  /** Configured reminder tier ratios, as fractions of the context window. */
  readonly reminderTiers: readonly number[]
}

/** The section's unique name within one agent's prompt scope. */
export const CAPACITY_SECTION_NAME = 'context-sense:capacity'

/**
 * The section's fixed placement, between the harness's own allocated
 * positions: after `HARNESS_IDENTITY` (-1000) and
 * `DEPLOYMENT_PERSONA_PREFIX` (0), and ahead of `PLAN_POLICY` (500) and every
 * `TOOL_*` section (>= 1000).
 */
export const CAPACITY_STATEMENT_ORDER = 100

/**
 * Render the statement for one agent.
 * @param input - the route capacity and reminder tiers in force.
 * @returns the section text, with no trailing newline.
 */
export function renderCapacityStatement(input: CapacityStatementInput): string {
  return [
    capacitySentence(input.contextWindow),
    // Deliberately neutral about which figures the tool reports. The reading
    // gives a ratio and a remaining room only when the pressure figure is
    // confirmed for the route, and says `unknown` or `stale` otherwise, so
    // enumerating figures here would promise the model numbers this session may
    // not have. The tool's own description carries that detail.
    `Call the \`${CONTEXT_READING_TOOL_NAME}\` tool at any time for a live, source-attributed reading of this session's context.`,
    reminderSentence(input.reminderTiers),
  ].join('\n')
}

/**
 * State the route's capacity, or say plainly that it is not known yet.
 * Capacity is route metadata: it exists only once the harness has recorded a
 * resolved route, so a session's first request legitimately has none.
 * @param contextWindow - the newest recorded route's context window.
 * @returns one sentence of the statement.
 */
function capacitySentence(contextWindow: number | undefined): string {
  if (contextWindow === undefined) {
    return 'The context window of the current route is not yet known, because this session has not recorded a resolved route that advertises one.'
  }
  return `The current route accepts ${contextWindow} tokens of context.`
}

/**
 * State the configured reminder tiers and what a reminder does and does not
 * claim.
 *
 * The ratios come from this plugin's own config — an assumed compaction
 * threshold, in the domain's vocabulary — so a reminder describes committed
 * history rather than the request being assembled, and the threshold it names
 * is an assumption about the deployment, never a reading of the mounted
 * compaction policy.
 * @param reminderTiers - configured tier ratios, in ascending order.
 * @returns one sentence of the statement.
 */
function reminderSentence(reminderTiers: readonly number[]): string {
  if (reminderTiers.length === 0) {
    // An empty list is a valid configuration: the strict rules constrain each
    // tier, not how many there are, and disabling reminders arrives here too.
    // Saying so is what keeps the statement a true sentence — and what stops it
    // promising the model a reminder no step will ever deliver.
    return 'No advisory context reminder tiers are configured, so no reminder will interrupt a step as this history grows.'
  }
  const tiers = reminderTiers.map(formatPercent).join(' and ')
  return `Advisory context reminders arrive at ${tiers} of the context window. ${REMINDER_DISCLAIMER}`
}
