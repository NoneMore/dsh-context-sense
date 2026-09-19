# DSH context/token instrumentation — read-only recon

Root searched: `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
Installed build: `@deepseek-ai/dsh-*` version `0.1.5-rc.2` (from each `package.json`). No TypeScript source ships; read the built JS + `.d.ts`.
Nothing was modified. All line numbers refer to the installed files.

Path shorthand below: `<root>` = the directory above; e.g. `<root>\dsh-token-meter\lib\index.js`.

---

## 1. Token counting — `dsh-token-meter`

### 1.1 Cordis service key

`ctx.tokenMeter` — service key string `"tokenMeter"`.

`<root>\dsh-token-meter\lib\index.js:608-621` (the registration):

```js
/** Replay owner for one service-wide estimator and isolated per-session folds. */
var TokenMeter = class extends Service {
	static Config = z.object({});
	static inject = ["sessionProjections"];
	states = /* @__PURE__ */ new WeakMap();
	constructor(ctx, config = {}) {
		super(ctx, "tokenMeter");
		validateConfigKeys(config);
		ctx.sessionProjections.register(tokenUsageProjectionDefinition);
		ctx.sessionProjections.register(contextPressureProjectionDefinition);
		ctx.sessionProjections.register(contextBreakdownProjectionDefinition);
		ctx.on("session/event", (session) => {
			if (this.states.has(session)) this._sync(session);
		});
	}
```

Context merge declaring it: `<root>\dsh-token-meter\lib\types\index.d.ts:14-18`

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        tokenMeter: TokenMeter;
    }
}
```

- Hard dependency: `static inject = ["sessionProjections"]` (line 610). The `llm` service is **optional** and read with `this.ctx.get("llm")` (lines 691, 695).
- Config is empty by design — any key throws (`lib\index.js:603-606`):
  ```js
  /** Reject stale or misspelled keys before defaults can hide them. */
  function validateConfigKeys(config) {
  	for (const key of Object.keys(config)) throw new Error(`TokenMeterConfig: unknown key "${key}" (no settings are supported)`);
  }
  ```

### 1.2 Methods and exact signatures

From `<root>\dsh-token-meter\lib\types\index.d.ts:20-70`:

```ts
export declare class TokenMeter extends Service {
    static Config: z<TokenMeterConfig>;
    static inject: string[];
    measure(session: Session, requestHeader?: EpochHeader): TokenMeasurement;
    estimateMessage(message: Message): number;
}
```

**`measure(session, requestHeader?)` → `TokenMeasurement`** — body at `lib\index.js:643-686`; the returned object:

```js
return deepFreeze(structuredClone({
	logRevision: state.consumedEvents,
	baseline,
	surfaceDeltaTokens,
	totalTokens: Math.max(0, baseline.tokens + surfaceDeltaTokens),
	surfaceTokens: surface.surfaceTokens,
	nodes: surface.nodes
}));
```

Return shape (`lib\types\types.d.ts:12-55`), verbatim:

```ts
export type TokenMeasurementBaseline = {
    readonly kind: 'none';
    readonly tokens: 0;
} | {
    readonly kind: 'estimated';
    readonly tokens: number;
} | {
    readonly kind: 'usage';
    readonly tokens: number;
    readonly usage: Readonly<TokenUsage>;
};
export interface TokenMeasurement {
    /** Number of durable events consumed; equal to the next unread event seq. */
    readonly logRevision: SessionLogOffset;
    /** Provider or heuristic anchor used for this measurement. */
    readonly baseline: TokenMeasurementBaseline;
    /** Signed repricing of current surface content relative to the baseline anchor. */
    readonly surfaceDeltaTokens: number;
    /** Non-negative current request-and-response pressure. */
    readonly totalTokens: number;
    /** Total route-priced request tokens across the current surface; equals the sum of the node prices. */
    readonly surfaceTokens: number;
    /** Current surface nodes in positional head-to-tail order. */
    readonly nodes: readonly TokenSurfaceNode[];
}
export interface TokenSurfaceNode {
    readonly seq: SessionSeq;
    readonly tokens: number;
    readonly heuristicTokens: number;
}
```

**`estimateMessage(message)` → `number`** — `lib\index.js:704-706`:

```js
	estimateMessage(message) {
		return estimateMessage(message);
	}
```

Units returned: **tokens** (dimensionless counts). Semantics:
- `totalTokens` = request **and** response pressure (`baseline.tokens + surfaceDeltaTokens`).
- `surfaceTokens` = request-side route-priced total of the current model-visible surface = Σ `nodes[].tokens`.
- `nodes[].tokens` = per-message request price under the measured route; `nodes[].heuristicTokens` = the route-independent 4-chars/token price.
- `logRevision` is a consumed-event offset, not a token figure.

### 1.3 Local tokenizer or provider usage? — a hybrid, both

**Heuristic** (no tokenizer anywhere; the meter makes no model calls). `<root>\dsh-token-meter\lib\index.js:15-18, 34-50`:

```js
/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4;
/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4;
...
function estimateContent(blocks) {
	let tokens = 0;
	for (const block of blocks) switch (block.type) {
		case "text":
		case "reasoning":
			tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
			break;
		case "tool-call":
			tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN) + Math.ceil(block.arguments.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
			break;
		case "tool-result":
			tokens += estimateContent(block.content) + BLOCK_OVERHEAD;
			break;
		default: tokens += estimateStructuralBlock(block);
	}
	return tokens;
}
```

**Provider usage is reused only when the anchor's canonical envelope matches** — `lib\index.js:652-664`:

```js
		if (anchor !== void 0 && optionalHeaderEquals(anchor.header, header)) {
			const anchorSurfaceTokens = priceSurface(anchor.nodes, pricing, fileText).surfaceTokens + anchor.assistantTokens;
			const estimatedAnchorTokens = estimateToolsTokens(header) + anchorSurfaceTokens;
			const usage = anchor.usage;
			baseline = usage !== void 0 && usageTokens(usage) >= estimatedAnchorTokens ? {
				kind: "usage",
				tokens: usageTokens(usage),
				usage
			} : {
				kind: "estimated",
				tokens: estimatedAnchorTokens
			};
```

`usageTokens` sums the disjoint provider buckets (`lib\index.js:594-597`):

```js
/** Sum disjoint provider usage buckets without double-counting reasoning output. */
function usageTokens(usage) {
	return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens;
}
```

Route-exact add-ons come from the optional `llm` service (`lib\index.js:687-697`): `llm.imageRequestPricing(config.provider, config.model)` for image visual tokens, and `llm.fileRequestText(ref)` for file-handle text. Unknown/undeclared routes fall back to the heuristic.

### 1.4 Session projections registered by the meter (the other counters)

Three units, keys quoted from `lib\index.js:415, 470, 211` (`key: "tokenUsage"`, `key: "contextPressure"`, `key: "contextBreakdown"`):

| Projection key | stateVersion | View shape (wire) | Source of numbers |
|---|---|---|---|
| `tokenUsage` | 2 (line 417) | `{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }` (`lib\index.js:361-366`) | Provider-reported, cumulative over the whole durable log |
| `contextPressure` | 4 (line 472) | `{ pressureTokens?, projectedTokens?, contextWindow? }` (`lib\index.js:379-387`) | Usage sample + signed surface movement |
| `contextBreakdown` | 4 (line 213) | `{ systemTokens, toolsTokens, messageTokens }` (`lib\index.js:199-203`) | Fixed heuristic only |

`contextPressure` view computation (`lib\index.js:510-516`):

```js
	wire: {
		viewSchema: pressureSchema,
		view: ({ contextWindow, pressureTokens, surfaceTokens, sampledSurfaceTokens }) => ({
			...contextWindow === void 0 ? {} : { contextWindow },
			...pressureTokens === void 0 ? {} : { pressureTokens },
			...pressureTokens === void 0 || sampledSurfaceTokens === void 0 ? {} : { projectedTokens: Math.max(0, pressureTokens + surfaceTokens - sampledSurfaceTokens) }
		})
	}
```

Prompt-side pressure definition (`lib\index.js:388-389`) — **no output tokens**:

```js
/** Prompt-side pressure of one request: input plus cache traffic, no output. */
const pressureFrom = (usage) => usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
```

Per-Turn exact accounting exists as `deriveTurnTokenUsage(events)` (`lib\types\turn-usage.d.ts:32`), but it is **not on the package root**; it is reachable only through the browser-safe subpath `@deepseek-ai/dsh-token-meter/client` (`lib\types\client.js:6`, exports map `package.json:21-24`). `deriveTurnTokenUsage` returns `TurnTokenUsage { uncachedInputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens?, reasoningTokens?, routes? }` (`turn-usage.d.ts:8-22`), or `undefined` when it cannot be proven.

---

## 2. Context window size — where it comes from

**It is model-catalog/adapter metadata scoped to an exact `provider/model` route, not a provider response field and not a harness setting.** It reaches the session by being logged as a `request/context` session event.

### 2.1 The service API that resolves it

`<root>\dsh-llm\lib\index.js:2043-2048`:

```js
		async resolveModelInfo(provider, model, signal) {
			return this.resolveModelInfoFor(this.registration(provider), model, signal);
		}
		async resolveModelInfoFor(registration, model, signal) {
			const resolved = await registration.adapter.resolveModel(registration.provider.id, model, signal);
			return this.normalizeModelInfo(registration, model, resolved);
		}
```

Normalization/validation, `<root>\dsh-llm\lib\index.js:2054-2055, 2067`:

```js
			const context = resolved.context;
			if (context !== void 0 && (!Number.isInteger(context.contextWindow) || context.contextWindow <= 0)) throw new LlmError(`adapter returned invalid context metadata for provider "${provider}" model "${model}"`, "INVALID_MODEL_CONTEXT");
...
				...context === void 0 ? {} : { context: { contextWindow: context.contextWindow } },
```

Type: `<root>\dsh-llm\lib\typert.host.js:343` → `export interface LlmModelContext { contextWindow: number; }`. `contextWindow` is a positive integer number of tokens; the field is **optional** on the resolved info (`context?: LlmModelContext`).

### 2.2 DeepSeek adapter: catalog entry, then connection default

`<root>\dsh-llm-deepseek\lib\index.js:1575-1588`:

```js
	resolveModel(provider, model, _signal) {
		return Promise.resolve(this.modelInfoFor(this.config.options(), provider, model));
	}
	modelInfoFor(connection, provider, model) {
		const configured = connection.models.find((entry) => entry.id === model);
		const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
		return {
			...
			context: { contextWindow },
```

Sources and their types (`<root>\dsh-llm-deepseek\lib\index.js`):

- `const DEFAULT_CONTEXT_WINDOW = 1e6;` (line 1392) — **1,000,000 tokens**.
- Per-model catalog field: `contextWindow: z.number().step(1).min(1)` (line 1877); the shipped `DEFAULT_MODELS` (lines 1841-1871) set `contextWindow: DEFAULT_CONTEXT_WINDOW` on all four of `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp`.
- Connection-level default: `defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW)` (line 1895); `models: z.array(catalogModel).default(DEFAULT_MODELS)` (line 1896).
- The pi-ai multi-provider adapter has the same precedence chain — `<root>\dsh-llm-pi-ai\lib\index.js:670-671`:
  ```js
  		const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow;
  		if (!Number.isInteger(contextWindow) || contextWindow <= 0) invalid(provider, `model "${entry.id}" contextWindow must be a positive integer`);
  ```

The Web Models page writes these per-model values: `<root>\dsh-client-ui-settings-models\lib\client.js:241-242, 766-771` (`contextWindow` / `maxTokens` capacity fields).

### 2.3 How it becomes per-session: the `request/context` log event

`<root>\dsh-agent-loop\lib\index.js:1192-1201` — the exact read:

```js
		const contextWindow = preparedCall?.context?.contextWindow;
		const systemPromptUpdate = preparedCall?.systemPromptUpdate;
		const requestContext = {
			provider: config.provider,
			model: config.model,
			...contextWindow === void 0 ? {} : { contextWindow },
			...systemPromptUpdate === void 0 ? {} : { systemPromptUpdate }
		};
		const previousContext = session.requestContext();
		if (previousContext?.provider !== requestContext.provider || previousContext.model !== requestContext.model || previousContext.contextWindow !== requestContext.contextWindow || previousContext.systemPromptUpdate !== requestContext.systemPromptUpdate) session.append("request/context", requestContext);
```

Event type (`<root>\dsh-session\lib\types\index.d.ts`, `SessionEventMap`): `'request/context': RequestContext;` where

```ts
export interface RequestContext {
    provider: string;
    model: string;
    contextWindow?: number;
    systemPromptUpdate?: SystemPromptUpdate;
}
```

Read back per session:

1. Live fold — `<root>\dsh-session\lib\index.js:1238-1244`:
   ```js
   	requestContext() {
   		if (this.contextFoldSeq < this.log.length) {
   			for (const event of this.log.slice(this.contextFoldSeq)) if (event.type === "request/context") this.contextFold = deepFreeze({ ...event.data });
   			this.contextFoldSeq = this.log.length;
   		}
   		return this.contextFold;
   	}
   ```
2. Projection — `<root>\dsh-token-meter\lib\index.js:478-488` folds the newest `request/context` into `contextPressure.contextWindow`:
   ```js
   		if (event.type === "request/context") {
   			const contextWindow = event.data.contextWindow;
   			if (contextWindow !== state.contextWindow) if (contextWindow !== void 0) next = {
   				...next,
   				contextWindow
   			};
   ```

**Answer: per-session availability, per-model value.** The number is resolved per exact `provider/model` route by the adapter; the session records the resolved pair in its log, so a session that switches models gets an updated `contextWindow` in its own `request/context` record. Before the first request in a session, `session.requestContext()` is `undefined`.

Existing consumers proving the read pattern — `<root>\dsh-acp\lib\index.js:624-635`:

```js
/** Report current context occupancy only when DSH has both usage and capacity facts. */
function usageUpdate(ctx, session, event) {
	if (event.data.usage === void 0) return void 0;
	const size = session.requestContext()?.contextWindow;
	const meter = ctx.get("tokenMeter");
	if (size === void 0 || meter === void 0) return void 0;
	return {
		sessionUpdate: "usage_update",
		used: meter.measure(session).totalTokens,
		size
	};
}
```

and `<root>\dsh-client-ui-conversation\lib\client.js:15328-15336`:

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

---

## 3. Compaction configuration

### 3.1 Base `dsh-compaction` — no configuration at all

`<root>\dsh-compaction\lib\index.js:172-176` is the whole plugin:

```js
var CompactionEngine = class extends Service {
	constructor(ctx) {
		super(ctx, "compaction");
	}
};
```

There is **no `static Config`** and **no config key** in `dsh-compaction`. It is a pure Service Definition plus helpers (`toolPairingBalancedBefore/After`, `compactCheckpointSource`, `isCompactCheckpointSource`, `CompactionId`, `ManualCompactionError`), exported at `lib\index.js:178`.

Abstract API (`<root>\dsh-compaction\lib\types\index.d.ts:89, 110, 130`), verbatim signatures:

```ts
    abstract compactIfNeeded(agent: CompactionAgentContext, trigger: CompactionTrigger, signal: AbortSignal): Promise<CompactionResult | null>;
    abstract compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId): Promise<CompactionResult | null>;
    abstract compactRegion(start: SessionSeq, end: SessionSeq, agent: CompactionAgentContext, signal?: AbortSignal): Promise<CompactionResult>;
```

with `export type CompactionTrigger = 'pressure' | 'context-overflow';` (line 19) and `export type ManualCompactionErrorCode = 'busy' | 'cancelled' | 'changed' | 'summary' | 'commit' | 'persistence';` (line 21).

### 3.2 `dsh-compaction-basic` schema and defaults

Schema (`<root>\dsh-compaction-basic\lib\index.js:732-777`):

```js
const thresholdRatioSchema = z.number();
const retainRatioSchema = z.number();
const retainTokensSchema = z.number().step(1).min(0);
const summarizationProviderSchema = z.string();
const summarizationModelSchema = z.string();
const maxTokensSchema = z.number().step(1).min(1);
const compactionRetriesSchema = z.number().step(1).min(0);
const maxOverflowRetriesSchema = z.number().step(1).min(0);
...
const modelPolicy = z.object({
	provider: z.string().required(),
	model: z.string().required(),
	thresholdRatio: thresholdRatioSchema,
	retainRatio: retainRatioSchema,
	retainTokens: retainTokensSchema,
	summarizationProvider: summarizationProviderSchema,
	summarizationModel: summarizationModelSchema,
	maxTokens: maxTokensSchema,
	compactionRetries: compactionRetriesSchema,
	maxOverflowRetries: maxOverflowRetriesSchema
});
...
	static Config = z.object({
		thresholdRatio: thresholdRatioSchema,
		retainRatio: retainRatioSchema,
		retainTokens: retainTokensSchema,
		summarizationProvider: summarizationProviderSchema,
		summarizationModel: summarizationModelSchema,
		maxTokens: maxTokensSchema,
		compactionRetries: compactionRetriesSchema,
		maxOverflowRetries: maxOverflowRetriesSchema,
		modelPolicies: z.array(modelPolicy),
		auto: z.boolean()
	});
```

Defaults (`resolveConfig`, `<root>\dsh-compaction-basic\lib\index.js:58-78`):

```js
function resolveConfig(config = {}) {
	validateKeys(config, BASIC_COMPACT_CONFIG_KEYS, "BasicCompactionConfig");
	validatePolicy(config, "BasicCompactionConfig");
	if (config.auto !== void 0 && typeof config.auto !== "boolean") throw new Error("BasicCompactionConfig: auto must be a boolean");
	const thresholdRatio = config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO;
	const retention = resolveRetention(config, { retainRatio: DEFAULT_RETAIN_RATIO });
	validateRatioRetention(thresholdRatio, retention, "BasicCompactionConfig");
	const modelPolicies = resolveModelPolicies(config.modelPolicies);
	for (const [index, policy] of modelPolicies.entries()) validateRatioRetention(policy.thresholdRatio ?? thresholdRatio, resolveRetention(policy, retention), `BasicCompactionConfig: modelPolicies[${index}]`);
	return deepFreeze({
		thresholdRatio,
		...retention,
		summarizationProvider: config.summarizationProvider ?? "",
		summarizationModel: config.summarizationModel ?? "",
		maxTokens: config.maxTokens ?? 8192,
		compactionRetries: config.compactionRetries ?? 1,
		maxOverflowRetries: config.maxOverflowRetries ?? 1,
		modelPolicies,
		auto: config.auto ?? true
	});
}
```

with `DEFAULT_THRESHOLD_RATIO = .8` and `DEFAULT_RETAIN_RATIO = .16` (`lib\index.js:14-17`).

Complete key table (type, default, meaning — types from `lib\types\types.d.ts:8-39`, validation from `lib\index.js:159-202`):

| Key | Type / validation | Default | Meaning |
|---|---|---|---|
| `thresholdRatio` | number in `(0, 1]` (`assertRatio`, line 200-202) | `0.8` | **When to compact**: `floor(contextWindow × thresholdRatio)` freed-vs-pressure comparison |
| `retainRatio` | number in `(0, 1]`, must be `< thresholdRatio` (line 135) | `0.16` | Verbatim recent tail as a fraction of the window |
| `retainTokens` | non-negative integer, mutually exclusive with `retainRatio` (line 169) | — (unset) | Absolute verbatim tail budget; must be `< thresholdTokens` (checked at first use, line 113) |
| `summarizationProvider` | string, non-empty pair with `summarizationModel` (line 176-183) | `''` | Summary call provider; empty pair ⇒ latest routed target, then `AgentOptions` |
| `summarizationModel` | string, same pairing rule | `''` | Summary call model |
| `maxTokens` | positive integer (line 194-196) | `8192` | Output cap of the summary request (may include reasoning tokens) |
| `compactionRetries` | non-negative integer | `1` | Extra attempts after the first while pressure stays above threshold |
| `maxOverflowRetries` | non-negative integer | `1` | Retries after a provider-confirmed overflow; `0` disables recovery only |
| `modelPolicies` | array of exact `{provider, model, ...partialPolicy}`; duplicates rejected (line 145) | `[]` | Per-route overrides of every policy key above |
| `auto` | boolean (line 61) | `true` | Registers the automatic pressure + overflow listeners |

Unknown keys are rejected: `for (const key of Object.keys(config)) if (!keys.has(key)) throw new Error(`${name}: unknown key "${key}"`);` (line 186).

### 3.3 Threshold computation — exact code

`<root>\dsh-compaction-basic\lib\index.js:108-126`:

```js
function resolveCompactSpec(policy, contextWindow) {
	const targetKey = `${policy.target.provider}/${policy.target.model}`;
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: contextWindow (${contextWindow}) must be a positive integer`);
	const thresholdTokens = Math.floor(contextWindow * policy.thresholdRatio);
	const retainTokens = policy.retainTokens === void 0 ? Math.floor(contextWindow * policy.retainRatio) : policy.retainTokens;
	if (retainTokens >= thresholdTokens) throw new TargetPressureConfigError(targetKey, `BasicCompactionConfig: ${policy.target.provider}/${policy.target.model} retainTokens (${retainTokens}) must be less than threshold tokens ${thresholdTokens}`);
	return deepFreeze({
		target: { ...policy.target },
		contextWindow,
		thresholdRatio: policy.thresholdRatio,
		thresholdTokens,
		retainTokens,
		...
	});
}
```

Where the context window is obtained and compared (`compactIfNeeded`, `<root>\dsh-compaction-basic\lib\index.js:873-905`):

```js
	async compactIfNeeded(agent, trigger, signal) {
		const target = routedTarget(agent.session);
		if (target === void 0) return null;
		const policy = resolveTargetPolicy(this.config, target);
		const meter = this.ctx.tokenMeter;
		let measurement = meter.measure(agent.session);
		...
		const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context;
		assertNoActiveCompaction(agent.session, "automatic pressure compaction");
		const targetKey = `${target.provider}/${target.model}`;
		if (context === void 0) throw new TargetPressureConfigError(targetKey, `compaction-basic: no context capacity for ${targetKey}; configure contextWindow on that adapter model`);
		const spec = resolveCompactSpec(policy, context.contextWindow);
		if (measurement.totalTokens < spec.thresholdTokens) return null;
		if (prune !== void 0) {
			prune.pruneSession(agent.session);
			measurement = meter.measure(agent.session);
		}
		if (measurement.totalTokens < spec.thresholdTokens) return null;
```

Key facts:
- The compared quantity is **`measurement.totalTokens`** (request **+ response** pressure from `ctx.tokenMeter.measure`), **not** `surfaceTokens` and not the `contextPressure` projection.
- The `route` comes from the latest durable `request/header` config (`routedTarget`, lines 713-721). `model discovery (listModels())` is never consulted — README:126.
- The **`context-overflow` trigger bypasses the threshold and retention entirely** (`lib\index.js:886-893`):
  ```js
  		if (trigger === "context-overflow") {
  			if (prune !== void 0) {
  				prune.pruneSession(agent.session);
  				measurement = meter.measure(agent.session);
  			}
  			const range = selectCompactableRange(agent.session, measurement, 0);
  			if (range === null) return null;
  			return this.compactRegion(range.start, range.end, agent, signal);
  		}
  ```
- Retention selection walks the priced nodes from the tail until `accumulated >= retainTokens`, then snaps to a `toolPairingBalancedBefore` boundary (`selectCompactableRange`, lines 393-416).

### 3.4 Tool-result pruner config (optional companion, separate package)

`<root>\dsh-compaction-tool-result-pruner\lib\index.js:61-72` and `:10-14`:

```js
var ToolResultPruner = class extends Service {
	static inject = ["tokenMeter"];
	static Config = z.object({
		thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
		headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
		tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars)
	});
	...
		constructor(ctx, config = {}) {
		super(ctx, "toolResultPruner");
		this.config = resolveConfig(config);
	}
```
```js
const DEFAULTS = deepFreeze({
	thresholdChars: 8192,
	headChars: 4096,
	tailChars: 1024
});
```
`headChars + marker + tailChars ≤ thresholdChars` is enforced (line 44). The marker is `const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";` (line 8). Config is in **characters**, not tokens.

---

## 4. Compaction events

### 4.1 They are session-log events, not Cordis `Events`

Declaration-merged into `SessionEventMap` in `<root>\dsh-compaction\lib\types\types.d.ts:14-99`. Owner: `dsh-compaction` (the declaration module). Verbatim payloads:

```ts
declare module '@deepseek-ai/dsh-session/types' {
    interface SessionEventMap {
        'compaction/start': {
            compactionId: CompactionId;
            sourceCommandId?: CommandId;
            turn: number | null;
        };
        'compaction/summary': {
            compactionId: CompactionId;
            sourceCommandId?: CommandId;
            summary: ContentBlock[];
            shadowedRange: {
                start: SessionSeq;
                end: SessionSeq;
            };
            shadowedSeqs: SessionSeq[];
            shadowedTokenCount: number;
            provider: string;
            model: string;
            maxTokens?: number;
            usage?: TokenUsage;
        } & ({
            rawOutput: ContentBlock[];
            llmStreamCall: true;
        } | {
            rawOutput?: ContentBlock[];
            llmStreamCall?: never;
        });
        'compaction/end': {
            compactionId: CompactionId;
            sourceCommandId?: CommandId;
            turn: number | null;
            error?: string;
        };
        'compaction/prune': {
            shadowedRange: {
                start: SessionSeq;
                end: SessionSeq;
            };
            shadowedSeqs: SessionSeq[];
            shadowedTokenCount: number;
        };
    }
}
```

All four are **log-only, never on the surface** (no `surfaceOp`); the summary lands as a separate replacement `user/message`.

### 4.2 The emit calls

`<root>\dsh-compaction-basic\lib\index.js:446-452` (start — before summarization yields):

```js
	const compactionId = CompactionId(randomUUID());
	const lifecycle = {
		compactionId,
		...options.sourceCommandId === void 0 ? {} : { sourceCommandId: options.sourceCommandId },
		turn: owner
	};
	const startEvent = session.append("compaction/start", lifecycle);
```

`:605-632` (summary + the single surface mutation + `sourceEventSeqs`):

```js
	const summaryEvent = session.append("compaction/summary", {
		compactionId: startEvent.data.compactionId,
		...startEvent.data.sourceCommandId === void 0 ? {} : { sourceCommandId: startEvent.data.sourceCommandId },
		summary,
		...callProvenance,
		shadowedRange: {
			start,
			end
		},
		shadowedSeqs: [...shadowedSeqs],
		shadowedTokenCount,
		provider,
		model,
		...maxTokens === void 0 ? {} : { maxTokens },
		...usage === void 0 ? {} : { usage }
	});
	session.append("user/message", checkpointMessage, {
		surfaceOp: {
			op: "replace",
			startSeq: start,
			endSeq: end
		},
		sourceEventSeqs: [
			startEvent.seq,
			summaryEvent.seq,
			...shadowedSeqs
		]
	});
```

`:465-467` (success close) and `:478-481` (failure close):

```js
		const pending = commitCompactionBody(session, startEvent, summarized);
		closing = true;
		const endEvent = session.append("compaction/end", lifecycle);
```
```js
				session.append("compaction/end", {
					...lifecycle,
					error: errorChain(error)
				});
```

`<root>\dsh-compaction-tool-result-pruner\lib\index.js:162-180` (prune shadow price, immediately followed by the replacement):

```js
			session.append("compaction/prune", {
				shadowedRange: {
					start: seq,
					end: seq
				},
				shadowedSeqs: [seq],
				shadowedTokenCount: this.ctx.tokenMeter.estimateMessage(event.data.message)
			});
			const replacement = session.append("tool/result", {
				...event.data,
				message
			}, {
				surfaceOp: {
					op: "replace",
					startSeq: seq,
					endSeq: seq
				},
				sourceEventSeqs: [seq]
			});
```

### 4.3 How to listen — `"about to happen"` and `"finished"`

The Cordis hook is the session firehose. `<root>\dsh-session\lib\types\index.d.ts:62`:

```ts
        'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
```

described as `@mode emit` / "Post-commit, fire-and-forget append feed" (lines 51-61). Real usages show the argument order: `<root>\dsh-compaction-basic\lib\index.js:815-819` — `ctx.on("session/event", (session, event) => { ... })`; `<root>\dsh-token-meter\lib\index.js:618-620` — `ctx.on("session/event", (session) => { ... })`.

- **"about to happen" = `compaction/start`.** It is appended *synchronously before* summarization awaits, and it doubles as the lock. Comment at `<root>\dsh-compaction-basic\lib\index.js:419-423`: *"Idle/log validation and `compaction/start` are synchronously adjacent, so the durable opening marker is the compaction lock before summarization yields."* Caveat: by the time it fires, the range has already been selected, validated and the threshold already crossed — the *decision* itself is not an event.
- **"finished" = `compaction/end`.** `error` absent ⇒ success (invariant: `<root>\dsh-compaction\lib\invariant.js:171` — `if (event.data.error === void 0 && !open.summarized) fail("successful compaction/end requires one compaction/summary");`). Match `compactionId` across start/summary/end.
- `compaction/summary` carries `shadowedTokenCount` (heuristic) for "how much was freed".
- The landed checkpoint is recognizable backend-independently by the replacement `user/message`'s source marker: `<root>\dsh-compaction\lib\index.js:109-133` — `const COMPACT_CHECKPOINT_MARKER = Object.freeze({ kind: "plugin", plugin: "compact" });` and `isCompactCheckpointSource(source)`.

Pre-existing observers (proof the firehose is enough): `<root>\dsh-client-ui-trajectory\lib\client.js:938-957`, `<root>\dsh-client-ui-chat\lib\client.js:5846-5907`, `<root>\dsh-token-meter\lib\index.js:305` (`foldSurfaceProjection` consumes `compaction/summary`/`compaction/prune` shadow prices), `<root>\dsh-compaction\lib\invariant.js`.

---

## 5. Early warning precedent — **none found**

There is **no** existing mechanism that warns the *model* about context pressure before compaction. Specifically:

- No package appends a model-visible reminder, system message, or prompt section about token/context pressure. Greps for `context pressure`, `context limit`, `token pressure`, `approaching` across all package `README.md` return only prose describing compaction itself, never a warning artifact.
- The only "warning" in the compaction path is a **host log line, not model-visible** — `<root>\dsh-compaction-basic\lib\index.js:803-808`:
  ```js
  			} catch (error) {
  				if (error instanceof TargetPressureConfigError) {
  					if (this.warnedPressureConfigTargets.has(error.targetKey)) return next();
  					this.warnedPressureConfigTargets.add(error.targetKey);
  				}
  				const message = error instanceof Error ? error.message : String(error);
  				ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`);
  			}
  ```
  and `<root>\dsh-compaction-basic\README.md:114`: *"the automatic listener warns once for that exact target and continues with full history."*
- The only *pre-compaction* model-visible content is the **checkpoint preamble inside the replacement itself**, which is post-hoc, not a warning — `<root>\dsh-compaction-basic\lib\index.js:257`:
  ```js
  const CHECKPOINT_PREAMBLE = "This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";
  ```
  framed at `:323-335` with `SUMMARY_OPEN_TAG = "<compacted-summary>"` / `SUMMARY_CLOSE_TAG = "</compacted-summary>"` (lines 211-212).
- Occupancy is displayed to the **user**, not the model: `<root>\dsh-client-ui-conversation\lib\client.js:15328-15336` (`contextOccupancy`), fed by the `contextPressure` projection.

**Closest existing precedent for an advisory, model-visible mid-turn injection** — `dsh-repeat-tool-reminder` (a different purpose, but the mechanism to copy):

- Delivered through `additionalContexts` on the `tools/post-execute` decision, source `{kind: 'plugin', plugin: 'repeat-tool-reminder', form: 'notice', summary: '<tool> × <count>'}`; the loop buffers it and appends it as an injected `user/message` after the step's tool results. `<root>\dsh-repeat-tool-reminder\README.md:91`.
- The other model-visible injection channel is the system prompt, appended by the loop as `system/message`: `<root>\dsh-agent-loop\lib\index.js:1019-1027`:
  ```js
  			const commits = this.systemPrompt.project(renderedPrompt, {
  				inHistory: preparedCall?.systemPromptUpdate === "in-history",
  				startsSeries: startsRequestSeries || this.requestSurfaceGeneration !== this.session.surface.replaceGeneration || this.toolsChanged(assembly.tools)
  			});
  			for (const { message, intent } of commits) this.session.append("system/message", {
  				turn,
  				step,
  				message
  			}, intent);
  ```
  (This is the **only** `append("system/message")` call in the whole tree.)
- Prompt sections/context are registered through `ctx.systemPrompt` (`<root>\dsh-system-prompt\lib\index.js:231-266`: `section()`, `context()` with a finite `order`), and the assembly waterfall is `"system-prompt/assemble"` (`lib\index.js:351`).

**The pre-compaction observation point that does exist** (for a warning plugin) is the automatic `agent/pre-step` waterfall, registered by compaction-basic at `<root>\dsh-compaction-basic\lib\index.js:798-811`:

```js
		ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
			if (!signal.aborted) try {
				const result = await this.compactIfNeeded(agent, "pressure", signal);
				if (result !== null) logResult(result, "step pressure");
			} catch (error) {
```

Its payload is declared at `<root>\dsh-agent\lib\types\runtime-types.d.ts:310-319`, `@mode waterfall`, `next: () => Promise<PreStepDecision>`:

```ts
        'agent/pre-step'(this: Scoped<Agent>, payload: {
            agent: Agent;
            messages: UserMessage[];
            turn: number;
            step: number;
            signal: AbortSignal;
        }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
```

A listener registered **before** the compaction-basic row (or using `next()` ordering) can measure pressure itself and inject a reminder — but note there is no event that says "compaction is imminent"; it must re-derive the threshold from `ctx.tokenMeter.measure(session).totalTokens` plus `session.requestContext()?.contextWindow`.

---

## 6. Replaceability / configurability of compaction

### 6.1 It is a Cordis service provided by a composition row

- The seam is the service name `"compaction"` (`<root>\dsh-compaction\lib\index.js:174`: `super(ctx, "compaction")`), merged onto `Context` as `compaction: CompactionEngine` (`<root>\dsh-compaction\lib\types\index.d.ts:61-65`).
- The shipped backend provides that name by subclassing: `<root>\dsh-compaction-basic\lib\index.js:760-787` — `var BasicCompactionEngine = class extends CompactionEngine { static inject = ["llm","tokenMeter","sessions"]; ... constructor(ctx, config = {}) { super(ctx, config); ... } }` (the `super(ctx, config)` chain reaches `CompactionEngine`'s `super(ctx, "compaction")`).
- Composition rows — `<root>\dsh-base\cordis.patch.yml:317-326`:
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
  and `<root>\dsh-base\cordis.patch.yml:394-399`:
  ```yaml
      - id: tool-result-pruner
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
        config:
          thresholdChars: 8192
          headChars: 4096
          tailChars: 1024
  ```
  Note the comment at line 323-324: `command-compact` is **backend independent** — `/compact` follows whichever service provides `compaction`.

### 6.2 Can a third-party plugin override it?

- **Replace: yes, by composition.** Cordis rejects two live registrations of one service name — `<root>\cordis\lib\index.js:812`:
  ```js
  			if (this.store[key]) throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`);
  ```
  So a deployment overrides compaction by **not mounting / disabling the `compaction-basic` row** and mounting its own `CompactionEngine` subclass that calls `super(ctx, "compaction")`. Mounting both in the same isolate scope throws at load. (`ctx.isolate(name)` — `<root>\cordis\lib\index.js:1723-1725` — is the mechanism that would give one scope its own `compaction` symbol; the base row lives in the shared host composition.)
- **Observe: yes, fully.**
  - `ctx.get("compaction")` (optional read, no inject) or `inject: ["compaction"]`.
  - `ctx.on("session/event", (session, event) => ...)` for every `compaction/*` event (§4.3).
  - `ctx.tokenMeter` / `inject: ["tokenMeter"]` for pressure, `session.requestContext()?.contextWindow` for capacity, and `ctx.sessionProjections.snapshot(session, ['contextPressure','contextBreakdown','tokenUsage'])` (`<root>\dsh-session-projection\lib\types\index.d.ts:185`) for the wire views.
- **Configure: yes** — per-row `config` in the composition, identical to the README example (`<root>\dsh-compaction-basic\README.md:48-58`), validated at load with hard failures on unknown keys, duplicate model policies, mutually exclusive retention forms, or a ratio retention not below the threshold.
- **Subclass hook:** `summarize(input, agent, signal)` is documented as *the sole subclass customization hook* (`<root>\dsh-compaction-basic\lib\index.d.ts:20-23`, implementation at `lib\index.js:858-862`); pressure/retention/shrink logic stays with the base class and the singleton token meter.
- **Optional-capability lookup by name:** the engine looks the pruner up dynamically, so any provider of that name is used — `<root>\dsh-compaction-basic\lib\index.js:885`: `const prune = this.ctx.get("toolResultPruner");` (service registered at `<root>\dsh-compaction-tool-result-pruner\lib\index.js:71` as `"toolResultPruner"`).
- No model-facing compaction tool exists: README `<root>\dsh-compaction\README.md:158` — *"Human command, not a model tool — condensation is triggered by the `/compact` command and by automatic pressure; no model-facing compaction tool is registered."*

---

## 7. `dsh-session-stats` — what it actually counts (no tokens)

It contributes **no token or context figures**. Piegonholed here because it was named in the brief.

`<root>\dsh-session-stats\lib\index.js:186-196`:

```js
const name = "session-stats";
/** The projection registry is the plugin's whole purpose; without it the fiber stays pending. */
const inject = ["sessionProjections"];
function apply(ctx) {
	ctx.sessionProjections.register(sessionStatsProjectionDefinition);
}
```

Registered unit key `"sessionStats"`, `stateVersion: 1`, view schema (`lib\index.js:28-37`):

```js
const sessionStatsSchema = z.object({
	turns: z.number().int().nonnegative(),
	steps: z.number().int().nonnegative(),
	llmMs: z.number().nonnegative(),
	toolMs: z.number().nonnegative(),
	ttftMs: z.number().nonnegative(),
	ttftSteps: z.number().int().nonnegative(),
	decodeMs: z.number().nonnegative(),
	decodeTokens: z.number().nonnegative()
}).strict();
```

`decodeTokens` is accumulated from **provider-reported output tokens only** (`lib\index.js:60-64, 119-123`):

```js
function usageOutputTokens(usage) {
	if (typeof usage !== "object" || usage === null) return null;
	const value = usage.outputTokens;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
```

Counted step event is `step/end`, not `assistant/message` (see the module comment at `lib\index.js:9-14`). It is a whole-log fold, so paging and compaction cannot change it (`lib\index.js:175-183`). **Use `dsh-token-meter`, not `dsh-session-stats`, for any context/token signal.**

---

## 8. Summary of the facts a context-pressure feature must rely on

1. `ctx.tokenMeter.measure(session)` → `totalTokens` is the number compaction compares against `floor(contextWindow × thresholdRatio)`; `surfaceTokens`/`nodes[]` are the per-message breakdown; the estimate is 4 chars/token (approximate for CJK/JSON) unless a matching provider usage anchor exists.
2. Context capacity: `session.requestContext()?.contextWindow` (per-session logged record) or the `contextPressure` projection's `contextWindow`; resolved per model by the adapter catalog (`defaultContextWindow` default `1e6` on `deepseek-official`).
3. Compaction triggers at `totalTokens ≥ floor(contextWindow × 0.8)` by default, or unconditionally after a `CONTEXT_WINDOW_EXCEEDED` provider failure.
4. The only observable "compaction is happening" signal is the session event `compaction/start` (post-decision, pre-summary); `compaction/end` (with optional `error`) is the completion, and `compaction/summary` carries `shadowedTokenCount`.
5. Nothing warns the model today. The precedents to imitate are the `agent/pre-step` waterfall (where compaction itself decides) and `additionalContexts` / `system-prompt` sections for model-visible text.
6. Overriding compaction means replacing the composition row; two providers of `"compaction"` in one scope is a hard Cordis load error.
