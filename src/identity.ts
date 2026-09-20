/**
 * The plugin's identity, in its own module.
 *
 * Every other module needs the name — as the Cordis plugin name, as the source
 * attribution on this plugin's own messages, and as the fold's key prefix — so
 * it lives here rather than on the plugin entry point, which imports those
 * modules and would otherwise close a cycle through a still-uninitialized
 * binding.
 *
 * @module dsh-context-sense/identity
 */

/** The plugin's identity, used for attribution and as its name in diagnostics. */
export const PLUGIN_NAME = 'context-sense'
