# dsh-context-sense

A DeepSeek Harness bundle that gives the model explicit awareness of its own context window: route capacity, provider-anchored pressure, approximate composition, and advisory reminders as the window fills.

> **Compatibility:** verified against DeepSeek Harness `dsh-v0.1.5-rc.2`. DeepSeek Harness is still a Developer Preview, so later releases may change plugin seams. This package deliberately reports a narrow verified baseline rather than implying compatibility that has not been exercised.

## What it does

- Adds a stable system-prompt statement describing the newest recorded route's context-window capacity.
- Registers a parameterless `context_reading` tool for a source-attributed live reading.
- Reconstructs route coherence and reminder state from durable session events, including fork boundaries.
- Emits once-per-epoch advisory reminders at configurable pressure tiers.
- Reports a single raw tool result when its estimated size exceeds a configured share of the route capacity.
- Remains append-only: it does not rewrite, truncate, reorder, or remove existing conversation history.

The plugin treats missing measurements as unknown rather than inventing numbers. A pressure/capacity ratio is reported only when both figures are known and the plugin can show that they belong to the same resolved route.

## Install

### npm registry

After the package is published:

```sh
dsh plugin --profile demo add dsh-context-sense
```

Verify that the bundle layer composes before launching the profile:

```sh
dsh --profile demo --dump-config
dsh --profile demo
```

### Tarball

A tarball contains prebuilt `lib/` output and does not require install-time build permission:

```sh
npm pack
dsh plugin --profile demo add ./dsh-context-sense-0.1.0.tgz
```

### GitHub source

A git install fetches source code, so this package exposes a `prepare` script that builds `lib/` after installation:

```sh
dsh plugin --profile demo add github:NoneMore/dsh-context-sense#<commit>
```

pnpm 10+ requires explicit approval before running a git dependency's build script. If the first install reports that the build was blocked, add the package to the target profile's `pnpm-workspace.yaml` and retry:

```yaml
allowBuilds:
  dsh-context-sense: true
```

Only grant that permission to source you trust, and prefer pinning a commit rather than a moving branch.

## Default configuration

The bundle mounts one loader row with id `context-sense`. Its effective defaults are:

```yaml
statement:
  enabled: true

tool:
  enabled: true

reminders:
  enabled: true
  tiers: [0.60, 0.75]
  compactionThresholdRatio: 0.80
  oversized:
    enabled: true
    share: 0.10
```

A profile can override that row through its own `cordis.patch.yml`. DeepSeek Harness patch layers replace a row's complete `config` value rather than deep-merging individual keys, so restate every setting you want to keep when overriding the row.

## Reading semantics

**Capacity** is route metadata from the newest `request/context` record. A session's first request can therefore legitimately see capacity as not yet known.

**Pressure** is provider-anchored. It uses the newest provider-reported prompt size plus the Harness projection of surface changes since that sample. The projection is based on committed history, so a pre-step reminder describes the previously committed surface rather than claiming to be an exact measurement of the request currently being assembled.

**Route coherence** is conservative. If the newest pressure sample cannot be attributed to the same provider/model pair as the recorded capacity, pressure is reported as stale and no ratio or pressure-tier reminder is formed.

**Composition** is the Harness heuristic split between system prompt, tool definitions, and conversation messages. It is not a substitute for pressure and is not expected to sum to it.

**Compaction threshold** is an operator-declared assumption used for reminder wording and validation. The plugin does not claim to read the mounted compaction backend's live policy.

**Oversized tool results** are priced at the `tools/post-execute` seam before a tool's own finalization. A tool that later shrinks its output can therefore be reported larger than the final model-visible result.

For the domain vocabulary and the exact distinctions used by the implementation, see [CONTEXT.md](./CONTEXT.md).

## Development

Requires Node.js `^22.19.0 || >=24.0.0`.

```sh
npm ci
npm run typecheck
npm test
npm run smoke:pack
```

`npm test` builds first and runs the test suite against the emitted `lib/` artifact.

`npm run smoke:pack` exercises the distribution boundary rather than the source checkout: it runs the package's `prepare` build, creates an `npm pack` tarball, checks that runtime imports are declared, installs the tarball into a clean temporary consumer with install scripts disabled, mounts the real DSH test services and loader, and verifies that the packed bundle registers both the `context_reading` tool and the scoped capacity statement.

Before publishing, `prepublishOnly` runs `npm run verify:release`, which type-checks, runs the test suite, and executes the packed-install smoke test.

## Release

GitHub releases are created by the `Release` workflow; the workflow does **not** publish to npm.

For a new version, update both package manifests without creating a local tag, then merge that version bump to `master`:

```sh
npm version <version> --no-git-tag-version
```

After the version bump is on `master`:

1. Open **Actions → Release → Run workflow**.
2. Select the `master` branch.
3. Enter the package version without the leading `v` (for example, `0.1.0`).

The workflow refuses to release from another branch, refuses a version that does not exactly match `package.json`, and refuses to reuse an existing tag. It then runs `npm run verify:release`, creates the distributable `.tgz` plus a SHA-256 checksum, and publishes a GitHub Release whose `v<version>` tag points at the exact commit that passed verification. Prerelease versions such as `0.2.0-rc.1` are marked as GitHub prereleases automatically.

## License

MIT
