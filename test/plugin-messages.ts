/**
 * Reading this plugin's own messages back out of a session and a request.
 *
 * Both reminder listeners deliver the same artifact — a user-role message this
 * plugin attributes to itself, whose declared context form says which shape it
 * is — so every test that observes one reads it the same way. What is read here
 * is the harness's own durable log and its own assembled request, never a
 * private field of the plugin.
 *
 * @module test/plugin-messages
 */
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session'

import { name as PLUGIN_NAME } from '../lib/index.js'
import { textOf, type ScriptedAdapter } from './scripted-provider.js'

/** One of this plugin's messages, wherever it was read from. */
export interface PluginMessage {
  /** The declared context form: `snapshot` for a reading, `notice` for a one-off account. */
  readonly form: 'snapshot' | 'notice'
  /** The model-facing text the message carries. */
  readonly text: string
  /** The one-line account a `notice` carries, and only a notice. */
  readonly summary?: string | undefined
  /** The named contributions a `snapshot` carries; empty for a notice. */
  readonly sections: readonly { readonly name: string; readonly text: string }[]
}

/**
 * Every message this plugin committed to a session, in log order.
 *
 * The durable log, not the surface, is what a reminder is reconstructed from, so
 * a message a compaction has since replaced still counts as spoken.
 * @param session - the session to read.
 * @returns one entry per committed message.
 */
export function committedPluginMessages(session: Session): PluginMessage[] {
  const messages: PluginMessage[] = []
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type !== 'user/message') continue
    const source = event.data.source
    if (source.kind !== 'plugin' || source.plugin !== PLUGIN_NAME) continue
    if (source.form === 'notice') {
      messages.push({ form: 'notice', text: textOf(event.data.content), summary: source.summary, sections: [] })
    } else if (source.form === 'snapshot') {
      messages.push({ form: 'snapshot', text: textOf(event.data.content), sections: source.sections })
    }
  }
  return messages
}

/** The oversized-result notices a session has committed, in log order. */
export function committedNotices(session: Session): PluginMessage[] {
  return committedPluginMessages(session).filter((message) => message.form === 'notice')
}

/**
 * The section names of every reading this plugin has committed, in order.
 *
 * One entry per named section rather than per message: a section name is the
 * durable key a tier's firing is recorded under.
 * @param session - the session to read.
 * @returns the section names, in log order.
 */
export function committedReminderSections(session: Session): string[] {
  return committedPluginMessages(session)
    .filter((message) => message.form === 'snapshot')
    .flatMap((message) => message.sections.map((section) => section.name))
}

/**
 * The text committed under one section name, if this plugin committed it.
 * @param session - the session to read.
 * @param sectionName - the section name to look for.
 * @returns the section's model-facing text, or `undefined` when it never spoke.
 */
export function committedReminderText(session: Session, sectionName: string): string | undefined {
  const message = committedPluginMessages(session).find((candidate) =>
    candidate.sections.some((section) => section.name === sectionName),
  )
  return message?.sections.find((section) => section.name === sectionName)?.text
}

/**
 * The plugin-attributed text one assembled request carried.
 * @param adapter - the scripted provider holding the requests the loop assembled.
 * @param index - the request to read, in assembly order.
 * @param form - restrict the result to one context form.
 * @returns the matching texts, in message order.
 */
export function pluginMessagesInRequest(
  adapter: ScriptedAdapter,
  index: number,
  form?: 'snapshot' | 'notice',
): string[] {
  const request = adapter.requests[index]
  if (request === undefined) throw new Error(`the loop assembled no request at index ${index}`)
  return request.messages
    .filter(
      (message) =>
        message.source.kind === 'plugin' &&
        message.source.plugin === PLUGIN_NAME &&
        (form === undefined || message.source.form === form),
    )
    .map((message) => textOf(message.content))
}
