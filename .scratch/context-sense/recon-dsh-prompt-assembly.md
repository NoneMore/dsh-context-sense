# DSH prompt-assembly reconnaissance

Read-only recon of the installed DeepSeek Harness (DSH). Nothing was modified.

Root searched: `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`
(shipped, built `dsh-*` packages; `lib/*.js` + `lib/types/*.d.ts`).

Home/profile root observed: `DSH_HOME=E:\Home\.dsh`.

---

## 1. System prompt service

**Package:** `...\dsh-system-prompt\lib\index.js` (361 lines)

**Service key: `systemPrompt`** — the service is registered in the constructor:

```js
// dsh-system-prompt\lib\index.js:198-211
var SystemPrompt = class extends Service {
	static Config = z.object({
		includeHarnessIdentity: z.boolean().default(true),
		includeRuntimeContext: z.boolean().default(true),
		personaPrefix: z.string().default(""),
		personaSuffix: z.string().default(""),
		toolOrder: z.array(z.string()).default(void 0)
	});
	layers = new ScopedLayers((scope) => new PromptLayer(scope), () => {
		this.ctx.emit("system-prompt/change");
	});
	toolOrder;
	constructor(ctx, config) {
		super(ctx, "systemPrompt");
```

Cordis `Context` augmentation, `dsh-system-prompt\lib\types\index.d.ts:10-13`:

```ts
declare module '@deepseek-ai/cordis' {
    interface Context {
        systemPrompt: SystemPrompt;
    }
```

### API for contributing a section

| Method | Signature (`lib\types\index.d.ts`) | Line |
|---|---|---|
| `section` | `section(section: PromptSection): () => void` | 233 |
| `context` | `context(context: PromptContext): () => void` | 252 |
| `variable` | `variable(name: string, provider: (context: AssembleContext) => string \| undefined): () => void` | 276 |
| `suppressRuntimeContext` | `suppressRuntimeContext(): () => void` | 259 |
| `tools` | `tools(provider: (context: AssembleContext) => ToolProviderResult): () => void` | 267 |
| `getSectionOrder` | `getSectionOrder(name: PromptSectionOrderName): number` | 239 |
| `getContextOrder` | `getContextOrder(name: PromptContextOrderName): number` | 245 |
| `assemble` | `assemble(context?: AssembleContext): Promise<PromptAssembly>` | 286 |

`PromptSection` shape (`lib\types\index.d.ts:47-68`):

```ts
export interface PromptSection {
    /** Unique name — a duplicate registration throws (see {@link SystemPrompt.section}). */
    readonly name: string;
    /**
     * Sections are concatenated in ascending order. Equal orders use code-unit
     * name order.
     */
    readonly order: number;
    /**
     * Static text or a provider evaluated at each assembly with that assembly's
     * {@link AssembleContext}. The text may reference `{{variable}}`s — they are
     * interpolated later, by {@link renderPrompt}.
     */
    readonly text: string | ((context: AssembleContext) => string);
    /**
     * Treat this contribution as the complete system prompt. ...
     */
    readonly complete?: boolean;
}
```

`PromptContext` shape (`lib\types\index.d.ts:70-77`):

```ts
export interface PromptContext {
    /** Unique name — a duplicate registration throws (see {@link SystemPrompt.context}). */
    readonly name: string;
    /** Contexts are joined in ascending order. */
    readonly order: number;
    /** Static text or a provider evaluated for each assembly. Empty text contributes nothing. */
    readonly text: string | ((context: AssembleContext) => string);
}
```

Answering the parameter question precisely:

- **identifier** — `name: string`. There is **no** `id` and **no** `title` field. Duplicate `name` in one layer throws (`NamedEntries`, `lib\index.js:188-190`).
- **order/priority** — `order: number`, must be finite or `section()` throws `order must be a finite number` (`lib\index.js:239`). Ascending; ties break by code-unit name order (`comparePromptSections`, `lib\index.js:96-98`).
- **render/callback** — `text` is `string | (context) => string`. It is **synchronous**; the declared type has no `Promise`.
- **conditional inclusion** — return `''`. `renderPrompt` drops empty sections (`lib\index.js:112`):

```js
function renderPrompt(assembly) {
	return assembly.sections.map((section) => interpolate(section, section.variables ...))
```
(the exact filter is `.filter((text) => text.length > 0).join("\n\n")`).

- **`complete: true`** — replaces the entire system prompt; more than one active complete section makes `assemble()` throw (`lib\index.js:332-333`).

### Registration code (verbatim, `dsh-system-prompt\lib\index.js:238-241`)

```js
	section(section) {
		if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`);
		return this.layers.effect(this.ctx, (layer) => layer.sections.insert(section.name, section), { label: "systemPrompt.section()" });
	}
```

Registration is **scope-aware**: `this.layers.effect(this.ctx, ...)` registers into the calling fiber's scope, and a scoped section **shadows** a global section of the same name (`lib\index.js:315` `this.layers.merge(scope, ...)`).

### One real caller (verbatim, `dsh-tool-goal\lib\index.js:256-263`)

```js
/** Register the three Codex-shaped goal tools and their shared policy section. */
function apply(ctx, config) {
	const resolved = resolveConfig(config);
	ctx.systemPrompt.section({
		name: "tool:goal",
		order: ctx.systemPrompt.getSectionOrder("TOOL_GOAL"),
		text: guidance(resolved.blockedAfterConsecutiveRounds)
	});
```

Other real callers found (all `*.js`, `ctx.systemPrompt.section(...)`):
`dsh-persona\lib\index.js:36,42`; `dsh-plan-mode\lib\index.js:170`; `dsh-tool-fs\lib\index.js:326,591,736`;
`dsh-tool-fs-search\lib\index.js:775,1084`; `dsh-tool-bash\lib\index.js:254`; `dsh-tool-pwsh\lib\index.js:228`;
`dsh-tool-web\lib\index.js:256,731`; `dsh-tool-jobs\lib\index.js:201`; `dsh-tool-workflow\lib\index.js:138`;
`dsh-tool-ralph\lib\index.js:295`; `dsh-tool-cordis\lib\index.js:9108`; `dsh-tools\lib\index.js:2611,2612,2717,2718`;
`dsh-subagent\lib\index.js:549`; `dsh-subagent-in-process-driver\lib\index.js:80`; `dsh-tool-subagent\lib\index.js:576`;
`dsh-file-reference-local\lib\index.js:342`; `dsh-web-app\lib\index.js:180`; `dsh-client-ui-deliverables\lib\index.js:132`;
`dsh-app-boot\lib\index.js:1568`.
`ctx.systemPrompt.context(...)`: `dsh-sandbox-policy\lib\index.js:122`, `dsh-user-approval\lib\index.js:80`, `dsh-subagent\lib\index.js:544`.
`ctx.systemPrompt.variable(...)`: `dsh-agent-loop\lib\index.js:1534-1536` (`"provider"`, `"model"`, `"cwd"`).

---

## 2. Dynamic prompt sections — **yes, recomputed every request**

The section `text` function is re-invoked on **every assembly**, and an assembly happens **once per step**, i.e. before every model request.

Render path (verbatim, `dsh-system-prompt\lib\index.js:331-351`):

```js
		const sectionDefinitions = [...sectionByName.values()].sort(comparePromptSections);
		const completeSections = sectionDefinitions.filter((section) => section.complete === true);
		if (completeSections.length > 1) throw new Error(`multiple complete prompt sections are active: ${completeSections.map((section) => JSON.stringify(section.name)).join(", ")}`);
		let completeSection;
		const assembly = {
			sections: sectionDefinitions.map((section) => {
				const assembled = {
					name: section.name,
					text: typeof section.text === "function" ? section.text(context) : section.text
				};
				if (section.complete === true) completeSection = { ...assembled };
				return assembled;
			}),
			contexts: runtimeContextSuppressed ? [] : [...contextByName.values()].sort((a, b) => a.order - b.order).map((entry) => ({
				name: entry.name,
				text: typeof entry.text === "function" ? entry.text(context) : entry.text
			})),
			tools: orderTools(collected, this.toolOrder, knownNames),
			variables
		};
```

Note `assemble()` itself is `async` (`await this.ctx.waterfall(...)` at line 351), but individual `text` providers are called **synchronously** and must return a string.

Caller — `dsh-agent-loop\lib\index.js:885-908` (`preStep`):

```js
	async preStep(target, position) {
		/* v8 ignore next -- private callers establish the running phase before proposing a step */
		if (this.phase.kind !== "running") throw new Error(`agent "${this.id}": pre-step outside running phase`);
		const signal = this.phase.abort.signal;
		const claimed = this.inbox.claim(target, position.turn);
		const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));
		signal.throwIfAborted();
		const sections = renderContextSections(assembly);
		const context = this.runtimeContext.project(joinContextSections(sections), sections);
		const decision = await this.dispatch.waterfall("agent/pre-step", {
			messages: claimed,
			...position,
			signal
		}, () => Promise.resolve({
			kind: "enter",
			messages: context === void 0 ? claimed : [...claimed, context]
		}));
```

`preStep` is called once per step inside the turn's `while (true)` loop (`dsh-agent-loop\lib\index.js:934-940`), and `step()` renders it again at line 1014:

```js
	async step(decision) {
		...
		const { assembly } = decision;
		const renderedPrompt = renderPrompt(assembly);
```

**The assembly context carries the live agent.** `assembleContextFor` (verbatim, `dsh-agent\lib\types\dispatch.js:92-94`):

```js
export function assembleContextFor(agent, signal) {
    return { agent, scope: agent, ...signal === undefined ? {} : { signal } };
}
```

and `dsh-agent\lib\types\runtime-types.d.ts:14-19` augments it:

```ts
declare module '@deepseek-ai/dsh-system-prompt' {
    interface AssembleContext {
        /** Agent for this assembly; absent on diagnostics. When present, `scope` must identify the same agent. */
        agent?: Agent;
    }
}
```

So `text: (context) => …context.agent.session…` can read live per-session state at request time. This is exactly the hook needed for "current context usage".

**Real conditional/dynamic sections in the install** (proof this pattern is idiomatic):
- `dsh-tool-fs\lib\index.js:329` — `text: ({ scope }) => ctx.tools.get("read", scope) === void 0 ? "" : "Use the read tool — …"`
- `dsh-tools\lib\index.js:2634` — `text: (context) => this.modeFor(context.scope) === "ptc" ? PTC_ONLY_INSTRUCTION : ""`
- `dsh-file-reference-local\lib\index.js:345` — `text: () => agent.ctx.tools.get("read", agent) === void 0 ? "" : FILE_REFERENCE_PROMPT`
- `dsh-plan-mode\lib\index.js:173` — `text: (context) => { … }`
- `dsh-user-approval\lib\index.js:83`, `dsh-sandbox-policy\lib\index.js:125`, `dsh-tools\lib\index.js:2651`

Caveat: because sections are concatenated into one string, a changing section changes the system prompt text, and `SystemPromptProjection.project` decides whether that becomes a replaced node or an appended tail (see §4). `startsSeries` / `systemPromptUpdate === "in-history"` govern that; a route that caches the prefix appends rather than rewrites.

---

## 3. Working precedents — `dsh-time-context` and `dsh-tmux-context`

**Important, and contrary to the question's premise: neither plugin registers a system-prompt section. Both inject a sourced user-role message through the `agent/pre-step` waterfall.** There is no `ctx.systemPrompt.*` call anywhere in either package.

### `dsh-time-context`

File: `...\dsh-time-context\lib\index.js` — **250 lines total**.

Plugin object (verbatim, `lib\index.js:101-117` and `:248-250`):

```js
/** Cordis plugin name used by loader diagnostics. */
const name = "time-context";
const timeContextStateSchema = z$1.object({
	/** Time of the latest model-visible event (user/assistant message, tool result), or null. */
	lastMessageTime: z$1.number().nullable(),
	/** Time of this plugin's latest durable injection, or null. */
	lastInjectionTime: z$1.number().nullable(),
	/** Latest injection time in the open turn, or null before that turn receives one. */
	lastTurnInjectionTime: z$1.number().nullable()
});
/** The agent registry that owns pre-step processing. */
const inject = ["agents", "sessionProjections"];
/** Schemastery validation for {@link Config}. */
const Config = z.object({
	timeZone: z.string(),
	refreshIntervalMs: z.number()
});
```

```js
export { Config, apply, inject, name };
```

`apply` skeleton (`lib\index.js:160-247`): validates `refreshIntervalMs`; builds an `Intl.DateTimeFormat` and caches formatters; registers a session projection under key `"timeContext"`; then:

```js
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted) return decision;
		const now = Date.now();
		const state = ctx.sessionProjections.stateOf(agent.session, "timeContext");
		...
		const text = renderText(now, turn, step, previous, formatterFor(selectedTimeZone), selectedTimeZone, browser);
		return {
			...decision,
			messages: [...decision.messages, createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "plugin",
					plugin: name,
					form: "snapshot",
					sections: [{
						name,
						text
					}]
				}
			})]
		};
	}, { prepend: true });
```

Its three-line reading is `renderText` (`lib\index.js:144-149`):

```js
function renderText(now, turn, step, previous, formatter, timeZone, browserContext) {
	const elapsed = previous === void 0 ? "unavailable" : formatDuration(now - previous);
	const baseline = step === 1 ? "model-visible message" : "step context";
	const browserText = renderBrowserTimeZoneContext(browserContext);
	return `Time sampled while preparing turn ${turn}, step ${step}: ${formatTimestamp(now, formatter, timeZone)}\n${browserText}\nElapsed since the preceding ${baseline}: ${elapsed}.`;
}
```

### `dsh-tmux-context`

File: `...\dsh-tmux-context\lib\index.js` — **1546 lines total**, but only the last ~193 lines (1354-1546) are the plugin; the head of the file is bundled code (an inventory/remotes region, lines ~54-1352).

Plugin object (verbatim, `lib\index.js:1374-1379` and `:1546`):

```js
/** Cordis plugin name used by loader diagnostics. */
const name = "tmux-context";
/** The agent registry that owns pre-step processing. */
const inject = ["agents", "sessionProjections"];
/** Schemastery validation for {@link Config}. */
const Config = z.object({ refreshIntervalMs: z.number() });
```

```js
export { Config, apply, inject, name };
```

`apply` (`lib\index.js:1491-1544`): registers a `"tmuxContext"` session projection, then:

```js
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal.aborted || step !== 1) return decision;
		const bash = ctx.get("shell");
		if (bash === void 0) return decision;
		const previous = ctx.sessionProjections.stateOf(agent.session, "tmuxContext");
		if (refreshIntervalMs !== void 0 && refreshIntervalMs > 0 && previous !== null) {
			const now = Date.now();
			if (now >= previous.time && now - previous.time < refreshIntervalMs) return decision;
		}
		const location = await queryTmuxLocation(bash, ctx.logger, process.pid, signal);
		if (location === void 0) return decision;
		const state = renderState(location);
		if (previous !== null && previous.state === state) return decision;
		const text = renderReading(location, turn);
		return {
			...decision,
			messages: [createUserMessage({
				content: [{
					type: "text",
					text
				}],
				source: {
					kind: "plugin",
					plugin: name,
					form: "snapshot",
					sections: [{
						name,
						text
					}]
				}
			}), ...decision.messages]
		};
	}, { prepend: true });
}
```

Its two-line reading (`lib\index.js:1470-1476`):

```js
function renderState(location) {
	return `session ${location.sessionName}, window ${location.windowIndex} ${JSON.stringify(location.windowName)}, pane ${location.paneIndex} ${location.paneId}\nwindow active=${location.windowActive}, pane active=${location.paneActive}, layout ${location.windowLayout}`;
}
/** Render the full durable reading, including the volatile turn preamble. */
function renderReading(location, turn) {
	return `${READING_PREFIX}${turn}):\n${renderState(location)}`;
}
```
with `READING_PREFIX = "tmux location (turn "` (`lib\index.js:1396`).

### Shared structural facts about both

- `inject: ["agents", "sessionProjections"]` (the `agents` entry is what gives the `agent/pre-step` event; `sessionProjections` gives the fold).
- `{ prepend: true }` — listener runs **before** other pre-step listeners; both `await next()` first and then mutate the downstream decision.
- Both use `ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply })` to derive due-ness from durable events (so it survives compaction/resume without process-local cache).
- Both use `createUserMessage` from `@deepseek-ai/dsh-llm`.
- Both use `source: { kind: 'plugin', plugin: <name>, form: 'snapshot', sections: [{ name, text }] }`.
- Difference: time-context runs on **every eligible step** (`step` is used only in the text); tmux-context runs only on `step === 1`.
- Both are documented as opt-in; the time-context README (`...\dsh-time-context\README.md:12`) says "default compositions leave it disabled, and the Schedule Web overlay mounts it". Neither is mounted by `dsh-base\cordis.patch.yml` (grep for `dsh-time-context` / `dsh-tmux-context` in `*\cordis.patch.yml` under the install returned no row).

---

## 4. Who renders the final prompt

**`dsh-agent-loop` composes it.** Sequence, all in `...\dsh-agent-loop\lib\index.js`:

1. `turn()` — per-step loop, calls `preStep` (`:934-940`).
2. `preStep()` (`:885-908`) → `systemPrompt.assemble(assembleContextFor(this, signal))` (`:890`).
3. `renderContextSections(assembly)` + `joinContextSections(...)` (`:892-893`) → the "Current runtime context." snapshot candidate.
4. `agent/pre-step` waterfall (`:894-901`).
5. `step(decision)` (`:1008`) → `renderPrompt(assembly)` (`:1014`).
6. `this.systemPrompt.project(renderedPrompt, { inHistory, startsSeries })` (`:1019`) → commits via `session.append("system/message", {turn, step, message}, intent)` (`:1023-1027`).
7. `buildRequest(config, preparedCall, assembly.tools, startsRequestSeries, signal)` (`:1030`, defined `:1166-1218`).

The system prompt is **not** a separate request field. `buildRequest` ends with (`:1204-1217`):

```js
		const boundaryMessages = session.deriveMessages();
		for (const message of boundaryMessages) {
			if (this.frozenMessages.has(message)) continue;
			deepFreeze(message);
			this.frozenMessages.add(message);
		}
		Object.freeze(boundaryMessages);
		return markAgentLoopRequest(Object.freeze({
			...header.config,
			messages: boundaryMessages,
			...header.tools !== void 0 ? { tools: header.tools } : {},
			sessionId: this.session.id,
			signal
		}));
```

i.e. the system prompt reaches the model as a `system/message` **surface node** derived into the message list, and the projection class decides whether it is a rewrite of node 0 or an appended in-history tail:

```js
// dsh-agent-loop\lib\index.js:241-279
var SystemPromptProjection = class {
	...
	project(rendered, input) {
		const nodes = this.systemNodes();
		const head = nodes[0];
		if (head === void 0) return [{
			message: createSystemMessage(rendered, SOURCE),
			intent: { surfaceOp: "append" }
		}];
		const latest = nodes.findLast((node) => node.text !== "") ?? head;
		if (!input.inHistory || input.startsSeries || rendered.length === 0) {
			const updates = nodes.slice(1).filter((node) => node.text !== "").map((node) => this.replace(node.seq, ""));
			if (head.text !== rendered) updates.push(this.replace(head.seq, rendered));
			return updates;
		}
		if (latest.text === rendered) return [];
```

with `const SOURCE = "@deepseek-ai/dsh-system-prompt";` (`:220`).

### Section order table

`SECTION_ORDERS` (verbatim, `dsh-system-prompt\lib\index.js:10-42`):

```js
const SECTION_ORDERS = {
	HARNESS_IDENTITY: -1e3,
	DEPLOYMENT_PERSONA_PREFIX: 0,
	PLAN_POLICY: 500,
	TEAM_POLICY: 600,
	PTC_ONLY: 800,
	FILE_REFERENCE: 900,
	TOOL_BASH: 1e3,
	TOOL_PWSH: 1010,
	TOOL_READ: 1100,
	TOOL_WRITE: 1200,
	TOOL_EDIT: 1300,
	TOOL_GLOB: 1400,
	TOOL_GREP: 1500,
	TOOL_JOBS: 1600,
	TOOL_PTY: 1700,
	TOOL_WEB_SEARCH: 2e3,
	TOOL_WEB_FETCH: 2100,
	TOOL_LSP: 2200,
	TOOL_SESSION_QUERY: 2300,
	TOOL_GOAL: 2400,
	TOOL_CORDIS: 2500,
	TOOL_WORKFLOW: 2600,
	TOOL_RALPH: 2700,
	TOOL_SUBAGENT: 2800,
	TOOL_REPORT: 2900,
	TOOLS_SDK: 5e3,
	DELIVERABLE_FILE_REFERENCES: 9e3,
	STRUCTURED_OUTPUT: 9900,
	HARNESS_SOURCE: 1e4,
	WEB_SURFACE: 10100,
	DEPLOYMENT_PERSONA_SUFFIX: 10200
};
const CONTEXT_ORDERS = {
	SANDBOX_POLICY: 110,
	APPROVAL_POLICY: 115,
	SUBAGENT_DELEGATION: 120
};
```

`PERSONA_PREFIX_SECTION = "deployment:persona-prefix"`, `PERSONA_SUFFIX_SECTION = "deployment:persona-suffix"`, `TOOL_ORDER_REST = "<unlisted-tools>"` (`lib\index.js:54-62`).

**Where a new section appears:** there is no free enum key — a plugin passes its own literal `order`. Examples of literals in the install: `"harness:identity"` uses `-1000`; a new informational section between the file-reference guidance (900) and the bash tool guidance (1000) would use e.g. `order: 900` + something, or between tools and `STRUCTURED_OUTPUT` (9900). The `getSectionOrder(name)` helper is only valid for the exact keys listed above; an unknown name returns `undefined`, and `section()` then throws `order must be a finite number`.

---

## 5. Injecting non-prompt (transient) context

Five distinct mechanisms exist.

### 5a. `agent/pre-step` waterfall event (what both context plugins use)

Declared at `dsh-agent\lib\types\runtime-types.d.ts:302-319`:

```ts
        /**
         * Reject a proposed step or replace the messages that enter it. Calling
         * `next()` preserves the current messages.
         * ...
         * @mode waterfall
         */
        'agent/pre-step'(this: Scoped<Agent>, payload: {
            agent: Agent;
            messages: UserMessage[];
            turn: number;
            step: number;
            signal: AbortSignal;
        }, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
```

`PreStepDecision` (`:91-99`):

```ts
export type PreStepDecision = {
    kind: 'reject';
} | {
    kind: 'enter';
    messages: UserMessage[];
    /** Start a distinct model-message series before this step's admitted messages. */
    startsRequestSeries?: true;
};
```

Listener options include `{ prepend: true }` (used by both context plugins). Dispatch is scope-filtered (`@deepseek-ai/dsh-scope`): an agent-scoped listener receives only that agent.

### 5b. Agent-level delivery methods

`dsh-agent\lib\types\runtime-types.d.ts:165-209` (`interface Agent`, augmented into `./types.ts`):

```ts
        /**
       * Route identified input to an inbox boundary and optionally wake the driver.
       * ...
       * @param target - the preferred next-turn or next-step inbox boundary.
       * @param wakeup - whether delivery may wake the driver.
       */
        send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
        /**
       * Queue an ordinary follow-up turn and wake the driver. ...
       */
        followup(message: UserMessage): void;
        /**
       * Submit steering for the nearest step. An idle driver starts a turn;
       * a running driver consumes it at its next step boundary. ...
       */
        steer(message: UserMessage): void;
        /**
       * Queue model-facing context for the next pre-step without waking the
       * driver. A running driver claims it at the nearest later step boundary;
       * idle drivers leave it pending until follow-up or steering
       * wakes them. It may miss a request whose pre-step already claimed its
       * batch. ...
       */
        inject(message: UserMessage): void;
```

Inbox surface (`:41-82`): `nextTurn`, `nextStep`, `clear()`, `append(target, message)`, `prepend(target, message)`, `replace(messageId, newMessage)`, `remove(messageId)`, `splice(target, start, deleteCount, inserted)`.

Real callers: `dsh-plan-mode\lib\index.js:215` (`agent.steer(createUserMessage({...}))`) and `:377` (`agent.inject(narration)`); `dsh-hooks-codex\lib\index.js:206` (`agent.inject(context)`), `:284` (`agent.steer(...)`); `dsh-cordis-host-runner\lib\index.js:2397-2471` (`agent.steer` ×4, `agent.inject`); `dsh-command-goal\lib\index.js:99` (`invocation.agent.followup(...)`); `dsh-repeat-tool-reminder\lib\index.js:1509` (`agent/pre-step` + inbox).

### 5c. `createUserMessage` and source discriminators

`@deepseek-ai/dsh-llm` exports `createUserMessage` (`dsh-llm\lib\index.js:48` → `lib\types\message.js:45`). Real source shapes observed:

| Source | Where |
|---|---|
| `{ kind: 'plugin', plugin, form: 'snapshot', sections: [{ name, text }] }` | `dsh-time-context\lib\index.js:236-244`; `dsh-tmux-context\lib\index.js:1532-1540` |
| `{ kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections }` (runtime context) | `dsh-agent-loop\lib\index.js:345-353` |
| `{ kind: 'plugin', plugin, form: 'notice', summary }` | `dsh-repeat-tool-reminder\lib\index.js:1488-1492` |
| `{ kind: 'agent-instructions', form: 'instructions', changes }` | `dsh-agent-instructions\lib\index.js:772-777` |

Comment worth noting (`dsh-repeat-tool-reminder\lib\index.js:1372-1380`):

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

### 5d. `tools/post-execute` waterfall with `additionalContexts`

`dsh-repeat-tool-reminder\lib\index.js:1495-1508`:

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
```

### 5e. `systemPrompt.context()` → durable runtime-context snapshot (the "system reminder" that IS a prompt contribution)

This is the one prompt-adjacent mechanism that is re-rendered per step **and** change-suppressed. `SystemPrompt.context()` contributions are joined by `joinContextSections` into a snapshot whose header is (`dsh-system-prompt\lib\index.js:130-134`):

```js
function joinContextSections(sections) {
	const body = sections.map((section) => section.text).join("\n\n");
	if (body.length === 0) return "";
	return `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n${body}`;
}
```

and projected into a **user-role** durable message by `RuntimeContextProjection.project` (`dsh-agent-loop\lib\index.js:336-355`):

```js
	project(current, sections) {
		if (this.retained === void 0 && current.length === 0) return;
		const snapshot = current.length === 0 ? CLEARED : current;
		if (this.retained?.text === snapshot) return;
		return createUserMessage({
			content: [{
				type: "text",
				text: snapshot
			}],
			source: sections.length === 0 ? {
				kind: "plugin",
				plugin: SOURCE
			} : {
				kind: "plugin",
				plugin: SOURCE,
				form: "snapshot",
				sections
			}
		});
	}
```

with `const CLEARED = "Current runtime context: none. Earlier runtime-context snapshots no longer apply.";` (`:221`). This is emitted from `preStep` (`:893`) via the `agent/pre-step` waterfall's default branch (`:900`). `systemPrompt.suppressRuntimeContext()` (and the `includeRuntimeContext: false` config / persona `includeRuntimeContext`) disables the whole channel.

Real contributors: `dsh-sandbox-policy\lib\index.js:121-125` (order `getContextOrder("SANDBOX_POLICY")` = 110), `dsh-user-approval\lib\index.js:80-83` (115), `dsh-subagent\lib\index.js:544` (120).

### 5f. Reminder / context plugins in this install

| Package | plugin `name` | `inject` | Mechanism |
|---|---|---|---|
| `dsh-repeat-tool-reminder` | `"repeat-tool-reminder"` (`lib\index.js:1361`) | (none declared in the region read) | `tools/post-execute` → `additionalContexts`; plus `agent/pre-step` (`:1509`) |
| `dsh-agent-instructions` | `"agent-instructions"` (`lib\index.js:765`) | `["sessionProjections"]` (`:1072`) | `agent/pre-step` (`:1270-1288`), inserts/replaces a user-role message in `decision.messages` |
| `dsh-time-context` | `"time-context"` | `["agents", "sessionProjections"]` | `agent/pre-step` append |
| `dsh-tmux-context` | `"tmux-context"` | `["agents", "sessionProjections"]` | `agent/pre-step` prepend |
| `dsh-disclosure-policy` (third-party, installed at `E:\Home\.dsh\profiles\web\node_modules\dsh-disclosure-policy`) | — | — | reminder plugin; config `reminderAfterCalls`, `maxReminders` |

`dsh-agent-instructions` pre-step body (`lib\index.js:1270-1288`) is the most instructive for "insert a notice at a precise place in the entering batch":

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

### 5g. Existing source of "current context usage"

`@deepseek-ai/dsh-token-meter` provides the `tokenMeter` service (`dsh-token-meter\lib\index.js:608-621`: `super(ctx, "tokenMeter")`, `static inject = ["sessionProjections"]`). Public API (`lib\index.js:643`):

```js
	measure(session, requestHeader) {
```

returning (`:678-685`):

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

`baseline` is `{kind:'usage'|'estimated'|'none', tokens, usage?}` (`:656-676`). It also exports `estimateMessage(message)` (`:704-706`).

It additionally registers a `contextPressure` session projection (`:470-517`) whose wire view is `{ pressureTokens?, projectedTokens?, contextWindow? }` — read by the browser at `dsh-client-ui-conversation\lib\client.js:15414` (`useProjection("contextPressure")`). `dsh-compaction-basic\lib\index.js:951` calls `this.ctx.tokenMeter.measure(agent.session)`.

Relevance: "current context usage" already has a first-party provider; a context-sense section would most naturally read `tokenMeter.measure(context.agent.session)` (or the `contextPressure` projection) inside a dynamic `text` provider.

---

## 6. Composition placement

### What the files are

- **Agent preset** = a directory containing `agent.cordis.yml`. `dsh-agent-presets\lib\types\discovery.js:35`:
  ```js
  export const COMPOSITION_FILE = 'agent.cordis.yml';
  ```
  User preset root (`:48`): `export const USER_PRESET_DIR = '.agent-presets';` → `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml`.
  Shipped root (`:56`): `export const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../presets/', import.meta.url));`
- **Host composition** — a profile bootstrap `cordis.yml`, normally empty, composed from bundle patch layers. `cordis\bin.js:14` defaults to `path: './cordis.yml'`.

### No `cordis.yml` ships inside any npm package

Glob `**/*.cordis.yml` over `E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh` returns exactly four files, all presets:

```
...\dsh-agent-presets\presets\cordis\agent.cordis.yml
...\dsh-agent-presets\presets\minimal\agent.cordis.yml
...\dsh-agent-presets\presets\ptc\agent.cordis.yml
...\dsh-agent-presets\presets\standard\agent.cordis.yml
```

Host-plane rows live in each bundle package's `cordis.patch.yml` (e.g. `dsh-base\cordis.patch.yml`, 487 lines) and are merged into the profile.

### A real preset row that contributes a prompt section

`E:\Apps\nvm\v24.19.0\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-agent-presets\presets\standard\agent.cordis.yml:20-34` (verbatim):

```yaml
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
```

`dsh-persona` is the prompt-contributing row: it calls `ctx.systemPrompt.section(...)` twice (`dsh-persona\lib\index.js:35-48`, quoted in full):

```js
const name = "persona";
/** The prompt registry this row contributes to. */
const inject = ["systemPrompt"];
/** Runtime schema for the persona row. */
const Config = z.object({
	prefix: z.string().required(),
	suffix: z.string().default(""),
	complete: z.boolean().default(false),
	includeRuntimeContext: z.boolean().default(true)
});
function apply(ctx, config) {
	ctx.effect(() => ctx.systemPrompt.section({
		name: PERSONA_PREFIX_SECTION,
		order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
		text: config.prefix,
		...config.complete ? { complete: true } : {}
	}), "persona.section()");
	ctx.effect(() => ctx.systemPrompt.section({
		name: PERSONA_SUFFIX_SECTION,
		order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX"),
		text: config.suffix ?? ""
	}), "persona.suffix()");
	if (!(config.includeRuntimeContext ?? true)) ctx.systemPrompt.suppressRuntimeContext();
}
```

The package docstring (`dsh-persona\lib\index.js:4-17`) states the ownership rule plainly: this row is **scope-only** — mounted inside an agent preset it shadows the deployment persona for that session; mounted globally it collides with the registry's own registration and fails loud.

Shipped alongside it, a row whose **config text becomes a prompt section** — `...\dsh-agent-presets\presets\standard\agent.cordis.yml:105-112`:

```yaml
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
              You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. ...
```

### The local (user-authored) preset

`E:\Home\.dsh\.agent-presets\bare-standard\agent.cordis.yml` — a copy of `standard` minus orchestration rows; 243 lines. Its identity rows (`:50-62`):

```yaml
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
```

Its header comment (`:31-46`) is the authoritative statement of placement rules:

```
# This file is an AGENT-PLANE composition. The roster mounts it ONCE under a
# standing scope; every session naming it joins by scope parentage, so the
# tools and prompt sections registered here cover each joined agent while a
# session's own state stays keyed per Session/Agent inside the plugins. The
# host composition (`base.cordis.yml` + `web.cordis.yml`) keeps everything a
# preset must not own: the registries themselves, the sandbox and approval
# stack, persistence, and the model route.
#
# A service row here MUST sit inside a group carrying an `isolate` realm.
```

### The host row that mounts the prompt registry

`...\dsh-base\cordis.patch.yml:456-475` (verbatim):

```yaml
    # ── rows every mode mounts, whose values each overlay may state ──────────────

    # The tool registry. Presentation mode is a deployment choice; omitting it here
    # keeps the schema default (native).
    - id: tools
      name: '@deepseek-ai/dsh-tools'

    # The deployment persona is a deployment choice; plan-mode and tool plugins own
    # their own prompt sections.
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
      config:
        personaPrefix: ''

    # Agents created at startup. The base stays empty; raw overlays may create
    # agents, while Web creates sessions on client request.
    - id: agent-loop
      name: '@deepseek-ai/dsh-agent-loop'
      config:
        agents: []
```

`dsh-token-meter` is mounted on the same plane (`...\dsh-base\cordis.patch.yml:317-318`):

```yaml
    - id: token-meter
      name: '@deepseek-ai/dsh-token-meter'
```

### The profile on this machine

`E:\Home\.dsh\profiles\web\cordis.yml` (verbatim, 4 lines):

```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

`E:\Home\.dsh\profiles\web\package.json` declares the bundle order:

```json
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
```

The user's own patch layer, `E:\Home\.dsh\profiles\web\cordis.patch.yml` (verbatim):

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

Insert dialect, from a bundle patch — `E:\Home\.dsh\profiles\web\node_modules\dsh-disclosure-policy\cordis.patch.yml` (verbatim):

```yaml
- insert:
    - id: disclosure-policy
      name: dsh-disclosure-policy
      config:
        reminderAfterCalls: 8
        maxReminders: 3
```

So: a **new** row arrives via `- insert: [ <row> ]`; an existing row is retargeted via `- id: <rowId>` with `config:` / `disabled:` / arbitrary row keys. Per `dsh-agent-presets\lib\types\discovery.js:72-94` (`entryListProblem`), a row must be a map with a `name: string`; `group: true` rows recurse into `config` as a nested list.

`!!js` YAML expressions are supported in rows (used in `bare-standard`: `disabled: !!js process.platform === 'win32'`).

---

## Not found / explicitly negative

- **No `title` field** on `PromptSection` / `PromptContext` — only `name`. No `id`.
- **No async section text.** The declared type is `string | ((context: AssembleContext) => string)`; no `Promise` arm exists.
- **No `cordis.yml` shipped inside any npm package** under the searched root; only the four preset `agent.cordis.yml` files. `base.cordis.yml` / `web.cordis.yml` referenced by the preset header comments are **not present on disk** — the live tree is `profiles/web/cordis.yml` (`[]`) plus bundle `cordis.patch.yml` layers.
- **`dsh-time-context` and `dsh-tmux-context` never call `ctx.systemPrompt.*`.** Grep for `systemPrompt` across both packages returns nothing.
- **Neither context plugin is mounted by `dsh-base\cordis.patch.yml`.** Grep for `dsh-time-context` / `dsh-tmux-context` / `dsh-persona` across every `cordis.patch.yml` in the install returned only `dsh-agent-instructions` (`:269`) and `dsh-token-meter` (`:318`). `dsh-persona` appears only in the preset files.
- `dsh-agent-instructions` has no `Config`-typed prompt section; its contributions are user-role messages, not system prompt text.
- `SHIPPED_PRESET_ROOT` resolves to `dsh-agent-presets/presets/` (package root), **not** `lib/presets/` — confirmed by the four files globbed there.
