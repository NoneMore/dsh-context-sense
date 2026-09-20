import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options })
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function walkFiles(root) {
  const files = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) files.push(...walkFiles(path))
    else files.push(path)
  }
  return files
}

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/')
  return specifier.split('/')[0]
}

function runtimeImports(libDir) {
  const found = new Set()
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const file of walkFiles(libDir).filter((path) => path.endsWith('.js'))) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1]
        if (
          specifier === undefined ||
          specifier.startsWith('.') ||
          specifier.startsWith('/') ||
          specifier.startsWith('node:')
        ) {
          continue
        }
        found.add(packageName(specifier))
      }
    }
  }
  return [...found].sort()
}

function installSpec(name, harnessBaseline) {
  const dev = packageJson.devDependencies?.[name]
  if (dev !== undefined) return `${name}@${dev}`
  if (name.startsWith('@deepseek-ai/dsh-')) return `${name}@${harnessBaseline}`
  throw new Error(`no packed-smoke baseline declared for ${name}`)
}

const temp = mkdtempSync(join(tmpdir(), 'dsh-context-sense-pack-'))

try {
  // The git-install contract is the prepare script, so exercise that exact build
  // before packing. Pack itself ignores lifecycle scripts so the tarball must be
  // independently usable from the artifacts prepare produced.
  run(NPM, ['run', 'prepare'], { cwd: ROOT })

  const declaredRuntime = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.peerDependencies ?? {}),
    ...(packageJson.optionalDependencies ?? {}),
  }
  const undeclaredRuntime = runtimeImports(join(ROOT, 'lib')).filter((name) => declaredRuntime[name] === undefined)
  assert(
    undeclaredRuntime.length === 0,
    `built runtime imports missing from dependencies/peerDependencies: ${undeclaredRuntime.join(', ')}`,
  )

  const packed = JSON.parse(
    capture(NPM, ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { cwd: ROOT }),
  )[0]
  assert(packed !== undefined, 'npm pack produced no artifact metadata')

  const packedFiles = new Set((packed.files ?? []).map((file) => file.path))
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    'cordis.patch.yml',
    'lib/index.js',
    'lib/index.d.ts',
  ]) {
    assert(packedFiles.has(required), `packed artifact is missing ${required}`)
  }
  for (const forbiddenPrefix of ['src/', 'test/', '.scratch/', 'scripts/']) {
    assert(
      ![...packedFiles].some((path) => path.startsWith(forbiddenPrefix)),
      `packed artifact unexpectedly includes ${forbiddenPrefix}`,
    )
  }

  const consumer = join(temp, 'consumer')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'dsh-context-sense-packed-smoke', private: true, type: 'module' }, null, 2) + '\n',
  )

  const harnessBaseline = packageJson.devDependencies?.['@deepseek-ai/dsh-agent-loop-testkit']
  assert(
    typeof harnessBaseline === 'string' && /^\d/.test(harnessBaseline),
    'packed smoke requires an exact dsh-agent-loop-testkit development baseline',
  )

  const install = new Map()
  for (const name of Object.keys(packageJson.peerDependencies ?? {})) {
    install.set(name, installSpec(name, harnessBaseline))
  }
  for (const name of [
    '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/dsh-agent-loop',
    '@deepseek-ai/dsh-agent-loop-testkit',
    '@deepseek-ai/dsh-invariants',
    '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-session-persistence',
    '@deepseek-ai/dsh-settings',
    'js-yaml',
  ]) {
    install.set(name, installSpec(name, harnessBaseline))
  }

  const tarball = join(temp, packed.filename)
  run(
    NPM,
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      tarball,
      ...install.values(),
    ],
    { cwd: consumer },
  )

  const boot = `import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { load } from 'js-yaml'
import { readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const manifestPath = fileURLToPath(import.meta.resolve('dsh-context-sense/package.json'))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('packed manifest does not declare the expected dsh.bundle.patch')
}
const patchPath = resolve(dirname(manifestPath), manifest.dsh.bundle.patch)
const patch = load(readFileSync(patchPath, 'utf8'))
const rows = patch.flatMap((operation) => operation.insert ?? [])
if (rows.length !== 1 || rows[0]?.name !== 'dsh-context-sense') {
  throw new Error('packed bundle patch does not contain the expected loader row')
}

const ctx = new Context()
try {
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('packed-smoke'))

  await ctx.plugin(Loader, { baseUrl: pathToFileURL(process.cwd() + sep).href })
  await ctx.loader.root.update(rows)

  if (ctx.tools.get('context_reading') === undefined) {
    throw new Error('packed plugin did not register context_reading')
  }
  const prompt = await ctx.systemPrompt.assemble({ scope: scopeOf(agent.ctx) })
  if (!prompt.sections.some((section) => section.name === 'context-sense:capacity')) {
    throw new Error('packed plugin did not register the scoped capacity statement')
  }
} finally {
  await ctx.fiber.dispose()
}
`
  writeFileSync(join(consumer, 'smoke.mjs'), boot)
  run(process.execPath, ['smoke.mjs'], { cwd: consumer })

  console.log(`packed install smoke passed: ${packed.filename}`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
