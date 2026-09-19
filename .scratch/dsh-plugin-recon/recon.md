# DSH installation & plugin-loading reconnaissance (read-only)

Environment inspected: Windows, DSH CLI `0.1.5-rc.1`, harness home `E:\Home\.dsh`.
Nothing was modified. Every claim below is grounded in a file read this session; paths are exact.

---

## 0. Inventory: what is actually installed, and where

| Artifact | Absolute path | Notes |
|---|---|---|
| DSH CLI package | `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\` | the **only** `@deepseek-ai` entry in the global `node_modules`; `package.json` + `lib/bin.js` + `lib/plugin-Ddi42qoW.js` + `lib/profile-boot-Dk-7KqJc.js` + `lib/dump-config-lFgMwK8i.js` |
| CLI's own dependency closure | `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` | ~230 packages, incl. `dsh-agent-presets`, `cordis`, `cordis-plugin-{loader,include,group,hmr,timer}`, `schemastery` |
| Harness home | `E:\Home\.dsh\` | contents: `.agent-presets\`, `attachments\`, `profiles\`, `sessions\`, `storages\`, `.anonymous-user-id`, `.credentials.yaml`, `settings.yaml` |
| Active profile | `E:\Home\.dsh\profiles\web\` | `package.json`, `cordis.yml`, `cordis.patch.yml`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `node_modules\`, `.dsh-market\`, `.dsh-module-fallback\` |
| Shared profile closure | `E:\Home\.dsh\profiles\node_modules\` | 240 `@deepseek-ai` packages + the whole transitive closure (hoisted by pnpm) |
| **Shipped** agent presets | `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-agent-presets\presets\` | `standard`, `ptc`, `minimal`, `cordis` |
| Mirror of the same package | `E:\Home\.dsh\profiles\node_modules\@deepseek-ai\dsh-agent-presets\presets\` | same 4 presets |
| **User** agent preset root | `E:\Home\.dsh\.agent-presets\` | contains exactly one authored preset: `bare-standard\` |
| Home-level patch layer | `E:\Home\.dsh\cordis.patch.yml` | **does not exist** in this deployment |

`E:\Home\.dsh\settings.yaml` (verbatim, 39 lines):

```yaml
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
ui-conversation:
  busyEnter: queue
agent-default-model:
  provider: cliproxyapi
  model: deepseek-flash
  reasoningEffort: high
llm-pi-ai:
  providers:
    cliproxyapi:
      displayName: CLIProxyAPI
      apiKeyEnv: CLIPROXYAPI_API_KEY
      api: openai-completions
      baseURL: http://10.77.0.1:8317/v1
      models:
        - id: deepseek-flash
          name: DeepSeek-V41-Flash
          contextWindow: 384000
          maxTokens: 192000
          input:
            - text
            - image
          reasoningEfforts:
            off: none
            low: low
            high: high
            max: max
          compat:
            supportsDeveloperRole: false
            supportsReasoningEffort: true
            thinkingFormat: deepseek
            chatTemplateKwargs: {}
            chatTemplateArgs: {}
            thinkingTokenBudgetField: thinking_token_budget
locale:
  preference: zh
agent-presets:
  default: bare-standard
```

### Correction to a premise in the brief

The brief states the CLI declares:

```json
"dsh": { "configTrees": [{ "mount": "config/agent-presets",
                           "path": "../../packages/preset/agent-presets/presets",
                           "scanRoster": true }] }
```

That key **is** present verbatim in `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\package.json` (lines 20–28), but it is **not** how shipped presets are found in a published install:

* Its path resolves to `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\packages\preset\agent-presets\presets`, which **does not exist** (`Test-Path` → `False`). It is a source-repo-relative path.
* `@deepseek-ai/dsh-package-manifest`'s README states plainly: *"`configTrees` serves the experimental image packer"* — it is not the preset roster mechanism.
* The real root is a runtime constant in `dsh-agent-presets/lib/types/discovery.js:56`:
  `export const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../presets/', import.meta.url))`
  → `...\dsh-agent-presets\presets\`.

---

## 1. Composition format

There is no single `cordis.yml` that governs everything. Three distinct filenames, three roles:

| Filename | Location | Role |
|---|---|---|
| `cordis.yml` | `$DSH_HOME/profiles/<name>/cordis.yml` | the profile **root**. Always an empty list — the composer rewrites it on every boot. |
| `cordis.patch.yml` | a profile dir, the harness home, a bundle package, or a `--patch` file | a **patch layer**: list of insert/override entries |
| `agent.cordis.yml` | one per agent-preset directory | the **agent-plane composition**: a plain entry list (no `insert:` wrapper) |

`cordis.yml` in full (`E:\Home\.dsh\profiles\web\cordis.yml`):

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

The constant is in `lib/profile-boot-Dk-7KqJc.js:124-128` (`PROFILE_ROOT_CONFIG`) and is rewritten by `prepareProfile` at line 209.

### Layer order (authoritative: `lib/profile-boot-Dk-7KqJc.js:213-257`)

```
bundlePatches (dsh.profile.bundles order)
  → profile's own cordis.patch.yml       ($DSH_HOME/profiles/<name>/cordis.patch.yml)
  → home-level layer                     ($DSH_HOME/cordis.patch.yml)   ← outranks the per-profile layer
  → --patch overlays (argv order)
  → synthesised telemetry-disable patch (DSH_TELEMETRY_DISABLED)
```

All layers are flattened into **one** `applyEntryPatches([], layers.flat())` call (`composeEntries`, `dsh-app-boot/lib/index.js:904-909`), so a later layer can target a row an earlier layer inserted.

### Patch-entry semantics (authoritative: `dsh-app-boot/lib/index.js:59-108`)

```js
const { id, insert, name, ...overrides } = patch;
if (insert) {
  if (id) { /* target must exist AND be a group; push into target.config */ }
  else data.push(...insert);
  continue;
}
if (!id) { warn('patch: id is required for non-insert patches'); continue; }
const target = entryMap.get(id);
if (!target) { warn('patch: entry %C not found', id); continue; }
if (name && name !== target.name) { warn('patch: name mismatch …'); continue; }
for (const [key, value] of Object.entries(overrides)) { if (key === 'id') continue; target[key] = value; }
```

Consequences that bite:

* An **id-targeted patch replaces the whole field**, it does not deep-merge. `dsh-app-boot/README.md:144`: *"A user patch replaces the whole matched config — an id-targeted patch does not deep-merge, so a profile override restates the bundle fields it keeps."*
* A patch matching no row is only a **warning**, not a failure. A patch file that cannot be *parsed* throws; an empty/comments-only file **fails boot** (`README.md:55` — use `[]` to disable a layer).
* `insert` with `id` appends into an existing **group** row's `config` array.

### Row fields, complete

Observed across shipped presets and patches, plus the loader's `isolate` hook (`cordis-plugin-loader/lib/index.js:546-655`):

| Field | Type | Meaning |
|---|---|---|
| `id` | string | row identity; the patch target key; nested ids use `:` (`tools:logger`, `tool-subagent-control/list-agents`) |
| `name` | string | the module specifier (see table below) |
| `config` | object **or array** | row config. For a group row this is the **child entry array**. |
| `disabled` | bool or `!!js` expr | `disabledOf()` evaluates `!!js` against the loader ctx (`loader/lib/index.js:377-378`); a disabled group prevents its children |
| `group` | `true` | marks a row as a group/nesting row |
| `isolate` | map `serviceName → true \| label` | installs a per-entry service realm |
| `inject` | string[] | service names the row hard-depends on; loader resolves before activation |
| `intercept` | object | exists in the loader (`isolate.js:635`) but is **not used in any shipped composition** |

### How a row names its plugin

From `dsh-agent-presets/lib/types/specifier.js:30-40` — the classification the preset mount uses (presets) and, in `dsh-app-boot/lib/index.js:1324-1331`, the equivalent for the host include:

| `name` shape | kind | resolved against |
|---|---|---|
| `cordis:group`, `cordis:include` | builtin | loader builtins, registered by `mountRootInclude` (`app-boot/lib/index.js:1322-1342`: `ctx.loader.builtins.include`/`.group`) |
| starts with `.` | preset-relative | the composition's own directory |
| `file:…` | file | as-is |
| absolute path (e.g. `E:/x/y.js`) | file | converted to a `file:` URL by `pathToFileURL` |
| anything else | package | **the harness's own base**, not the preset dir |

The preset case is the non-obvious one — `mount.js:54-89` documents it: *"a locally authored preset lives under the user's home, where Node's upward `node_modules` walk never reaches the harness's own dependencies, so every `@deepseek-ai/dsh-*` row would fail to import. The mount records the host composition's base instead."*

Bundle patches additionally rewrite relative/absolute `name`s to `file:` URLs (`app-boot/lib/index.js:1170-1178`, `anchorInsertedPluginNames`), anchored **beside the patch file**. `app-boot/README.md:59`: *"Inserted plugin names may be absolute filesystem paths, file URLs, or package specifiers."*

### `cordis:group` and `isolate`

`dsh-app-boot/README.md:88`:

> **Two Loader builtins.** `mountRootinclude` registers `cordis:include` and `cordis:group` as Loader builtins: a group row gives one `isolate` realm to a provider and its consumers together, and an agent preset outside this workspace cannot resolve `@deepseek-ai/cordis-plugin-group` by name.

`isolate: { <service>: true }` = one realm **private to each mounting entry**. A string label joins subtrees into a shared realm, but `provide()` still throws on a second registration under the same realm symbol, so *"a label does not pool instances and is not what a preset needs"* (`editing-cordis-compositions/SKILL.md:99`).

The rule stated in the shipped `standard` preset (`agent.cordis.yml:11-18`):

> A service row here MUST sit inside a group carrying an `isolate` realm. Without one it publishes into the root realm, where it is process-global — another preset publishing the same name collides, and a host reader would resolve one preset's instance for every session; `dsh-agent-presets` rejects that at mount.

**There is no `include` row in any shipped preset or patch.** The only include is the boot-time root: `{ id: 'include', name: 'cordis:include', config: { path: <profile cordis.yml URL>, patches: [...] } }` (`app-boot/lib/index.js:1335-1342`).

---

### 1a. VERBATIM — shipped `minimal` preset

`E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-agent-presets\presets\minimal\agent.cordis.yml` (69 lines):

```yaml
# The `minimal` agent preset: a fixed-prompt, single-tool coding-agent composition.
#
# The persona is the complete system prompt, so global identity, Web orientation,
# tool guidance, and later assembly listeners cannot add prompt text. Runtime
# context snapshots are suppressed for this preset, and the model receives only
# the persistent shell (`bash` on POSIX, `pwsh` on win32). Context compaction is
# absent.

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false

# The PTY registry is an agent-owned service, so it lives in an entry-local
# realm. The backend still consumes the host sandbox policy and subprocess
# implementation, while the tool registers into this agent's scoped catalog.
# Exactly one shell stack mounts per host: the bash stack gates off win32 and
# its pwsh twin gates off POSIX, mirroring the one-shot shell rows.
- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'

    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 300000

    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      disabled: !!js process.platform === 'win32'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a bash shell
          * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
          * Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.
          * State is persistent across command calls and discussions with the user.
          * To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
          * Please avoid commands that may produce a very large amount of output.
          * Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.

    - id: terminal-pwsh
      name: '@deepseek-ai/dsh-terminal-bash'
      disabled: !!js process.platform !== 'win32'
      config:
        shellDialect: pwsh
        timeoutMs: 300000

    - id: persistent-pwsh
      name: '@deepseek-ai/dsh-tool-pwsh-persistent'
      disabled: !!js process.platform !== 'win32'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a PowerShell shell
          * When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
          * You don't have access to the internet via this tool.
          * State is persistent across command calls and discussions with the user.
          * Use native Windows paths (C:\...) and $env:NAME variables; this is PowerShell, not bash.
          * Please avoid commands that may produce a very large amount of output.
          * Please run long lived commands in the background, e.g. 'Start-Job' or start a server with Start-Process.
```

Field-by-field for this file:

* `persona` → package row. `config.prefix` is prompt text; `complete: true` makes it the *entire* system prompt; `includeRuntimeContext: false` suppresses runtime snapshots.
* `persistent-shell` → **group** row: `name: cordis:group`, `group: true`, `isolate: { terminals: true }` gives the PTY registry one private realm per mounting agent, and `config` is the **child row array**.
* `disabled: !!js process.platform === 'win32'` — a YAML custom tag evaluated by the loader at boot; this is the platform gate. On this Windows box, `persistent-bash` and `terminal-bash` are therefore **inactive** and `persistent-pwsh`/`terminal-pwsh` are active.
* Note a real quirk worth imitating/knowing: the *pwsh* terminal row is `name: '@deepseek-ai/dsh-terminal-bash'` with `config.shellDialect: pwsh` — the same package, dialect-switched. There is no `dsh-terminal-pwsh` package.

### 1b. VERBATIM — shipped `standard` preset (agent-plane file, comments included)

`...\dsh-agent-presets\presets\standard\agent.cordis.yml` (255 lines). Full text:

```yaml
# The `standard` agent preset: the full coding agent, mounted once per process.
#
# This file is an AGENT-PLANE composition. The roster mounts it ONCE under a
# standing scope; every session naming it joins by scope parentage, so the
# tools and prompt sections registered here cover each joined agent while a
# session's own state stays keyed per Session/Agent inside the plugins. The
# host composition (`base.cordis.yml` + `web.cordis.yml`) keeps everything a
# preset must not own: the registries themselves, the sandbox and approval
# stack, persistence, and the model route.
#
# A service row here MUST sit inside a group carrying an `isolate` realm.
# Without one it publishes into the root realm, where it is process-global —
# another preset publishing the same name collides, and a host reader would
# resolve one preset's instance for every session; `dsh-agent-presets` rejects
# that at mount. `true` means an entry-local realm: this standing mount's own
# private instance, apart from every other preset's. (A shared label does NOT
# pool instances — `provide()` throws on the second registration under the
# same realm symbol; labels join REALMS, and are not what this file needs.)

# ── identity ────────────────────────────────────────────────────────────────

# The preset's own persona, shadowing the deployment default for this agent.
# `{{model}}` and `{{cwd}}` resolve from the agent's own route and workspace.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
    prefix: >-
      You are a coding agent powered by the {{model}} model.

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536

# ── shell ───────────────────────────────────────────────────────────────────

# `shell-env` stays in the HOST composition: `apps/cli/src/web.ts` injects it to
# publish `DSH_WEB_URL`/`DSH_WEB_MODE`, and a host row that injects a service is
# the criterion for host-plane ownership — injection resolves before any session
# exists, so there is no agent to key by. Behind a preset realm those variables
# never reached the model's shell at all. Both shell tools consume the host
# registry from here; their executors (`bash-sandbox`/`pwsh-sandbox`) are
# host-plane too.
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: !!js process.platform === 'win32'

- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: !!js process.platform !== 'win32'

# ── filesystem ──────────────────────────────────────────────────────────────

# Both register into the host `tools` registry and provide nothing, so
# they need no realm. The `fs` service and its policy stay in the host.
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

# ── background jobs ────────────────────────────────────────────────────────

# Only the model-facing controls. The task REGISTRY stays on the host plane:
# its producers sit outside any realm this file could put it in — `tool-bash`
# above resolves it with `ctx.get`, and an entry-local realm here is invisible
# to every sibling row, so `run_in_background` would answer "background jobs
# unavailable" while these controls sat in the catalog. The registry is keyed by
# owning agent anyway, so one host instance serves every session. What a preset
# chooses is whether its agent can collect and stop background work at all.
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

# ── skills ──────────────────────────────────────────────────────────────────

# The skill REGISTRY lives in the host composition and is layered per scope:
# these rows register into THIS preset's layer of it, so they need no realm.
# `skill-filesystem` contributes local-root discovery for agents on this preset, and
# `tool-skill` gives them the catalog and loader; the merged catalog also
# carries whatever the deployment registered globally (repository plugins).
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'

# ── goals ───────────────────────────────────────────────────────────────────

# The goal service and session driver stay on the host plane, where the Gateway
# can resolve them. The human command and model-facing tool register into this
# preset's scoped layers.
- id: command-goal
  name: '@deepseek-ai/dsh-command-goal'

- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

# ── plan mode ───────────────────────────────────────────────────────────────

# Plan state is per-agent by nature, so an entry-local realm is not a
# workaround here — it is the correct lifetime.
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config:
        section: |
              You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

              Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

              The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

              Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

              Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

              When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.

# ── compaction ──────────────────────────────────────────────────────────────

# `compaction-basic` reads `toolResultPrune` through `ctx.get`, so the pruner must
# share this realm rather than sit outside it.
#
# `tokenMeter` is deliberately NOT in this realm: the meter stays on the HOST
# plane, and the rows here resolve that one instance. It takes no configuration,
# keys every fold by Session, and owns the context-meter projection units the
# browser reads for every session — behind a realm those units would come and go
# with whichever presets happen to be mounted. What a preset chooses is whether
# its agent compacts at all, which is `compaction-basic` below.
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024

# ── delegation and workflows ────────────────────────────────────────────────

# The `subagents` registry and its spawn/fork backends live in the HOST
# composition: the registry is a process singleton whose cross-session queries
# the api-proxy serves to the browser, and a provider name may only be
# registered once. This preset contributes the delegation TOOLS, which resolve
# that host registry.
#
# `workflows` is different — nothing outside an agent reads it — so every row
# that reaches it shares one entry-local realm here, and a consumer left
# outside would resolve a host registry this preset does not populate.
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'

    - id: tool-subagent-list-agents
      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        modelSelectionSettings: true
        backgroundMode: continuable

    # Fork omits model selection so provider/model stay equal to the parent and
    # the inherited history remains eligible for KV Cache reuse. This preset
    # keeps fork continuable; parent and child inherit the same messaging tool,
    # while the parent id and return guidance follow the inherited history.
    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable

    # Production dsh does not install these optional providers. Install the
    # matching Bundle in this Profile and restart the Host, then copy this
    # preset and remove `disabled` from the matching tool row. Host availability
    # alone grants no tool.
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: codex
        toolName: subagent_codex
        backgroundMode: one-shot
        maxDepth: provider-managed

    - id: tool-subagent-claude-code
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: claude-code
        toolName: subagent_claude_code
        backgroundMode: one-shot
        maxDepth: provider-managed

    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      config:
        provider: spawn

    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'

    - id: tool-ralph
      name: '@deepseek-ai/dsh-tool-ralph'
      config:
        subagentProvider: spawn
        maxRounds: 64

# ── remaining model-facing rows ─────────────────────────────────────────────

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

# The `web` service and its search provider stay in the host composition; only
# the model-facing tool is per-session.
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000

- id: present
  name: '@deepseek-ai/dsh-tool-present'
```

### 1c. The user-authored preset (proves the user root works)

`E:\Home\.dsh\.agent-presets\bare-standard\preset.yml`:

```yaml
name: 裸标准
description: 标准模式去掉内置编排：无 workflow、ralph、目标与计划模式；工作流规范由挂载的 Skill 提供。
```

`...\bare-standard\agent.cordis.yml` is 243 lines: a copy of `standard` with the `workflow-worker-thread` + `tool-workflow` + `tool-ralph` + `command-goal` + `tool-goal` + planning group deleted, and `planning`/`modelSelectionSettings` removed. It is mounted and selected: `settings.yaml` has `agent-presets: { default: bare-standard }`, and **this very session** announces `bare-standard`.

### 1d. `preset.yml` metadata, all four shipped presets

`preset.yml` is display metadata only: `name`, `description`, and (shipped only) `order`.

```yaml
# minimal\preset.yml
name: 极简模式
description: 仅提供持久 shell 的单工具编码 Agent。
order: 3
```
```yaml
# standard\preset.yml
name: 标准模式
description: 功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。
order: 1
```
```yaml
# cordis\preset.yml
name: 创造模式
description: 用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。
order: 4
```
```yaml
# ptc\preset.yml
name: PTC 模式
description: 功能完整的编码 Agent，但默认不提供 workflow 工具；其他工具通过 PTC 模式 SDK 呈现，让模型用一个 TypeScript 程序组合多步操作。
order: 2
```

Filename constants (`dsh-agent-presets/lib/index.js`): `COMPOSITION_FILE = "agent.cordis.yml"` (line 182), `METADATA_FILE = "preset.yml"` (line 36), `SHIPPED_PRESET_ROOT` (line 203), `SETTINGS_NAMESPACE = "agent-presets"` (line 1145).

### 1e. A real host-composition patch layer (`cordis.patch.yml`)

`E:\Home\.dsh\profiles\web\cordis.patch.yml` (8 lines, verbatim):

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
- id: disclosure-policy
  config:
    reminderAfterCalls: 12
- id: permission-rules
  disabled: true
```

This is the model for "disable a row" and "change a row's config".

### 1f. The host composition itself

`E:\Home\.dsh\profiles\web\package.json` (27 lines, verbatim):

```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@linxin666/dsh-client-ui-skill-explorer": "^0.3.23",
    "dsh-better-reasoning-effort": "^0.3.10",
    "dsh-context": "^0.53.3",
    "dsh-disclosure-policy": "github:NoneMore/dsh-disclosure-policy#8836381201fae0e9b3f4b8afa9efeffb711dbb99",
    "dsh-permission-rules": "^0.7.2",
    "dshmarket": "^1.47.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dshmarket",
        "@linxin666/dsh-client-ui-skill-explorer",
        "dsh-context",
        "dsh-better-reasoning-effort",
        "dsh-disclosure-policy",
        "dsh-permission-rules"
      ],
      "patchReload": "live"
    }
  }
}
```

`@deepseek-ai/dsh-base/cordis.patch.yml` and `@deepseek-ai/dsh-web-app/cordis.patch.yml` are the real host composition (≈100 + ≈80 rows). The web-app layer ends with:

```yaml
- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard
```

and disables every agent-plane row it moved to presets (`tool-bash`, `tool-pwsh`, `tool-jobs`, `tool-fs`, `tool-fs-search`, `skill-filesystem`, `tool-skill`, `command-goal`, `tool-goal`, `plan-mode`, `compaction-basic`, `command-compact`, `tool-result-pruner`, `tool-subagent*`, `workflow-worker-thread`, `tool-workflow`, `tool-ralph`, `agent-instructions`, `tool-todo`, `tool-web`) with the comment *"Disabling rather than deleting is deliberate: the base is shared, and a row absent from a surface overlay would silently reappear the day someone reorders the composition."*

---

## 2. Where a new local plugin mounts

Facts established:

* A **bundle** is any installed dependency whose `package.json` declares `dsh.bundle.patch`. Only bundles become patch layers (`app-boot/lib/index.js:849-852`): a listed bundle without that declaration **fails startup loudly**: `profile bundle X declares no dsh.bundle in its package.json`.
* Bundles resolve **install anchor first, then the profile's own `node_modules`** (`resolveBundleDir`, lines 826-832). If neither resolves: `cannot resolve profile bundle X from the dsh installation or <profileDir>; run 'dsh plugin --profile <name> install' if its dependency is not installed`.
* Preset rows resolve bare package names from the **harness base**, or accept an absolute path / `file:` URL directly (§1).

### (a) A row in a user agent preset — `E:\Home\.dsh\.agent-presets\<id>\agent.cordis.yml`

Exact row syntax (package installed into the profile closure):

```yaml
- id: context-sense
  name: '@deepseek-ai/dsh-context-sense'
```

Exact row syntax (no packaging at all — absolute path; `classifyRowSpecifier` turns it into a `file:` URL):

```yaml
- id: context-sense
  name: 'E:/Home/projects/dsh-context-sense/lib/index.js'
```

* **Build step:** yes, in practice — the `name` must point at loadable ESM. Either ship `lib/index.js` (build it) or point at the source entry and accept whatever module syntax Node's ESM loader can read.
* **Constraint:** this is the **agent plane**. A row that publishes a service needs a `cordis:group` + `isolate` realm, or the mount is rejected (see §1). Cross-session/host-plane capabilities cannot live here.
* **No file in the preset registry needs registering** — the roster scans `$DSH_HOME/.agent-presets` on every `list()` (`includeUserRoot`, default `true`).
* **Validation:** the roster's `standingKeyFor(id)` performs a real mount, and rejects exactly four shapes (unresolvable package / invalid config / row that never activated / service published into the root realm). The `editing-cordis-compositions` skill is the procedure for this; it also warns: the user preset root is outside the session workspace, so **the first write there is denied under `workspace-write`** and needs one escalation.

### (b) The host composition — do not edit the shipped patches

Editable files, in precedence order:

1. `E:\Home\.dsh\profiles\web\cordis.patch.yml` — **the** user layer for this profile.
2. `E:\Home\.dsh\cordis.patch.yml` — home-level, outranks (1). **Absent here**; creating it applies to every profile.
3. Any `--patch <file>` overlay on the command line.

Exact syntax to add a row into the tree without touching its own package:

```yaml
- insert:
    - id: context-sense
      name: 'dsh-context-sense'
      config: {}
```

Do **not** edit `node_modules\@deepseek-ai\dsh-base\cordis.patch.yml` or `...\dsh-web-app\cordis.patch.yml` — they are the deployment's own bundle layers and a package update overwrites them.

* **Build step:** the named module must resolve; for a package name that means it must be installed (§c).

### (c) Install into a profile / `node_modules` — the documented path for an out-of-tree plugin

```powershell
dsh plugin --profile web add link:E:\Home\projects\dsh-context-sense
```

* Prerequisite: the package declares `dsh.bundle.patch`, or it installs as a **plain library** and DSH warns and mounts nothing. Verbatim from `lib/plugin-Ddi42qoW.js:57`:
  `dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)`
* `reconcilePlugins` then appends the package to `dsh.profile.bundles` in `E:\Home\.dsh\profiles\web\package.json` **only if** `dsh.bundle.patch` is present (lines 46-78). Reconcile is by installed state, not by dependency diff.
* Package must ship a `cordis.patch.yml` and reference it as `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`.
* **Build step: yes.** `lib/index.js` (or whatever `main`/`exports` names) must exist before install; the `files` array must include it and `cordis.patch.yml`.
* Relative specs are re-anchored against your invoking directory (`anchorPathSpec`, lines 90-94), so `dsh plugin --profile web add link:.` from the plugin checkout does the right thing instead of self-linking the profile.
* git-hosted specs build via `prepare`, which pnpm blocks until allowed: add the exact key pnpm prints under `allowBuilds` in `E:\Home\.dsh\profiles\web\pnpm-workspace.yaml`.
* That file currently reads:

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
minimumReleaseAgeExclude:
  - '@linxin666/dsh-client-ui-skill-explorer@0.3.20 || 0.3.21 || 0.3.22 || 0.3.23'
  - dsh-context@0.49.1 || 0.52.1 || 0.52.2 || 0.53.0 || 0.53.2 || 0.53.3
  - dshmarket@1.46.0 || 1.47.0
```

### (d) `dsh plugin` CLI

It is **not** a plugin registry — it is a thin pnpm forwarder plus a bundle-list reconciler, documented at `lib/plugin-Ddi42qoW.js:6-17`:

> `dsh plugin --profile <name> <args...>` — profile plugin management as a thin pnpm forwarder: initialize the profile on first use, run `pnpm <args...>` in the profile directory, then reconcile the `dsh.profile.bundles` layer list against the installed state.

See §3 for the observed grammar.

### Recommendation summary

| Goal | Mechanism | Exact artifact | Build step |
|---|---|---|---|
| Give **one agent** a new tool/prompt section, host services already exist | user preset row | `E:\Home\.dsh\.agent-presets\<id>\agent.cordis.yml` | yes (loadable ESM) |
| Add a **host-plane** capability (service, cross-session) | profile patch layer row | `E:\Home\.dsh\profiles\web\cordis.patch.yml` (+ `insert`) | yes |
| Ship a **reusable, self-describing** plugin | bundle package installed into the profile | `dsh plugin --profile web add link:<repo>` + `dsh.bundle.patch` | yes |
| Try it **without packaging** | absolute-path row | `name: 'E:/Home/projects/dsh-context-sense/lib/index.js'` | yes |
| Preview the composition without booting | `dsh --profile web --dump-config` | — | — |

---

## 3. `dsh` CLI plugin commands

### Commands actually run (all read-only)

`dsh --help`:

```
Usage: dsh [options] [command] [args...]

dsh: boot a DeepSeek Harness profile — an ordered stack of plugin-bundle patch
layers under your own overrides.

Arguments:
  args                           arguments for the booted profile's app (see:
                                 dsh --profile <name> --help)

Options:
  -V, --version                  output the version number
  --profile <name>               the profile under $DSH_HOME/profiles to boot
  --from-default-profile <name>  initialize a new custom profile from a shipped
                                 profile template
  --patch <path>                 extra patch-list overlay applied after the
                                 profile layer (repeatable)
  --dump-config                  print the composed profile tree and exit
  --dump-default-config          print the profile tree without its user layer
                                 or --patch overlays and exit

Commands:
  web [options] [args...]        boot the web profile (alias of --profile web);
                                 the web app's own flags follow
  plugin [options] [args...]     manage a profile's plugins by forwarding the
                                 remaining arguments to pnpm in the profile
                                 directory

Examples:
  dsh --profile web                          boot the web profile (same as: dsh web)
  dsh --profile rescue --from-default-profile web
                                             create rescue from the shipped web template, then boot it
  dsh --profile headless "run the tests"     answer one task, print the result, and exit
  dsh --profile tui --patch ./extra.yml      boot a custom profile with one extra overlay
  dsh --profile tui --resume <session>       arguments after the launcher flags reach the app
  dsh --profile web --help                   the web app's own flags and help
  dsh plugin --profile tui add <package>     install a plugin into the tui profile
```

`dsh --version` → `0.1.5-rc.1`

`dsh plugin --help` → **exit 1**:

```
error: required option '--profile <name>' not specified
```

### Grammar, from `lib/bin.js:105-116` (authoritative, matches the observed error)

```js
const plugin = program.command("plugin")
  .description("manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory")
plugin.requiredOption("--profile <name>", "the profile whose plugins to manage (initialized on first use)")
      .allowUnknownOption()
      .argument("[args...]", "pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)")
```

* `--profile <name>` is **required**.
* Exactly one declared option. Everything else is forwarded verbatim to `pnpm`.
* `args.length === 0` → `error: plugin needs pnpm arguments to forward (e.g. add <package>)`.
* Profile `desktop` is rejected: `error: profile "desktop" is managed exclusively by the Electron application`.
* Parent options supplied before the subcommand are rejected: `error: plugin takes none of parent --profile, --from-default-profile, --patch, --dump-config, or --dump-default-config` (so the correct order is `dsh plugin --profile web add X`, never `dsh --profile web plugin add X`).
* **There is no `list` / `install` / `add` / `remove` subcommand of `dsh` itself.** `add`, `remove`, `why`, `list`, `update`, `install` are **pnpm** commands that happen to be forwarded. `dsh plugin --profile web list` forwards to `pnpm list` in the profile dir.
* There is **no `dsh dev` command**.
* `dsh plugin --profile web --help` would forward `--help` to pnpm; I did **not** run it. Reason: `runPlugin` calls `reconcilePlugins(before, dir)` on exit 0, which can rewrite `E:\Home\.dsh\profiles\web\package.json`. It is very likely a no-op here (all six deps already appear in `bundles`), but "very likely" is not "guaranteed read-only", so I skipped it per the brief. The commander definition above gives the same information with certainty.

---

## 4. Package shape required for a DSH plugin

### The `dsh` manifest key — official field list

From `@deepseek-ai/dsh-package-manifest/README.md:40`:

> `DshManifest` describes `bundle`, `profile`, `client`, `configTrees`, `sessionFormatMigration`, and `moduleFallback`, not the surrounding npm manifest. `moduleFallback` is launcher-generated metadata and is not an author configuration entry.

**There is no `cordis` key in any installed `package.json`.** I grepped all of `E:\Home\.dsh\profiles\web\node_modules\**\package.json` for `"cordis":` — zero matches (the only hits were the word `cordis` inside `keywords` arrays). `cordis.yml` / `cordis.patch.yml` are **filenames**; `cordis:group` / `cordis:include` are **loader builtins**.

Real `dsh` keys observed:

| Key | Declared by | Example |
|---|---|---|
| `dsh.bundle.patch` | a plugin package | `{ "bundle": { "patch": "./cordis.patch.yml" } }` |
| `dsh.client.platform` / `.inject` | a plugin with a browser half | `{ "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale"] } }` |
| `dsh.engines.dsh` | a third-party plugin | `{ "engines": { "dsh": ">=0.1.5-rc.1" } }` |
| `dsh.compatibility.dshReleases` | a third-party plugin | `{ "dshReleases": { "0.1.5-rc.1": "compatible" } }` |
| `dsh.profile.bundles` / `.patchReload` | a **profile** | `{ "profile": { "bundles": [...], "patchReload": "live" } }` |
| `dsh.configTrees` | the DSH CLI (image packer; inert here) | see §0 |

### Versions that plugins peer-depend on (installed)

| Package | Installed version | Peer range used by plugins |
|---|---|---|
| `@deepseek-ai/cordis` | **4.0.2** | `^4.0.2` (all first-party); third parties use `^4.0.1` … `>=4.0.0-rc.7 <5` |
| `@deepseek-ai/schemastery` | **3.18.2** | `^3.18.2` (a few use `^3.18.0` / `^3.18.1`) |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.3 | — |
| `@deepseek-ai/cordis-plugin-include` | 1.0.7 | — |
| `@deepseek-ai/cordis-plugin-group` | 1.0.2 | — |
| `@deepseek-ai/cordis-plugin-hmr` | 1.0.17 | — |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.4 | — |

Note the version skew: the CLI is `0.1.5-rc.1`; the plugin/preset packages installed into the profile are `0.1.5-rc.2`.

### `package.json` — `@deepseek-ai/dsh-time-context` (verbatim)

`E:\Home\.dsh\profiles\node_modules\@deepseek-ai\dsh-time-context\package.json`

```json
{
  "name": "@deepseek-ai/dsh-time-context",
  "description": "Opt-in durable per-step context with the current time and elapsed time",
  "version": "0.1.5-rc.2",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/context/time-context"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/invariant.js", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "dependencies": {
    "zod": "^4.4.3",
    "@deepseek-ai/dsh-util-values": "^0.1.5-rc.2",
    "@deepseek-ai/schemastery": "^3.18.2"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-invariants": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-llm": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session-projection": "^0.1.5-rc.2"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-agent-loop": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-agent-loop-testkit": "^0.1.5-rc.2",
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-llm": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-loader-smoke": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-bash-local": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-app-boot": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session-checkpoint-policy": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session-persistence-jsonl": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-subprocess-local": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-invariants": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session-projection": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-system-prompt": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.2"
  }
}
```

Two things to note: it declares **no `dsh` key at all** (it is an opt-in plugin mounted by naming it in a composition, not a bundle), and the `files` array excludes `src/` and any tests.

### `package.json` — `@deepseek-ai/dsh-repeat-tool-reminder` (verbatim)

`E:\Home\.dsh\profiles\node_modules\@deepseek-ai\dsh-repeat-tool-reminder\package.json`

```json
{
  "name": "@deepseek-ai/dsh-repeat-tool-reminder",
  "description": "Repeat-tool-call guard plugin: advisory reminders when an agent loops on identical tool calls",
  "version": "0.1.5-rc.2",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/deepseek-ai/deepseek-harness.git",
    "directory": "packages/guard/repeat-tool-reminder"
  },
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/types/**/*.d.ts"],
  "license": "MIT",
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.2" },
  "peerDependencies": {
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.2",
    "@deepseek-ai/cordis": "^4.0.2"
  },
  "devDependencies": {
    "@deepseek-ai/dsh-agent": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-agent-loop": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-agent-loop-testkit": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-llm": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-session": "^0.1.5-rc.2",
    "@deepseek-ai/dsh-tools": "^0.1.5-rc.2",
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-session-projection": "^0.1.5-rc.2"
  }
}
```

`dsh-repeat-tool-reminder` **is** mounted by default — the base host composition carries:

```yaml
    # Consecutive-repeat reminders on the tool chain.
    - id: repeat-tool-reminder
      name: '@deepseek-ai/dsh-repeat-tool-reminder'
      config:
        thresholds: [3, 5, 8]
        argumentsPreviewChars: 500
```

This is the closest structural model in the tree for "a small plugin with a config schema and an event listener, mounted host-side by id".

Contrast: `dsh-time-context` is installed but **not named by any shipped patch layer** — grep for `dsh-time-context` across `E:\Home\.dsh\profiles\node_modules\@deepseek-ai\**\*.yml` → no matches. Installed ≠ mounted. That is the single most important packaging lesson here.

### `package.json` — a real third-party bundle plugin (`dsh-disclosure-policy`, verbatim, trimmed to the manifest)

`E:\Home\.dsh\profiles\web\node_modules\dsh-disclosure-policy\package.json`

```json
{
  "name": "dsh-disclosure-policy",
  "version": "0.4.0",
  "type": "module",
  "main": "./lib/index.js",
  "types": "./lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./policy": { "types": "./lib/policy.d.ts", "default": "./lib/policy.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib/**/*.js", "lib/**/*.d.ts", "cordis.patch.yml", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "docs"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "node --test test/*.test.mjs",
    "check": "npm run typecheck && npm test",
    "prepack": "npm run build"
  },
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "dependencies": { "@deepseek-ai/schemastery": "^3.18.0" },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.0-rc.7 <5",
    "@deepseek-ai/dsh-agent": ">=0.1.5-rc.2 <0.2.0",
    "@deepseek-ai/dsh-llm": ">=0.1.5-rc.2 <0.2.0",
    "@deepseek-ai/dsh-session": ">=0.1.5-rc.2 <0.2.0",
    "@deepseek-ai/dsh-system-prompt": ">=0.1.5-rc.2 <0.2.0",
    "@deepseek-ai/dsh-tools": ">=0.1.5-rc.2 <0.2.0"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/cordis": { "optional": true },
    "@deepseek-ai/dsh-agent": { "optional": true },
    "@deepseek-ai/dsh-llm": { "optional": true },
    "@deepseek-ai/dsh-session": { "optional": true },
    "@deepseek-ai/dsh-system-prompt": { "optional": true },
    "@deepseek-ai/dsh-tools": { "optional": true }
  },
  "license": "MIT"
}
```

Its bundle patch (`dsh-disclosure-policy\cordis.patch.yml`, verbatim):

```yaml
- insert:
    - id: disclosure-policy
      name: dsh-disclosure-policy
      config:
        reminderAfterCalls: 8
        maxReminders: 3
```

That is the minimal shape of a mountable third-party plugin: **a `type: module` package with a `main`/`exports` ESM entry, a `cordis.patch.yml` that inserts one row naming the package, and `dsh.bundle.patch` pointing at it.**

Its client-half sibling shows the browser declaration (`dsh-context\package.json`):

```json
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-sidebar-right"
      ],
      "platform": "web"
    },
    "compatibility": {
      "dshReleases": {
        "0.1.2-rc.1": "compatible",
        "0.1.3-alpha.2": "compatible",
        "0.1.5-rc.1": "compatible"
      }
    }
  },
```

and its patch comment states the two-half rule:

```yaml
# Bundle patch layer: the row loads the package's main entry as the host half
# (a plain Cordis plugin); the `dsh.client` declaration makes the web app load
# its ./client bundle as the browser half.
- insert:
    - id: dsh-context
      name: dsh-context
```

### `package.json` — the DSH CLI itself

`E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\package.json`. Key shape:

```json
{
  "name": "@deepseek-ai/dsh",
  "description": "dsh CLI: profile boot, plugin management, and the browser UI alias",
  "version": "0.1.5-rc.1",
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "git+https://github.com/deepseek-ai/deepseek-harness.git", "directory": "apps/cli" },
  "type": "module",
  "bin": { "dsh": "lib/bin.js" },
  "files": ["lib/*.js"],
  "dsh": {
    "configTrees": [
      { "mount": "config/agent-presets", "path": "../../packages/preset/agent-presets/presets", "scanRoster": true }
    ]
  },
  "license": "MIT",
  "dependencies": {
    "commander": "^15.0.0",
    "js-yaml": "^4.2.0",
    "node-addon-require-builtin": "^0.1.4",
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/cordis-plugin-hmr": "^1.0.17",
    "@deepseek-ai/cordis-plugin-include": "^1.0.7",
    "@deepseek-ai/cordis-plugin-loader": "^1.0.3",
    "@deepseek-ai/cordis-plugin-timer": "^1.1.4",
    "@deepseek-ai/schemastery": "^3.18.2",
    ... ~60 more @deepseek-ai/dsh-* rows ...
  },
  "devDependencies": {
    "@deepseek-ai/dsh-agent-loop-testkit": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-llm-mock-server": "^0.1.5-rc.1",
    "@deepseek-ai/dsh-loader-smoke": "^0.1.5-rc.1",
    ... test-support and optional bundles ...
  }
}
```

The three test toolkits appear **only** under `devDependencies` — which is exactly why none of them is installed.

---

## 5. Development loop

### There is no `dsh dev` command

The full command surface is `--profile`, `--from-default-profile`, `--patch`, `--dump-config`, `--dump-default-config`, `web`, `plugin` (§3). Nothing else.

### The fastest edit → observe loop, in order of latency

**Tier 1 — composition change, live, no restart (this is the big one).**

`E:\Home\.dsh\profiles\web\package.json` sets `"patchReload": "live"`. `runProfile` therefore installs the HMR plugin if absent and starts watchers on **both user patch files** (`lib/profile-boot-Dk-7KqJc.js:321-341`):

```js
if (composed.profile.patchReload === "live" && !signalShutdown.signal.aborted && …) try {
  if (ctx.get("hmr") === void 0) {
    if (ctx.get("timer") === void 0) await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-timer" });
    await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-hmr", config: { root: [] } });
  }
  await watchUserPatches(ctx, { binName: NAME, filename: composed.profile.patchPath, compose: composeLive });
  await watchUserPatches(ctx, { binName: NAME, filename: homePatchPath(), compose: composeLive });
} catch (error) { … }
```

`dsh-app-boot/README.md:57` states the contract:

> Profiles with `patchReload: live` watch both user patch files: a valid edit recomposes without restart, while a rejected edit leaves the last good app running. A `startup` profile installs neither those watchers nor the launcher's watch-only HMR fallback.

So: edit `E:\Home\.dsh\profiles\web\cordis.patch.yml`, save, and the running host recomposes. **Caveat I verified in the code:** `composeLive()` re-reads only `composed.profile.patchPath` and `homePatchPath()`; `composed.bundlePatches` are reused from the boot-time snapshot:

```js
const composeLive = () => structuredClone([
  ...composed.bundlePatches,                                        // ← frozen at boot
  ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],   // ← re-read
  ...loadOptionalPatches(NAME, homePatchPath()) ?? [],              // ← re-read
  ...composed.overlays
]);
```

Therefore **editing an installed plugin's own `cordis.patch.yml` does not hot-reload** — only the profile's and the home's patch files do. To iterate on a row that an installed bundle owns, restate it in `profiles\web\cordis.patch.yml` (a later layer wins).

**Tier 2 — plugin source change, live, needs the `hmr` row.**

`dsh-base/cordis.patch.yml` carries it **disabled**:

```yaml
    # Module reload is opt-in per profile. `patchReload: live` config watching
    # uses the launcher's watch-only fallback and does not require this row.
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      disabled: true
      config:
        root: ['.']
```

`cordis-plugin-hmr/README.md` documents the fix (note: its example still uses the upstream `@cordisjs/*` names; the installed package is `@deepseek-ai/cordis-plugin-hmr`):

```yaml
- id: hmr
  name: '@cordisjs/plugin-hmr'
  config:
    root:
      - src
    ignored:
      - '**/node_modules'
      - '**/.*'
    debounce: 100
```

> The HMR plugin watches source files, traces Node's module graph, clears affected module caches, and reloads only the plugin entries that depend on changed application files. Changes to framework-level dependencies fall back to `loader.exit()`, letting the host process restart.

So `disabled: false` + `root: ['E:/Home/projects/dsh-context-sense/lib']` in the profile patch gives live host-half reloads. The launcher's watch-only fallback (`root: []`) deliberately watches **no** modules.

**Tier 3 — browser (client-half) change, live.**

The `dsh-client-hmr` row is always mounted by the web-app bundle:

```yaml
    # The client-plugin reload chain, always mounted: it is idle until a
    # rebuild watcher (pnpm run dev:web) actually rewrites client bundles.
    - id: client-hmr
      name: '@deepseek-ai/dsh-client-hmr'
```

`dsh-client-hmr/README.md:12,32`:

> The reload chain stays idle without a rebuild watcher: only a `pnpm run dev:web`-style process rewriting client bundles produces the rebuilds it reacts to.
> Run `pnpm run dev:web` (or any tsdown watch process that writes the plugin's `lib/client.js`) against the same host; rebuilt plugins are then swapped into the running browser automatically, one at a time.

Config: single field `pollIntervalMs`, default `500`. A failed reload is visible and retried on the next rebuild; there is **no rollback**. React state inside the reloaded plugin is lost.

Note: `pnpm run dev:web` is a **repository** script (the DSH source checkout), not something present in this installed deployment.

**Tier 4 — restart.** Required for: a newly installed package (bundle layers are read at boot), an edited installed bundle patch, and any `startup` profile.

### Previewing before you commit to a restart

```powershell
dsh --profile web --dump-config           # bundles + profile layer + home layer (+ --patch)
dsh --profile web --dump-default-config   # bundles only, no user layer (recovery diagnostic)
dsh --profile web --patch ./extra.yml --dump-config
```

`dump-config-lFgMwK8i.js` renders through the *same* `applyEntryPatches` the boot uses, "so a dump can never drift from what boots", with `# ==` comments naming each contributing file and `!!js` printed verbatim.

### Useful verbatim README excerpts

`E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\README.md`:

> ## Development
>
> Production runs require built package and frontend artifacts. From the repository root, run `pnpm run build` separately, then use `pnpm dsh <args...>` to run the TypeScript entry and forward every argument; the [source-execution reference](reference/README.md#source-execution) owns the module-resolution contract.

> ## Profiles
>
> A profile directory holds a `package.json` (out-of-tree plugin dependencies plus the profile manifest `dsh.profile` with its ordered `bundles` list and `patchReload` lifecycle) and a `cordis.patch.yml` (the user's own patch layer). `patchReload: live` watches the profile and home-level patch files; `startup` applies them once.

> Bundles named in `dsh.profile.bundles` resolve from the dsh installation first (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@deepseek-ai/dsh-headless`, `@deepseek-ai/dsh-sdk-app`, `@deepseek-ai/dsh-sdk-minimal`, `@deepseek-ai/dsh-acp-app`), then from the profile's own `node_modules`, where pnpm installs out-of-tree plugins.

The linked `reference/README.md` is **not shipped** in this install (no `reference/` directory exists under `...\@deepseek-ai\dsh\`). Neither is `config/`, `docs/`, or `config/examples/` — the published `files` array is `["lib/*.js"]`.

**Recommended loop for `E:\Home\projects\dsh-context-sense`:**

1. Point a row at the built entry and iterate config in `profiles\web\cordis.patch.yml` (live, no restart):
   ```yaml
   - insert:
       - id: context-sense
         name: 'file:///E:/Home/projects/dsh-context-sense/lib/index.js'
   ```
2. Add `hmr` with `disabled: false` and `root: ['E:/Home/projects/dsh-context-sense/lib']` in the same file for source-level reloads.
3. For the browser half, run a `tsdown --watch` writing `lib/client.js` (the package's own `watch`/`dev` script); `dsh-client-hmr` picks it up.
4. Before each restart, `dsh --profile web --dump-config` to confirm the composition.

---

## 6. Tests

### Do the shipped packages contain tests? **No.**

* No installed `@deepseek-ai` package directory contains a `test/` or `tests/` directory (checked by enumerating every directory under `E:\Home\.dsh\profiles\node_modules\@deepseek-ai`).
* `dsh-repeat-tool-reminder` installed contents, in full: `lib/`, `lib/index.js`, `lib/types/index.d.ts`, `LICENSE`, `package.json`, `README.i18n.yaml`, `README.md`, `README.zh.md`. `dsh-time-context` likewise (plus `lib/invariant.js`, `lib/types/{invariant,request-zone,timestamp}.d.ts`).
* The `files` arrays confirm the intent — e.g. `dsh-repeat-tool-reminder`: `["lib/index.js", "lib/types/**/*.d.ts"]`. Tests are simply not published.
* The third-party `dsh-disclosure-policy` declares `"test": "node --test test/*.test.mjs"` but its `files` array omits `test`, and the installed tree has no `test` dir — same story.

### The three toolkits: real, published, but not installed here

| Package | Installed here? | Where it comes from | Purpose |
|---|---|---|---|
| `@deepseek-ai/dsh-loader-smoke` | **No** | `packages/test-support/loader-smoke` | boot a real Loader composition from a real bin + `cordis.yml` in an isolated temp dir |
| `@deepseek-ai/dsh-agent-loop-testkit` | **No** | `packages/test-support/agent-loop-testkit` | mount the agent-loop prerequisite spine + drive a production Agent |
| `@deepseek-ai/dsh-llm-mock-server` | **No** | `packages/test-support/llm-mock-server` | scriptable OpenAI-compatible fault server, no provider key |

Verified absent (`Test-Path` → `False`) in all six candidate locations:
`E:\Home\.dsh\profiles\node_modules\@deepseek-ai\<name>` and `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\<name>`.

They are reachable only as `devDependencies` of the source repo / published packages:
* `@deepseek-ai/dsh` CLI `devDependencies` lists all three at `^0.1.5-rc.1`.
* `@deepseek-ai/dsh-time-context` `devDependencies` lists `@deepseek-ai/dsh-agent-loop-testkit: ^0.1.5-rc.2` and `@deepseek-ai/dsh-loader-smoke: ^0.1.5-rc.2`.
* `@deepseek-ai/dsh-repeat-tool-reminder` `devDependencies` lists `@deepseek-ai/dsh-agent-loop-testkit: ^0.1.5-rc.2`.

`@deepseek-ai/dsh-loader-smoke` **is published publicly** — registry metadata (fetched this session) shows `publishConfig.access: "public"` from `0.1.0-rc.6` onward, with versions up to `0.1.6-alpha.2`. ⚠️ **`dist-tags.latest` is `0.0.1-rc.1`**, an ancient `restricted` build; `dist-tags.next` is `0.1.5-rc.2`. A bare `npm i @deepseek-ai/dsh-loader-smoke` would install the wrong one — pin explicitly. `dsh-agent-loop-testkit` and `dsh-llm-mock-server` are likewise published ([Snyk listing](https://security.snyk.io/package/npm/%252540deepseek-ai%25252Fdsh-agent-loop-testkit), [repo source](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/test-support/llm-mock-server/README.md)). I could not confirm exact `latest` tags for those two: `npm view` is blocked in this session (`EPERM` writing `%LOCALAPPDATA%\npm-cache\_cacache\tmp\…`, outside the workspace sandbox), and I did not retry it.

### How a plugin test is structured — three tiers, with the real API

**(1) Unit / structural — no Loader at all.** Two live examples of this style in installed third-party plugins:
* `dsh-disclosure-policy`: `"test": "node --test test/*.test.mjs"` — plain `node:test`, no framework.
* `dsh-context`, `dsh-permission-rules`, `dshmarket`, `dsh-better-reasoning-effort`, `@linxin666/dsh-client-ui-skill-explorer`: `"test": "vitest run"`, with `jsdom` for client halves.

**(2) Agent-loop integration — `mountAgentLoopTestHarness()`.** From `@deepseek-ai/dsh-agent-loop-testkit` (README fetched from the public repo; the package is the one `dsh-time-context` and `dsh-repeat-tool-reminder` both dev-depend on). Verbatim:

```ts
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'

const ctx = new Context()

await mountAgentLoopTestDependencies(ctx)
// Register the test adapter and any load-order-sensitive plugins here.
const harness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId('test-agent'))
declare const message: UserMessage

agent.inbox.append('next-turn', message)
const admitted = harness.claim(agent, 'next-turn', 1)
```

Contract details from the same README:
* `mountAgentLoopTestDependencies` mounts six service plugins in a fixed order — LLM, session, session-projection registry, system-prompt registry, tool registry, agent registry — and **stops before `AgentLoop`**, so the caller controls loop load order.
* `mountAgentLoopTestHarness` mounts the production plugin and exposes the production driver's `claim` operation.
* *"The harness mounts no LLM adapter. Register an adapter before sending work that would start a model request."*
* *"Dispose the owning context after every test so Agents reach quiescence and their scoped registrations unwind."*
* `createInboxStub()` — process-local mutable stub for consumer tests that only edit the queue; `unsupportedInbox()` — every mutation throws, for tests that must not touch pending input.

**(3) Whole-composition smoke — `runLoaderSmoke`.** From `@deepseek-ai/dsh-loader-smoke`. Verbatim:

```text
const result = await runLoaderSmoke({
  label: 'acp-agent',
  tempDirPrefix: 'acp-smoke-',
  binScript: '/abs/path/to/src/bin.ts',
  configPath: '/abs/path/to/cordis.yml',
  tsconfigPath: '/abs/path/to/tsconfig.json',
})
```

> The harness creates a temporary cwd (or reuses a caller-provided one), prepares world state there, spawns the resolved bin with isolated DSH homes (`DSH_HOME`, `DSH_AGENTS_HOME` under that cwd), closes stdin immediately, and awaits a clean exit within the deadline before inspecting on every outcome and removing only a cwd it created.

Also exported: `runFixtureTurn(ctx, options)` — in-process; drives one task through the composition's single root agent, follows it from durable inbox receipt to whole-agent idle, sums per-step usage, flushes the session, returns final assistant text + usage. `resolveExampleLaunch` picks `src` mode (tsx + `TSX_TSCONFIG_PATH`) or `lib` mode (built `lib/` under plain Node) from `DSH_EXAMPLE_MODE` (`CI` sets `lib`).

Repository-only helper (not published, so **not imitable from here**): `tests/fixtures/production-profile.ts` — loads a shipped profile via `loadProfile`, mounts `PluginPackages`, and passes `*.patch.yml` files to the root `cordis:include`; *"Those patches should contain only the test provider or model, isolated persistence paths, and subject-specific changes."*

**(4) Provider-fault coverage — `@deepseek-ai/dsh-llm-mock-server`.** Scriptable FIFO of wire behaviors, one per accepted `POST …/chat/completions`: `connection_reset`, `stream_disconnect`, `partial_disconnect`, `stall`, `empty`, `empty_body`/`stream_eof`/`partial_eof`, `malformed_json`/`malformed_event`, `rate_limit`/`server_error`/`service_unavailable`, `auth_error`/`invalid_request`/`context_overflow`/`quota_exceeded`, `success`/`slow_success`/`reasoning_success`, `tool_call_success`/`max_tokens`, `wrong_content_type`, `random`. Run standalone (`pnpm run mock:llm --port 8000 --api-key mock-key --sequence partial_disconnect,success`) and point the real adapter at it via `DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1`. The library form `startMockLlmServer` returns captured requests for assertions. Validation happens before the cursor advances, so *"a misconfigured client can burn retries without advancing the sequence."*

### Practical takeaway for `dsh-context-sense`

The in-tree test convention for a plugin like this is: pure-logic unit tests (vitest or `node:test`) plus, for anything touching the agent loop or the Loader, a devDependency on `@deepseek-ai/dsh-agent-loop-testkit` (`^0.1.5-rc.2`) and/or `@deepseek-ai/dsh-loader-smoke` (`^0.1.5-rc.2` — **pin the version, avoid `latest`**). Neither is installed in this deployment and neither can be installed read-only; no shipped package offers a test to copy, so the harness API above is the only available template.

An additional zero-dependency verification channel exists without any test framework: the roster's live mount check. `dsh-agent-presets` exports `standingKeyFor(id)` (used by the `editing-cordis-compositions` skill), which composes a preset's subtree for real and rejects the four failure shapes:

* `Cannot find package …` — a row whose package does not resolve;
* `invalid config: $.<field> missing required value` — an invalid row config;
* `N row(s) did not activate: <id>: waiting for <service>` — a row that never activated;
* `row(s) published process-global service(s) [<name>]; a preset service must sit behind an isolate realm or move to the host composition`, or `service "<name>" has been registered at <Owner>` — a service publishing into the root realm.

Note also, from the same skill: *"Do not treat the roster's `broken` field as validation"* — it is only a YAML-shape check.

---

## 7. Things I could not determine (stated explicitly)

1. **`dsh plugin --profile web --help` output** — not run; `runPlugin` can call `reconcilePlugins`, which writes `profiles\web\package.json`. Grammar was instead read from source (§3).
2. **`dsh web --help` / `dsh --profile web --help`** — not run; `prepareProfile` unconditionally rewrites `profiles\web\cordis.yml` (harmless content, but a write to `$DSH_HOME`, outside the read-only mandate).
3. **Exact npm `latest` dist-tags for `dsh-agent-loop-testkit` and `dsh-llm-mock-server`** — `npm view` blocked by the sandbox (`EPERM`, npm cache outside the workspace). `dsh-loader-smoke`'s tags were verified; the `latest`-tag trap there is real and worth generalizing.
4. **`reference/README.md`, `docs/`, `config/`, `config/examples/`** — referenced by the shipped READMEs but **not published** in this install (`files: ["lib/*.js"]`). Content was not available to quote.
5. **Which of the two identical `dsh-agent-presets` copies the running host resolves** (`…\dsh\node_modules\@deepseek-ai\…` vs `E:\Home\.dsh\profiles\node_modules\@deepseek-ai\…`) — both exist with identical `presets/` trees. `resolveBundleDir` checks the install anchor first, but the Loader's bare-module base for a row is set separately; I did not instrument the live host to settle it. Practically it does not matter: both are read-only, upgrade-owned, and the user-editable root is `E:\Home\.dsh\.agent-presets\`.
6. **No editing was performed** — nothing in `E:\Apps\nvm\v24.19.0\node_modules\` or `E:\Home\.dsh\` was created, modified, or deleted.
