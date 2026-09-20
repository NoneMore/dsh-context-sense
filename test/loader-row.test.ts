import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import * as ContextSense from '../lib/index.js'
import { resolveOversizedResultPolicy } from '../lib/reminder.js'
import { capacitySections } from './capacity-statement.js'
import { minimalContextFixture } from './minimal-context.js'

/** One operation of the harness's entry-list patch dialect. */
interface PatchOperation {
  readonly insert?: readonly Row[]
}

/** One loader row as the bundle patch declares it. */
interface Row {
  readonly id: string
  readonly name: string
  readonly config?: unknown
}

/** The patch file this package's manifest declares, resolved from that manifest. */
function declaredPatchFile(): URL {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const declared = manifest.dsh?.bundle?.patch
  if (declared === undefined) throw new Error('package.json declares no dsh.bundle.patch')
  return new URL(declared, new URL('../package.json', import.meta.url))
}

/**
 * The entry list a profile mounts: this bundle patch's inserts applied over the
 * profile's empty root, which is the only operation form a bundle patch uses.
 * @param file - the patch file to read.
 * @returns the rows the profile's root would hold.
 */
function mountedRows(file: URL): readonly Row[] {
  const patch = load(readFileSync(file, 'utf8')) as readonly PatchOperation[]
  let rows: readonly Row[] = []
  for (const operation of patch) {
    if (operation.insert === undefined) throw new Error('a bundle patch over the empty root only inserts rows')
    rows = [...rows, ...operation.insert]
  }
  return rows
}

/**
 * The default-configuration block the README documents, parsed as YAML.
 * @returns the block, as the configuration an operator would copy out of the README.
 */
function readmeDefaults(): unknown {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const block = /## Default configuration[\s\S]*?```yaml\r?\n([\s\S]*?)```/.exec(readme)?.[1]
  if (block === undefined) throw new Error('the README documents no default-configuration block')
  return load(block)
}

describe('bundle patch loader row', () => {
  const boot = minimalContextFixture()

  /** The one row the declared patch inserts, or a failure that says it declares none. */
  function declaredRow(): Row {
    const rows = mountedRows(declaredPatchFile())
    expect(rows).toHaveLength(1)
    const [row] = rows
    if (row === undefined) throw new Error('the bundle patch declares no row')
    return row
  }

  it('boots the plugin by the row this package declares', async () => {
    // The manifest must name the file this test reads, or a profile would
    // compose a different patch than the row being booted here.
    const file = declaredPatchFile()
    expect(fileURLToPath(file)).toBe(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))

    const row = declaredRow()

    const { ctx, harness } = await boot()
    const agent = await harness.create(SessionId('agent-1'))

    // Boot the row the way a composition does: a loader tree whose entries are
    // the declared rows, rather than direct `ctx.plugin()` calls. The loader
    // imports a row's `name` from the tree's baseUrl; a profile resolves this
    // specifier from the node_modules it links the bundle into, and this
    // checkout resolves the same specifier through the package's own name and
    // `exports` map (its self-reference), so no install step is involved.
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(fileURLToPath(new URL('..', import.meta.url))).href })
    await ctx.loader.root.update([{ id: row.id, name: row.name, config: row.config }])

    expect(await capacitySections(ctx, agent)).toHaveLength(1)
  })

  it('resolves the declared row, and the README’s documented defaults, to the fixed form', () => {
    // The loader validates a row's `config` against the schema this plugin
    // declares, so resolving the declared row through that schema is what the
    // mounted plugin's `apply` is handed. The absolute form is the one in force,
    // at 8,000 estimated tokens, and no share is invented beside it.
    const row = ContextSense.Config(declaredRow().config as ContextSense.ContextSenseConfig)

    expect(row.reminders.oversized).toEqual({ enabled: true, mode: 'tokens', tokens: 8_000 })
    expect(resolveOversizedResultPolicy(row.reminders.oversized)).toEqual({ mode: 'tokens', tokens: 8_000 })

    // The README documents the same resolution as the default configuration, so
    // the configuration an operator copies from it is the one that runs.
    const documented = ContextSense.Config(readmeDefaults() as ContextSense.ContextSenseConfig)

    expect(documented.reminders.oversized).toEqual({ enabled: true, mode: 'tokens', tokens: 8_000 })
    expect(resolveOversizedResultPolicy(documented.reminders.oversized)).toEqual({ mode: 'tokens', tokens: 8_000 })
  })
})
