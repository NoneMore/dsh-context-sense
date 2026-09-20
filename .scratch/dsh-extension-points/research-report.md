# DSH plugin extension points: events/hooks and context injection

Reference checkout: `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\` — package version **0.1.5-rc.1**
(`package.json:4`), bundled sub-packages at version `0.1.5-rc.2`.

All paths below are relative to that checkout unless written in full. The shorthand
`ROOT` = `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`.
The checkout was treated as read-only.

## 0. Executive summary

1. **Yes — there is a typed pub/sub + waterfall hook system.** Plugins register listeners with
   `ctx.on('event/name', handler, options?)` on the Cordis `Context`. There is **no** `onEvent`,
   `subscribe`, or `hooks: {}` map in the event system (those names appear only in unrelated
   client/UI observers). Dispatch modes are `emit | parallel | serial | bail | waterfall`.
2. **Several hooks can mutate the request or its result**, but the mutation surface is deliberately
   narrow: system-prompt text via `system-prompt/assemble` + `ctx.systemPrompt.section()`, the
   entering message batch via `agent/pre-step`, tool results via `tools/post-execute`, tool
   permission via `tools/pre-execute`. `agent/request` can change *config only* (the code says
   explicitly it "cannot mutate messages").
3. **The canonical out-of-band text mechanism is an injected user-role message** —
   `createUserMessage({ content, source: { kind: 'plugin', plugin, form?, ... } })` folded into
   `agent/pre-step`'s returned `messages`, or queued with `agent.inject()`. DSH has **no shared
   `<system-reminder>` helper**; each producer builds its own frame. Two shipped producers exist:
   `dsh-agent-instructions` (workspace instructions) and `dsh-tool-skill` (skill catalog).
4. **No built-in tool exposes the transcript.** Session-state readers are `list_agents`,
   `job_output`/`job_list`, `get_goal`, `present`, `skill`, `exit_plan_mode`, `cordis_inspect_self`.
5. Sanctioned alternatives to prompt mutation: register a tool, register a system-prompt section,
   inject an attributed user message, attach `additionalContexts` to a tool decision, append a
   custom durable session event, register a command, or read a session projection.
6. **Yes, there are worked examples** — `dsh-agent-instructions` (injects `<system-reminder>`
   frames and reacts to filesystem touches) and `dsh-compaction-basic` (reacts to context size).

---

## 1. The event / hook / pub-sub system

### 1.1 The registry API

There is no bespoke "hook registry". The event bus is the Cordis `EventsService`, installed as
`ctx.events` and **mixed into every `Context`**, so `ctx.on(...)` is the API.

`ROOT\cordis\lib\types\events.d.ts:25`
```ts
export type DispatchMode = 'emit' | 'parallel' | 'serial' | 'bail' | 'waterfall';
```

The exact listener-registration signatures — `ROOT\cordis\lib\types\events.d.ts:80-97`:
```ts
        /**
         * Register an event listener owned by the current fiber.
         *
         * @param name — the event name to listen for.
         * @param listener — called with the dispatch arguments.
         * @param options — listener options; a boolean is shorthand for `prepend`.
         * @returns a disposer removing the listener; `true` if it was still registered.
         */
        on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean;
        /**
         * Same as `on()`, but the listener disposes itself after its first call.
         */
        once<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean;
```

Listener options — `ROOT\cordis\lib\types\events.d.ts:100-111`:
```ts
export interface EventOptions {
    /** Add the listener before existing listeners for the same event. */
    prepend?: boolean;
    /** Receive the event regardless of context filter checks. */
    global?: boolean;
}
/** Registered listener record stored by the event service. */
export interface Hook extends EventOptions {
    ctx: Context;
    callback: (...args: any[]) => any;
}
```

Dispatch methods (for a plugin that *produces* events) — `ROOT\cordis\lib\types\events.d.ts:35-79`:
```ts
        parallel<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promise<void>;
        emit<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): void;
        serial<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): Promisify<ReturnType<Events[K]>>;
        bail<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>;
        waterfall<K extends keyof Events>(name: K, ...args: Parameters<Events[K]>): ReturnType<Events[K]>;
```

Semantics of `waterfall` (`ROOT\cordis\lib\types\events.d.ts:67-77`): *"Each listener wraps the rest
of the chain: calling `next()` invokes the next listener (finally the built-in behavior); not
calling it vetoes."*

Event names are typed by **declaration merging into the global `interface Events`**. A plugin adds
its own events the same way, e.g. `ROOT\dsh-tools\lib\types\index.d.ts:24-27`:
```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        tools: ToolRuntime;
    }
    interface Events {
```

**The authoritative event catalog is itself introspectable at runtime:** `dsh-tool-cordis` embeds
every event's name and full signature string, e.g. `ROOT\dsh-tool-cordis\lib\index.js:5017-5019`:
```js
		name: "agent/pre-step",
		signature: "'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>",
```
and exposes it through the `cordis_inspect_list` / `cordis_inspect_query` / `cordis_inspect_self`
tools (`ROOT\dsh-tool-cordis\lib\index.js:9115`, `:9131`, `:9174`).

### 1.2 Live agent/session events (the extension-point surface)

Declared in `ROOT\dsh-agent\lib\types\runtime-types.d.ts:212-418`. Most are **scope-filtered**:
agent-scoped listeners receive only their own agent (via `@deepseek-ai/dsh-scope`).

| Event | Mode | Payload | Line |
|---|---|---|---|
| `agent/created` | emit | `{ agent: Agent }` | 224 |
| `agent/disposed` | emit | `{ agent: Agent }` | 235 |
| `agent/status` | emit | `{ agent: Agent; status: AgentStatus }` | 247 |
| `agent/inbox/inserted` | emit | `{ agent, message: UserMessage }` | 258 |
| `agent/inbox/claimed` | emit | `{ agent, message, turn: number }` | 272 |
| `agent/inbox/discarded` | emit | `{ agent, message }` | 284 |
| **`agent/session-start`** | emit | `{ agent: Agent; source: SessionStartSource }` | 298 |
| **`agent/pre-step`** | waterfall | `{ agent, messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }` → `Promise<PreStepDecision>` | 313 |
| **`agent/request`** | waterfall | `{ agent, turn, step, signal }` → `Promise<LlmCallConfig>` | 336 |
| **`agent/request-error`** | waterfall | `{ agent, turn, step, provider, failure: LlmFailure, retryPolicy, signal }` → `Promise<RequestErrorAction>` | 357 |
| `agent/assistant-stream` | emit | `{ agent, frame: AssistantStreamFrame }` | 375 |
| **`agent/turn-stopping`** | serial | `{ agent, turn, signal }` → `Promise<void> \| void` | 396 |
| `agent/error` | emit | `{ agent, turn, step, error: unknown }` | 411 |

`SessionStartSource` is the "session start" discriminator —
`ROOT\dsh-agent\lib\types\runtime-types.d.ts:105`:
```ts
export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';
```

`PreStepDecision` — `ROOT\dsh-agent\lib\types\runtime-types.d.ts:91-99`:
```ts
/** Whether and with which messages the loop enters a proposed step. */
export type PreStepDecision = {
    kind: 'reject';
} | {
    kind: 'enter';
    messages: UserMessage[];
    /** Start a distinct model-message series before this step's admitted messages. */
    startsRequestSeries?: true;
};
```

`RequestErrorAction` — `ROOT\dsh-agent\lib\types\runtime-types.d.ts:100-103`:
```ts
export type RequestErrorAction = {
    kind: 'retry';
} | undefined;
```

`agent/session-start`'s own doc states the injection intent —
`ROOT\dsh-agent\lib\types\runtime-types.d.ts:288-298`:
```
         * The session lifecycle began, once before the first turn. Use
         * `agent.inject()` to seed model-facing context. This is a notification, not
         * a veto; ...
```

### 1.3 Tool pipeline events

Declared in `ROOT\dsh-tools\lib\types\index.d.ts:28-94`.

| Event | Mode | Signature | Line |
|---|---|---|---|
| **`tools/pre-execute`** | waterfall | `(exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>` | 38 |
| **`tools/execute`** | waterfall | `(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => Promise<ToolExecutionResult>` | 49 |
| **`tools/post-execute`** | waterfall | `(exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>` | 61 |
| `tools/ptc-dispatch-log` | waterfall | `(dispatch: PtcDispatchLog, next: () => Promise<ContentBlock[]>) => Promise<ContentBlock[]>` | 75 |
| `tools/result` | emit | `(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => undefined` | 83 |
| `tools/change` | emit | `() => void` | 93 |

`tools/result` is observe-only, and its doc is explicit —
`ROOT\dsh-tools\lib\types\index.d.ts:77`:
```
         * Observe the frozen, lossless-JSON final outcome. Listener failures are contained.
```

### 1.4 Prompt-assembly events

`ROOT\dsh-system-prompt\lib\types\index.d.ts:14-34`:
```ts
    interface Events {
        /**
         * Expert waterfall over the assembled sections, contexts, tools, and variables.
         * ...
         * @mode waterfall
         */
        'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly, context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>;
        /**
         * Emitted when any prompt provider changes. This registry notification is
         * unfiltered because a global change affects every scope.
         * @mode emit
         */
        'system-prompt/change'(): void;
    }
```

### 1.5 Session events (durable log) — `session/event`

Besides the live events there is a **durable, append-only session log** which a plugin can observe
wholesale and extend.

`ROOT\dsh-session\lib\types\index.d.ts:62`:
```ts
        'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
```
plus `session/created` (`:40`), `session/disposed` (`:50`), `session/flush` (`:71`).

Core `SessionEventMap` members — `ROOT\dsh-session\lib\types\types.d.ts:242-404`:

| Durable event | Line |
|---|---|
| `turn/start` `{ turn }` | 249 |
| `turn/end` `{ turn, reason: TurnEndReason }` | 260 |
| `step/start` `{ turn, step }` | 265 |
| `step/end` `{ turn, step }` | 270 |
| `user/message` → `UserMessage` | 281 |
| `system/message` `{ turn, step, message: SystemMessage }` | 294 |
| `assistant/message` `{ turn, step, message, stream, usage?, interrupted? }` | 309 |
| `assistant/attempt` `{ turn, step, stream }` | 323 |
| `tool/call` `{ turn, step, callId, name, arguments }` | 333 |
| `tool/result` `{ turn, step, message, error?, meta? }` | 351 |
| `request/header` `{ header, reason, startsSeries? }` | 366 |
| `request/context` → `RequestContext` | 378 |
| `session/end-seed` `{ inherited?: true }` | 401 |

There is **no `session/end` event**; session teardown is `session/disposed` / `agent/disposed`, and
turn closure is `turn/end` with a `TurnEndReason`.

Plugins extend the durable log by declaration-merging `SessionEventMap`. Real examples:
`ROOT\dsh-compaction\lib\types\types.d.ts:14-99` (`compaction/start`, `compaction/summary`,
`compaction/end`, `compaction/prune`), `ROOT\dsh-hook-protocol\lib\types\types.d.ts:7-40`
(`hook/invoked`, `hook/result`), `ROOT\dsh-agent\lib\types\types.d.ts:73-88`
(`agent/inbox/spliced`), `ROOT\dsh-tool-todo\lib\types\types.d.ts:27`.

A plugin appends with `Session.append` — `ROOT\dsh-session\lib\types\index.d.ts:238`:
```ts
    append<T extends SessionEventType>(type: T, data: SessionEventMap[T], ...opts: T extends SurfaceEventType ? [opts: SurfaceIntent<T>] : []): SessionEvent<T>;
```

Surface placement (how an event joins the model-visible message array) —
`ROOT\dsh-session\lib\types\types.d.ts:413-446`:
```ts
export type SurfaceEventType = 'system/message' | 'user/message' | 'assistant/message' | 'tool/result';

export type SurfaceOp = 'append' | {
    op: 'replace';
    startSeq: SessionSeq;
    endSeq: SessionSeq;
};

export type SurfaceIntent<T extends SurfaceEventType = SurfaceEventType> = {
    surfaceOp: SurfaceOp;
} & ...
```

### 1.6 The `hook/*` nomenclature (Claude Code / Codex bridges)

"Hook" in the DSH vocabulary mostly means the **external command-hook bridges** for Claude Code and
Codex `hooks.json`, not native plugin listeners. Both are plugins and post to the same event bus.

`ROOT\dsh-hooks-codex\lib\types\config.d.ts:9`:
```ts
export declare const CODEX_EVENTS: readonly ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"];
```
Claude Code's set is the same (`ROOT\dsh-hooks-claude-code\lib\index.js:14-15`).

Shared vocabulary — `ROOT\dsh-hook-protocol\lib\types\types.d.ts:46` and `:83-131`:
```ts
export type HookDialect = 'claude-code' | 'codex';
...
export interface HookOutput {
    exitCode: number | undefined;
    stderr: string;
    stdout: string;
    continue?: boolean;
    stopReason?: string;
    decision?: 'approve' | 'allow' | 'block' | 'deny' | 'ask';
    reason?: string;
    hookEventName?: string;
    /** Extra context to inject for the next model request (CC `additionalContext`). */
    additionalContext?: string;
    /** A warning surfaced to the user (CC `systemMessage`). */
    systemMessage?: string;
    /**
     * A tool-input rewrite a hook requested (CC `updatedInput`). PARSED but NOT
     * honored — input rewrite is deferred ...
     */
    updatedInput?: Record<string, unknown>;
}
```
Note `updatedInput` is **parsed but not honored** (documented at
`ROOT\dsh-hook-protocol\README.md:127`).

---

## 2. Hooks that can MUTATE the request or its result

### 2.1 Rewrite the system prompt

**Two mechanisms, and they are not equivalent.**

**(a) Registration** — `ctx.systemPrompt.section()` / `.context()` / `.tools()` / `.variable()`,
`ROOT\dsh-system-prompt\lib\types\index.d.ts:233`, `:252`, `:267`, `:276`:
```ts
    section(section: PromptSection): () => void;
    context(context: PromptContext): () => void;
    tools(provider: (context: AssembleContext) => ToolProviderResult): () => void;
    variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void;
```
`PromptSection` — `ROOT\dsh-system-prompt\lib\types\index.d.ts:47-68`:
```ts
export interface PromptSection {
    /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
    readonly name: string;
    /** Sections are concatenated in ascending order. Equal orders use code-unit name order. */
    readonly order: number;
    readonly text: string | ((context: AssembleContext) => string);
    /**
     * Treat this contribution as the complete system prompt. ...
     */
    readonly complete?: boolean;
}
```
Placement uses centrally allocated orders, `ROOT\dsh-system-prompt\lib\types\index.d.ts:109-141`
(`HARNESS_IDENTITY: -1000` … `DEPLOYMENT_PERSONA_SUFFIX: 10200`), resolved with
`getSectionOrder(name)`. A scoped section **shadows** a global section of the same name.

**(b) The waterfall** — the assembled object is passed to listeners, who may rewrite it.
Invoked at `ROOT\dsh-system-prompt\lib\index.js:351`:
```js
		const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
```
`PromptAssembly` (the mutable payload) — `ROOT\dsh-system-prompt\lib\types\index.d.ts:103-108`:
```ts
export interface PromptAssembly {
    sections: AssembledSection[];
    contexts: AssembledContext[];
    tools: ToolSchema[];
    variables: Record<string, string | undefined>;
}
```

**Critical constraint** — a `complete` section is restored *after* the waterfall, so a listener
cannot replace it (`ROOT\dsh-system-prompt\lib\types\index.d.ts:19-22`, implemented at
`ROOT\dsh-system-prompt\lib\index.js:352-357`):
```js
		if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
		return {
			...transformed,
			sections: completeSection === void 0 ? transformed.sections : [completeSection],
			contexts: runtimeContextSuppressed ? [] : transformed.contexts
		};
```
Two `complete` sections make assembly **fail** (`ROOT\dsh-system-prompt\lib\index.js:333`).

Worked listener, rewriting assembly variables — `ROOT\dsh-agent\lib\index.js:134-147`:
```js
	const disposeAssembly = agentCtx.on("system-prompt/assemble", async (_assembly, _context, next) => {
		const selected = selection.current;
		const assembled = await next();
		selection.assembled = selected;
		if (selected === void 0) return assembled;
		return {
			...assembled,
			variables: { ...assembled.variables, provider: selected.provider, model: selected.model }
		};
	});
```

### 2.2 Append / replace the messages entering a step

`agent/pre-step` waterfall; `PreStepDecision` (quoted in §1.2). A listener may return
`{ kind: 'reject' }` to abort the step, or `{ kind: 'enter', messages: [...] }` with a replaced
batch.

Invoked at `ROOT\dsh-agent-loop\lib\index.js:894-901`:
```js
		const decision = await this.dispatch.waterfall("agent/pre-step", {
			messages: claimed,
			...position,
			signal
		}, () => Promise.resolve({
			kind: "enter",
			messages: context === void 0 ? claimed : [...claimed, context]
		}));
```

This is **the** hook for out-of-band text (see §3).

### 2.3 Replace the model call configuration — but not the messages

`agent/request` waterfall. Invoked at `ROOT\dsh-agent-loop\lib\index.js:1143-1147`:
```js
		const proposedConfig = await this.dispatch.waterfall("agent/request", {
			turn,
			step,
			signal
		}, () => Promise.resolve(seedConfig));
```
The doc is explicit about the boundary —
`ROOT\dsh-agent\lib\types\runtime-types.d.ts:320-328`:
```
         * Replace the frozen call configuration. `await next()` yields the config
         * the machine would use ...; return a replacement to switch. ...
         * The prepared call capability
         * governs prompt admission. Model-visible content must use logged channels;
         * this waterfall cannot mutate messages.
```

### 2.4 Block / gate a tool call

`tools/pre-execute`. `PreToolDecision` — `ROOT\dsh-tools\lib\types\index.d.ts:413-427`:
```ts
/**
 * Pre-dispatch decision. `allow` runs the call; `deny` materializes an error;
 * `ask` runs only after an approval service returns `allowed-once` and otherwise
 * denies. Input rewriting is excluded because arguments are already logged and
 * presented.
 */
export type PreToolDecision = {
    kind: 'allow';
} | {
    kind: 'deny';
    reason: string;
} | {
    kind: 'ask';
    reason?: string;
};
```
Invoked at `ROOT\dsh-tools\lib\index.js:3116`:
```js
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
```

**Monotonic guards** are the non-overridable variant — `ROOT\dsh-tools\lib\types\index.d.ts:481-489`
and `:620`:
```ts
export type ToolGuard = (execution: Readonly<ToolExecution>) => string | undefined;
...
    guard(guard: ToolGuard): () => void;
```
Doc (`ROOT\dsh-tools\lib\types\index.d.ts:610-619`): *"Any matching guard may deny by returning a
reason, while no guard can force-allow a call another guard denied."* Applied at
`ROOT\dsh-tools\lib\index.js:3127`.

Real blocker, Claude Code bridge — `ROOT\dsh-hooks-claude-code\lib\index.js:248-263`:
```js
	ctx.on("tools/pre-execute", async (exec, next) => {
		const turn = lastTurn(ctx, exec.agent);
		const merged = await runPoint("PreToolUse", exec.name, preToolPayload(exec), {...});
		if (merged.decision === "deny") return {
			kind: "deny",
			reason: merged.reason ?? "blocked by PreToolUse hook"
		};
		if (merged.decision === "ask") return {
			kind: "ask",
			...merged.reason !== void 0 ? { reason: merged.reason } : {}
		};
		return next();
	});
```

### 2.5 Rewrite / truncate a tool result, block it, or attach a reminder

`tools/post-execute`. `PostToolDecision` — `ROOT\dsh-tools\lib\types\index.d.ts:428-446`:
```ts
/**
 * Post-dispatch decision: accept, replace one projection, attach context for the
 * next request, or block by turning corrective feedback into an error result.
 */
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
Invoked at `ROOT\dsh-tools\lib\index.js:3378`:
```js
		const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
```
Application — `ROOT\dsh-tools\lib\index.js:3379-3405`:
```js
		const decisionContexts = decision.additionalContexts ?? [];
		if (decision.kind === "block") {
			const message = failureMessageFromContent(decision.feedback);
			return this.markCanonical(exec, {
				content: decision.feedback,
				isError: true,
				error: { message },
				...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
			});
		}
		...
		return this.markCanonical(exec, {
			...result,
			...decision.content !== void 0 ? { content: decision.content } : {},
			...additionalContexts.length > 0 ? { additionalContexts } : {}
		});
```

So: **`content` replacement = rewrite/truncate the tool result; `block` + `feedback` = turn the
result into a corrective error; `additionalContexts` = inject a reminder message.**

Real reminders:
- Repeat-tool reminder — `ROOT\dsh-repeat-tool-reminder\lib\index.js:1495-1508`:
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
		return { ...downstream, additionalContexts: prependContext(reminder, downstream.additionalContexts) };
	});
```
  Its text — `ROOT\dsh-repeat-tool-reminder\lib\index.js:1385`:
```js
const GENTLE_REMINDER = "You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.";
```
- Spill policy (byte-cap + locator preview) — `ROOT\dsh-spill-policy\lib\index.js:155`.
- Pruner (model-free truncation, mid-result marker `[... tool result middle pruned ...]`) —
  `ROOT\dsh-compaction-tool-result-pruner\lib\index.js:8`.

### 2.6 Around-dispatch (timeout / retry / metrics)

`tools/execute` waterfall, invoked at `ROOT\dsh-tools\lib\index.js:3213`. A wrapper **may change
only `exec.signal`** (`ROOT\dsh-tools\lib\types\index.d.ts:40-44`). Used by
`dsh-tool-call-timeout-policy`.

### 2.7 Keep the turn going / end the turn

- `agent/turn-stopping` (**serial**, awaited) — a listener may `agent.steer(...)` to force another
  step. Invoked at `ROOT\dsh-agent-loop\lib\index.js:967-970`.
  Claude Code bridge's `Stop` hook uses it (`ROOT\dsh-hooks-claude-code\lib\index.js:292-308`).
- `ToolExecutionSuccess.concludesTurn` — data-driven early stop,
  `ROOT\dsh-tools\lib\types\index.d.ts:398-399`; consumed at
  `ROOT\dsh-agent-loop\lib\index.js:579`: `concluded ||= result.concludesTurn === true;`
- `agent/request-error` — return `{ kind: 'retry' }` to own recovery, invoked at
  `ROOT\dsh-agent-loop\lib\index.js:1088`.

### 2.8 Defer context from inside a tool, and finalize a tool's own content

`ROOT\dsh-tools\lib\types\index.d.ts:284-301`:
```ts
export interface ToolRunContext extends ToolExecution {
    /**
     * Defer one context ... until this tool's
     * final result reaches the agent loop. Contexts retain their individual
     * source and metadata and are emitted in call order.
     */
    deferContext(context: UserMessage): void;
    concludeTurn(): void;
}
```
`ROOT\dsh-tools\lib\types\index.d.ts:120-131`:
```ts
    finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined;
```
A `ToolDefinition` author can therefore rewrite its own model-facing content last-mile (this is how
spill previews are produced).

---

## 3. How DSH already injects out-of-band text — the exact code

### 3.1 The mechanism

There is exactly one canonical channel: **a user-role message with a `plugin` source**, entering
the model-visible surface as a `user/message` event. Message construction —
`ROOT\dsh-llm\lib\types\message.d.ts:180-183`:
```ts
export declare function createUserMessage<T extends NewUserMessage>(input: T & {
    readonly id?: never;
    readonly role?: never;
}): T & Pick<UserMessage, 'id' | 'role'>;
```

Source vocabulary — `ROOT\dsh-llm\lib\types\message.d.ts:94-104`:
```ts
export interface MessageSourceMap {
    user: {
        kind: 'user';
    };
    plugin: {
        kind: 'plugin';
        plugin: string;
    } & ContextFormed;
    model: ModelMessageSource;
    tool: ToolMessageSource;
}
```
`ContextFormed` (`ROOT\dsh-llm\lib\types\message.d.ts:42-89`) declares the semantic form:
`'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'`, where `snapshot` requires
`sections` and `notice` requires a `summary`.

The `user/message` durable event documents that injected context is normal history —
`ROOT\dsh-session\lib\types\types.d.ts:274-281`:
```
     * A user-role message on the model-visible surface: a direct human prompt
     * (the queued message claimed for this turn), a synthetic `agent.inject()`
     * context (file-change notices, subdir AGENTS.md, skill content, cron
     * notifications, …), or an entered goal continuation round. All three
     * project their `content` verbatim; `source` tells them apart.
     */
    'user/message': UserMessage;
```

### 3.2 Insertion point A — return it from `agent/pre-step`

`ROOT\dsh-agent-instructions\lib\index.js:1270-1288` (the clearest example):
```js
	ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
		const decision = await next();
		await waitForProjections(agent);
		const pending = agent.inbox.nextStep.filter(isWorkspaceContext);
		const desired = await compose(agent, signal, messages, pending);
		signal.throwIfAborted();
		if (decision.kind === "reject" || step === 1 && decision.messages.length === 0) {
			syncInbox(agent, messages, desired);
			return decision;
		}
		for (const message of pending) agent.inbox.remove(message.id);
		if (desired === void 0 || decision.messages.some((message) => sameContextPayload(message, desired))) return decision;
		const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
		const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired);
		return {
			...decision,
			messages: entered
		};
	});
```

`ROOT\dsh-time-context\lib\index.js:215-247` appends a `snapshot`-form message:
```js
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		...
		return {
			...decision,
			messages: [...decision.messages, createUserMessage({
				content: [{ type: "text", text }],
				source: {
					kind: "plugin",
					plugin: name,
					form: "snapshot",
					sections: [{ name, text }]
				}
			})]
		};
	}, { prepend: true });
```

`ROOT\dsh-hooks-claude-code\lib\index.js:232-247` appends hook `additionalContext`:
```js
	ctx.on("agent/pre-step", async ({ agent, messages, turn, signal }, next) => {
		if (messages.length === 0) return next();
		const merged = await runPoint("UserPromptSubmit", "", promptPayload(agent, messages.flatMap((message) => message.content)), { agent, turn, signal });
		if (merged.decision === "deny") return { kind: "reject" };
		const downstream = await next();
		const ours = contextFrom(merged);
		if (!ours || downstream.kind !== "enter") return downstream;
		return { ...downstream, messages: [...downstream.messages, ours] };
	});
```

### 3.3 Insertion point B — `agent.inject()` (session start)

`ROOT\dsh-agent-loop\lib\index.js:789-797`:
```js
	followup(input) {
		this.send(input, "next-turn", true);
	}
	steer(input) {
		this.send(input, "next-step", true);
	}
	inject(input) {
		this.send(input, "next-step", false);
	}
```
Doc — `ROOT\dsh-agent\lib\types\runtime-types.d.ts:201-209`: *"Queue model-facing context for the
next pre-step without waking the driver."*

Used by the hooks bridge for `SessionStart` — `ROOT\dsh-hooks-claude-code\lib\index.js:221-231`:
```js
	ctx.on("agent/session-start", ({ agent, source }) => {
		detached.track(runPoint("SessionStart", source, sessionStartPayload(agent, source), {
			agent, signal: detached.signal
		}).then((merged) => {
			const context = contextFrom(merged);
			if (context) agent.inject(context);
		}).catch((error) => {
			ctx.logger.warn(`hooks-claude-code: SessionStart hook failed: ${String(error)}`);
		}));
	});
```

### 3.4 Insertion point C — `additionalContexts` after a tool result

Ferried out of `tools/post-execute` and appended by the loop after the step's tool results —
`ROOT\dsh-agent-loop\lib\index.js:576-579`:
```js
			const result = slot.needsPost ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result) : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result);
			appendToolResult(session, turn, step, call.block, result, callSeqs[committed]);
			for (const context of result.additionalContexts ?? []) acceptContext(context);
			concluded ||= result.concludesTurn === true;
```

### 3.5 The `<system-reminder>` frame — exact builders

**There is no exported shared `<system-reminder>` helper.** Each producer owns its frame.

**(a) `dsh-agent-instructions`** — declares the tags and the escape rule,
`ROOT\dsh-agent-instructions\lib\index.js:111-114` and `:127-129`:
```js
const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
const WORKSPACE_CONTEXT_INTRO = "The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.";
...
const REPLACEMENT_WORKSPACE_CONTEXT_INTRO = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. ...";
const EMPTY_REPLACEMENT_WORKSPACE_CONTEXT_INTRO = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. No workspace instructions are currently active.";
const COMPACT_WORKSPACE_CONTEXT_INTRO = "Workspace instructions were omitted or truncated to fit the configured byte budget.";
...
function escapeInstructionFrameBody(body) {
	return body.replaceAll(SYSTEM_REMINDER_CLOSE, "<\\/system-reminder>");
}
```

The frame builder — `ROOT\dsh-agent-instructions\lib\index.js:256-266`:
```js
function buildInstructionText(files, maxBytes, omitted, truncated, style) {
	return [
		SYSTEM_REMINDER_OPEN,
		escapeInstructionFrameBody([
			markerText(maxBytes, omitted, truncated),
			style.intro,
			...files.map((file) => style.section(file))
		].filter((block) => block.length > 0).join("\n\n")),
		SYSTEM_REMINDER_CLOSE
	].join("\n");
}
```
Section text — `ROOT\dsh-agent-instructions\lib\index.js:130-132`:
```js
function sectionText(file) {
	return `Instructions from: ${file.displayPath}\n\n${file.content}`;
}
```
Budget marker — `ROOT\dsh-agent-instructions\lib\index.js:249-255`:
```js
function markerText(maxBytes, omitted, truncated) {
	if (omitted.length === 0 && truncated.length === 0) return "";
	const parts = [];
	if (omitted.length > 0) parts.push(`omitted ${omitted.map((file) => file.displayPath).join(", ")}`);
	if (truncated.length > 0) parts.push(`truncated ${truncated.map((item) => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(", ")}`);
	return `Workspace instruction budget ${maxBytes} bytes: ${parts.join("; ")}`;
}
```
Rendered model-visible shape (from its README, `ROOT\dsh-agent-instructions\README.md:136-146`):
```
<system-reminder>
The following workspace instructions may be relevant to your work. ...

Instructions from: ~/.dsh/AGENTS.md

<user-global-instructions>

Instructions from: AGENTS.md

<project-instructions>
</system-reminder>
```
Change/removal notices — `ROOT\dsh-agent-instructions\lib\index.js:212-223`:
```js
function changedSectionText(item) {
	const { change, file } = item;
	if (change.action === "set") return additionalSectionText(file);
	if (change.action === "remove") return `Instructions removed: ${change.path}\n\nThe previously loaded instructions from this file no longer apply.`;
	return [ `Updated instructions from: ${change.path}`, "", "This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.", "", file.content ].join("\n");
}
```

**(b) `dsh-tool-skill`** — the skill catalog frame,
`ROOT\dsh-tool-skill\lib\index.js:238-261`:
```js
function renderCatalogMessage(entries) {
	return createUserMessage({
		content: [{
			type: "text",
			text: [
				"<system-reminder>",
				"A skill is a reusable set of task-specific instructions. The following skills are available in this session:",
				"",
				"<available_skills>",
				...renderCatalogEntries(entries),
				"</available_skills>",
				"",
				"If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. ...",
				"A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. ...",
				"</system-reminder>"
			].join("\n")
		}],
		source: { kind: "skill-catalog", form: "catalog", entries }
	});
}
```
and its replacement variant `renderCatalogUpdate` at `:262-279`, whose framing is
`"The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:"`.
It dedupes by digest and **replaces the existing catalog message in place** —
`ROOT\dsh-tool-skill\lib\index.js:231-235`:
```js
		const catalog = history.published ? renderCatalogUpdate(entries) : renderCatalogMessage(entries);
		return {
			...decision,
			messages: existing === void 0 ? [...decision.messages, catalog] : decision.messages.map((message) => message.id === existing.message.id ? catalog : message)
		};
```

### 3.6 Other shipped out-of-band injections

| Producer | Mechanism | Text | Path:line |
|---|---|---|---|
| Model switch notice | `agent/pre-step` append | `[model changed: assistant turns above this point were generated by X; the session continues with Y]` | `ROOT\dsh-agent\lib\index.js:99-114`, registered `:160-171` |
| Session reference | `agent/pre-step` splice after citing message | resolved session snapshot | `ROOT\dsh-session-reference\lib\index.js:467-474`, `:484-507` |
| Skill user-invocation | `agent/pre-step` append | `renderSkillContent(skill)` | `ROOT\dsh-tool-skill\lib\index.js:168-202` |
| Repeat-tool reminder | `tools/post-execute` → `additionalContexts` | `GENTLE_REMINDER` / `detailedReminder` | `ROOT\dsh-repeat-tool-reminder\lib\index.js:1385`, `:1471-1508` |
| Claude/Codex hooks | `agent/session-start` → `agent.inject`; `agent/pre-step`; `tools/post-execute` | hook `additionalContext` | `ROOT\dsh-hooks-claude-code\lib\index.js:207-231` |
| Compaction checkpoint | `session.append('user/message', …, { surfaceOp: replace })` | `<compacted-summary>` frame | `ROOT\dsh-compaction-basic\lib\index.js:565-578`, `:621-632` |
| Plan mode / goal round / tmux context | `agent/pre-step`, `systemPrompt.section` | various | `ROOT\dsh-plan-mode\lib\index.js:151`; `ROOT\dsh-goal-round-driver\lib\index.js:282`; `ROOT\dsh-tmux-context\lib\index.js:1510` |

Compaction's framing (a distinct, non-`system-reminder` idiom) —
`ROOT\dsh-compaction-basic\lib\index.js:211-212`, `:323-335`:
```js
const SUMMARY_OPEN_TAG = "<compacted-summary>";
const SUMMARY_CLOSE_TAG = "</compacted-summary>";
...
function frameSummary(summary) {
	return [
		{ type: "text", text: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}` },
		...summary,
		{ type: "text", text: SUMMARY_CLOSE_TAG }
	];
}
```

### 3.7 Negative findings on reminders

- **No todo-list reminder exists.** `dsh-tool-todo` registers the `todo_write` tool and a session
  projection only; it has no `agent/pre-step` listener and no reminder text (grep for
  `reminder|system-reminder|createUserMessage|pre-step` in `ROOT\dsh-tool-todo\lib` → no matches).
- **No `system/reminder` durable event type, and no shared reminder helper module.** The four
  `system-reminder` producers listed above are independent.
- **No `<system-reminder>` in the system prompt itself** — the frame is only ever used inside
  user-role messages. The rendered prompt is a separate `system/message` surface node.

---

## 4. Built-in tools a plugin could imitate for reading session state

Registration API: `ctx.tools.register(definition)` — `ROOT\dsh-tools\lib\types\index.d.ts:601`;
lookup `ctx.tools.get(name, scope?)` — `:655`.

**Complete model-facing tool-name inventory** (definition sites):

| Tool | Package | Path:line |
|---|---|---|
| `read` | dsh-tool-fs | `ROOT\dsh-tool-fs\lib\index.js:332` |
| `write` | dsh-tool-fs | `:597` |
| `edit` | dsh-tool-fs | `:742` |
| `read_image` | dsh-tool-fs | `:1042` |
| `glob` | dsh-tool-fs-search | `ROOT\dsh-tool-fs-search\lib\index.js:782` |
| `grep` | dsh-tool-fs-search | `:1090` |
| `bash` | dsh-tool-bash | `ROOT\dsh-tool-bash\lib\index.js:260` |
| `pwsh` | dsh-tool-pwsh | `ROOT\dsh-tool-pwsh\lib\index.js:234` |
| `ask_user_question` | dsh-tool-ask-user | `ROOT\dsh-tool-ask-user\lib\index.js:16` |
| `todo_write` | dsh-tool-todo | `ROOT\dsh-tool-todo\lib\index.js:96` |
| `present` | dsh-tool-present | `ROOT\dsh-tool-present\lib\index.js:24` |
| `skill` | dsh-tool-skill | `ROOT\dsh-tool-skill\lib\index.js:60` / registered `:167` |
| `web_search` | dsh-tool-web | `ROOT\dsh-tool-web\lib\index.js:262` |
| `web_fetch` | dsh-tool-web | `:737` |
| `get_goal` / `create_goal` / `update_goal` | dsh-tool-goal | `ROOT\dsh-tool-goal\lib\index.js:265` / `:276` / `:302` |
| `job_output` / `job_list` / `job_kill` | dsh-tool-jobs | `ROOT\dsh-tool-jobs\lib\index.js:229` / `:285` / `:305` |
| `send_message` / `interrupt_agent` | dsh-tool-subagent-control | `ROOT\dsh-tool-subagent-control\lib\index.js:23` / `:62` |
| `list_agents` | dsh-tool-subagent-control | `ROOT\dsh-tool-subagent-control\lib\types\list-agents.js:54` |
| `subagent` / `subagent_fork` | dsh-tool-subagent | `ROOT\dsh-tool-subagent\lib\index.js:398-399` (`toolName` config, default at `:373`) |
| `list_subagent_models` | dsh-tool-subagent | `:174` |
| `ralph` | dsh-tool-ralph | `ROOT\dsh-tool-ralph\lib\index.js:301` |
| `workflow` | dsh-tool-workflow | `ROOT\dsh-tool-workflow\lib\index.js:144` |
| `exit_plan_mode` | dsh-plan-mode | `ROOT\dsh-plan-mode\lib\index.js:230` (`const EXIT_PLAN_MODE = "exit_plan_mode"` `:34`) |
| `cordis_inspect_list` / `cordis_inspect_query` / `cordis_inspect_self` / `cordis_define` / `cordis_run` / `cordis_stop` / `cordis_undefine` | dsh-tool-cordis | `ROOT\dsh-tool-cordis\lib\index.js:9115`, `:9131`, `:9174`, `:9219`, `:9349`, `:9428`, `:9457` |
| `str_replace_editor` | dsh-tool-str-replace-editor | `:266` — **not mounted in any shipped preset** |
| `schedule_create` / `schedule_list` / `schedule_delete` | dsh-schedule | `ROOT\dsh-schedule\lib\index.js:1269` / `:1350` / `:1372` — **not mounted in any shipped preset** |

Tool-defining packages that are **not** under a `dsh-tool-*` name: `dsh-plan-mode`, `dsh-schedule`,
and `dsh-agent-tool-presentation` (which registers **no tool** — it only calls
`ctx.tools.presentAs(...)`, `ROOT\dsh-agent-tool-presentation\lib\index.js:41-49`).

**Session-state readers** (the closest thing to a "session state tool"):

| Tool | State read | Service / API |
|---|---|---|
| `list_agents` | continuable subagents + live status | `ctx.subagents.listChildren/listDescendants` (`ROOT\dsh-tool-subagent-control\lib\types\list-agents.js:136,142`) + `ctx.agents` |
| `job_output` / `job_list` | background jobs per owning agent | `ctx.jobs.wait/read/list(exec.agent)` (`ROOT\dsh-tool-jobs\lib\index.js:274,276,299`) |
| `get_goal` | current goal snapshot | `ctx.goals.get(...)` (`ROOT\dsh-tool-goal\lib\index.js:271`) |
| `present` | open turn + session cwd | `ctx.sessionProjections.stateOf(exec.agent.session, "turnBoundary")` (`ROOT\dsh-tool-present\lib\index.js:78`), `agent.session.header.cwd` (`:81`) |
| `skill` | skill catalog + session surface | `ctx.skills`, `agent.session.surface.nodes` / `eventAt(seq)` (`ROOT\dsh-tool-skill\lib\index.js:332-336`) |
| `cordis_inspect_self` | Cordis objects owned by this Session | `ctx.dynamicCordisRunner.listPlugins(agent)` (`ROOT\dsh-tool-cordis\lib\index.js:9198`) |
| `exit_plan_mode` | plan projection | `ctx.sessionProjections.stateOf(session, "plan")` (`ROOT\dsh-plan-mode\lib\index.js:325`) |

**Important negative finding: no built-in tool exposes the transcript, message history, or
session-log search.** `ctx.sessionQuery` (`listSessions` / `observeSession` / `readSurface` /
`traceSession` / `readEvent`) is consumed only by host-plane packages
(`dsh-api-session-controller`, `dsh-session-log-export`, `dsh-session-reference`,
`dsh-subagent`) — never by a `dsh-tool-*` package.

`present` is the cleanest template for reading session projection state — its parameters are
`files: [{ path: string, description?: string }]` (`ROOT\dsh-tool-present\lib\index.js:26-44`) and it
is the tool this agent used to declare deliverables.

---

## 5. Sanctioned alternatives when a plugin cannot mutate prompts directly

1. **Register a tool the model calls** — `ctx.tools.register(defineTool({...}))`
   (`ROOT\dsh-tools\lib\types\index.d.ts:601`). Tools may `deferContext` a message back to the loop
   (`:291`) and `concludeTurn()` (`:300`).
2. **Register a system-prompt section/context/variable** — `ctx.systemPrompt.section({name, order, text})`
   (`ROOT\dsh-system-prompt\lib\types\index.d.ts:233`). This is the sanctioned way to add *standing*
   prompt text, and it is what `dsh-persona`, `dsh-web-app`, `dsh-plan-mode`, `dsh-tool-*` all do.
   A `complete: true` section can replace the whole prompt (one at a time).
3. **Inject an attributed user-role message** — `createUserMessage({ content, source: {kind:'plugin', plugin, form?, ...} })`
   returned from `agent/pre-step`, or `agent.inject(msg)`. This is the `<system-reminder>` channel.
4. **Attach `additionalContexts` to a tool decision** — `PostToolDecision.additionalContexts`
   (`ROOT\dsh-tools\lib\types\index.d.ts:436`, `:441`, `:445`).
5. **Rewrite a tool result** — `PostToolDecision { kind:'accept', content }` (truncate/preview) or
   `{ kind:'block', feedback }` (corrective error).
6. **Append a custom durable event** — declaration-merge `SessionEventMap` and call
   `session.append('myplugin/thing', data)` (`ROOT\dsh-session\lib\types\index.d.ts:238`).
7. **Register a command** — `ctx.commands.register({ name, description, handler })`
   (see `ROOT\dsh-command-compact\lib\index.js:92-96` for `/compact`).
8. **Emit notifications to the UI** — a *client*-side concern:
   - the `notice` `ContextForm` (`ROOT\dsh-llm\lib\types\message.d.ts:81-84`) with a bounded
     one-line `summary` (`CONTEXT_SUMMARY_MAX_CHARS = 120`, `:110`) renders injected context as a
     collapsed, attributed transcript row.
   - the conversation UI exposes `notify(level: 'info' | 'error', text: string): void`
     (`ROOT\dsh-client-ui-conversation\lib\types\client\contract\input.d.ts:195`).
   - the `present` tool is the sanctioned "show the user a deliverable" path
     (`ROOT\dsh-tool-present\lib\index.js:24`).
9. **Read state instead of writing it** — `ctx.sessionProjections.stateOf(session, key)` /
   `.snapshot(session, keys?)` (synchronously), `agent.session.snapshotEvents()` / `ownEvents()` /
   `eventAt(seq)` / `surface.nodes`, `ctx.tokenMeter.measure(session)`, `ctx.sessionQuery`.
10. **`ctx.logger.warn(...)`** for diagnostics (used throughout, e.g.
    `ROOT\dsh-hooks-claude-code\lib\index.js:229`).

**Binding a plugin to services** uses Cordis injection — `export const inject = [...]`, e.g.
`ROOT\dsh-persona\lib\index.js:21`:
```js
/** The prompt registry this row contributes to. */
const inject = ["systemPrompt"];
```
and a plugin module exports `{ name, inject, Config, apply }` — full example
`ROOT\dsh-persona\lib\index.js:19-48`:
```js
const name = "persona";
const inject = ["systemPrompt"];
const Config = z.object({ prefix: z.string().required(), suffix: z.string().default(""), complete: z.boolean().default(false), includeRuntimeContext: z.boolean().default(true) });
function apply(ctx, config) {
	ctx.effect(() => ctx.systemPrompt.section({
		name: PERSONA_PREFIX_SECTION,
		order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
		text: config.prefix,
		...config.complete ? { complete: true } : {}
	}), "persona.section()");
	...
}
export { Config, PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, apply, inject, name };
```
Packaging: a plugin that should be a profile layer declares `dsh.bundle.patch` in package.json —
`ROOT\dsh-base\package.json`:
```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
```
and is installed into a profile with `dsh plugin --profile <name> add <pkg>`
(`dsh\lib\plugin-Ddi42qoW.js:101-128`, reconciliation by installed `dsh.bundle` state).

---

## 6. Worked examples in the checkout

### 6.1 `dsh-agent-instructions` — injects `<system-reminder>` and reacts to activity

- **What it does:** loads user-global and project `AGENTS.md`/`CLAUDE.md` and injects them as one
  bounded `<system-reminder>` user message per baseline/change.
- **Subscribes to:** `agent/pre-step` (`ROOT\dsh-agent-instructions\lib\index.js:1270`),
  `tools/result` (`:1289`), `session/event` for `step/end` (`:1263`).
- **Injects via:** returned `decision.messages` (splice after the claimed message, `:1283`).
- **Budget:** `maxBytes` caps the whole frame; broader files are dropped before the most specific is
  truncated by binary search (`ROOT\dsh-agent-instructions\lib\index.js:273-292`).
- **Safety:** escapes any literal `</system-reminder>` in repo-controlled text (`:127-129`).
- **Config:** `{ dshHome?, projectRootMarkers?, maxBytes, maxSourceBytes?, instructionFileCandidates?, localInstructionFileCandidates? }`
  (`ROOT\dsh-agent-instructions\README.md:48-57`), mounted by `dsh-base` with `maxBytes: 65536`.
- **Test hooks in this very session:** the workspace `AGENTS.md` block in the system reminder is
  this plugin's output.

### 6.2 `dsh-compaction-basic` — reacts to context size

- **Service:** implements `ctx.compaction` (`CompactionEngine`,
  `ROOT\dsh-compaction\lib\types\index.d.ts:75`), which is itself the seam another backend could
  replace.
- **Reacts automatically** (default `auto: true`) at the step boundary —
  `ROOT\dsh-compaction-basic\lib\index.js:798`:
```js
	ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
		if (!signal.aborted) try {
			const result = await this.compactIfNeeded(agent, "pressure", signal);
			if (result !== null) logResult(result, "step pressure");
		} catch (error) { ... ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`); }
		return next();
	});
```
- **Threshold:** `thresholdTokens = Math.floor(contextWindow * thresholdRatio)`, default ratio
  `0.8` (`ROOT\dsh-compaction-basic\lib\index.js:15`, `:108-126`); decision at `:895-905` using
  `ctx.tokenMeter.measure(agent.session).totalTokens`.
- **Overflow recovery:** `agent/request-error` on provider code `CONTEXT_WINDOW_EXCEEDED`
  (`ROOT\dsh-compaction-basic\lib\index.js:820-846`, code constant
  `ROOT\dsh-llm\lib\types\error.d.ts:18`), returns `{ kind: 'retry' }`.
- **Rewrite:** `user/message` with `surfaceOp: { op: 'replace', startSeq, endSeq }`
  (`ROOT\dsh-compaction-basic\lib\index.js:621-632`), frame `<compacted-summary>`.
- **Subclass hook:** `protected summarize(input, agent, signal)` is the designed customization
  point (`ROOT\dsh-compaction-basic\lib\types\index.d.ts:49`).
- **Sibling context-size mechanisms:** `ctx.tokenMeter` (`ROOT\dsh-token-meter\lib\types\index.d.ts:20`,
  `measure(session)` synchronous; **no remaining-budget field** — capacity comes from
  `ctx.llm.resolveModelInfo(provider, model, signal).context.contextWindow`, async), the
  `contextPressure` session projection (`ROOT\dsh-token-meter\lib\types\projection.d.ts:28-46`),
  `ctx.toolResultPruner` (`ROOT\dsh-compaction-tool-result-pruner\lib\types\index.d.ts:19`),
  and `dsh-spill-policy`'s per-result `maxInlineBytes` cap (`ROOT\dsh-spill-policy\lib\index.js:155`).

### 6.3 `dsh-hooks-claude-code` / `dsh-hooks-codex` — the compatibility hook layer

Maps external `hooks.json` events onto native hooks:
`SessionStart → agent/session-start + agent.inject`
(`ROOT\dsh-hooks-claude-code\lib\index.js:221-231`),
`UserPromptSubmit → agent/pre-step` (`:232-247`),
`PreToolUse → tools/pre-execute` (`:248-264`),
`PostToolUse → tools/post-execute` (`:265-291`),
`Stop → agent/turn-stopping` + `agent.steer` (`:292-308`),
plus `subagent/start` (`:309`). This is the best end-to-end template for a plugin that must react
to a permission decision and inject text.

---

## 7. UNKNOWN / not determinable from this checkout

- Whether any **deployment-specific bundle outside this checkout** mounts `dsh-schedule` or
  `dsh-tool-str-replace-editor` (both define tools but appear in no shipped preset).
- The complete parameter schemas of `write`, `edit`, and `read_image` (names and definition lines
  verified; schemas not read in full).
- Whether the **Web GUI client** exposes a plugin-facing notification registration beyond
  `notify(level, text)` in the conversation input contract; the client slot registry
  (`ROOT\dsh-client-ui-renderer\lib\types\client\registry.d.ts:197 subscribe(key, fn)`) exists but
  was not traced to a host-side plugin seam.
- The exact public API for **third-party standalone tool packages outside this monorepo**: there is
  no `dsh` CLI "new plugin" scaffold in this checkout (`dsh plugin` only forwards to pnpm,
  `dsh\lib\plugin-Ddi42qoW.js:101`).
- No published `docs/plugin-authoring.md` equivalent exists in the shipped tarball; the
  package-level `README.md` files (present for every `dsh-*` package) are the documentation surface.
