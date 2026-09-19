# Context Sense

A DeepSeek Harness plugin that makes the model aware of its own context budget: it learns the ceiling, can query where it currently stands, and is told when it is running out of room or when a single tool output has just eaten a large share of it.

## Language

### Capacity

**上下文窗口** (context window):
The total token ceiling a single request may occupy for the active model.
_Avoid_: 上下文长度, context length, 最大 token

**上下文用量** (context usage):
The tokens the current session actually occupies right now. A variable, not a constant.
_Avoid_: 已用上下文, token 消耗, usage

**余量** (headroom):
The distance between context usage and the threshold that matters — context window − context usage, or warning line − context usage, depending on which ceiling is being discussed.
_Avoid_: 剩余空间, 空间, budget left

### Thresholds

**压缩阈值** (compaction threshold):
The context usage at which DSH compacts the conversation. A configured constant, and the number the model most needs to reason about its own survival.
_Avoid_: 压缩线, 上限, limit, 最大上下文

**预警线** (warning line):
A configured fraction of the compaction threshold — default 0.8 — whose crossing is the event that triggers a reminder. Not a second compaction trigger; nothing compacts because of it.
_Avoid_: 危险线, 警戒值, 阈值

**滞后带** (hysteresis band):
The gap between the warning line and a lower re-arm line, both expressed as fractions of the compaction threshold. Context usage must fall below the re-arm line before the warning line is allowed to fire again, so a session hovering at the warning line is reminded once rather than every turn.
_Avoid_: 迟滞, 回差, deadband

### Scope

**顶层会话** (top-level session):
A session driven directly by the user. Subagent, workflow, and Ralph child agents have their own sessions and are deliberately outside this plugin's scope.
_Avoid_: 主会话, 父会话, root session

### Events

**提醒** (reminder):
A short notice injected into the conversation at runtime to tell the model something about its own state. Delivered as a message, never by rewriting the system prompt.
_Avoid_: 通知, 警告, warning, 提示

**静态指引** (static guidance):
The unchanging text in the system prompt that tells the model what it can know and how to ask for it. Distinct from a reminder in every respect: constant, not event-driven, and never carries a live number.
_Avoid_: 系统提示, prompt 说明, 固定提示

**溢出工具结果** (oversized tool output):
A single tool result whose size exceeds the configured size threshold. Its size is a property of that one result, not of the turn or the session.
_Avoid_: 大输出, 长结果, 超长输出, big output

## Relationships

- Context usage is measured against the compaction threshold to decide whether the warning line has been crossed.
- A reminder is emitted on crossing, not on every turn spent above it.
- An oversized tool output is judged on its own size, independent of how full the context is.
- The static guidance is the only one of these that lives in the system prompt.
