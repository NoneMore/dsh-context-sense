# 上下文用量取面板口径,而非压缩判定口径

DSH 内部对"上下文用量的当前值"存在两个不同的数:`tokenMeter.measure(session)` 的 `totalTokens` 包含上一次响应的输出 token,是**压缩引擎**用来与阈值比较的那个数;`contextPressure` 投影的 `projectedTokens` 只算 prompt 侧,是**Web GUI 面板**显示给用户的那个数。两者本来就不同。

我们选了面板口径 `projectedTokens`。理由是:**一个廉价的增量折叠**同时给出 `contextWindow` 与 `projectedTokens`(投影视图里就带窗口),而 `measure()` 每次都要重新定价整条外表;而且模型看到的数与用户看到的数一致,任何一方显得奇怪时都能对上账。

**代价必须写下来**:预警线定义为"压缩阈值 × 比例",但我们用来与它比较的量不是压缩引擎比较的那个量,所以提醒会相对真实触发点略微偏晚。差异主要来自上一次响应的输出 token —— 默认 1M 窗口下不到 1%,窗口调小后会放大。这是刻意的取舍,不是疏漏;若要改回与压缩同源,只需把读数换成 `measure().totalTokens` 一处。
