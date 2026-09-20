# DSH context-window / token accounting — factual audit

Reference material inspected read-only:

- Checkout: `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\` (`@deepseek-ai/dsh` version `0.1.5-rc.1`, `package.json:4`), plus ~230 bundled packages under `.../dsh/node_modules/@deepseek-ai/`.
- Live deployment config: `E:\Home\.dsh\settings.yaml` (`DSH_HOME=E:\Home\.dsh`).

Nothing in the checkout was modified. Paths below are relative to
`E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` unless prefixed.

---

## 1. Where the context window lives

### 1.1 The type

`dsh-llm\lib\types\types.d.ts`

```ts
/** Provider-owned context capacity for one exact provider/model route. */
export interface LlmModelContext {
    /** Maximum combined request and response context in tokens. */
    contextWindow: number;
}
```
(lines 289–293)

```ts
/** Exact-route model metadata resolved by its owning adapter. */
export interface LlmResolvedModelInfo extends LlmModelInfo {
    /** Provider-owned context capacity when known. */
    context?: LlmModelContext;
    /** Adapter-configured per-request output cap materialized when callers omit one. */
    defaultMaxTokens?: number;
    ...
}
```
(lines 320–330)

Also `LlmDiscoveredModel { id; name?; contextWindow?; maxTokens? }` for endpoint interrogation
(`dsh-llm\lib\types\types.d.ts:266–275`).

### 1.2 The runtime resolution path

Capacity is **adapter-owned**, not session-owned. `dsh-token-meter\README.md:28`:

> "The estimator has no settings and adds no model-visible surface; model capacity belongs to the adapter that owns the exact provider/model route and is available through `ctx.llm.resolveModelInfo().context`."

Consumers call:

- `ctx.llm.resolveModelInfo(provider, model, signal)` → `LlmResolvedModelInfo` (`dsh-llm\lib\index.js:2055–2067` validates `context.contextWindow` is a positive integer, else throws `LlmError(..., "INVALID_MODEL_CONTEXT")`).
- `dsh-compaction-basic\lib\index.js:895` — `const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;`
- `dsh-session-reference\lib\index.js:661` — `Math.max(DEFAULT_MAX_REFERENCE_BYTES, Math.floor(info.context.contextWindow * 4 * this.config.referenceContextFraction))` (the `4` is chars-per-token).

### 1.3 Durable per-session record

`dsh-session\lib\types\types.d.ts`

```ts
/** Registration-bound metadata for one resolved model route. */
export interface RequestContext {
    provider: string;
    model: string;
    /** Maximum combined request and response context in tokens, when advertised. */
    contextWindow?: number;
    systemPromptUpdate?: SystemPromptUpdate;
}
```
(lines 217–226)

Logged as the log-only `request/context` event (line 378), emitted only when route/capacity/system-prompt mode changes
(`dsh-agent-loop\lib\index.js:1192–1201`):

```js
const contextWindow = preparedCall?.context?.contextWindow;
...
if (previousContext?.provider !== requestContext.provider || previousContext.model !== requestContext.model || previousContext.contextWindow !== requestContext.contextWindow || ...) session.append("request/context", requestContext);
```

Read back with `Session.requestContext(): RequestContext | undefined`
(`dsh-session\lib\types\index.d.ts:260`).

### 1.4 The actual numbers shipped

**DeepSeek official adapter** — `dsh-llm-deepseek\lib\index.js`:

```js
const DEFAULT_CONTEXT_WINDOW = 1e6;    // line 1392  → 1_000_000
const DEFAULT_MAX_TOKENS = 256e3;      // line 1394  →   256_000
```

`DEFAULT_MODELS` (lines 1841–1871) — **all four models use `contextWindow: DEFAULT_CONTEXT_WINDOW` (1,000,000)**:

| model id | name | contextWindow | maxTokens | modalities |
|---|---|---|---|---|
| `deepseek-flash` | DeepSeek-V41-Flash | 1e6 | inherits 256e3 | text, image |
| `deepseek-v4-flash` | DeepSeek-V4-Flash | 1e6 | inherits 256e3 | text |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 1e6 | inherits 256e3 | text |
| `deepseek-v4-flash-vision-exp` | DeepSeek-V4-Flash-Vision-Exp | 1e6 | inherits 256e3 | text, image |

Merge order (lines 1578–1590):

```js
const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
...
context: { contextWindow },
defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
```
and the config defaults (lines 1998–1999): `maxTokens: config.maxTokens ?? 256e3, defaultContextWindow: config.defaultContextWindow ?? 1e6`.
Config schema defaults: `dsh-llm-deepseek\lib\index.js:1894–1895`.

**Generic pi-ai adapter** — `dsh-llm-pi-ai\lib\index.js`:

```js
const DEFAULT_CONTEXT_WINDOW = 262144;   // line 893  → 262_144
const DEFAULT_MAX_TOKENS = 32768;        // line 895  →  32_768
```
Per-profile defaults (`defaultContextWindow`, `defaultMaxTokens`) at lines 991–992; per-model `contextWindow`/`maxTokens` schema at 971–972; resolution `entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow` at line 670, validated positive-integer at 671.

### 1.5 This session's live numbers

`E:\Home\.dsh\settings.yaml`

```yaml
agent-default-model:
  provider: cliproxyapi
  model: deepseek-flash
  reasoningEffort: high
llm-pi-ai:
  providers:
    cliproxyapi:
      api: openai-completions
      models:
        - id: deepseek-flash
          name: DeepSeek-V41-Flash
          contextWindow: 384000
          maxTokens: 192000
```
(lines 5–19)

So for the session producing this report: **contextWindow = 384,000 tokens, per-request output cap = 192,000**,
and (from §5) the auto-compaction threshold is `floor(384000 × 0.8) = 307,200` with `floor(384000 × 0.16) = 61,440` retained.

**No other per-session token budget exists** — there is no session-level `budget`/`quota` field anywhere; the only capacity fact is `contextWindow`.

---

## 2. How DSH knows tokens consumed

### 2.1 Provider usage per call

`dsh-llm\lib\types\types.d.ts:128–150`

```ts
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
}
```
Doc comment: *"Counts are DISJOINT: `inputTokens` is uncached input only; cached input is reported separately as `cacheReadTokens`/`cacheWriteTokens` (billed input = sum of the three). Adapters whose providers fold cache hits into a total prompt count (DeepSeek's `prompt_tokens`) subtract them out."*

Stored **on the message event itself**, `dsh-session\lib\types\types.d.ts:299–317`:

```ts
'assistant/message': {
    turn: number;
    step: number;
    message: AssistantMessage;
    stream: AssistantStreamRecord[];
    usage?: TokenUsage;
    interrupted?: true;
};
```
with the comment *"so the model output and its accounting travel together (there is no separate usage record)"* (lines 301–303).

### 2.2 The measurement service: `ctx.tokenMeter`

`dsh-token-meter\lib\types\index.d.ts:20–57`

```ts
export declare class TokenMeter extends Service {
    static Config: z<TokenMeterConfig>;
    static inject: string[];
    measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement;
    estimateMessage(message: Message): number;
    ...
}
```
Registered as `ctx.tokenMeter` via module augmentation (`dsh-token-meter\lib\types\index.d.ts:14–18`).

`TokenMeasurement` — `dsh-token-meter\lib\types\types.d.ts:12–55`:

```ts
export type TokenMeasurementBaseline =
    | { readonly kind: 'none'; readonly tokens: 0 }
    | { readonly kind: 'estimated'; readonly tokens: number }
    | { readonly kind: 'usage'; readonly tokens: number; readonly usage: Readonly<TokenUsage> };

export interface TokenMeasurement {
    readonly logRevision: SessionLogOffset;
    readonly baseline: TokenMeasurementBaseline;
    readonly surfaceDeltaTokens: number;
    readonly totalTokens: number;      // request + response pressure
    readonly surfaceTokens: number;    // sum of nodes[].tokens
    readonly nodes: readonly TokenSurfaceNode[];
}

export interface TokenSurfaceNode {
    readonly seq: SessionSeq;
    readonly tokens: number;
    readonly heuristicTokens: number;
}
```

### 2.3 The estimator (no real tokenizer)

`dsh-token-meter\lib\types\estimate.js:8–13`

```js
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
export const ROLE_OVERHEAD = 4;
```
Applied in `estimateContent` (lines 29–53), `estimateSystemMessage` (62–70), `estimateMessage` (77–81), `estimateToolsTokens` (88–92).

**There is no tiktoken/tokenizer dependency**: a full-tree grep for `tiktoken|js-tiktoken|gpt-tokenizer` returns nothing; every `tokenize` hit is unrelated (cosmokit string splitting, Shiki syntax highlighting, SQLite FTS5 `unicode61`). The README confirms (`dsh-token-meter\README.md:134`, dev note line 148–149): *"The fixed four-characters-per-token heuristic underprices CJK text and JSON schemas… A per-provider exact tokenizer is not decided."*

### 2.4 Exposed to plugins — three session projections

`dsh-token-meter\lib\types\projection.d.ts:12–73`

```ts
export interface TokenUsageProjection {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}
export interface ContextPressureProjection {
    pressureTokens?: number;     // newest provider-reported prompt size
    projectedTokens?: number;    // what the next request's prompt would cost
    contextWindow?: number;
}
export interface ContextBreakdownProjection {
    systemTokens: number;
    toolsTokens: number;
    messageTokens: number;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        tokenUsage: TokenUsageProjection;
        contextPressure: ContextPressureProjection;
        contextBreakdown: ContextBreakdownProjection;
    }
}
```
`pressureTokens = inputTokens + cacheReadTokens + cacheWriteTokens`; output excluded. Unloading the plugin removes all three keys (`dsh-token-meter\README.md:49`).

Read APIs a plugin may use (`dsh-session-projection\lib\types\index.d.ts`):

- `snapshot(session, keys?)` — line 185 (synchronous consistent cut over all client-visible units)
- `stateOf(session, key)` — line 175
- `cachedSnapshot(session, keys?)` — line 194 (hints only)
- `onChanged(listener)` — line 166
- `restore(checkpoint, events, baseSeq, header, inheritedEventCount)` — line 263 (cold read from a stored log)

A host reader must declare `sessionProjections` in its plugin `inject` (lines 126–132).

### 2.5 Exact per-turn usage

`dsh-token-meter\lib\types\turn-usage.d.ts:8–32`

```ts
export interface TurnTokenUsage {
    readonly uncachedInputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly reasoningTokens?: number;
    readonly routes?: readonly TurnTokenUsageRoute[];
}
export declare function deriveTurnTokenUsage(events: readonly SessionEvent[]): TurnTokenUsage | undefined;
```
*"No attempt is inferred from a usage sample. Any missing lifecycle boundary, incomplete attempt usage, unsafe count, or contradictory exact total makes the whole disclosure unavailable."*

The browser client folds the same three projections itself from the log:
`dsh-client-connection\lib\client.js:3162–3187` (`contextPressureOf`, `tokenUsageOf`, `contextBreakdownOf`).

---

## 3. "Context remaining" / percentage / `/context`

**Yes** — there is a first-class occupancy indicator, but no `/context` command.

`dsh-client-ui-conversation\lib\types\client\context-occupancy.d.ts:1–13`

```ts
export interface ContextOccupancy {
    percent: number;
    usedTokens: number;
    contextWindow: number;
}
export declare function contextOccupancy(pressure: ContextPressureProjection | undefined): ContextOccupancy | null;
```

Implementation — `dsh-client-ui-conversation\lib\client.js:15328–15336`:

```js
function contextOccupancy(pressure) {
    const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens;
    if (usedTokens === void 0 || pressure?.contextWindow === void 0) return null;
    return {
        percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
        usedTokens,
        contextWindow: pressure.contextWindow
    };
}
```

UI component `ContextMeter` (same file, CSS module injected at 15338–15359): a circular ring whose
`strokeDasharray` is `${CIRCUMFERENCE * percent / 100} ...` (line 15485) plus a popover panel showing

```js
children: `~${formatTokens(context.usedTokens, t)} / ${formatTokens(context.contextWindow, t)}`
```
(line 15512) with breakdown rows for system / tools / messages (lines 15523–15532, labels from `ROWS`).

Other surfaces:

- **ACP clients**: `dsh-acp\lib\index.js:625–634` emits a standard ACP `usage_update { used, size }` where `size = session.requestContext()?.contextWindow` and `used = meter.measure(session).totalTokens`.
- **No `/context` slash command exists.** Registered commands found: `/compact` (`dsh-command-compact\lib\index.js:92–96`), `/goal`, `/feedback`, plus plan-mode and permission-preset commands. Grep for `name: "context"|\"/context\"` returns only the cordis introspection tool's event-parameter listing (`dsh-tool-cordis\lib\index.js:5538`), not a command.

Design caveat, `dsh-token-meter\README.md:64`:

> "Occupancy is a reference figure, not a billing record: nothing in the harness makes decisions from it, and compaction reads `measure()` instead. A UI computes occupancy by dividing measured pressure by the separately resolved capacity for the selected model."

---

## 4. Tool output truncation / caps

### 4.1 The shared retention library

`dsh-output-retention` provides `ItemRetainer` (head window + exact omitted count) and `TextRetainer`
(`head` / `tail` / `headTail`, byte-counted, UTF-8-safe cuts) plus `formatRetentionNotice`. It is a library,
not a plugin — tools configure their own budgets. Usage matrix in `dsh-output-retention\README.md:83–91`.

### 4.2 Exact per-tool constants

| Tool | Constant | Value | Path:line |
|---|---|---|---|
| `read` | `READ_LIMIT` (default **and** max lines) | `2e3` = 2,000 | `dsh-tool-fs\lib\index.js:293`, config default `1248` |
| `read` | `READ_MAX_LINE_LENGTH` | `2e3` = 2,000 chars/line | `dsh-tool-fs\lib\index.js:16`, config `1249` |
| `read` | `READ_MAX_BYTES` | `50 * 1024` = 51,200 bytes | `dsh-tool-fs\lib\index.js:18`, config `1250` |
| `glob` | `globMaxResults` | `100` | `dsh-tool-fs-search\lib\index.js:1219` |
| `grep` | `grepMaxMatches` | `250` | `dsh-tool-fs-search\lib\index.js:1220` |
| `grep` | `GREP_MAX_LINE_BYTES` | `2e3` = 2,000 | `dsh-tool-fs-search\lib\index.js:889` |
| `grep`/`glob` | `SEARCH_META_MAX_BYTES` | `65536` | `dsh-tool-fs-search\lib\index.js:58` |
| `grep`/`glob` | `RAW_OUTPUT_MAX_BYTES` | `2e7` = 20,000,000 | `dsh-tool-fs-search\lib\index.js:33` |
| `grep`/`glob` | `SEARCH_STDERR_MAX_BYTES` | `64 * 1024` = 65,536 | `dsh-tool-fs-search\lib\index.js:45` |
| `bash` | `maxOutputBytes` (per stream) | `64e3` = 64,000 | `dsh-bash-local\lib\index.js:132` |
| `bash` | `DEFAULT_MAX_SPILL_BYTES` | `64 * 1024 * 1024` = 67,108,864 | `dsh-bash-local\lib\index.js:89`, config `133` |
| `pwsh` | `maxOutputBytes` (per stream) | `64e3` = 64,000 | `dsh-pwsh-local\lib\index.js:203` |
| `pwsh` | `DEFAULT_MAX_SPILL_BYTES` | `64 * 1024 * 1024` | `dsh-pwsh-local\lib\index.js:161–162`, config `204` |
| `web_search` | `WEB_SEARCH_MAX_RESULTS` | `8` | `dsh-tool-web\lib\index.js:25`, config `848` |
| `web_search` | `WEB_SEARCH_MAX_QUERIES` | `4` | `dsh-tool-web\lib\index.js:27`, config `849` |
| `web_fetch` | `DEFAULT_FETCH_MAX_OUTPUT_CHARS` | `2e5` = 200,000 | `dsh-tool-web\lib\index.js:844`, config `852` |
| LLM notices | `CONTEXT_SUMMARY_MAX_CHARS` | `120` | `dsh-llm\lib\types\message.js:10–19` |

### 4.3 Truncation code paths

`read` — byte-budgeted window builder, `dsh-tool-fs\lib\index.js:27–47`:

```js
function truncateLine(line, maxLineLength) {
    return line.length > maxLineLength ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)` : line;
}
...
function consumeLine(acc, rawLine, request) {
    acc.totalLines += 1;
    if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) return;
    ...
    if (acc.outputBytes + bytes > request.maxBytes) { acc.truncatedByBytes = true; return; }
```

`pwsh` — spill notice appended when truncation occurred, `dsh-tool-pwsh\lib\index.js:45–48`:

```js
function ...(output) {
    if (!output.truncated) return output.text;
    return `${output.text}\n[output truncated; full output: ${output.spillPath ?? "(unavailable)"}]`;
}
```
(the bash tool's description at `dsh-tool-bash\lib\index.js:127` carries the same contract in prose: *"Long output is truncated to its tail; the full output is saved to a file whose path is reported when available."*)

### 4.4 Configurability: per tool, not global

Every cap above is a **plugin config field** on its own tool package (`z.number().default(...)`), so a composition
tunes each tool independently. There is **no global tool-result size cap** in the agent loop: a grep for
`truncat|maxBytes|maxChars` in `dsh-agent-loop\lib\index.js` finds only unrelated `Math.trunc` inbox-index math
(lines 185–189).

A second, *global-ish* cap exists as a mounted companion plugin (§5.4).

---

## 5. Compaction / summarization / auto-compact

### 5.1 Seam and default backend

Seam `dsh-compaction` — `CompactionEngine.compactIfNeeded` / `compactNow` / `compactRegion`
(`dsh-compaction\lib\types\index.d.ts:89,110,130`); result type `CompactionResult` with
`shadowedRange`, `shadowedSeqs`, `shadowedTokenCount` (`dsh-compaction\lib\types\types.d.ts:102–130`).

Backend `@deepseek-ai/dsh-compaction-basic` is **mounted by default with no config** —
`dsh-base\cordis.patch.yml:317–326`:

```yaml
    - id: token-meter
      name: '@deepseek-ai/dsh-token-meter'

    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    # Human `/compact`: one useful reduction below the automatic threshold. Backend
    # independent, so it follows whichever compaction service this leaf mounts.
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
```

### 5.2 Trigger threshold

`dsh-compaction-basic\lib\index.js:15,17,62–77`

```js
const DEFAULT_THRESHOLD_RATIO = .8;    // line 15
const DEFAULT_RETAIN_RATIO = .16;      // line 17
...
    thresholdRatio, ...retention,
    maxTokens: config.maxTokens ?? 8192,
    compactionRetries: config.compactionRetries ?? 1,
    maxOverflowRetries: config.maxOverflowRetries ?? 1,
    auto: config.auto ?? true
```

`dsh-compaction-basic\lib\index.js:108–125`

```js
function resolveCompactSpec(policy, contextWindow) {
    ...
    const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
    const retainTokens = policy.retainTokens === void 0 ? Math.floor(contextWindow * policy.retainRatio) : policy.retainTokens;
    if (retainTokens >= thresholdTokens) throw new TargetPressureConfigError(...);
```

Config surface — `dsh-compaction-basic\lib\types\types.d.ts:8–38` (`thresholdRatio` default `0.8`,
`retainRatio` default `0.16`, `retainTokens` mutually exclusive, `summarizationProvider/Model`, `maxTokens` default `8192`,
`compactionRetries` default `1`, `maxOverflowRetries` default `1`, `auto` default `true`, plus a `modelPolicies[]`
exact provider/model override table).

**For this session**: threshold 307,200 tokens; retained tail 61,440 tokens.

### 5.3 Trigger code paths

Automatic listeners are registered only when `auto` is true (`dsh-compaction-basic\lib\index.js:793–846`):

```js
_registerAutomaticCompaction() {
    ...
    ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
        if (!signal.aborted) try {
            const result = await this.compactIfNeeded(agent, "pressure", signal);
            ...
        } catch (error) { ... ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`); }
        return next();
    });
    ...
    ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
        if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next();
        ...
        result = await this.compactIfNeeded(agent, "context-overflow", signal);
        ...
        return { kind: "retry" };
    });
```

`CONTEXT_WINDOW_EXCEEDED_CODE = 'CONTEXT_WINDOW_EXCEEDED'` (`dsh-llm\lib\types\error.js:22`); adapters map provider
overflow to it (`dsh-llm-deepseek\lib\index.js:1537`, `dsh-llm-pi-ai\lib\index.js:1388–1395`).

Pressure gate — `dsh-compaction-basic\lib\index.js:895–919`:

```js
const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;
...
if (context === void 0) throw new TargetPressureConfigError(targetKey, `compaction-basic: no context capacity for ${targetKey}; configure contextWindow on that adapter model`);
const spec = resolveCompactSpec(policy, context.contextWindow);
if (measurement.totalTokens < spec.thresholdTokens) return null;
if (prune !== void 0) { prune.pruneSession(agent.session); measurement = meter.measure(agent.session); }
if (measurement.totalTokens < spec.thresholdTokens) return null;
for (let attempt = 0; attempt <= spec.compactionRetries; attempt += 1) { ... }
throw new Error(`compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts (...)`);
```

Overflow path bypasses the threshold and the retained tail (`retainTokens = 0`, line 891): *"overflow bypasses the normal threshold and retained-tail policy so it can force one useful balanced reduction"* (lines 864–867).

### 5.4 Tool-result pruning that runs first

`dsh-compaction-tool-result-pruner\lib\index.js:8–13`

```js
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
const DEFAULTS = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };
```
Mounted with those explicit values in `dsh-base\cordis.patch.yml:394–399`. It runs only *after* a compaction trigger
qualifies (`dsh-compaction-basic\lib\index.js:885–905`), replaces over-budget tool-result text with
head + marker + tail, and records a `compaction/prune` shadow-price event. Original events remain in the log.

### 5.5 What happens to message history

Selection (`dsh-compaction-basic\lib\index.js:393–416`): walks the priced surface from the tail forward until the
retain budget is met, never includes surface node 0 (the `system/message`), and never splits an assistant
tool-call/tool-result pair.

Commit (`dsh-compaction-basic\lib\index.js:599–645`) appends three events:

```js
const summaryEvent = session.append("compaction/summary", {
    compactionId: startEvent.data.compactionId,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider, model, ...maxTokens === void 0 ? {} : { maxTokens }, ...usage === void 0 ? {} : { usage }
});
session.append("user/message", checkpointMessage, {
    surfaceOp: { op: "replace", startSeq: start, endSeq: end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs]
});
```

So the **append-only log keeps every original event** (all shadowed nodes stay durable and inspectable); only the
**derived model-visible surface** drops them and substitutes one synthesized user message. The checkpoint text is framed
(`dsh-compaction-basic\lib\index.js:211–212, 256–257, 323–335`):

```js
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. ...";
```

The summarization call reuses the conversation's own system prompt, tool schemas and message prefix and appends a
`COMPACTION_INSTRUCTION` as the **final user message** for KV-cache reuse (`dsh-compaction-basic\lib\index.js:213–255, 269–317`),
with `purpose: "compaction"` and `maxTokens: config.maxTokens` (default 8192). The DeepSeek adapter turns that purpose
into the header `"x-deepseek-harness-compact": "1"` (`dsh-llm-deepseek\lib\index.js:1667`).

### 5.6 Manual `/compact`

`dsh-command-compact\lib\index.js:48–98` registers name `"compact"`, description `"Compact older conversation history"`,
executing `ctx.compaction.compactNow(invocation.agent, invocation.signal, invocation.commandId)` and reporting
`` `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens).` ``
(line 61). `compactNow` requires an idle agent under `runMaintenance` and compacts with `retainTokens = 0`
(`dsh-compaction-basic\lib\index.js:944–970`).

---

## 6. System prompt assembly and per-turn injection

### 6.1 The registry a plugin contributes to: `ctx.systemPrompt`

`dsh-system-prompt\lib\types\index.d.ts:220–287` — `SystemPrompt extends Service`:

```ts
section(section: PromptSection): () => void;
getSectionOrder(name: PromptSectionOrderName): number;
context(context: PromptContext): () => void;
suppressRuntimeContext(): () => void;
tools(provider: (context: AssembleContext) => ToolProviderResult): () => void;
variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void;
assemble(context?: AssembleContext): Promise<PromptAssembly>;
```

```ts
export interface PromptSection {
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: AssembleContext) => string);
    readonly complete?: boolean;
}
export interface PromptContext {           // dynamic runtime context → user-role snapshot
    readonly name: string;
    readonly order: number;
    readonly text: string | ((context: AssembleContext) => string);
}
export interface PromptAssembly {
    sections: AssembledSection[];
    contexts: AssembledContext[];
    tools: ToolSchema[];
    variables: Record<string, string | undefined>;
}
```
(lines 47–108)

Contributing a section (README:59–63):

```
ctx.systemPrompt.section({ name: 'tool:bash', order: 100, text: 'Prefer bash for file and process operations.' })
```

Sections concatenate ascending by `order` (ties by code-unit name order); `complete: true` makes one section the
entire prompt (more than one fails assembly). A scoped registration shadows a same-named global for one agent.

Fixed order table — `dsh-system-prompt\lib\types\index.d.ts:109–141`:

```ts
const SECTION_ORDERS = {
    HARNESS_IDENTITY: -1000, DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500, TEAM_POLICY: 600,
    PTC_ONLY: 800, FILE_REFERENCE: 900, TOOL_BASH: 1000, TOOL_PWSH: 1010, TOOL_READ: 1100,
    TOOL_WRITE: 1200, TOOL_EDIT: 1300, TOOL_GLOB: 1400, TOOL_GREP: 1500, TOOL_JOBS: 1600,
    TOOL_PTY: 1700, TOOL_WEB_SEARCH: 2000, TOOL_WEB_FETCH: 2100, TOOL_LSP: 2200,
    TOOL_SESSION_QUERY: 2300, TOOL_GOAL: 2400, TOOL_CORDIS: 2500, TOOL_WORKFLOW: 2600,
    TOOL_RALPH: 2700, TOOL_SUBAGENT: 2800, TOOL_REPORT: 2900, TOOLS_SDK: 5000,
    DELIVERABLE_FILE_REFERENCES: 9000, STRUCTURED_OUTPUT: 9900, HARNESS_SOURCE: 10000,
    WEB_SURFACE: 10100, DEPLOYMENT_PERSONA_SUFFIX: 10200,
};
const CONTEXT_ORDERS = { SANDBOX_POLICY: 110, APPROVAL_POLICY: 115, SUBAGENT_DELEGATION: 120 };
```

Config (`index.d.ts:163–184`): `includeHarnessIdentity` (default `true`, emits the order −1000 opener
`You are an AI agent powered by DeepSeek Harness.`), `includeRuntimeContext` (default `true`), `personaPrefix`
(default `''`, order 0), `personaSuffix` (default `''`, order 10200), `toolOrder` (must contain exactly one
`'<unlisted-tools>'` rest entry, `TOOL_ORDER_REST` at line 161).

There is also an expert waterfall: `'system-prompt/assemble'(assembly, context, next)` (`index.d.ts:27`) whose
returned value is authoritative, and `renderPrompt(assembly)` (line 193) which interpolates strict `{{variable}}`
references, drops empty sections and joins with blank lines.

**The rendered prompt is not a request field.** `dsh-system-prompt\README.md:135`:

> "The rendered prompt reaches the model as a system-role message of derived history — surface node 0, or the latest system node after an in-history update — neither the loop request nor `request/header` carries a separate `system` field."

Durably that is the `system/message` event (`dsh-session\lib\types\types.d.ts:294–298`); with
`systemPromptUpdate: 'in-history'` (declared for `deepseek-flash`, `dsh-llm-deepseek\lib\index.js:1849`) a changed
prompt is appended after cached history instead of rewriting node 0.

### 6.2 Per-turn injection into the conversation

The plugin seam is the agent inbox, `dsh-agent\lib\types\runtime-types.d.ts`:

```ts
/**
 * Queue model-facing context for the next pre-step without waking the
 * driver. ...
 * @param message - identified injected context and the source that supplied it.
 */
inject(message: UserMessage): void;
```
(lines 201–209; siblings `send` 186, `followup` 192, `steer` 200)

Listener seam: the `agent/pre-step` waterfall event (`runtime-types.d.ts:313`), where listeners may fold messages
into the entering batch — this is exactly how `compaction-basic` and `dsh-time-context` hook in. Related events:
`agent/inbox/inserted|claimed|discarded` (lines 258–290).

### 6.3 `<system-reminder>` blocks

There is **no shared constant** for the framing; each plugin owns its own. The reference implementation is
`dsh-agent-instructions\lib\index.js:111–129`:

```js
const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
...
function escapeInstructionFrameBody(body) {
    return body.replaceAll(SYSTEM_REMINDER_CLOSE, "<\\/system-reminder>");
}
```
with `dsh-agent-instructions\README.md:86`: *"The plugin owns the complete `<system-reminder>` framing and every injected message reaches the model verbatim."* Its baseline/refresh messages are ordinary sourced `user/message` events
(README:32, 86, 102), budget-capped by `maxBytes` (default `65536` in `dsh-base`; `maxSourceBytes` default `1048576`).

`dsh-tool-skill\lib\index.js:243–276` emits the same framing for skill badges, and `dsh-client-ui-chat\lib\client.js:473,609`
renders it. `dsh-session\lib\types\surface.js:83` documents that pattern as the sanctioned way for a plugin to add
model-visible context.

Other shipped per-turn injectors: `dsh-time-context` (per-step clock reading via `agent/pre-step`, README:28, 67–80 —
*"Each injection is one additional user-role message in the durable history"*), `dsh-repeat-tool-reminder`,
`dsh-skill-badge`, `dsh-tmux-context`. Runtime contexts registered via `ctx.systemPrompt.context(...)` become
*sourced user-role snapshots*, distinct from prompt sections (README:94, 135).

---

## 7. Persistence and whether a plugin can read it

### 7.1 Format

`@deepseek-ai/dsh-session-persistence-jsonl` is the sole first-party backend.
`dsh-session-persistence-jsonl\README.md:43–48`: `root` required (no default), `compression` default `'zstd'`
(checksummed Zstandard frames) or `'none'` for plain newline-delimited UTF-8 text.

On-disk layout (README:56–68):

```text
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.v1.jsonl.zstd
      session.v2.jsonl.zstd
      session.v3.jsonl.zstd      # current generation in this install
```
*"Every canonical generation starts with a physical header whose version equals its filename. The current format stores one physical row per durable event."*

Live evidence on this machine (`DSH_HOME=E:\Home\.dsh`, `DSH_SESSION_ID=f8da2413-fd03-4925-a5a1-d64419d81fb2`):

```
E:\Home\.dsh\sessions\--E-Home-projects-dsh-context-sense--\session-<id>\session.v3.jsonl.zstd
```

One frame per append batch, header frame first, `fsync` before each append resolves; committed events are never
rewritten; torn-tail recovery is internal (README:74). `compression: 'none'` is required for an *external* plain-text
reader — compressed logs must go through the backend (README:80, 156).

### 7.2 Plugin read APIs

**Live session object** (`dsh-session\lib\types\index.d.ts`):

| API | Line | Notes |
|---|---|---|
| `eventAt(seq)` | 178 | one exact event |
| `snapshotEvents(from?, toExclusive?)` | 187 | frozen array; full snapshot reused until next append |
| `ownEvents()` | 192 | events after the fork-inherited prefix |
| `get seq()` | 200 | log length |
| `requestHeader()` | 251 | folded `EpochHeader` (provider/model/tools/call config) |
| `requestContext()` | 260 | folded `RequestContext` → **`contextWindow`** |
| `deriveMessages(): Message[]` | 285 | *"the single source of derived history"*; frozen, cached, surface-replacement aware; O(new nodes) per call |

**Cross-session / cold reads** — `ctx.sessionQuery` (`dsh-session-query\lib\types\index.d.ts:35–153`):
`observeSession(id, options)`, `readSession(id)`, `listEvents(id)`, `filterEvents(id, filters)`,
`readSurface(id)`, `readEvent({...})`, `searchSessions`, `searchEvents`, `listSessions`, `traceSession`,
`traceEvent`.

**Cold projection reads over a stored log** — `dsh-session-projection\lib\types\index.d.ts:209–277`:
`checkpoint(session)`, `restoreFloor(checkpoint)`, `viewCheckpoint(...)`, `restore(...)`, `hydrate(...)`.

### 7.3 Counting messages and tokens from the log

- **Messages**: the surface event types are `'system/message' | 'user/message' | 'assistant/message' | 'tool/result'`
  (`dsh-session\lib\types\types.d.ts:413`); count those in `snapshotEvents()` / `listEvents()`, or use
  `session.deriveMessages().length` for the model-visible count (post-compaction, shadowed nodes are excluded).
- **Tokens, live**: `ctx.tokenMeter.measure(session).totalTokens` (needs a live `Session`);
  per-turn exact figures via `deriveTurnTokenUsage(turnEvents)`.
- **Tokens from a persisted log without a live Session**: restore the projection units with
  `ctx.sessionProjections.restore(checkpoint, events, baseSeq, header, inheritedEventCount)` and read
  `values.tokenUsage` / `values.contextPressure` / `values.contextBreakdown`; or sum the `usage?: TokenUsage`
  field of each `assistant/message` row directly (the client does exactly this at
  `dsh-client-connection\lib\client.js:3162–3186`).

---

## UNKNOWN / not determinable from the checkout

1. **No exact tokenizer.** Nothing in the tree implements provider-accurate tokenization; all text pricing is the
   `CHARS_PER_TOKEN = 4` heuristic plus small structural overheads. There is no `tiktoken`/`gpt-tokenizer` dependency
   anywhere in the checkout. Exact billing-grade counts are explicitly out of scope (`dsh-token-meter\README.md:134, 148–149`).
2. **No `/context` command.** The only context-related command is `/compact`.
3. **Model catalogs only exist for two adapters**: `deepseek-official` (`dsh-llm-deepseek`) and the generic
   OpenAI-compatible `pi-ai` routes, whose per-model numbers come from user settings. Any other provider's numbers are
   undeterminable from the checkout.
4. **Whether the shipped `1e6` contextWindow for `deepseek-v4-*` matches the real endpoint** is a provider fact, not
   verifiable from this tree.
5. **No per-session token budget/quota** beyond `contextWindow`; no cumulative cost/pricing gate was found in the
   accounting path (the token meter only resolves image request pricing — `dsh-llm-deepseek\lib\types\request-pricing.d.ts`).
6. **No shared `<system-reminder>` constant or helper**: plugins that want the framing re-implement it
   (`dsh-agent-instructions\lib\index.js:111`, `dsh-tool-skill\lib\index.js:243`); there is no exported
   `injectSystemReminder`-style API surface.
