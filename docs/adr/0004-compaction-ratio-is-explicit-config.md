# 压缩阈值由插件显式配置, 不读取 DSH

原先的决定是"优先从 DSH 读压缩阈值,读不到才回退到插件配置,再没有就在提示词里省略"。侦察否掉了这条**主路**:在 `web` profile 里读不到。

`dsh-base` 确实在 root 挂了 `compaction-basic`,但 **`dsh-web-app` 这一层把它 `disabled: true`**,压缩改由 **agent preset 平面在 `isolate` realm 里**提供。realm 是私有的,所以一个**全局挂载**的插件执行 `ctx.get('compaction')` 得到的是 `undefined` —— 它解析到 root realm,而那个 realm 里没有 provider。

于是"单一真相来源"这个目标在当前架构下不可达。改用插件自己的 `compactionThresholdRatio` 显式配置作为唯一来源。

**代价必须写下来**:这是第二个真相来源。如果 DSH 那边的 `thresholdRatio` 被改过(或用了 `modelPolicies` 按模型覆盖),我们算出的阈值就与真正触发压缩的水位不一致,模型被告知的"压缩会在哪里发生"就是错的 —— 而且不会报错,只表现为提醒偏早或偏晚。唯一的缓解是让配置值与 `compaction-basic` 的 `thresholdRatio` 保持同步,并且在提示词里**不**声称这个数字来自 DSH。

因此 `compactionThresholdRatio` **没有默认值**。在拿不到真实值的前提下给默认值,就是编造一个数字,而设计规则是宁可不说。键未设置时:阈值从提示词里省略,**越线提醒完全失效**(预警线是阈值的比例,没有阈值就没有预警线)。这是刻意的降级,不是疏漏 —— 使用者必须显式配置才能拿到需求 1 的阈值与需求 3 的提醒。
