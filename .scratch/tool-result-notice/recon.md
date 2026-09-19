# DSH recon: registering tools, observing tool results, and where a result notice would attach

Read-only reconnaissance of the installed harness. Version of every package inspected: `0.1.5-rc.2`
(`package.json` of `dsh-tool-todo`, `dsh-spill-policy`, etc.).

Root of all paths below, abbreviated **`<PKGS>`**:

```
E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\
```

There is no TypeScript source in these packages; every claim below cites built JS or `.d.ts`.

---

## 0. Executive answer

- Tools register through the Cordis service **`tools`** (class `ToolRuntime`), method **`register(definition)`**, and
  the definition is built by **`defineTool`** from `@deepseek-ai/dsh-tools`.
  Argument/output schemas are **not** schemastery and **not** zod: they are a DSH-authored JSON-schema DSL
  (`ValueSchemaSpec` / `ParameterSchemaSpec`) compiled to raw JSON Schema at definition time.
  (Schemastery *is* the house library for a plugin's own `Config`.)
- The tool pipeline exposes five Cordis events: `tools/pre-execute`, `tools/execute`, `tools/post-execute`
  (all waterfalls), `tools/result` (observe-only emit), and `tools/ptc-dispatch-log` (waterfall,
  `run_code` sub-calls only). Plus `tools/change` (registry changed).
- **No event payload carries a byte or token size.** There is no size field anywhere; a listener computes it
  itself (the existing spill policy does `Buffer.byteLength(text, "utf8")`).
- The hook that sees a result *after it is produced but before it enters history* is **`tools/post-execute`**:
  the agent loop appends the durable `tool/result` event only after the registry's post-execute stage returns
  (`dsh-agent-loop/lib/index.js:576-577`).
- The cleanest way to append a short note **without truncating** the result is a `tools/post-execute` listener
  returning `{kind:'accept', additionalContexts:[notice]}`. Precedent: `dsh-repeat-tool-reminder` — its whole
  delivery mechanism is exactly this, and the note becomes a plugin-sourced `user/message` after the result.
- Large tool output is *already* handled by three separate mechanisms (retention library, spill policy,
  tool-result pruner) and a truncation notice **already exists** (`describeOmitted` /
  `formatRetentionNotice` / the spill notice) — but it is always attached by *replacing the result content*,
  never as an appended note.

---

## 1. Registering a tool

### 1.1 The service

`<PKGS>\dsh-tools\lib\index.js:2567`

```js
var ToolRuntime = class extends Service {
	static inject = ["systemPrompt"];
	static Config = z.object({
		mode: z.union([
			"native",
			"ptc",
			"both"
		]).default("native"),
		maxParallelSubCalls: z.natural().min(1).default(10)
	});
```

`<PKGS>\dsh-tools\lib\index.js:2605-2606`

```js
	constructor(ctx, config = {}) {
		super(ctx, "tools");
```

So the Cordis **service key is `tools`** (`ctx.tools`), provided by `@deepseek-ai/dsh-tools`
(`<PKGS>\dsh-tools\lib\index.js:1` imports `Service` from `@deepseek-ai/cordis`).
Declared on `Context` in `<PKGS>\dsh-tools\lib\types\index.d.ts:24-27`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        tools: ToolRuntime;
    }
```

### 1.2 The register method

`<PKGS>\dsh-tools\lib\index.js:2773-2782` (signature in `.d.ts:601`: `register(definition: ToolDefinition): () => void`):

```js
	register(definition) {
		const name = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name}" timeoutMs must be a positive finite number`);
		if (name === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the PTC mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, definition), { label: "tools.register()" });
	}
```

Registration is **not** a service provide: nothing is registered under a new Cordis key, and a tool plugin needs
no realm/`isolate` (see `presets/standard/agent.cordis.yml:55-58`: "Both register into the host `tools` registry
and provide nothing, so they need no realm").

### 1.3 What the definition accepts

`<PKGS>\dsh-tools\lib\types\schema.d.ts:178-239` (`DefineToolOptions`) and `:239`:

```ts
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
```

Fields: `name`, `description`, `parameters` (per-property DSL map), `output: { schema, render, presentationMeta? }`,
`timeoutMs?`, `isConcurrencySafe?(args)`, `execute(args, exec)`, `finalizeContent?(exec, result)`,
`presentCall?(args)`, `presentResult?(args, result)`.

`<PKGS>\dsh-tools\lib\types\index.d.ts:106-172` (`ToolDefinition`) — the essentials:

```ts
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
    timeoutMs?: number;
    isConcurrencySafe?(args: unknown): boolean;
    presentCall?(args: unknown): ToolCallView | undefined;
    presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined;
}
```

`<PKGS>\dsh-tools\lib\types\index.d.ts:284-301` (`ToolRunContext`) — the second handler argument:

```ts
export interface ToolRunContext extends ToolExecution {
    deferContext(context: UserMessage): void;
    concludeTurn(): void;
}
```

### 1.4 Which schema library

Three different libraries appear, for three different jobs:

| Job | Library | Evidence |
|---|---|---|
| Tool **arguments/output** | DSH's own JSON-schema DSL, compiled to raw JSON Schema | `<PKGS>\dsh-tools\lib\types\schema.d.ts:9-84`; compiled in `defineTool` |
| Plugin **`Config`** | `@deepseek-ai/schemastery` (`import z from "@deepseek-ai/schemastery"`) | every plugin's `lib/index.js` line 1-2 |
| Session-projection **wire** schema (todo only) | `zod` | `<PKGS>\dsh-tool-todo\lib\index.js:2` `import { z as z$1 } from "zod";` |

`<PKGS>\dsh-tools\lib\index.js:837-848` — `defineTool` compiles the DSL once, at definition time:

```js
function defineTool(options) {
	const userExecute = options.execute;
	...
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
```

`<PKGS>\dsh-tools\lib\index.js:863-867` — the wrapped execute validates first:

```js
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
```

The DSL node kinds (`<PKGS>\dsh-tools\lib\types\schema.d.ts:72`): `string | number | integer | boolean | null |
array | object | json | oneOf`. Requiredness is a per-property annotation: `required: true`
(`schema.d.ts:74-84`). `ArrayValueSchemaSpec.items`, `ObjectValueSchemaSpec.additionalProperties` (mandatory
for object nodes), and `ParameterSchemaSpec` is an "implicit open object root" — the `parameters` object itself
is the property map, not a `{type:'object', properties:{...}}` wrapper.

### 1.5 A complete small registration, verbatim

`<PKGS>\dsh-tool-goal\lib\index.js:264-274` — the smallest complete one in the tree (`get_goal`):

```js
	ctx.tools.register(defineTool({
		name: "get_goal",
		description: GET_DESCRIPTION,
		parameters: {},
		output: GOAL_OUTPUT,
		execute(_args, exec) {
			const execution = goalToolExecution(ctx, exec);
			return Promise.resolve(goalValue(ctx.goals.get(execution.agent)));
		},
		presentCall: () => present("Read current goal", "read")
	}));
```

with the shared output declaration, `<PKGS>\dsh-tool-goal\lib\index.js:240-246`:

```js
const GOAL_OUTPUT = {
	schema: GOAL_VALUE_SCHEMA,
	render: (_args, value) => [{
		type: "text",
		text: JSON.stringify(value)
	}]
};
```

And the full `todo_write` registration, `<PKGS>\dsh-tool-todo\lib\index.js:95-193` (abridged only where marked;
parameters, output and execute are complete):

```js
	ctx.tools.register(defineTool({
		name: "todo_write",
		description: describe(allowParallel),
		parameters: { todos: {
			type: "array",
			required: true,
			description: "The COMPLETE task list, replacing any previous list.",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					content: {
						type: "string",
						required: true,
						description: "What the task is — a short imperative line."
					},
					status: {
						type: "string",
						required: true,
						enum: [...STATUSES],
						description: "pending (not started) | in_progress (now) | completed (done)."
					}
				}
			}
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					todos: { /* array of {content, status}, both required */ },
					counts: {
						type: "object",
						additionalProperties: false,
						required: true,
						properties: {
							pending: { type: "integer", required: true },
							inProgress: { type: "integer", required: true },
							completed: { type: "integer", required: true }
						}
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`
			}]
		},
		execute(args, exec) {
			const todos = toTodoList(args.todos, allowParallel);
			if (!exec.agent) throw new Error("todo_write requires an owning agent session");
			exec.agent.session.append("todo/write", { todos });
			const count = (status) => todos.filter((t) => t.status === status).length;
			return Promise.resolve({
				todos: todos.map((todo) => ({ content: todo.content, status: todo.status })),
				counts: { pending: count("pending"), inProgress: count("in_progress"), completed: count("completed") }
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: "Update todo list",
			kind: "other",
			rawInput: args.todos
		})
	}));
```

### 1.6 How the handler's return value becomes the tool result text

Chain, with exact sites:

1. `execute` returns a **canonical JSON value** (not text, not content blocks).
2. `<PKGS>\dsh-tools\lib\index.js:3414-3445` `createSuccessResult(exec, tool, candidate)`:
   snapshot → `validateJsonSchemaValue(tool.output.schema, detached, "value")` → `deepFreeze` →
   `rendered = tool.output.render(exec.arguments, value)` → `snapshotProjection(tool.name, "render", rendered)`
   → returns `{isError:false, value, content, meta?, concludesTurn?}`.
3. `<PKGS>\dsh-tools\lib\index.js:3465-3484` `materializeFinalResult` builds the frozen published result.
4. `<PKGS>\dsh-agent-loop\lib\index.js:697-713` the loop turns `result.content` into the durable event:

```js
function appendToolResult(session, turn, step, block, result, callSeq) {
	const message = createToolResultMessage({
		callId: block.id,
		content: result.content,
		isError: result.isError
	});
	session.append("tool/result", {
		turn,
		step,
		message,
		...result.error?.info ? { error: result.error.info } : {},
		...result.meta !== void 0 ? { meta: result.meta } : {}
	}, {
		surfaceOp: "append",
		sourceEventSeqs: [callSeq]
	});
}
```

Result shapes, `<PKGS>\dsh-tools\lib\types\index.d.ts:390-412`:

```ts
export interface ToolExecutionSuccess {
    readonly isError: false;
    readonly value: JsonValue;
    readonly content: ContentBlock[];
    readonly error?: never;
    readonly meta?: JsonValue;
    readonly additionalContexts?: UserMessage[];
    readonly concludesTurn?: true;
}
export interface ToolExecutionFailure {
    readonly isError: true;
    readonly error: ToolFailure;
    readonly value?: never;
    readonly content: ContentBlock[];
    ...
}
```

A thrown `execute` becomes text `"Error: <message>"` (`<PKGS>\dsh-tools\lib\index.js:3490-3499` `toolErrorResult`).

---

## 2. Observing tool calls and results

### 2.1 The events, as declared

`<PKGS>\dsh-tools\lib\types\index.d.ts:28-94`:

| Event | Mode | Payload |
|---|---|---|
| `tools/pre-execute` | waterfall | `(exec: ToolExecution, next: () => Promise<PreToolDecision>)` |
| `tools/execute` | waterfall | `(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>)` |
| `tools/post-execute` | waterfall | `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>)` |
| `tools/ptc-dispatch-log` | waterfall | `(dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>)` |
| `tools/result` | **emit** | `(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>)` |
| `tools/change` | **emit** | `()` — a tool was registered/unregistered or a restriction changed |

All are `this: Scoped<ToolRuntime>`: **agent-scoped listeners receive only that agent's calls**
(`dsh-scope` scope-filtered dispatch).

### 2.2 The `exec` payload

`<PKGS>\dsh-tools\lib\types\index.d.ts:197-266`:

```ts
export interface ToolExecutionInput {
    readonly callId: ToolCallId;
    readonly rootCallId?: ToolCallId;
    readonly name: string;
    /** Losslessly JSON-serializable parsed arguments (tools validate their own schema). */
    readonly arguments: unknown;
    /** The agent on whose behalf the call runs (set by the agent loop). */
    readonly agent?: Agent;
    readonly parent?: ToolExecutionToken;
    readonly signal: AbortSignal;
}
export interface ToolExecution extends ToolExecutionInput {
    readonly rootCallId: ToolCallId;
    readonly token: ToolExecutionToken;
}
```

So: **tool name = `exec.name`**, **call id = `exec.callId`**, **arguments = `exec.arguments` (already parsed
JSON, not the raw string)**, agent = `exec.agent`, cancellation = `exec.signal`, nesting = `exec.parent`.

The **raw** argument string is not on the event payload — it is durable only, on the session event
`<PKGS>\dsh-session\lib\types\types.d.ts:328-339`:

```ts
    /**
     * The model requested one tool invocation: `name` with the raw `arguments`
     * JSON string exactly as the model produced it (unparsed). `callId` pairs the
     * call with its `tool/result`.
     */
    'tool/call': {
        turn: number;
        step: number;
        callId: ToolCallId;
        name: string;
        arguments: string;
    };
```

and `<PKGS>\dsh-session\lib\types\types.d.ts:351-361`:

```ts
    'tool/result': {
        turn: number;
        step: number;
        message: ToolResultMessage;
        error?: { name: string; code: string; };
        meta?: JsonValue;
    };
```

### 2.3 Where they are emitted / invoked

- `tools/pre-execute` — `<PKGS>\dsh-tools\lib\index.js:3116`:
  `const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));`
- `tools/execute` — `<PKGS>\dsh-tools\lib\index.js:3213`:
  `const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));`
- `tools/post-execute` — `<PKGS>\dsh-tools\lib\index.js:3378`:
  `const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));`
- `tools/result` — `<PKGS>\dsh-tools\lib\index.js:3284-3302`:

```js
	notifyResult(exec, result) {
		Object.freeze(exec);
		const { name: toolName, callId } = exec;
		const reportFailure = (error) => {
			this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`);
		};
		const callbacks = this.ctx.events.dispatch("emit", [
			scopeTarget(this, exec.agent),
			"tools/result",
			exec,
			result
		]);
		for (const callback of callbacks) try {
			const returned = callback(exec, result);
			Promise.resolve(returned).catch(reportFailure);
		} catch (error) {
			reportFailure(error);
		}
	}
```

  Note: `tools/result` **cannot change the outcome** — return values are discarded, only failures are logged.
- `tools/change` — `<PKGS>\dsh-tools\lib\index.js:2592-2594`:
  `layers = new ScopedLayers((scope) => new ToolLayer(scope), () => { this.ctx.emit("tools/change"); });`

### 2.4 Size / error fields

- **Errored:** yes — `result.isError` plus `result.error: { message, info?: { name, code } }`
  (`types/index.d.ts:356-367`).
- **Byte size / token count:** **NOT FOUND.** No field on `ToolExecution`, `ToolExecutionResult`,
  `PostToolDecision`, `PtcDispatchLog`, or the `tool/result` event carries a size. Every consumer computes it:
  e.g. `<PKGS>\dsh-spill-policy\lib\index.js:160` `const totalBytes = Buffer.byteLength(text, "utf8");`, and
  `<PKGS>\dsh-compaction-tool-result-pruner\lib\index.js:79-83` counts code points via `Array.from(text).length`.

### 2.5 The hook after production, before history — yes

`tools/post-execute` is exactly that seam. Proof of ordering:

- `<PKGS>\dsh-agent-loop\lib\index.js:571-581` `commitReady`:
  ```js
			const result = slot.needsPost ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result) : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result);
			appendToolResult(session, turn, step, call.block, result, callSeqs[committed]);
			for (const context of result.additionalContexts ?? []) acceptContext(context);
  ```
  The `appendToolResult` call (the durable `tool/result`) happens **after** `finalize`, and
  `finalizeScheduledExecution` (`<PKGS>\dsh-tools\lib\index.js:3241-3248`) is what runs `postExecute`.
- After post-execute, `<PKGS>\dsh-tools\lib\index.js:3257-3272` still applies the definition-owned
  `finalizeContent`, then materializes and notifies.

Pipeline order, stated by the package README
(`<PKGS>\dsh-tools\README.md:103`): `tools/pre-execute` → guards → `tools/execute` →
`tools/post-execute` → `finalizeContent` → `tools/result`.

### 2.6 The post-execute decision shape

`<PKGS>\dsh-tools\lib\types\index.d.ts:432-446`:

```ts
export type PostToolDecision = {
    kind: 'accept';
    content?: ContentBlock[];
    value?: never;
    additionalContexts?: UserMessage[];
} | {
    kind: 'accept';
    value: JsonValue;
    content?: never;
    additionalContexts?: UserMessage[];
} | {
    kind: 'block';
    feedback: ContentBlock[];
    additionalContexts?: UserMessage[];
};
```

Enforced at `<PKGS>\dsh-tools\lib\index.js:3389`: replacing **both** `value` and `content` throws; replacing
the `value` of a failed result throws (`:3392`).

---

## 3. `dsh-repeat-tool-reminder` anatomy

**Total line count: 1515 lines** in
`<PKGS>\dsh-repeat-tool-reminder\lib\index.js`. Of those, **lines 1-1352 are inlined bundled dependencies**
(the bundler emits `//#region ../../typert/protocol/src/remote-error.ts` etc.: typert-protocol, util/values,
util/crypto, util/brand, llm message/error/retry-policy/call-config). **The plugin itself is lines 1353-1515**
(`//#region lib/types/index.js`), i.e. ~163 lines.

### 3.1 Its plugin object

There is **no `inject` export** — only `name`, `Config`, `apply`:

`<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1361-1371`

```js
const name = "repeat-tool-reminder";
const Config = z.object({
	thresholds: z.array(z.number()).default([
		3,
		5,
		8
	]),
	include: z.array(z.string()).default([]),
	exclude: z.array(z.string()).default([]),
	argumentsPreviewChars: z.number().default(500)
});
```

`<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1515`

```js
export { Config, apply, name };
```

It reaches the tool pipeline purely through `ctx.on("tools/post-execute", …)` — no `ctx.tools` property access,
so no static injection is needed. (Contrast: tool plugins all declare `inject: ["tools", …]`.)

### 3.2 The reminder source stamp

`<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1372-1380`

```js
/**
* The `{kind:'plugin'}` source stamped on every reminder this guard injects —
* the label is load-bearing (an unlabeled context would render as a user
* prompt in derived history).
*/
const PLUGIN_SOURCE = {
	kind: "plugin",
	plugin: "repeat-tool-reminder"
};
```

### 3.3 Detection: the chain

`<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1399-1412` — canonicalization:

```js
function sortJsonValue(value) {
	if (Array.isArray(value)) return value.map(sortJsonValue);
	if (value !== null && typeof value === "object") {
		const record = value;
		const sorted = {};
		for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key]);
		return sorted;
	}
	return value;
}
/** Canonical string form of a call's arguments: deep key-sort, then stringify. */
function canonicalize(argumentsValue) {
	return JSON.stringify(sortJsonValue(argumentsValue));
}
```

`<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1463-1494` — the counter, keyed per agent in a
`WeakMap` (`const chains = /* @__PURE__ */ new WeakMap();`, line 1457):

```js
	function observe(exec) {
		if (!exec.agent) return void 0;
		if (!tracked(exec.name)) return void 0;
		const canonical = canonicalize(exec.arguments);
		const key = JSON.stringify([exec.name, canonical]);
		const chain = chains.get(exec.agent);
		const count = chain !== void 0 && chain.key === key ? chain.count + 1 : 1;
		chains.set(exec.agent, {
			key,
			count
		});
		if (!thresholdSet.has(count)) return void 0;
		return createUserMessage({
			content: [{
				type: "text",
				text: count === thresholds[0] ? GENTLE_REMINDER : detailedReminder(exec.name, count, previewArguments(canonical, argumentsPreviewChars))
			}],
			source: {
				...PLUGIN_SOURCE,
				form: "notice",
				summary: `${exec.name} × ${count}`
			}
		});
	}
```

with `tracked()` (`:1458-1462`) applying `include`/`exclude` `*`-wildcards (`wildcardToRegExp`, `:1414-1417`);
untracked calls neither count nor reset.

### 3.4 The delivery mechanism

**Not** a system-prompt section, **not** a tool-result text annotation, **not** a session append of its own. It
enriches the `tools/post-execute` decision with `additionalContexts`, delegating via `next()` first:

`<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1495-1512` (the entire mechanism)

```js
	ctx.on("tools/post-execute", async (exec, _result, next) => {
		const reminder = observe(exec);
		const downstream = await next();
		if (!reminder) return downstream;
		if (downstream.kind === "block") return {
			kind: "block",
			feedback: downstream.feedback,
			additionalContexts: prependContext(reminder, downstream.additionalContexts)
		};
		return {
			...downstream,
			additionalContexts: prependContext(reminder, downstream.additionalContexts)
		};
	});
	ctx.on("agent/pre-step", ({ agent, messages }, next) => {
		if (messages.some((message) => message.source.kind === "user")) chains.delete(agent);
		return next();
	});
```

with `<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1442-1444`:

```js
function prependContext(ours, theirs) {
	return [ours, ...theirs ?? []];
}
```

Inside the harness, the context travels: post-execute decision → `result.additionalContexts`
(`<PKGS>\dsh-agent-loop\lib\index.js:578` `acceptContext`) → inbox
(`<PKGS>\dsh-agent-loop\lib\index.js:1118` `this.inbox.splice("next-step", …)`) → claimed at the next step's
`preStep` → appended as a **`user`-role** message
(`<PKGS>\dsh-agent-loop\lib\index.js:1028`):

```js
			if (firstAttempt) for (const message of decision.messages) this.session.append("user/message", message, { surfaceOp: "append" });
```

The role is `user` because it was built with `createUserMessage`
(`<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1483`); the `{kind:'plugin'}` source is what keeps derived
history from reading it as a human turn. Its README states the same
(`<PKGS>\dsh-repeat-tool-reminder\README.md:91`): "Reminders ride the post-execute decision's
`additionalContexts` … never a `content` replacement: the `tool/result` event stays the tool's own output for
audit."

### 3.5 Full config schema

| Field | Schemastery | Default | Meaning (from `lib/types/index.d.ts:20-35`) |
|---|---|---|---|
| `thresholds` | `z.array(z.number()).default([3,5,8])` | `[3, 5, 8]` | Consecutive-repeat counts that trigger a reminder |
| `include` | `z.array(z.string()).default([])` | `[]` | Tool-name `*`-wildcard patterns to track; empty = every tool |
| `exclude` | `z.array(z.string()).default([])` | `[]` | Patterns transparent to the chain (neither count nor reset) |
| `argumentsPreviewChars` | `z.number().default(500)` | `500` | Max chars of canonical arguments quoted in the detailed reminder |

Fail-loud validation in `apply` (not in the schema): `<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1432-1437`
(non-empty, every threshold an integer `>= 2`, no duplicates, sorted ascending) and `:1456`
(`argumentsPreviewChars` integer `>= 1`). Shipped deployment config:
`<PKGS>\dsh-base\cordis.patch.yml:419-423`

```yaml
    - id: repeat-tool-reminder
      name: '@deepseek-ai/dsh-repeat-tool-reminder'
      config:
        thresholds: [3, 5, 8]
        argumentsPreviewChars: 500
```

The two reminder texts, `<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1385-1390`:

```js
const GENTLE_REMINDER = "You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.";
function detailedReminder(toolName, count, canonicalArguments) {
	return `Repeated tool call detected:
- tool: ${toolName}\n- consecutive_calls: ${count}\n- arguments: ${canonicalArguments}\nThe repeated calls are not making progress. Do not call this tool with these exact arguments again. Inspect the latest result and choose a different action, different arguments, or finish the task if enough evidence has been gathered.`;
}
```

---

## 4. Existing size limits

Four independent mechanisms. Only two of them *truncate*, and only one of those *replaces a model-facing result*.

### 4.1 `dsh-output-retention` — a library, no config, no service

`<PKGS>\dsh-output-retention\lib\index.js:18-21`:

```
 * This is deliberately a library, not a cordis service or plugin: it takes no
 * `ctx`, registers nothing, and emits no events. The two retainers are the only
 * stateful pieces and their state is per-instance (one accumulation), never
 * cross-call. Tool packages import it directly when they need bounded output.
```

**No config keys and no defaults** — callers own the budgets. Exports
(`<PKGS>\dsh-output-retention\lib\index.js:285`): `ItemRetainer`, `TextRetainer`, `describeOmitted`,
`formatRetentionNotice`.

- `TextRetainer` (`:139-167` constructor): strategy `{kind:'head', maxBytes}` | `{kind:'tail', maxBytes}` |
  `{kind:'headTail', headBytes, tailBytes}`; budgets must be non-negative integers; UTF-8 boundary preserved at
  `finish()`.
- `ItemRetainer` (`:47-56`): `{kind:'head', maxItems}`.
- The "this output was truncated" wording, `<PKGS>\dsh-output-retention\lib\index.js:261-283`:

```js
function describeOmitted(omitted, unit) {
	switch (omitted.kind) {
		case "none": return "";
		case "exact": return `Omitted ${omitted.count} ${unit}.`;
		case "unknown": return `More ${unit} were omitted.`;
	}
}
function formatRetentionNotice(notice, recovery) {
	return [describeOmitted(notice.omitted, notice.unit), recovery(notice)].filter((part) => part.length > 0).join(" ");
}
```

**So yes, "tell the model this was truncated" already exists as standard wording** — but it is a *library*
helper; whoever truncates must concatenate it. Real callers found by grep:
`<PKGS>\dsh-tool-fs-search\lib\index.js:235-266` (per-line `" (line truncated)"` + `ItemRetainer` cap),
`<PKGS>\dsh-tool-jobs\lib\index.js:84-99` (`retainTail`/`retainHead`, `"[notice truncated]"` at `:123`),
`<PKGS>\dsh-session-reference\lib\index.js:251`.

### 4.2 `dsh-spill` — the storage seam only, no limits

`<PKGS>\dsh-spill\lib\index.js:52-56`:

```js
var SpillStore = class extends Service {
	constructor(ctx) {
		super(ctx, "spillStore");
	}
};
```

One method, `saveText(input) → { locator, bytes, retrievalHint }`. It explicitly owns "NO retention policy …
NO tool-result replacement" (`<PKGS>\dsh-spill\lib\index.js:29-31`).
Backend `dsh-spill-local` Config, `<PKGS>\dsh-spill-local\lib\index.js:482-485`:

```js
	static Config = z.object({
		root: z.string(),
		cleanupPeriodDays: z.number().step(1).min(0).default(30)
	});
```

and the retrieval hint, `<PKGS>\dsh-spill-local\lib\index.js:566`:
`retrievalHint: "Use read with offset/limit, or grep this path to search within it."`
No byte limit exists in the store; files land under `<root>/session-<sha256(sessionId)[0:12]>/`.

### 4.3 `dsh-spill-policy` — the mechanism that truncates AND notices

**Config schema**, `<PKGS>\dsh-spill-policy\lib\index.js:74`:

```js
const Config = z.object({ maxInlineBytes: z.number() });
```

**No schema default.** Omitted ⇒ the plugin is a true no-op,
`<PKGS>\dsh-spill-policy\lib\index.js:102-105`:

```js
function apply(ctx, config) {
	const maxInlineBytes = config.maxInlineBytes;
	if (maxInlineBytes === void 0) return;
	if (!Number.isInteger(maxInlineBytes) || maxInlineBytes < 0) throw new Error(`spill-policy: maxInlineBytes must be a non-negative integer (got ${maxInlineBytes})`);
```

**Shipped value: `50000`** — `<PKGS>\dsh-base\cordis.patch.yml:383-386`:

```yaml
    - id: spill-policy
      name: '@deepseek-ai/dsh-spill-policy'
      config:
        maxInlineBytes: 50000
```

(this row is **not** disabled by the Web overlay, so it is live in the Web deployment's host plane).

Role, `<PKGS>\dsh-spill-policy\lib\index.js:26-36`: "a `tools/post-execute` result transformer that keeps
oversized plain-text tool results out of the model's context. When a final result's UTF-8 size exceeds
`maxInlineBytes`, it saves the FULL text to a session-scoped spill artifact (`ctx.spillStore`) and replaces the
model-facing result with a bounded head/tail preview plus the backend's locator and retrieval guidance."

The preview, `<PKGS>\dsh-spill-policy\lib\index.js:88-101`:

```js
function preview(text, budget) {
	const retainer = new TextRetainer({
		kind: "headTail",
		headBytes: Math.ceil(budget / 2),
		tailBytes: Math.floor(budget / 2)
	});
	retainer.push(text);
	const kept = retainer.finish();
	return {
		text: kept.text,
		omitted: kept.omittedBytes
	};
}
```

The notice, `<PKGS>\dsh-spill-policy\lib\index.js:5-23`:

```js
const OPEN = "(";
const CLOSE = ")";
const LOCATION = " Full formatted result stored at: ";
const GUIDANCE_SEPARATOR = ". ";
...
function formatSpillNotice(omitted, ref) {
	return `${OPEN}${describeOmitted(omitted, "bytes")}${LOCATION}${ref.locator}${GUIDANCE_SEPARATOR}${ref.retrievalHint}${CLOSE}`;
}
```

rendering as (README `:51-55`):

```text
<retained head/tail preview>

(Omitted N bytes. Full formatted result stored at: /…/session-…/…-web_fetch.txt. Use read with offset/limit, or grep this path to search within it.)
```

Budget arithmetic + failure containment, `<PKGS>\dsh-spill-policy\lib\index.js:142-153`:

```js
		const reserve = Buffer.byteLength(formatSpillNotice({
			kind: "exact",
			count: totalBytes
		}, ref), "utf8") + 2;
		const { text: previewText, omitted } = preview(text, Math.max(0, cap - reserve));
		const notice = formatSpillNotice(omitted, ref);
		const replacedText = previewText.length > 0 ? `${previewText}\n\n${notice}` : notice;
		if (Buffer.byteLength(replacedText, "utf8") > cap) {
			ctx.logger.warn(`spill-policy: spill notice for ${toolName} exceeds maxInlineBytes; keeping the inline content`);
			return;
		}
		return replacedText;
```

The model-facing arm, `<PKGS>\dsh-spill-policy\lib\index.js:155-172`:

```js
	ctx.on("tools/post-execute", async (exec, result, next) => {
		const decision = await next();
		if (decision.kind !== "accept" || Object.hasOwn(decision, "value") || exec.parent !== void 0 || exec.name === "read") return decision;
		const text = flattenPlainText(decision.content ?? result.content);
		if (text === void 0) return decision;
		const totalBytes = Buffer.byteLength(text, "utf8");
		if (totalBytes <= maxInlineBytes) return decision;
		const replacedText = await spillReplacement(text, totalBytes, ownerSessionId(exec), exec.name, exec.callId, "result");
		if (replacedText === void 0) return decision;
		return {
			kind: "accept",
			content: [{
				type: "text",
				text: replacedText
			}],
			...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}
		};
	}, { prepend: true });
```

Skips: nested (`exec.parent !== void 0`), `read` (loop avoidance), non-text content
(`flattenPlainText`, `:76-83`), accepted **value** replacements, and block decisions. Best-effort: no session
owner / no `ctx.spillStore` / `saveText` rejection / notice exceeding cap ⇒ keep the original
(`:114-154`). A second arm bounds the durable log copy of `run_code` sub-calls via
`tools/ptc-dispatch-log` (`:173-185`).

Recognition (browser-safe subpath export `./notice`,
`<PKGS>\dsh-spill-policy\package.json` `exports`): `formatSpillNotice` and `hasSpillNotice`
(`<PKGS>\dsh-spill-policy\lib\types\notice.js:17-19, 34-50`).

### 4.4 `dsh-compaction-tool-result-pruner` — the token-side pruner

`<PKGS>\dsh-compaction-tool-result-pruner\lib\index.js:8-14, 61-67`:

```js
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
const DEFAULTS = deepFreeze({
	thresholdChars: 8192,
	headChars: 4096,
	tailChars: 1024
});
...
var ToolResultPruner = class extends Service {
	static inject = ["tokenMeter"];
	static Config = z.object({
		thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
		headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
		tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars)
	});
```

Service key `toolResultPruner` (`:71`), counts **Unicode code points** (`:79-83`), head/middle/tail pruning
(`:91-121`). Shipped: mounted on the host plane (`<PKGS>\dsh-base\cordis.patch.yml:394-399`) but **disabled in
the Web overlay** (`<PKGS>\dsh-web-app\cordis.patch.yml:433-434`) and re-mounted inside the `standard` preset's
compaction realm (`<PKGS>\dsh-agent-presets\presets\standard\agent.cordis.yml:138-156`), because
`compaction-basic` reads it through `ctx.get`.

### 4.5 Summary of "does a truncation notice already exist?"

**Yes, twice over:**
- generic wording: `describeOmitted(omitted, unit)` → `"Omitted N bytes."` (`dsh-output-retention`);
- the persisted, recognizable spill notice
  `(Omitted N bytes. Full formatted result stored at: <locator>. <retrievalHint>)`
  (`dsh-spill-policy`, `./notice` subpath).

But both are attached by **replacing the result content** (spill) or by a tool's own renderer (retention).
**No existing mechanism appends a separate notice message next to an untruncated result** — that is the gap a
new plugin would fill, and its natural home is the same `tools/post-execute` seam.

---

## 5. Where a tool-result notice would be attached

### Recommendation: `tools/post-execute`, returning `additionalContexts`

The cleanest supported hook, because it:
- sees the final normalized result (`result.content`, `result.isError`) *before* the durable `tool/result` is
  appended (`dsh-tools/lib/index.js:3241-3248` + `dsh-agent-loop/lib/index.js:576-577`);
- is a **waterfall**, so it composes with `next()` and with the already-mounted spill policy (which registered
  with `{ prepend: true }` and calls `next()`, see `dsh-spill-policy/lib/index.js:155`);
- leaves the tool result untouched (good for audit and the `tools/result` observers), unlike a `content`
  replacement.

**Exact precedent doing exactly this, for a different reason** —
`<PKGS>\dsh-repeat-tool-reminder\lib\index.js:1495-1508` (quoted in full in §3.4). Its returned decision is:

```js
		return {
			...downstream,
			additionalContexts: prependContext(reminder, downstream.additionalContexts)
		};
```

**The other precedent, which modifies the result instead** —
`<PKGS>\dsh-spill-policy\lib\index.js:155-172` returns `{kind:'accept', content:[…], …}`.

A note-only plugin would look like:

```js
ctx.on("tools/post-execute", async (exec, result, next) => {
  const decision = await next();
  if (decision.kind !== "accept") return decision;
  const text = /* flatten decision.content ?? result.content */;
  if (Buffer.byteLength(text, "utf8") <= maxInlineBytes) return decision;
  return { ...decision, additionalContexts: [notice, ...decision.additionalContexts ?? []] };
});
```

### Constraints a new plugin must honor

1. **Delegating with `next()` is mandatory** for composition; the spill policy's own header documents the
   contract (`<PKGS>\dsh-spill-policy\lib\index.js:62-66`).
2. The context **must** be a `UserMessage` from `@deepseek-ai/dsh-llm` (`createUserMessage`, used at
   `dsh-tool-goal/lib/index.js:365` and `dsh-repeat-tool-reminder/lib/index.js:1483`) with a
   `source: { kind: 'plugin', plugin: '<name>', form: 'notice', summary: <bounded string> }`.
   The comment at `dsh-repeat-tool-reminder/lib/index.js:1372-1376` warns that an unlabeled source "would render
   as a user prompt in derived history"; `dsh-tool-goal` bounds its summary with
   `boundContextSummary(...)` (`dsh-tool-goal/lib/index.js:365-373`).
3. It becomes a **`user`-role** session event after the results
   (`dsh-agent-loop/lib/index.js:1028`), retained in history until compaction.
4. Async listeners must observe `exec.signal` (`dsh-tools/lib/types/index.d.ts:51-59`).
5. `tools/result` is **not** an option (return values are discarded, `dsh-tools/lib/index.js:3284-3302`).
6. A per-tool `finalizeContent` (`dsh-tools/lib/types/index.d.ts:120-131`) is a clean last-mile *content*
   transform, but only for tools you own, and it also replaces content rather than appending a note.

### Where the row would mount in the shipped deployment

- `tools/post-execute` transformers that belong to the deployment rather than one agent live on the **host
  plane**: `spill-policy` sits at `<PKGS>\dsh-base\cordis.patch.yml:383-386` and is *not* disabled by the Web
  overlay. `repeat-tool-reminder` is likewise host-plane (`:419-423`).
- Model-facing **tool** rows instead live in the agent preset: the base mounts them
  (`<PKGS>\dsh-base\cordis.patch.yml:401-409`) and the Web overlay disables them
  (`<PKGS>\dsh-web-app\cordis.patch.yml:467-468`), with `presets/standard/agent.cordis.yml:95-99, 241-244,
  254-255` re-mounting them per agent.
- Authored presets live outside the install, one directory per preset under
  `${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>/`.

---

## 6. Tool config schema convention (house style)

### 6.1 The export shape

Every plugin inspected exports four **named** constants/functions and no default:

```js
const name = "...";
const inject = [...];          // service keys (omitted by repeat-tool-reminder)
const Config = z.object({...}); // schemastery
function apply(ctx, config) {...}
export { Config, apply, inject, name };
```

Attested:
- `<PKGS>\dsh-tool-todo\lib\index.js:11-12, 20, 78, 196`
- `<PKGS>\dsh-tool-goal\lib\index.js:106-113, 115, 257, 380`
- `<PKGS>\dsh-tool-present\lib\index.js:6, 8, 10-14, 21, 20`
- `<PKGS>\dsh-spill-policy\lib\index.js:71-74, 102, 188`
- `<PKGS>\dsh-agent-tool-presentation\lib\index.js:23, 29, 31-35, 41, 51`

### 6.2 Three real `Config` schemas, verbatim

**(a) `dsh-tool-todo`** — `<PKGS>\dsh-tool-todo\lib\index.js:11-12, 19-20, 78-79, 95`:

```js
const name = "tool-todo";
const inject = ["tools", "sessionProjections"];
/** Schemastery configuration for the todo tool consumer. */
const Config = z.object({ allowParallelInProgress: z.boolean().required() });
...
function apply(ctx, config) {
	const allowParallel = config.allowParallelInProgress;
	...
	ctx.tools.register(defineTool({ ... }));
```

Note the `.required()` with no default: the deployment **must** supply it. Shipped:
`allowParallelInProgress: true` (`<PKGS>\dsh-base\cordis.patch.yml:401-404`).

**(b) `dsh-tool-goal`** — `<PKGS>\dsh-tool-goal\lib\index.js:106-115, 257-263`:

```js
const name = "tool-goal";
const inject = [
	"agents",
	"goals",
	"tools",
	"systemPrompt",
	"sessionProjections"
];
/** Schemastery config for the goal-tool policy. */
const Config = z.object({ blockedAfterConsecutiveRounds: z.number().step(1).min(1).default(3) });
...
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	ctx.systemPrompt.section({
		name: "tool:goal",
		order: ctx.systemPrompt.getSectionOrder("TOOL_GOAL"),
		text: guidance(resolved.blockedAfterConsecutiveRounds)
	});
	ctx.tools.register(defineTool({ ... }));
```

with belt-and-braces re-validation for direct (non-Loader) construction —
`<PKGS>\dsh-tool-goal\lib\index.js:198-203`:

```js
function resolveConfig(config) {
	const blockedAfter = config.blockedAfterConsecutiveRounds ?? 3;
	if (!Number.isSafeInteger(blockedAfter) || blockedAfter < 1) throw new TypeError("blockedAfterConsecutiveRounds must be a positive safe integer");
	return { blockedAfterConsecutiveRounds: blockedAfter };
}
```

**(c) `dsh-tool-present`** — `<PKGS>\dsh-tool-present\lib\index.js:6-14, 21-23`:

```js
const name = "tool-present";
/** Validated delivery limit. */
const Config = z.object({ maxFiles: z.number().default(8) });
/** Services used by the scoped delivery tool. */
const inject = [
	"tools",
	"fs",
	"sessionProjections"
];
function apply(ctx, config) {
	if (!Number.isSafeInteger(config.maxFiles) || config.maxFiles < 1) throw new Error("present requires a positive integer maxFiles");
	const pending = /* @__PURE__ */ new WeakMap();
	ctx.tools.register(defineTool({ ... }));
```

**(d) `dsh-spill-policy`** (a post-execute transformer, the closest shape to a "notice" plugin) —
`<PKGS>\dsh-spill-policy\lib\index.js:70-74`:

```js
/** Cordis plugin name used by loader diagnostics. */
const name = "spill-policy";
/** Require the tool registry (its `tools/post-execute` waterfall is the extension point we transform). */
const inject = ["tools"];
const Config = z.object({ maxInlineBytes: z.number() });
```

**(e) `dsh-agent-tool-presentation`** (a preset-plane selector) —
`<PKGS>\dsh-agent-tool-presentation\lib\index.js:23-49`:

```js
const name = "tool-presentation";
const inject = ["tools"];
/** Runtime schema. */
const Config = z.object({ mode: z.union([
	"native",
	"ptc",
	"both"
]).required() });
function apply(ctx, config) {
	if (config.mode === "native") {
		ctx.tools.presentAs("native");
		return;
	}
	ctx.inject(["codeRuntime"], (runtimeCtx) => {
		runtimeCtx.tools.presentAs(config.mode);
	});
}
```

### 6.3 Schemastery idioms observed

| Idiom | Example site |
|---|---|
| `z.boolean().required()` (no default) | `dsh-tool-todo/lib/index.js:20` |
| `z.number().step(1).min(1).default(3)` | `dsh-tool-goal/lib/index.js:115` |
| `z.number().step(1).min(0).default(30)` | `dsh-spill-local/lib/index.js:484` |
| `z.array(z.string()).default([])` | `dsh-repeat-tool-reminder/lib/index.js:1368-1369` |
| `z.natural().min(1).default(10)` | `dsh-tools/lib/index.js:2575` |
| `z.union([...]).required()`, `z.union([...]).default("native")` | `dsh-tool-presentation/lib/index.js:31-35`, `dsh-tools/lib/index.js:2570-2574` |
| bare `z.number()` = optional, no default | `dsh-spill-policy/lib/index.js:74` |

### 6.4 Conventions beyond the schema

- Doc style: JSDoc `/** … */` blocks on `name`, `Config`, `apply`, and each helper, with `@param`/`@returns`
  (see `dsh-tool-todo/lib/index.js:5-10, 19, 72-77`).
- `apply` validates fail-loud for anything the schema cannot express, and throws at load (never silently
  defaults): `dsh-tool-present/lib/index.js:21`, `dsh-tool-goal/lib/index.js:201`,
  `dsh-repeat-tool-reminder/lib/index.js:1433-1436, 1456`, `dsh-spill-policy/lib/index.js:105`.
- Every side effect an `apply` creates is owned by the plugin fiber: `ctx.tools.register()` returns the exact
  disposer (`dsh-tools/lib/index.js:2773-2782`), `ctx.on(...)` is fiber-scoped, `ctx.get('spillStore')` is read
  opportunistically rather than injected because storage is optional
  (`dsh-spill-policy/lib/index.js:119-123`).

---

## 7. Explicit negatives (things NOT found)

- **No byte/token size on any tool event payload.** Not on `ToolExecution`, `ToolExecutionResult`,
  `PostToolDecision`, `PtcDispatchLog`, or the durable `tool/result` event. Callers compute it.
- **No "append a note to a tool result" hook that preserves the result text.** The only content-preserving
  channel is `additionalContexts` (a *separate* `user/message`), and the only result-touching channels are
  `content`/`value` replacement in `tools/post-execute`, per-tool `finalizeContent`, and
  `tools/ptc-dispatch-log` (log copy only).
- **No `Config` schema or defaults in `dsh-output-retention`** — it is a plain library with no plugin entry.
- **No size limit in `dsh-spill` / `dsh-spill-local`** — storage only; the limit lives in `dsh-spill-policy`.
- **`dsh-repeat-tool-reminder` does not export `inject`** and does not touch `ctx.tools` — it is the only
  inspected plugin that hooks the pipeline with bare `ctx.on`.
- The built packages contain **no README/config reference for pruner defaults beyond the code**, and no
  `.ts` sources; `schema.d.ts` / `types.d.ts` files are the authoritative interface documentation shipped in
  the package.
